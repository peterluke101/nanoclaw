/**
 * mc-chat channel
 *
 * Lets Peter chat with Ares/NanoClaw directly from the Mission Control
 * dashboard. Runs a small HTTP server inside NanoClaw that the dashboard
 * (via Cloudflare Pages Functions over a Tailscale Funnel) talks to.
 *
 * Wire protocol
 * -------------
 *   POST /chat
 *     Auth: Authorization: Bearer ${MC_CHAT_SECRET}
 *     Body: { conversationId: string, message: string, attachments?: Array<{ url: string, filename: string }> }
 *     Response: text/event-stream
 *       event: ready    data: { ts }            — connection accepted, message enqueued
 *       event: status   data: { phase, ts }     — heartbeat while agent is running
 *       event: chunk    data: { text }          — (reserved; future streaming)
 *       event: done     data: { text, ts }      — final agent response
 *       event: error    data: { message }       — fatal error before/instead of done
 *
 *   POST /upload
 *     Auth: same bearer
 *     Body: { filename: string, mime?: string, dataBase64: string }
 *     Response: { url: string, filename: string }
 *       url is the in-container path (/workspace/group/attachments/<safe>) the
 *       agent will see when it processes the next message.
 *
 *   GET /health
 *     Auth: same bearer
 *     Response: { ok: true, ts, channel: 'mc-chat', queued: number }
 *
 * JID convention
 * --------------
 *   Single JID per install: `mc-chat:dashboard`. The conversationId from the
 *   client is recorded in the message thread_id for memory segmentation but
 *   does not split into separate JIDs — NanoClaw's per-JID conversation memory
 *   already handles continuity.
 *
 * Auth
 * ----
 *   MC_CHAT_SECRET (required). If missing, the factory returns null and the
 *   channel is skipped. The dashboard's Pages Functions hold the matching
 *   secret as a Cloudflare env var.
 *
 * Port
 * ----
 *   MC_CHAT_PORT (default 54173). Tailscale Funnel exposes this externally.
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';

const DEFAULT_PORT = 54173;
const JID = 'mc-chat:dashboard';
const HEARTBEAT_MS = 5000;
const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — covers slow agent runs
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB after base64 decode
const MAX_JSON_BYTES = 35 * 1024 * 1024; // ≈ 25MB base64-inflated

interface PendingResponse {
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
  timeout: NodeJS.Timeout;
  createdAt: number;
  conversationId: string;
}

interface ChatRequest {
  conversationId?: string;
  message?: string;
  attachments?: Array<{ url?: string; filename?: string }>;
}

interface UploadRequest {
  filename?: string;
  mime?: string;
  dataBase64?: string;
}

/**
 * Safe-rename a filename: alphanumerics, dot, underscore, hyphen only.
 * Strips path separators and leading dots to prevent traversal.
 */
function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/^\.+/, '');
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.length > 0 ? safe.slice(0, 200) : 'file';
}

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class McChatChannel implements Channel {
  name = 'mc-chat';

  private server: Server | null = null;
  private opts: ChannelOpts;
  private secret: string;
  private port: number;
  // FIFO queue of pending HTTP responses awaiting an agent reply.
  // Each inbound message that successfully delivers to the orchestrator pushes
  // an entry; sendMessage() shifts the oldest. Single-user usage keeps this
  // queue at depth 0 or 1 in practice.
  private pending: PendingResponse[] = [];

  constructor(secret: string, port: number, opts: ChannelOpts) {
    this.secret = secret;
    this.port = port;
    this.opts = opts;
  }

  /**
   * Find the registered group that serves the mc-chat JID, whether as the
   * primary key or as a subscriber (unified channel mirror). Returns
   * undefined if no group claims it.
   */
  private findGroupForMcChat(): RegisteredGroup | undefined {
    const all = this.opts.registeredGroups();
    const direct = all[JID];
    if (direct) return direct;
    for (const group of Object.values(all)) {
      if (group.subscriberJids?.includes(JID)) return group;
    }
    return undefined;
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.server!.removeListener('error', reject);
        logger.info(
          { port: this.port },
          'mc-chat HTTP server listening (loopback only — expose via Tailscale Funnel)',
        );
        console.log(`\n  mc-chat: http://127.0.0.1:${this.port}`);
        console.log(
          `  Expose externally with: tailscale funnel --bg ${this.port}\n`,
        );
        resolve();
      });
    });
  }

  private checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string') return false;
    if (!auth.startsWith('Bearer ')) return false;
    const token = auth.slice('Bearer '.length).trim();
    // Constant-time compare to avoid timing oracles
    if (token.length !== this.secret.length) return false;
    let mismatch = 0;
    for (let i = 0; i < token.length; i++) {
      mismatch |= token.charCodeAt(i) ^ this.secret.charCodeAt(i);
    }
    return mismatch === 0;
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
      const method = req.method ?? 'GET';

      if (!this.checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            ts: new Date().toISOString(),
            channel: 'mc-chat',
            queued: this.pending.length,
          }),
        );
        return;
      }

      if (method === 'POST' && url.pathname === '/chat') {
        await this.handleChat(req, res);
        return;
      }

      if (method === 'POST' && url.pathname === '/upload') {
        await this.handleUpload(req, res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      logger.error({ err, url: req.url }, 'mc-chat request error');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  private async handleChat(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: ChatRequest;
    try {
      const buf = await readBody(req, MAX_JSON_BYTES);
      body = JSON.parse(buf.toString('utf8')) as ChatRequest;
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      logger.debug({ err }, 'mc-chat /chat: bad body');
      return;
    }

    const message = (body.message ?? '').toString();
    const conversationId = (body.conversationId ?? '').toString() || 'default';
    if (!message.trim() && (!body.attachments || body.attachments.length === 0)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty message' }));
      return;
    }

    // Confirm a registered group serves this JID — either as the primary or
    // as a subscriber (unified channel mirror). Fail fast with a clear
    // instruction otherwise.
    const group = this.findGroupForMcChat();
    if (!group) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'mc-chat JID not registered. Register `' +
            JID +
            '` in NanoClaw before chatting (see add-mc-chat SKILL.md).',
        }),
      );
      return;
    }

    // Compose the message text the agent will see.
    // Attachments are surfaced as a trailing block of in-container paths so the
    // agent can simply Read them. The dashboard's /upload step already moved
    // the files into the group's attachments dir.
    let content = message;
    if (body.attachments && body.attachments.length > 0) {
      const refs = body.attachments
        .filter((a) => a && typeof a.url === 'string')
        .map((a) => `- ${a.filename ?? 'attachment'} → ${a.url}`)
        .join('\n');
      if (refs) content = `${content}\n\n[Attachments]\n${refs}`;
    }

    // Start SSE response.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Pages Functions / CF will buffer without this hint
      'X-Accel-Buffering': 'no',
    });
    sseWrite(res, 'ready', { ts: new Date().toISOString() });

    const heartbeat = setInterval(() => {
      sseWrite(res, 'status', {
        phase: 'thinking',
        ts: new Date().toISOString(),
      });
    }, HEARTBEAT_MS);

    const timeout = setTimeout(() => {
      logger.warn(
        { conversationId },
        'mc-chat: pending response timed out, closing SSE',
      );
      sseWrite(res, 'error', { message: 'agent timeout' });
      this.releasePending(res, /*err*/ false);
    }, PENDING_TIMEOUT_MS);

    const pending: PendingResponse = {
      res,
      heartbeat,
      timeout,
      createdAt: Date.now(),
      conversationId,
    };
    this.pending.push(pending);

    // If the client closes early, drop the pending entry so a later
    // sendMessage() doesn't try to write to a dead socket.
    req.on('close', () => {
      if (res.writableEnded) return;
      logger.debug({ conversationId }, 'mc-chat: client disconnected early');
      this.releasePending(res, /*err*/ false);
    });

    // Deliver the message to the orchestrator. From here, the scheduler loop
    // runs the agent and eventually calls channel.sendMessage(JID, text),
    // which resolves the oldest pending entry.
    const now = new Date().toISOString();
    const newMsg: NewMessage = {
      id: randomUUID(),
      chat_jid: JID,
      sender: 'mc-dashboard',
      sender_name: 'Peter (MC)',
      content,
      timestamp: now,
      is_from_me: false,
      // conversationId rides along as thread_id — useful if we ever shard
      // memory per-conversation, but per-JID memory works fine today.
      thread_id: conversationId,
    };
    this.opts.onChatMetadata(JID, now, 'Mission Control', 'mc-chat', false);
    this.opts.onMessage(JID, newMsg);

    logger.info(
      { conversationId, len: content.length },
      'mc-chat: message accepted',
    );
  }

  private async handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: UploadRequest;
    try {
      const buf = await readBody(req, MAX_JSON_BYTES);
      body = JSON.parse(buf.toString('utf8')) as UploadRequest;
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      logger.debug({ err }, 'mc-chat /upload: bad body');
      return;
    }

    if (!body.filename || !body.dataBase64) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'filename and dataBase64 required' }));
      return;
    }

    const group = this.findGroupForMcChat();
    if (!group) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'mc-chat JID not registered' }));
      return;
    }

    let data: Buffer;
    try {
      data = Buffer.from(body.dataBase64, 'base64');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid base64' }));
      return;
    }
    if (data.length > MAX_UPLOAD_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file too large' }));
      return;
    }

    const groupDir = resolveGroupFolderPath(group.folder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    // Prefix with a short random token so concurrent uploads with the same
    // name don't clobber each other.
    const token = randomUUID().slice(0, 8);
    const safeName = sanitizeFilename(body.filename);
    const finalName = `${token}_${safeName}`;
    const destPath = path.join(attachDir, finalName);
    fs.writeFileSync(destPath, data);

    const containerUrl = `/workspace/group/attachments/${finalName}`;
    logger.info(
      { dest: destPath, bytes: data.length },
      'mc-chat: upload stored',
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: containerUrl, filename: finalName }));
  }

  /**
   * Pop the oldest pending response and clean up. If `withDone` is supplied,
   * emits a `done` event with the agent's text before closing. Otherwise the
   * caller is responsible for any final SSE event (e.g. error path).
   */
  private releasePending(
    targetRes: ServerResponse | null,
    err: boolean,
    withDone?: string,
  ): PendingResponse | null {
    const idx = targetRes
      ? this.pending.findIndex((p) => p.res === targetRes)
      : 0;
    if (idx < 0 || this.pending.length === 0) return null;
    const entry = this.pending[idx];
    this.pending.splice(idx, 1);
    clearInterval(entry.heartbeat);
    clearTimeout(entry.timeout);
    if (!entry.res.writableEnded) {
      if (withDone !== undefined) {
        sseWrite(entry.res, 'done', {
          text: withDone,
          ts: new Date().toISOString(),
        });
      }
      entry.res.end();
    }
    if (err) {
      logger.debug(
        { conversationId: entry.conversationId },
        'mc-chat: released pending with error',
      );
    }
    return entry;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // mc-chat is a singleton: there is exactly one pending SSE queue regardless
    // of the JID the caller addresses. The orchestrator routes mc-chat traffic
    // via `mirrorSend(mc-chat:dashboard, …)` for fan-outs, and the agent reply
    // via the message's `source_jid` (which may be the unified primary JID,
    // e.g. `tg:…`, when the inbound was rewritten). In both cases delivery is
    // to the oldest pending response.
    const released = this.releasePending(null, false, text);
    if (!released) {
      // Agent emitted a scheduled or unprompted message with no live client
      // waiting. We can't push (no persistent socket). Log and drop — the
      // dashboard will see it when it asks next time (memory persists).
      logger.info(
        { jid, len: text.length },
        'mc-chat: outbound with no pending client — dropping (client polls memory)',
      );
      return;
    }
    logger.info(
      { jid, len: text.length, conversationId: released.conversationId },
      'mc-chat: response delivered',
    );
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid === JID || jid.startsWith('mc-chat:');
  }

  async disconnect(): Promise<void> {
    // Drain pending responses with a polite error.
    while (this.pending.length > 0) {
      const entry = this.pending.shift()!;
      clearInterval(entry.heartbeat);
      clearTimeout(entry.timeout);
      if (!entry.res.writableEnded) {
        sseWrite(entry.res, 'error', { message: 'channel shutting down' });
        entry.res.end();
      }
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
      logger.info('mc-chat HTTP server stopped');
    }
  }
}

registerChannel('mc-chat', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['MC_CHAT_SECRET', 'MC_CHAT_PORT']);
  const secret = process.env.MC_CHAT_SECRET || envVars.MC_CHAT_SECRET || '';
  if (!secret) {
    logger.warn('mc-chat: MC_CHAT_SECRET not set — channel disabled');
    return null;
  }
  if (secret.length < 16) {
    logger.warn(
      'mc-chat: MC_CHAT_SECRET is shorter than 16 chars — generate a stronger secret (`openssl rand -hex 32`)',
    );
  }
  const portStr = process.env.MC_CHAT_PORT || envVars.MC_CHAT_PORT;
  const port = portStr ? parseInt(portStr, 10) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    logger.error({ portStr }, 'mc-chat: invalid MC_CHAT_PORT, refusing to start');
    return null;
  }
  return new McChatChannel(secret, port, opts);
});

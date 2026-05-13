import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AddressInfo } from 'net';

// Mock registry — we drive the factory directly in tests
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/mc-chat-test/${folder}`),
}));

import { McChatChannel } from './mc-chat.js';
import type { ChannelOpts } from './registry.js';
import fs from 'fs';
import path from 'path';

const JID = 'mc-chat:dashboard';
const SECRET = 'test-secret-1234567890abcdef';

function makeOpts(overrides: Partial<ChannelOpts> = {}): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({
      [JID]: {
        name: 'Mission Control',
        folder: 'main',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        isMain: true,
      },
    }),
    ...overrides,
  };
}

async function withChannel(
  opts: ChannelOpts,
  fn: (channel: McChatChannel, baseUrl: string) => Promise<void>,
): Promise<void> {
  // Port 0 so the OS picks a free port (parallel test friendly)
  const channel = new McChatChannel(SECRET, 0, opts);
  await channel.connect();
  // @ts-expect-error — access private server for test URL
  const addr = channel.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(channel, baseUrl);
  } finally {
    await channel.disconnect();
  }
}

describe('McChatChannel', () => {
  beforeEach(() => {
    // Clean test attachments dir
    const dir = '/tmp/mc-chat-test/main/attachments';
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('auth', () => {
    it('returns 401 without bearer token', async () => {
      const opts = makeOpts();
      await withChannel(opts, async (_ch, baseUrl) => {
        const res = await fetch(`${baseUrl}/health`);
        expect(res.status).toBe(401);
      });
    });

    it('returns 401 with wrong token', async () => {
      const opts = makeOpts();
      await withChannel(opts, async (_ch, baseUrl) => {
        const res = await fetch(`${baseUrl}/health`, {
          headers: { Authorization: 'Bearer wrong' },
        });
        expect(res.status).toBe(401);
      });
    });

    it('accepts correct bearer token', async () => {
      const opts = makeOpts();
      await withChannel(opts, async (_ch, baseUrl) => {
        const res = await fetch(`${baseUrl}/health`, {
          headers: { Authorization: `Bearer ${SECRET}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; channel: string };
        expect(body.ok).toBe(true);
        expect(body.channel).toBe('mc-chat');
      });
    });
  });

  describe('routing', () => {
    it('ownsJid matches mc-chat scheme', () => {
      const ch = new McChatChannel(SECRET, 0, makeOpts());
      expect(ch.ownsJid('mc-chat:dashboard')).toBe(true);
      expect(ch.ownsJid('mc-chat:anything')).toBe(true);
      expect(ch.ownsJid('tg:123')).toBe(false);
      expect(ch.ownsJid('whatsapp:foo')).toBe(false);
    });

    it('returns 404 for unknown paths', async () => {
      await withChannel(makeOpts(), async (_ch, baseUrl) => {
        const res = await fetch(`${baseUrl}/nope`, {
          headers: { Authorization: `Bearer ${SECRET}` },
        });
        expect(res.status).toBe(404);
      });
    });
  });

  describe('POST /chat', () => {
    it('rejects when JID not registered', async () => {
      const opts = makeOpts({ registeredGroups: () => ({}) });
      await withChannel(opts, async (_ch, baseUrl) => {
        const res = await fetch(`${baseUrl}/chat`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ conversationId: 'c1', message: 'hi' }),
        });
        expect(res.status).toBe(503);
      });
    });

    it('rejects empty messages', async () => {
      await withChannel(makeOpts(), async (_ch, baseUrl) => {
        const res = await fetch(`${baseUrl}/chat`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ conversationId: 'c1', message: '   ' }),
        });
        expect(res.status).toBe(400);
      });
    });

    it('delivers message via onMessage and resolves on sendMessage', async () => {
      const onMessage = vi.fn();
      const opts = makeOpts({ onMessage });
      await withChannel(opts, async (channel, baseUrl) => {
        const pending = fetch(`${baseUrl}/chat`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ conversationId: 'c1', message: 'hello there' }),
        });

        // Wait for the server to invoke onMessage (means SSE is open + queued)
        await waitFor(() => onMessage.mock.calls.length > 0, 2000);
        const [jid, msg] = onMessage.mock.calls[0];
        expect(jid).toBe(JID);
        expect(msg.content).toBe('hello there');
        expect(msg.thread_id).toBe('c1');

        // Simulate the agent responding
        await channel.sendMessage(JID, 'pong');

        const res = await pending;
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: ready');
        expect(text).toContain('event: done');
        expect(text).toContain('"text":"pong"');
      });
    });

    it('includes attachments in the agent-facing content block', async () => {
      const onMessage = vi.fn();
      const opts = makeOpts({ onMessage });
      await withChannel(opts, async (channel, baseUrl) => {
        const pending = fetch(`${baseUrl}/chat`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            conversationId: 'c1',
            message: 'check this',
            attachments: [
              { url: '/workspace/group/attachments/abc_pic.png', filename: 'pic.png' },
            ],
          }),
        });

        await waitFor(() => onMessage.mock.calls.length > 0, 2000);
        const [, msg] = onMessage.mock.calls[0];
        expect(msg.content).toContain('check this');
        expect(msg.content).toContain('[Attachments]');
        expect(msg.content).toContain('/workspace/group/attachments/abc_pic.png');

        await channel.sendMessage(JID, 'got it');
        await pending;
      });
    });
  });

  describe('POST /upload', () => {
    it('stores base64 file in the group attachments dir', async () => {
      await withChannel(makeOpts(), async (_ch, baseUrl) => {
        const content = 'hello world';
        const dataBase64 = Buffer.from(content, 'utf8').toString('base64');
        const res = await fetch(`${baseUrl}/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filename: 'note.txt',
            mime: 'text/plain',
            dataBase64,
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { url: string; filename: string };
        expect(body.url).toMatch(/^\/workspace\/group\/attachments\/[a-f0-9]{8}_note\.txt$/);
        expect(body.filename).toMatch(/^[a-f0-9]{8}_note\.txt$/);

        // Verify the file actually landed on disk
        const localPath = path.join(
          '/tmp/mc-chat-test/main/attachments',
          body.filename,
        );
        expect(fs.existsSync(localPath)).toBe(true);
        expect(fs.readFileSync(localPath, 'utf8')).toBe(content);
      });
    });

    it('sanitizes path-traversal filenames', async () => {
      await withChannel(makeOpts(), async (_ch, baseUrl) => {
        const res = await fetch(`${baseUrl}/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filename: '../../../etc/passwd',
            dataBase64: Buffer.from('x').toString('base64'),
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { filename: string };
        expect(body.filename).not.toContain('..');
        expect(body.filename).not.toContain('/');
      });
    });

    it('rejects missing fields', async () => {
      await withChannel(makeOpts(), async (_ch, baseUrl) => {
        const res = await fetch(`${baseUrl}/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ filename: 'x.txt' }),
        });
        expect(res.status).toBe(400);
      });
    });
  });

  describe('lifecycle', () => {
    it('isConnected reflects server state', async () => {
      const channel = new McChatChannel(SECRET, 0, makeOpts());
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect drains pending SSE responses with an error event', async () => {
      const onMessage = vi.fn();
      const opts = makeOpts({ onMessage });
      const channel = new McChatChannel(SECRET, 0, opts);
      await channel.connect();
      // @ts-expect-error — private server
      const addr = channel.server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const pending = fetch(`${baseUrl}/chat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ conversationId: 'c1', message: 'hi' }),
      });
      await waitFor(() => onMessage.mock.calls.length > 0, 2000);

      await channel.disconnect();
      const res = await pending;
      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('channel shutting down');
    });
  });
});

// --- helpers ---

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

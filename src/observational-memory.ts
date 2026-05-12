/**
 * Observational Memory (v1)
 *
 * After each successful agent run, compress the new conversation turns into
 * a small set of dated factual observations and append them to the group's
 * `observations.md`. The next session imports that file via `@observations.md`
 * in CLAUDE.md, giving the agent dense, time-aware recall without bloating the
 * raw conversation history.
 *
 * Pattern inspired by Mastra's Observational Memory: two background passes
 * (Observer + Reflector). v1 ships the Observer only. Reflector compaction
 * is a follow-up.
 *
 * Auth: shells out to the `claude` CLI in print mode. Reuses the user's
 * subscription OAuth (same surface Claude Code itself uses) — no API key
 * required.
 *
 * Cost: ~1 short Haiku call per conversation. Default-off via the
 * OBSERVATIONAL_MEMORY env flag. Fire-and-forget — never blocks the response.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  OBSERVATIONAL_MEMORY_MIN_MESSAGES,
  OBSERVATIONAL_MEMORY_MODEL,
  OBSERVATIONAL_MEMORY_TIMEOUT_MS,
} from './config.js';
import { getMessagesSince } from './db.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

const OBSERVATIONS_FILE = 'observations.md';
const STATE_FILE = '.observation-state.json';
const MAX_MESSAGES_PER_OBSERVATION = 50;

interface ObservationState {
  lastObservedTimestamp: string;
}

function readState(folderPath: string): ObservationState {
  const statePath = path.join(folderPath, STATE_FILE);
  if (!fs.existsSync(statePath)) {
    return { lastObservedTimestamp: '' };
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ObservationState>;
    return {
      lastObservedTimestamp: parsed.lastObservedTimestamp || '',
    };
    // Intentional catch-all: a corrupt state file should never crash the agent
    // loop. Fall back to a fresh state — the next pass will reseed from the
    // current message tail.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.warn(
      { folder: folderPath, err },
      'Failed to read observation state, starting fresh',
    );
    return { lastObservedTimestamp: '' };
  }
}

function writeState(folderPath: string, state: ObservationState): void {
  const statePath = path.join(folderPath, STATE_FILE);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Render the new conversation turns into a compact transcript the Observer
 * model can compress. Bot messages are tagged separately so the model knows
 * which side is the assistant.
 */
export function formatTranscript(messages: NewMessage[]): string {
  return messages
    .map((m) => {
      const who = m.is_from_me
        ? 'assistant'
        : m.sender_name || m.sender || 'user';
      const content = (m.content || '').trim().replace(/\s+/g, ' ');
      return `[${m.timestamp}] ${who}: ${content}`;
    })
    .join('\n');
}

/**
 * Build the prompt the Observer sends to the model. Kept short, low-temperature
 * task: extract durable facts, not opinions or rephrasings.
 */
export function buildObserverPrompt(transcript: string): string {
  return [
    'You are an observation extractor. Read the conversation transcript below',
    'and write a short list of DURABLE FACTS worth remembering for future',
    'conversations with this user or group.',
    '',
    'Rules:',
    '- Output 3–10 bullet observations. Skip if nothing is worth remembering.',
    '- Focus on stable facts: preferences, decisions, identities, ongoing',
    '  projects, things the user owns / works on, dates and commitments.',
    '- Skip filler, chitchat, model meta-commentary, and one-shot questions.',
    '- One fact per bullet. Past tense. No quotes. No fluff.',
    '- If a fact updates an earlier one (e.g. project renamed), say so',
    '  explicitly: "Project X renamed to Y."',
    '- If nothing is worth recording, output exactly: NONE',
    '',
    'Format: plain markdown bullets, one per line, starting with "- ".',
    '',
    'Transcript:',
    transcript,
  ].join('\n');
}

/**
 * Parse the model's response into a clean array of bullet observations.
 * Defensive: drops anything that isn't a "- " bullet, normalizes whitespace.
 */
export function parseObservations(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'NONE') return [];
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^-\s+/, '').trim())
    .filter((line) => line.length > 0);
}

function appendObservations(
  folderPath: string,
  observations: string[],
  range: { from: string; to: string },
): void {
  if (observations.length === 0) return;
  const filePath = path.join(folderPath, OBSERVATIONS_FILE);
  const header = !fs.existsSync(filePath)
    ? `# Observations\n\nCompressed factual recall, appended automatically after each conversation.\nMost recent at the bottom. Hand-edit freely — Reflector pass (v2) will preserve manual edits.\n\n`
    : '';
  const ts = new Date().toISOString();
  const block =
    `\n## ${ts}\n` +
    `_From conversation turns ${range.from} → ${range.to}_\n\n` +
    observations.map((o) => `- ${o}`).join('\n') +
    '\n';
  fs.appendFileSync(filePath, header + block);
}

/**
 * Spawn `claude --print -p <prompt> --model <model> --output-format text`
 * and return stdout. Resolves with `null` on timeout, non-zero exit, or
 * missing CLI — caller logs and moves on (this is fire-and-forget).
 */
async function callClaude(
  prompt: string,
  model: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const proc = spawn(
      'claude',
      ['--print', '--model', model, '--output-format', 'text'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
        // proc may have already exited between the timeout firing and the
        // kill call; that's the desired post-condition, so swallow.
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch {
        /* already exited */
      }
      logger.warn(
        { model, timeoutMs: OBSERVATIONAL_MEMORY_TIMEOUT_MS },
        'Observer call timed out',
      );
      resolve(null);
    }, OBSERVATIONAL_MEMORY_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT: claude CLI not installed on host. Log once at warn so the user
      // knows the feature is enabled but can't run, then resolve null.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Observer spawn failed (is the `claude` CLI installed on the host?)',
      );
      resolve(null);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn(
          { code, stderr: stderr.slice(-500) },
          'Observer call exited non-zero',
        );
        resolve(null);
        return;
      }
      resolve(stdout);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export interface ObserveOptions {
  /** Override the model (defaults to OBSERVATIONAL_MEMORY_MODEL env). */
  model?: string;
  /**
   * Override the spawn function (for tests). Receives the prompt + model and
   * returns the same shape as `callClaude`.
   */
  call?: (prompt: string, model: string) => Promise<string | null>;
  /** Override the messages source (for tests). */
  fetchMessages?: (chatJid: string, sinceTimestamp: string) => NewMessage[];
}

/**
 * Run a single Observer pass for a group. Reads new messages since the last
 * observation, asks the model for a compressed observation set, appends to
 * observations.md, advances the state marker.
 *
 * Returns the count of observations recorded, or 0 if skipped.
 *
 * Errors never throw — they log and resolve 0. Caller fires-and-forgets.
 */
export async function observeConversation(
  groupFolder: string,
  chatJid: string,
  options: ObserveOptions = {},
): Promise<number> {
  // Note: the feature flag (OBSERVATIONAL_MEMORY_ENABLED) is checked at the
  // call site (src/index.ts) so this function stays pure and testable. Direct
  // callers are responsible for honoring the flag.
  const folderPath = path.join(GROUPS_DIR, groupFolder);
  if (!fs.existsSync(folderPath)) {
    logger.warn({ groupFolder }, 'Observer: group folder missing, skipping');
    return 0;
  }

  const state = readState(folderPath);
  const since = state.lastObservedTimestamp;

  // Bot prefix matches the legacy filter used elsewhere in db.ts. We don't
  // want bot-authored echo lines in the transcript we summarize.
  const fetchMessages =
    options.fetchMessages ||
    ((jid: string, ts: string) =>
      getMessagesSince(jid, ts, 'bot', MAX_MESSAGES_PER_OBSERVATION));

  const messages = fetchMessages(chatJid, since);

  if (messages.length < OBSERVATIONAL_MEMORY_MIN_MESSAGES) {
    logger.debug(
      {
        groupFolder,
        count: messages.length,
        min: OBSERVATIONAL_MEMORY_MIN_MESSAGES,
      },
      'Observer: too few new messages, skipping',
    );
    return 0;
  }

  const transcript = formatTranscript(messages);
  const prompt = buildObserverPrompt(transcript);
  const model = options.model || OBSERVATIONAL_MEMORY_MODEL;

  const call = options.call || callClaude;
  const raw = await call(prompt, model);
  if (raw === null) {
    // CLI failure already logged inside callClaude. Don't advance state so
    // the next run retries this same window.
    return 0;
  }

  const observations = parseObservations(raw);
  const newestTs = messages[messages.length - 1].timestamp;

  if (observations.length > 0) {
    appendObservations(folderPath, observations, {
      from: messages[0].timestamp,
      to: newestTs,
    });
    logger.info(
      { groupFolder, observations: observations.length, range: newestTs },
      'Observer: appended observations',
    );
  } else {
    logger.debug(
      { groupFolder, range: newestTs },
      'Observer: no durable facts in this window',
    );
  }

  // Advance state even when no observations were recorded — the model
  // intentionally said NONE for this window, no point re-asking.
  writeState(folderPath, { lastObservedTimestamp: newestTs });
  return observations.length;
}

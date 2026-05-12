import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  buildObserverPrompt,
  formatTranscript,
  observeConversation,
  parseObservations,
} from './observational-memory.js';
import { NewMessage } from './types.js';

// --- pure helpers ----------------------------------------------------------

describe('formatTranscript', () => {
  it('renders bot messages as "assistant" and tags humans by sender_name', () => {
    const msgs: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'g',
        sender: 'pete',
        sender_name: 'Pete',
        content: 'hi',
        timestamp: '2026-05-12T10:00:00Z',
        is_from_me: false,
      },
      {
        id: '2',
        chat_jid: 'g',
        sender: 'bot',
        sender_name: 'Andy',
        content: 'hello back',
        timestamp: '2026-05-12T10:00:05Z',
        is_from_me: true,
      },
    ];
    const out = formatTranscript(msgs);
    expect(out).toContain('Pete: hi');
    expect(out).toContain('assistant: hello back');
    expect(out).toContain('[2026-05-12T10:00:00Z]');
  });

  it('collapses internal whitespace and trims', () => {
    const msgs: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'g',
        sender: 'pete',
        sender_name: 'Pete',
        content: '  line   one\n\n   line two   ',
        timestamp: '2026-05-12T10:00:00Z',
      },
    ];
    expect(formatTranscript(msgs)).toContain('Pete: line one line two');
  });

  it('falls back to sender id when sender_name is missing', () => {
    const msgs: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'g',
        sender: 'pete',
        sender_name: '',
        content: 'hi',
        timestamp: '2026-05-12T10:00:00Z',
      },
    ];
    expect(formatTranscript(msgs)).toContain('pete: hi');
  });
});

describe('buildObserverPrompt', () => {
  it('includes the transcript and the NONE escape hatch', () => {
    const p = buildObserverPrompt('Pete: hi\nAndy: hello');
    expect(p).toContain('Pete: hi');
    expect(p).toContain('NONE');
    expect(p).toContain('DURABLE FACTS');
  });
});

describe('parseObservations', () => {
  it('returns empty array on NONE', () => {
    expect(parseObservations('NONE')).toEqual([]);
    expect(parseObservations('  NONE  ')).toEqual([]);
  });

  it('extracts bullet lines', () => {
    const raw = `- Pete prefers gold-on-teal branding\n- Juvenis launched videos.html on 2026-05-10\n- Skipped issue #35`;
    expect(parseObservations(raw)).toEqual([
      'Pete prefers gold-on-teal branding',
      'Juvenis launched videos.html on 2026-05-10',
      'Skipped issue #35',
    ]);
  });

  it('ignores non-bullet prose and blank lines, keeps indented bullets', () => {
    const raw = `Here are some facts:\n\n- Fact A\n  - Indented sub-bullet\n- Fact B\n\nDone.`;
    // Indented bullets are treated as additional facts after trimming whitespace
    // — that matches how LLMs sometimes structure nested observations.
    expect(parseObservations(raw)).toEqual([
      'Fact A',
      'Indented sub-bullet',
      'Fact B',
    ]);
  });

  it('handles empty input', () => {
    expect(parseObservations('')).toEqual([]);
    expect(parseObservations('   ')).toEqual([]);
  });
});

// --- observeConversation integration --------------------------------------

const TEST_GROUP = 'test_observational_memory';
const TEST_DIR = path.join(GROUPS_DIR, TEST_GROUP);

function makeMessage(partial: Partial<NewMessage>): NewMessage {
  return {
    id: 'id',
    chat_jid: 'jid',
    sender: 'pete',
    sender_name: 'Pete',
    content: 'hello',
    timestamp: '2026-05-12T10:00:00Z',
    is_from_me: false,
    ...partial,
  };
}

describe('observeConversation', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns 0 and does nothing when there are too few messages', async () => {
    const messages: NewMessage[] = [makeMessage({ id: '1' })];
    let called = false;
    const result = await observeConversation(TEST_GROUP, 'jid', {
      fetchMessages: () => messages,
      call: async () => {
        called = true;
        return '- Should not be called';
      },
    });
    expect(result).toBe(0);
    expect(called).toBe(false);
    expect(fs.existsSync(path.join(TEST_DIR, 'observations.md'))).toBe(false);
  });

  it('writes observations.md and advances state on success', async () => {
    const messages: NewMessage[] = [
      makeMessage({ id: '1', timestamp: '2026-05-12T10:00:00Z' }),
      makeMessage({
        id: '2',
        timestamp: '2026-05-12T10:00:05Z',
        sender_name: 'Andy',
        is_from_me: true,
        content: 'ok',
      }),
      makeMessage({
        id: '3',
        timestamp: '2026-05-12T10:01:00Z',
        content: 'cool',
      }),
    ];

    const result = await observeConversation(TEST_GROUP, 'jid', {
      fetchMessages: () => messages,
      call: async () =>
        `- Pete asked about videos\n- Andy responded with ok\n- Pete confirmed cool`,
    });

    expect(result).toBe(3);

    const obsFile = path.join(TEST_DIR, 'observations.md');
    expect(fs.existsSync(obsFile)).toBe(true);
    const body = fs.readFileSync(obsFile, 'utf-8');
    expect(body).toContain('# Observations');
    expect(body).toContain('Pete asked about videos');
    expect(body).toContain('2026-05-12T10:00:00Z → 2026-05-12T10:01:00Z');

    const statePath = path.join(TEST_DIR, '.observation-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(state.lastObservedTimestamp).toBe('2026-05-12T10:01:00Z');
  });

  it('does not append on NONE but still advances state', async () => {
    const messages: NewMessage[] = [
      makeMessage({ id: '1', timestamp: '2026-05-12T10:00:00Z' }),
      makeMessage({ id: '2', timestamp: '2026-05-12T10:00:05Z' }),
      makeMessage({ id: '3', timestamp: '2026-05-12T10:01:00Z' }),
    ];

    const result = await observeConversation(TEST_GROUP, 'jid', {
      fetchMessages: () => messages,
      call: async () => 'NONE',
    });

    expect(result).toBe(0);
    expect(fs.existsSync(path.join(TEST_DIR, 'observations.md'))).toBe(false);
    const state = JSON.parse(
      fs.readFileSync(path.join(TEST_DIR, '.observation-state.json'), 'utf-8'),
    );
    expect(state.lastObservedTimestamp).toBe('2026-05-12T10:01:00Z');
  });

  it('does not advance state on CLI failure (so next run retries)', async () => {
    const messages: NewMessage[] = [
      makeMessage({ id: '1', timestamp: '2026-05-12T10:00:00Z' }),
      makeMessage({ id: '2', timestamp: '2026-05-12T10:00:05Z' }),
      makeMessage({ id: '3', timestamp: '2026-05-12T10:01:00Z' }),
    ];

    const result = await observeConversation(TEST_GROUP, 'jid', {
      fetchMessages: () => messages,
      call: async () => null, // simulates CLI failure
    });

    expect(result).toBe(0);
    expect(fs.existsSync(path.join(TEST_DIR, '.observation-state.json'))).toBe(
      false,
    );
  });

  it('uses last observed timestamp on the second pass', async () => {
    const all: NewMessage[] = [
      makeMessage({ id: '1', timestamp: '2026-05-12T10:00:00Z' }),
      makeMessage({ id: '2', timestamp: '2026-05-12T10:00:05Z' }),
      makeMessage({ id: '3', timestamp: '2026-05-12T10:01:00Z' }),
    ];

    // First pass — observe all 3.
    await observeConversation(TEST_GROUP, 'jid', {
      fetchMessages: () => all,
      call: async () => '- First batch',
    });

    // Second pass — fetchMessages should be called with the state ts.
    let receivedSince = '';
    const newer: NewMessage[] = [
      makeMessage({ id: '4', timestamp: '2026-05-12T11:00:00Z' }),
      makeMessage({ id: '5', timestamp: '2026-05-12T11:00:10Z' }),
      makeMessage({ id: '6', timestamp: '2026-05-12T11:00:20Z' }),
    ];
    await observeConversation(TEST_GROUP, 'jid', {
      fetchMessages: (_jid, since) => {
        receivedSince = since;
        return newer;
      },
      call: async () => '- Second batch',
    });

    expect(receivedSince).toBe('2026-05-12T10:01:00Z');

    // observations.md should contain both batches.
    const body = fs.readFileSync(
      path.join(TEST_DIR, 'observations.md'),
      'utf-8',
    );
    expect(body).toContain('First batch');
    expect(body).toContain('Second batch');
  });

  it('returns 0 when group folder does not exist', async () => {
    const result = await observeConversation('definitely_not_a_group', 'jid', {
      fetchMessages: () => [
        makeMessage({ id: '1', timestamp: '2026-05-12T10:00:00Z' }),
        makeMessage({ id: '2', timestamp: '2026-05-12T10:00:05Z' }),
        makeMessage({ id: '3', timestamp: '2026-05-12T10:01:00Z' }),
      ],
      call: async () => '- should not run',
    });
    expect(result).toBe(0);
  });
});

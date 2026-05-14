import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  getMessagesSince,
  storeChatMetadata,
} from './db.js';
import {
  getAvailableGroups,
  _setRegisteredGroups,
  _onInboundForTest,
  _getRecentSourceJid,
  _resetRecentSourceJid,
  _setChannelsForTest,
} from './index.js';
import type { Channel, NewMessage } from './types.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
  _resetRecentSourceJid();
  _setChannelsForTest([]);
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'group1@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'whatsapp',
      false,
    );
    storeChatMetadata(
      'group2@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'reg@g.us',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'unreg@g.us',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'whatsapp',
      true,
    );

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'old@g.us',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'new@g.us',
      '2024-01-01T00:00:05.000Z',
      'New',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'mid@g.us',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// --- Unified channel mirror: inbound rewrite + fan-out ---

/**
 * Test stub channel. Records every sendMessage call so tests can assert what
 * the orchestrator dispatched. Use one stub per channel name + ownership glob.
 */
function makeStubChannel(opts: {
  name: string;
  ownsPredicate: (jid: string) => boolean;
}): Channel & { sent: Array<{ jid: string; text: string }> } {
  const sent: Array<{ jid: string; text: string }> = [];
  return {
    name: opts.name,
    sent,
    connect: async () => undefined,
    disconnect: async () => undefined,
    isConnected: () => true,
    ownsJid: (jid: string) => opts.ownsPredicate(jid),
    sendMessage: async (jid: string, text: string) => {
      sent.push({ jid, text });
    },
  };
}

function mkMsg(chatJid: string, overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
    chat_jid: chatJid,
    sender: overrides.sender ?? 'peter',
    sender_name: overrides.sender_name ?? 'Peter',
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? '2025-01-01T00:00:01.000Z',
    is_from_me: overrides.is_from_me ?? false,
    is_bot_message: overrides.is_bot_message ?? false,
    ...overrides,
  };
}

describe('unified channel mirror — inbound rewrite', () => {
  it('rewrites chat_jid to primary when arriving on a subscriber JID', () => {
    _setRegisteredGroups({
      'tg:1': {
        name: 'Unified',
        folder: 'telegram_unified',
        trigger: '@Andy',
        added_at: '2025-01-01T00:00:00.000Z',
        subscriberJids: ['mc-chat:dashboard'],
      },
    });
    storeChatMetadata('tg:1', '2025-01-01T00:00:00.000Z');

    _onInboundForTest(
      'mc-chat:dashboard',
      mkMsg('mc-chat:dashboard', {
        id: 'inb-1',
        content: 'remember Otis',
      }),
    );

    const stored = getMessagesSince('tg:1', '', 'Andy');
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('inb-1');
    expect(stored[0].chat_jid).toBe('tg:1');

    // Source tracking is updated so the next agent reply dispatches to the
    // channel the user actually used.
    expect(_getRecentSourceJid('tg:1')).toBe('mc-chat:dashboard');
  });

  it('leaves chat_jid unchanged for inbound on the primary JID', () => {
    _setRegisteredGroups({
      'tg:2': {
        name: 'Unified',
        folder: 'telegram_unified2',
        trigger: '@Andy',
        added_at: '2025-01-01T00:00:00.000Z',
        subscriberJids: ['mc-chat:dashboard'],
      },
    });
    storeChatMetadata('tg:2', '2025-01-01T00:00:00.000Z');

    _onInboundForTest(
      'tg:2',
      mkMsg('tg:2', { id: 'inb-2', content: 'hi from tg' }),
    );

    const stored = getMessagesSince('tg:2', '', 'Andy');
    expect(stored).toHaveLength(1);
    expect(stored[0].chat_jid).toBe('tg:2');
    expect(_getRecentSourceJid('tg:2')).toBe('tg:2');
  });

  it('does not rewrite when the JID belongs to no registered group', () => {
    _setRegisteredGroups({});
    storeChatMetadata('tg:unrelated', '2025-01-01T00:00:00.000Z');

    _onInboundForTest(
      'tg:unrelated',
      mkMsg('tg:unrelated', { id: 'inb-3' }),
    );

    // The message is still stored (storeMessage doesn't care about groups),
    // but no rewrite happened. No source is tracked because no group exists.
    const stored = getMessagesSince('tg:unrelated', '', 'Andy');
    expect(stored).toHaveLength(1);
    expect(stored[0].chat_jid).toBe('tg:unrelated');
    expect(_getRecentSourceJid('tg:unrelated')).toBeUndefined();
  });
});

describe('unified channel mirror — fan-out', () => {
  it('mirrors inbound from subscriber to primary with the friendly prefix', async () => {
    const tg = makeStubChannel({
      name: 'telegram',
      ownsPredicate: (jid) => jid.startsWith('tg:'),
    });
    const mc = makeStubChannel({
      name: 'mc-chat',
      ownsPredicate: (jid) => jid.startsWith('mc-chat:'),
    });
    _setChannelsForTest([tg, mc]);

    _setRegisteredGroups({
      'tg:3': {
        name: 'Unified',
        folder: 'telegram_unified3',
        trigger: '@Andy',
        added_at: '2025-01-01T00:00:00.000Z',
        subscriberJids: ['mc-chat:dashboard'],
      },
    });
    storeChatMetadata('tg:3', '2025-01-01T00:00:00.000Z');

    _onInboundForTest(
      'mc-chat:dashboard',
      mkMsg('mc-chat:dashboard', { id: 'inb-fanout', content: 'remember Otis' }),
    );

    // mirrorSend is fire-and-forget; allow microtasks to flush.
    await new Promise((r) => setImmediate(r));

    // Inbound arrived via mc-chat → mirror lands in Telegram with the
    // "📥 [Mission Control]" prefix.
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].jid).toBe('tg:3');
    expect(tg.sent[0].text).toBe('📥 [Mission Control]\nremember Otis');
    // The source channel (mc-chat) does NOT receive its own mirror back.
    expect(mc.sent).toHaveLength(0);
  });

  it('mirrors Telegram inbound to mc-chat with the [Telegram] prefix', async () => {
    const tg = makeStubChannel({
      name: 'telegram',
      ownsPredicate: (jid) => jid.startsWith('tg:'),
    });
    const mc = makeStubChannel({
      name: 'mc-chat',
      ownsPredicate: (jid) => jid.startsWith('mc-chat:'),
    });
    _setChannelsForTest([tg, mc]);

    _setRegisteredGroups({
      'tg:4': {
        name: 'Unified',
        folder: 'telegram_unified4',
        trigger: '@Andy',
        added_at: '2025-01-01T00:00:00.000Z',
        subscriberJids: ['mc-chat:dashboard'],
      },
    });
    storeChatMetadata('tg:4', '2025-01-01T00:00:00.000Z');

    _onInboundForTest(
      'tg:4',
      mkMsg('tg:4', { id: 'inb-fanout-2', content: 'oat flat white' }),
    );

    await new Promise((r) => setImmediate(r));

    expect(mc.sent).toHaveLength(1);
    expect(mc.sent[0].jid).toBe('mc-chat:dashboard');
    expect(mc.sent[0].text).toBe('📥 [Telegram]\noat flat white');
    expect(tg.sent).toHaveLength(0);
  });

  it('does not fan-out when there are no subscribers', async () => {
    const tg = makeStubChannel({
      name: 'telegram',
      ownsPredicate: (jid) => jid.startsWith('tg:'),
    });
    _setChannelsForTest([tg]);

    _setRegisteredGroups({
      'tg:5': {
        name: 'Solo Telegram',
        folder: 'telegram_solo3',
        trigger: '@Andy',
        added_at: '2025-01-01T00:00:00.000Z',
        // no subscriberJids
      },
    });
    storeChatMetadata('tg:5', '2025-01-01T00:00:00.000Z');

    _onInboundForTest('tg:5', mkMsg('tg:5', { id: 'solo-1' }));
    await new Promise((r) => setImmediate(r));

    expect(tg.sent).toHaveLength(0); // no mirror sends (source is the only JID)
  });

  it('does not fan-out is_from_me or is_bot_message inbounds (avoids echo loops)', async () => {
    const tg = makeStubChannel({
      name: 'telegram',
      ownsPredicate: (jid) => jid.startsWith('tg:'),
    });
    const mc = makeStubChannel({
      name: 'mc-chat',
      ownsPredicate: (jid) => jid.startsWith('mc-chat:'),
    });
    _setChannelsForTest([tg, mc]);

    _setRegisteredGroups({
      'tg:6': {
        name: 'Unified',
        folder: 'telegram_unified6',
        trigger: '@Andy',
        added_at: '2025-01-01T00:00:00.000Z',
        subscriberJids: ['mc-chat:dashboard'],
      },
    });
    storeChatMetadata('tg:6', '2025-01-01T00:00:00.000Z');

    _onInboundForTest(
      'tg:6',
      mkMsg('tg:6', { id: 'bot-1', is_bot_message: true, sender_name: 'Andy' }),
    );
    _onInboundForTest(
      'tg:6',
      mkMsg('tg:6', { id: 'me-1', is_from_me: true }),
    );
    await new Promise((r) => setImmediate(r));

    expect(mc.sent).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);
  });
});

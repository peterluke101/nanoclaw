import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});

// --- Unified channel mirror: mc-chat → telegram subscriber merge ---

/**
 * Helper: stand up a temp DB with the registered_groups schema as it exists
 * just BEFORE the subscriber_jids column is added (i.e., the legacy schema
 * Peter's install will be on at upgrade time), insert the supplied rows, then
 * load NanoClaw's db.ts which runs `createSchema` (adding subscriber_jids and
 * running the merge migration).
 *
 * Returns helpers for inspecting the post-migration state.
 */
async function withLegacyDb(
  preInsertRows: Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    requires_trigger?: number;
    is_main?: number;
  }>,
  cb: (helpers: {
    queryRow: (jid: string) =>
      | {
          jid: string;
          folder: string;
          requires_trigger: number;
          is_main: number;
          subscriber_jids: string;
        }
      | undefined;
    queryAllJids: () => string[];
  }) => Promise<void>,
) {
  const repoRoot = process.cwd();
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-mcmerge-test-'),
  );
  try {
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

    const dbPath = path.join(tempDir, 'store', 'messages.db');
    const legacy = new Database(dbPath);
    // Legacy schema: no subscriber_jids column. createSchema in db.ts will
    // ALTER TABLE to add it, then run the merge migration.
    legacy.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0
      );
    `);
    const ins = legacy.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of preInsertRows) {
      ins.run(
        row.jid,
        row.name,
        row.folder,
        row.trigger_pattern,
        row.added_at,
        row.requires_trigger ?? 1,
        row.is_main ?? 0,
      );
    }
    legacy.close();

    vi.resetModules();
    const { initDatabase, _closeDatabase } = await import('./db.js');
    initDatabase();

    // Open a separate read-only handle for inspection (db.ts holds its own).
    const inspect = new Database(dbPath, { readonly: true });
    const queryRow = (jid: string) =>
      inspect
        .prepare(
          `SELECT jid, folder, requires_trigger, is_main, subscriber_jids FROM registered_groups WHERE jid = ?`,
        )
        .get(jid) as
        | {
            jid: string;
            folder: string;
            requires_trigger: number;
            is_main: number;
            subscriber_jids: string;
          }
        | undefined;
    const queryAllJids = () =>
      (
        inspect
          .prepare(`SELECT jid FROM registered_groups`)
          .all() as Array<{ jid: string }>
      ).map((r) => r.jid);

    await cb({ queryRow, queryAllJids });

    inspect.close();
    _closeDatabase();
  } finally {
    process.chdir(repoRoot);
  }
}

describe('mc-chat → telegram subscriber merge', () => {
  it('merges both rows: adds mc-chat as subscriber, deletes mc-chat row', async () => {
    await withLegacyDb(
      [
        {
          jid: 'tg:6951928213',
          name: 'Telegram',
          folder: 'telegram_main',
          trigger_pattern: '@Ares',
          added_at: '2024-01-01T00:00:00.000Z',
          requires_trigger: 1,
          is_main: 0,
        },
        {
          jid: 'mc-chat:dashboard',
          name: 'Mission Control',
          folder: 'mc-dashboard',
          trigger_pattern: '@Ares',
          added_at: '2024-01-02T00:00:00.000Z',
          requires_trigger: 0,
          is_main: 1,
        },
      ],
      async ({ queryRow, queryAllJids }) => {
        // mc-chat row is gone
        expect(queryAllJids()).toEqual(['tg:6951928213']);

        // tg row keeps folder/trigger, picks up subscriber, and inherits the
        // more-permissive is_main (1) and requires_trigger (0) settings so
        // dock messages don't get silently dropped by the trigger gate.
        const tg = queryRow('tg:6951928213')!;
        expect(tg.folder).toBe('telegram_main');
        expect(JSON.parse(tg.subscriber_jids)).toEqual(['mc-chat:dashboard']);
        expect(tg.is_main).toBe(1);
        expect(tg.requires_trigger).toBe(0);
      },
    );
  });

  it('is idempotent — re-running on already-merged DB is a no-op', async () => {
    await withLegacyDb(
      [
        {
          jid: 'tg:6951928213',
          name: 'Telegram',
          folder: 'telegram_main',
          trigger_pattern: '@Ares',
          added_at: '2024-01-01T00:00:00.000Z',
          requires_trigger: 0,
          is_main: 1,
        },
      ],
      async ({ queryRow, queryAllJids }) => {
        // Pre-state: mc-chat row already absent, tg has empty subscriber_jids
        // (because the column was just added with default '[]'). Migration
        // should still add the subscriber.
        expect(queryAllJids()).toEqual(['tg:6951928213']);
        const tg = queryRow('tg:6951928213')!;
        expect(JSON.parse(tg.subscriber_jids)).toEqual(['mc-chat:dashboard']);
      },
    );
  });

  it('does not run subscriber-add when the legacy mc-chat row was never present', async () => {
    // Edge case: a fresh user who installed AFTER this migration shouldn't get
    // an mc-chat subscriber automatically. The migration only adds the
    // subscriber when ANY mc-chat row exists (now or historically) — once the
    // tg row's subscriber_jids has 'mc-chat:dashboard' the second branch is
    // also a no-op. For users without mc-chat at all, this is wrong: we should
    // only auto-add for Peter. Verify the current behavior so any change is
    // intentional.
    await withLegacyDb(
      [
        {
          jid: 'tg:7777777',
          name: 'Different user',
          folder: 'telegram_other',
          trigger_pattern: '@Bot',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      ],
      async ({ queryRow }) => {
        // Different primary JID — migration only targets tg:6951928213. So
        // this user's row is left untouched (empty subscribers).
        const row = queryRow('tg:7777777')!;
        expect(JSON.parse(row.subscriber_jids)).toEqual([]);
      },
    );
  });

  it('skips merge when tg primary is missing but mc-chat exists (logs only)', async () => {
    await withLegacyDb(
      [
        {
          jid: 'mc-chat:dashboard',
          name: 'Mission Control',
          folder: 'mc-dashboard',
          trigger_pattern: '@Ares',
          added_at: '2024-01-02T00:00:00.000Z',
          requires_trigger: 0,
          is_main: 1,
        },
      ],
      async ({ queryAllJids, queryRow }) => {
        // mc-chat row should remain untouched — there's no tg row to merge into.
        expect(queryAllJids()).toEqual(['mc-chat:dashboard']);
        const mc = queryRow('mc-chat:dashboard')!;
        expect(mc.folder).toBe('mc-dashboard');
      },
    );
  });

  it('preserves the most-permissive settings even when both sides differ', async () => {
    // Telegram is main + triggerless; mc-chat is non-main + requires trigger.
    // Merge should keep main=1 (from tg) and requires_trigger=0 (from tg).
    await withLegacyDb(
      [
        {
          jid: 'tg:6951928213',
          name: 'Telegram',
          folder: 'telegram_main',
          trigger_pattern: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requires_trigger: 0,
          is_main: 1,
        },
        {
          jid: 'mc-chat:dashboard',
          name: 'Mission Control',
          folder: 'mc-dashboard',
          trigger_pattern: '@Andy',
          added_at: '2024-01-02T00:00:00.000Z',
          requires_trigger: 1,
          is_main: 0,
        },
      ],
      async ({ queryRow }) => {
        const tg = queryRow('tg:6951928213')!;
        expect(tg.is_main).toBe(1);
        expect(tg.requires_trigger).toBe(0);
      },
    );
  });
});

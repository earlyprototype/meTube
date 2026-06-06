/**
 * Wave 1 database tests.
 *
 * Exercises the `DatabaseManager` public API surface against `:memory:`
 * SQLite — no mocking, real DDL, real transactions, real branded IDs.
 *
 * Coverage:
 *   1. Schema bootstrap — every expected table exists after construction.
 *   2. `withTransaction<T>()` rollback — throw inside the callback leaves
 *      the DB unmodified (no committed rows).
 *   3. `withTransaction<T>()` happy path — committed rows are visible to
 *      subsequent reads.
 *   4. Branded ID round-trip — insert via `asVideoId`, read back via
 *      `prepare(...).get()`, parse via `VideoRowSchema`, re-brand via
 *      `asVideoId`. End-to-end pattern for repository code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../database/connection.js';
import { EXPECTED_TABLES } from '../database/schema.js';
import { asVideoId } from '../types/index.js';
import { VideoRowSchema, type VideoRow } from '../schemas/db.js';

/**
 * Per-test row shape from `SELECT name FROM sqlite_master`. Declared
 * separately so the prepared-statement generic type stays narrow.
 */
interface SqliteMasterTableRow {
  name: string;
}

describe('DatabaseManager — schema bootstrap', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    // Arrange — fresh in-memory DB per test so state never leaks
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('creates every expected table after construction', () => {
    // Act
    const rows = dbm
      .prepare<
        [],
        SqliteMasterTableRow
      >("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    const names = rows.map((r) => r.name);

    // Assert — every name in EXPECTED_TABLES must be present
    for (const expected of EXPECTED_TABLES) {
      expect(names).toContain(expected);
    }
  });

  it('seeds the schema_version row at construction time', () => {
    // Act
    const row = dbm
      .prepare<[], { version: number }>('SELECT version FROM schema_version LIMIT 1')
      .get();

    // Assert
    expect(row?.version).toBe(1);
  });

  it('reports the database path', () => {
    // Act + Assert
    expect(dbm.getPath()).toBe(':memory:');
    expect(dbm.isOpen()).toBe(true);
  });
});

describe('DatabaseManager.withTransaction — rollback', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('rolls back all writes when the callback throws', () => {
    // Arrange — sentinel error type so we know exactly which throw triggered the rollback
    class TestRollbackError extends Error {}

    // Act + Assert — the inserted row must not be visible after the throw
    expect(() =>
      dbm.withTransaction((db) => {
        db.prepare(
          `INSERT INTO videos (video_id, title, channel_id, channel_title, published_at, duration, duration_seconds, is_short)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          'dQw4w9WgXcQ',
          'will be rolled back',
          'UCxxxx',
          'ch',
          '2024-01-01T00:00:00Z',
          'PT1S',
          1,
          0
        );
        throw new TestRollbackError('boom');
      })
    ).toThrow();

    const count = dbm.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM videos').get();
    expect(count?.c).toBe(0);
  });
});

describe('DatabaseManager.withTransaction — happy path', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('commits writes performed inside the callback', () => {
    // Arrange — insert a single video
    dbm.withTransaction((db) => {
      db.prepare(
        `INSERT INTO videos (video_id, title, channel_id, channel_title, published_at, duration, duration_seconds, is_short)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('dQw4w9WgXcQ', 'committed', 'UCxxxx', 'ch', '2024-01-01T00:00:00Z', 'PT3M33S', 213, 0);
    });

    // Act
    const row = dbm
      .prepare<
        [string],
        { video_id: string; title: string }
      >('SELECT video_id, title FROM videos WHERE video_id = ?')
      .get('dQw4w9WgXcQ');

    // Assert
    expect(row?.title).toBe('committed');
  });

  it('returns the callback return value to the caller', () => {
    // Arrange + Act
    const insertedId = dbm.withTransaction((db) => {
      const info = db.prepare(`INSERT INTO tags (tag) VALUES (?)`).run('machine-learning');
      return info.lastInsertRowid;
    });

    // Assert
    expect(Number(insertedId)).toBeGreaterThan(0);
  });
});

describe('DatabaseManager — branded ID round-trip', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('inserts a row via asVideoId(...) and reads it back through VideoRowSchema + asVideoId', () => {
    // Arrange — branded id is the only path into the row
    const vid = asVideoId('dQw4w9WgXcQ');

    dbm.withTransaction((db) => {
      db.prepare(
        `INSERT INTO videos (video_id, title, channel_id, channel_title, published_at, duration, duration_seconds, is_short)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vid, 'round-trip', 'UCxxxx', 'ch', '2024-01-01T00:00:00Z', 'PT3M33S', 213, 0);
    });

    // Act — pull the raw row, validate via Zod, re-brand the id
    const raw = dbm.prepare<[string], unknown>('SELECT * FROM videos WHERE video_id = ?').get(vid);

    const parsed: VideoRow = VideoRowSchema.parse(raw);
    const rebranded = asVideoId(parsed.video_id);

    // Assert — branded type, persisted value, schema parse all line up
    expect(parsed.video_id).toBe('dQw4w9WgXcQ');
    expect(parsed.title).toBe('round-trip');
    expect(rebranded).toBe(vid);
  });
});

describe('DatabaseManager — close discipline', () => {
  it('throws when a prepare is attempted after close()', () => {
    // Arrange
    const dbm = new DatabaseManager(':memory:');
    dbm.close();

    // Act + Assert
    expect(() => dbm.prepare<[], unknown>('SELECT 1')).toThrow();
  });

  it('close() is idempotent', () => {
    // Arrange
    const dbm = new DatabaseManager(':memory:');

    // Act + Assert — calling twice must not throw
    dbm.close();
    expect(() => dbm.close()).not.toThrow();
  });
});

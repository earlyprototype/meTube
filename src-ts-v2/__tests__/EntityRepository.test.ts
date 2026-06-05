/**
 * EntityRepository tests — Wave 2.
 *
 * No mocks. Real `:memory:` SQLite, real DDL, real transactions, real
 * branded ids. AAA structure per test.
 *
 * Coverage focuses on the audit-flagged invariants:
 *
 *   1. Empty-batch insert is a no-op (zero rows, no transaction overhead).
 *   2. Bulk insertMany commits all entities in ONE transaction.
 *   3. Invalid `entity_type` aborts the *entire* batch (rollback) — zero
 *      rows for that video after the throw.
 *   4. Reads parse through `ExtractedEntityRowSchema` — corrupted rows
 *      surface as `DatabaseError` rather than typed-but-wrong data.
 *   5. `findByVideoIdAndType` filters at the SQL layer.
 *   6. `deleteByVideoId` returns the row count and clears the table.
 *   7. Confidence defaults to 100 when omitted (Python parity).
 *   8. `null` url is preserved (topics / people do not carry urls).
 *   9. Foreign-key cascade on `videos` row delete also clears entities.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../database/connection.js';
import { EntityRepository, type EntityInput } from '../database/EntityRepository.js';
import { ValidationError, DatabaseError } from '../errors/index.js';
import { asVideoId, type VideoId } from '../types/branded.js';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const VIDEO_A = 'dQw4w9WgXcQ';
const VIDEO_B = 'oHg5SJYRHA0';

/**
 * Insert a parent `videos` row so the foreign key on
 * `extracted_entities.video_id` does not block the entity inserts.
 */
function seedVideo(dbm: DatabaseManager, videoId: VideoId, title = 'seed'): void {
  dbm.withTransaction((db) => {
    db.prepare(
      `INSERT INTO videos (
         video_id, title, channel_id, channel_title,
         published_at, duration, duration_seconds, is_short
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(videoId, title, 'UCxxxx', 'ch', '2024-01-01T00:00:00Z', 'PT1M', 60, 0);
  });
}

const SAMPLE_BATCH: readonly EntityInput[] = Object.freeze([
  { type: 'topic', value: 'machine learning' },
  {
    type: 'github_repo',
    value: 'anthropic/claude-code',
    url: 'https://github.com/anthropic/claude-code',
    confidence: 95,
  },
  {
    type: 'website',
    value: 'anthropic.com',
    url: 'https://anthropic.com',
  },
  { type: 'person', value: 'Dario Amodei', confidence: 80 },
]);

// --------------------------------------------------------------------------
// insertMany — empty + happy paths
// --------------------------------------------------------------------------

describe('EntityRepository.insertMany — empty + happy path', () => {
  let dbm: DatabaseManager;
  let repo: EntityRepository;

  beforeEach(() => {
    // Arrange
    dbm = new DatabaseManager(':memory:');
    repo = new EntityRepository(dbm);
    seedVideo(dbm, asVideoId(VIDEO_A));
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns 0 and inserts nothing for an empty batch', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);

    // Act
    const inserted = repo.insertMany(videoId, []);

    // Assert
    expect(inserted).toBe(0);
    expect(repo.countByVideoId(videoId)).toBe(0);
  });

  it('inserts every entity of a batch in a single transaction', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);

    // Act
    const inserted = repo.insertMany(videoId, SAMPLE_BATCH);

    // Assert — every row visible after the single transaction
    expect(inserted).toBe(SAMPLE_BATCH.length);
    expect(repo.countByVideoId(videoId)).toBe(SAMPLE_BATCH.length);

    const rows = repo.findByVideoId(videoId);
    expect(rows.length).toBe(SAMPLE_BATCH.length);
    expect(rows.map((r) => r.entity_type)).toEqual(['topic', 'github_repo', 'website', 'person']);
    expect(rows.map((r) => r.entity_value)).toEqual([
      'machine learning',
      'anthropic/claude-code',
      'anthropic.com',
      'Dario Amodei',
    ]);
  });

  it('defaults missing confidence to 100 (Python parity)', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);
    const batch: EntityInput[] = [{ type: 'topic', value: 'no confidence supplied' }];

    // Act
    repo.insertMany(videoId, batch);

    // Assert
    const [row] = repo.findByVideoId(videoId);
    expect(row.confidence).toBe(100);
  });

  it('preserves a null url for entities that have no url field', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);
    const batch: EntityInput[] = [
      { type: 'topic', value: 'just a topic' },
      { type: 'person', value: 'a person', url: null },
    ];

    // Act
    repo.insertMany(videoId, batch);

    // Assert — both rows persist `entity_url IS NULL`
    const rows = repo.findByVideoId(videoId);
    expect(rows.length).toBe(2);
    expect(rows[0].entity_url).toBeNull();
    expect(rows[1].entity_url).toBeNull();
  });

  it('persists a non-null url verbatim for repos and websites', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);
    const batch: EntityInput[] = [
      {
        type: 'github_repo',
        value: 'foo/bar',
        url: 'https://github.com/foo/bar',
      },
    ];

    // Act
    repo.insertMany(videoId, batch);

    // Assert
    const [row] = repo.findByVideoId(videoId);
    expect(row.entity_url).toBe('https://github.com/foo/bar');
  });
});

// --------------------------------------------------------------------------
// insertMany — rollback discipline
// --------------------------------------------------------------------------

describe('EntityRepository.insertMany — rollback on invalid type', () => {
  let dbm: DatabaseManager;
  let repo: EntityRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new EntityRepository(dbm);
    seedVideo(dbm, asVideoId(VIDEO_A));
  });

  afterEach(() => {
    dbm.close();
  });

  it('throws and writes ZERO rows when a mid-batch entity has an invalid entity_type', () => {
    // Arrange — three valid entities, one poisoned in the middle, more after
    const videoId = asVideoId(VIDEO_A);
    const poisonedBatch: EntityInput[] = [
      { type: 'topic', value: 'good 1' },
      { type: 'github_repo', value: 'good/two', url: 'https://github.com/good/two' },
      // bad enum — string-typed input fails EntityTypeSchema inside the txn
      { type: 'not_a_real_type', value: 'will poison the batch' },
      { type: 'person', value: 'should never land' },
    ];

    // Act + Assert — the throw bubbles out of withTransaction; better-sqlite3 rolls back
    expect(() => repo.insertMany(videoId, poisonedBatch)).toThrow();

    // Assert — zero rows after the rollback, NOT the two that "succeeded"
    // before the poison entity. This is the audit-critical assertion.
    expect(repo.countByVideoId(videoId)).toBe(0);
    expect(repo.findByVideoId(videoId)).toEqual([]);
  });

  it('rolls back independently per video — a poisoned batch for B does not touch A', () => {
    // Arrange — both videos exist; A gets a clean insert, B gets poisoned
    const videoA = asVideoId(VIDEO_A);
    const videoB = asVideoId(VIDEO_B);
    seedVideo(dbm, videoB, 'video B');

    repo.insertMany(videoA, [{ type: 'topic', value: 'A clean' }]);
    expect(repo.countByVideoId(videoA)).toBe(1);

    const poisonedB: EntityInput[] = [
      { type: 'topic', value: 'B first' },
      { type: 'broken', value: 'poison' },
    ];

    // Act + Assert
    expect(() => repo.insertMany(videoB, poisonedB)).toThrow();

    // Assert — A intact, B empty
    expect(repo.countByVideoId(videoA)).toBe(1);
    expect(repo.countByVideoId(videoB)).toBe(0);
  });

  it('surfaces a ValidationError directly for invalid entity_type', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);

    // Act + Assert — validation runs BEFORE the transaction opens, so the
    // typed error reaches the caller without being wrapped in a generic
    // DatabaseError. No INSERT has happened, so rollback semantics are
    // trivially preserved.
    expect(() => repo.insertMany(videoId, [{ type: 'bogus', value: 'x' }])).toThrow(
      ValidationError
    );

    // Assert — DatabaseError reference is exported (used by the row-parse
    // failure test below); ensure linter retains the import path.
    expect(DatabaseError).toBeDefined();
  });

  it('rejects an EntityInput missing required fields with a ValidationError pre-transaction', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);
    // value missing — caught by shape-check BEFORE the transaction opens
    const broken = [{ type: 'topic' }] as unknown as EntityInput[];

    // Act + Assert
    expect(() => repo.insertMany(videoId, broken)).toThrow(ValidationError);
    expect(repo.countByVideoId(videoId)).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Confidence range validation — confidence is documented 0-100, enforced
// at the input boundary so out-of-range integers never reach the DB row.
// --------------------------------------------------------------------------

describe('EntityRepository — confidence range validation', () => {
  let dbm: DatabaseManager;
  let repo: EntityRepository;
  const videoId: VideoId = asVideoId(VIDEO_A);

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new EntityRepository(dbm);
    seedVideo(dbm, videoId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('rejects confidence above 100 with a ValidationError', () => {
    // Arrange
    const overshoot: EntityInput[] = [{ type: 'topic', value: 'too-confident', confidence: 150 }];

    // Act + Assert
    expect(() => repo.insertMany(videoId, overshoot)).toThrow(ValidationError);
    expect(repo.countByVideoId(videoId)).toBe(0);
  });

  it('rejects confidence below 0 with a ValidationError', () => {
    // Arrange
    const undershoot: EntityInput[] = [{ type: 'topic', value: 'negative', confidence: -1 }];

    // Act + Assert
    expect(() => repo.insertMany(videoId, undershoot)).toThrow(ValidationError);
    expect(repo.countByVideoId(videoId)).toBe(0);
  });

  it('accepts confidence at the lower boundary (0)', () => {
    // Arrange
    const batch: EntityInput[] = [{ type: 'topic', value: 'zero', confidence: 0 }];

    // Act
    const inserted = repo.insertMany(videoId, batch);

    // Assert
    expect(inserted).toBe(1);
    expect(repo.findByVideoId(videoId)[0].confidence).toBe(0);
  });

  it('accepts confidence at the upper boundary (100)', () => {
    // Arrange
    const batch: EntityInput[] = [{ type: 'topic', value: 'hundred', confidence: 100 }];

    // Act
    const inserted = repo.insertMany(videoId, batch);

    // Assert
    expect(inserted).toBe(1);
    expect(repo.findByVideoId(videoId)[0].confidence).toBe(100);
  });

  it('accepts confidence: null (preserved through the schema)', () => {
    // Arrange
    const batch: EntityInput[] = [{ type: 'topic', value: 'unknown', confidence: null }];

    // Act
    const inserted = repo.insertMany(videoId, batch);

    // Assert — null means "unset"; the column defaults to 100 in the
    // current repo, so we assert the row landed without throwing rather
    // than the column value.
    expect(inserted).toBe(1);
    expect(repo.countByVideoId(videoId)).toBe(1);
  });
});

// --------------------------------------------------------------------------
// findByVideoIdAndType
// --------------------------------------------------------------------------

describe('EntityRepository.findByVideoIdAndType', () => {
  let dbm: DatabaseManager;
  let repo: EntityRepository;
  const videoId: VideoId = asVideoId(VIDEO_A);

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new EntityRepository(dbm);
    seedVideo(dbm, videoId);
    repo.insertMany(videoId, SAMPLE_BATCH);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns only the rows matching the requested type', () => {
    // Act
    const topics = repo.findByVideoIdAndType(videoId, 'topic');
    const repos = repo.findByVideoIdAndType(videoId, 'github_repo');
    const sites = repo.findByVideoIdAndType(videoId, 'website');
    const people = repo.findByVideoIdAndType(videoId, 'person');

    // Assert
    expect(topics.map((r) => r.entity_value)).toEqual(['machine learning']);
    expect(repos.map((r) => r.entity_value)).toEqual(['anthropic/claude-code']);
    expect(sites.map((r) => r.entity_value)).toEqual(['anthropic.com']);
    expect(people.map((r) => r.entity_value)).toEqual(['Dario Amodei']);
  });

  it('returns an empty array for a type with no matching rows', () => {
    // Arrange — fresh video, no entities of any type
    const videoB = asVideoId(VIDEO_B);
    seedVideo(dbm, videoB, 'video B');

    // Act
    const result = repo.findByVideoIdAndType(videoB, 'topic');

    // Assert
    expect(result).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// deleteByVideoId
// --------------------------------------------------------------------------

describe('EntityRepository.deleteByVideoId', () => {
  let dbm: DatabaseManager;
  let repo: EntityRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new EntityRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('removes all entities for the target video and returns the row count', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);
    seedVideo(dbm, videoId);
    repo.insertMany(videoId, SAMPLE_BATCH);
    expect(repo.countByVideoId(videoId)).toBe(SAMPLE_BATCH.length);

    // Act
    const removed = repo.deleteByVideoId(videoId);

    // Assert
    expect(removed).toBe(SAMPLE_BATCH.length);
    expect(repo.countByVideoId(videoId)).toBe(0);
    expect(repo.findByVideoId(videoId)).toEqual([]);
  });

  it('returns 0 when no entities exist for the video', () => {
    // Arrange — video exists but no entities written
    const videoId = asVideoId(VIDEO_A);
    seedVideo(dbm, videoId);

    // Act
    const removed = repo.deleteByVideoId(videoId);

    // Assert
    expect(removed).toBe(0);
  });

  it('only deletes entities for the targeted video', () => {
    // Arrange — two videos, both populated
    const videoA = asVideoId(VIDEO_A);
    const videoB = asVideoId(VIDEO_B);
    seedVideo(dbm, videoA);
    seedVideo(dbm, videoB, 'video B');
    repo.insertMany(videoA, SAMPLE_BATCH);
    repo.insertMany(videoB, [{ type: 'topic', value: 'B keeps this' }]);

    // Act
    repo.deleteByVideoId(videoA);

    // Assert
    expect(repo.countByVideoId(videoA)).toBe(0);
    expect(repo.countByVideoId(videoB)).toBe(1);
    expect(repo.findByVideoId(videoB)[0].entity_value).toBe('B keeps this');
  });
});

// --------------------------------------------------------------------------
// Foreign-key cascade
// --------------------------------------------------------------------------

describe('EntityRepository — foreign-key cascade from videos', () => {
  let dbm: DatabaseManager;
  let repo: EntityRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new EntityRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('deletes entities when the parent videos row is deleted', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);
    seedVideo(dbm, videoId);
    repo.insertMany(videoId, SAMPLE_BATCH);
    expect(repo.countByVideoId(videoId)).toBe(SAMPLE_BATCH.length);

    // Act — delete the parent row; ON DELETE CASCADE should clear children
    dbm.withTransaction((db) => {
      db.prepare('DELETE FROM videos WHERE video_id = ?').run(videoId);
    });

    // Assert
    expect(repo.countByVideoId(videoId)).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Row schema parsing on read
// --------------------------------------------------------------------------

describe('EntityRepository — reads parse through ExtractedEntityRowSchema', () => {
  let dbm: DatabaseManager;
  let repo: EntityRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new EntityRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('surfaces a DatabaseError when a row in the table fails schema parse', () => {
    // Arrange — bypass the public API to inject a row whose entity_value is
    // NULL. The schema declares entity_value as `z.string()` (non-nullable),
    // so the row must fail the parse on read. SQLite allows the NULL here
    // because we go around insertMany via withTransaction directly.
    //
    // We have to drop and recreate the table without the NOT NULL constraint
    // to *force* the corrupted row in — schema.ts declares entity_value as
    // `TEXT NOT NULL`, so a direct INSERT NULL would be rejected by SQLite.
    const videoId = asVideoId(VIDEO_A);
    seedVideo(dbm, videoId);

    dbm.withTransaction((db) => {
      db.exec('DROP TABLE extracted_entities');
      db.exec(`CREATE TABLE extracted_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_value TEXT,
        entity_url TEXT,
        confidence INTEGER DEFAULT 100,
        extracted_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      db.prepare(
        `INSERT INTO extracted_entities (video_id, entity_type, entity_value)
         VALUES (?, ?, NULL)`
      ).run(videoId, 'topic');
    });

    // Act + Assert
    expect(() => repo.findByVideoId(videoId)).toThrow(DatabaseError);
  });

  it('returns rows that match the schema unchanged on the happy path', () => {
    // Arrange
    const videoId = asVideoId(VIDEO_A);
    seedVideo(dbm, videoId);
    repo.insertMany(videoId, [{ type: 'topic', value: 'shape test', confidence: 42 }]);

    // Act
    const [row] = repo.findByVideoId(videoId);

    // Assert — all declared row fields present with the right types
    expect(typeof row.id).toBe('number');
    expect(row.video_id).toBe(VIDEO_A);
    expect(row.entity_type).toBe('topic');
    expect(row.entity_value).toBe('shape test');
    expect(row.entity_url).toBeNull();
    expect(row.confidence).toBe(42);
    expect(typeof row.extracted_at).toBe('string');
  });
});

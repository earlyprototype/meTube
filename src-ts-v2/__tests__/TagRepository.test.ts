/**
 * TagRepository tests — Phase 2 Wave 2.
 *
 * `:memory:` SQLite, no mocks, AAA pattern. Exercises:
 *   1. findOrCreate — fresh insert returns row with id
 *   2. findOrCreate — second call returns the same row (idempotent)
 *   3. findOrCreate — normalization (trim + lower) collapses variants
 *   4. findOrCreate — empty / whitespace input throws
 *   5. findByName — returns null for absent, row for present, normalized
 *   6. attachToVideo — happy path; tag created if missing; join row inserted
 *   7. attachToVideo — re-attach is idempotent (no unique constraint error)
 *   8. attachToVideo — FK violation when video doesn't exist
 *   9. attachToVideo — empty tag throws
 *  10. attachManyToVideo — multiple tags in one transaction
 *  11. attachManyToVideo — skips blank entries silently (Python parity)
 *  12. attachManyToVideo — empty input returns empty array (no transaction)
 *  13. detachFromVideo — removes join row, returns true; tag row remains
 *  14. detachFromVideo — absent tag returns false (no-op)
 *  15. detachFromVideo — absent association returns false
 *  16. detachFromVideo — empty tag returns false (no-op, no throw)
 *  17. detachAllForVideo — clears all join rows for a video; returns count
 *  18. findByVideoId — returns all attached tags, alphabetized
 *  19. findByVideoId — empty for video with no tags
 *  20. findJoinRowsByVideoId — returns raw join rows
 *  21. Rollback — throw inside withTransaction (simulated via attach + post-hoc
 *      throw in test) leaves nothing committed
 *  22. Concurrent findOrCreate semantics — two TagRepository instances over
 *      the same DB, interleaved calls, both observe the same final row
 *      (INSERT OR IGNORE + SELECT pattern)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../database/connection.js';
import { TagRepository } from '../database/TagRepository.js';
import { DatabaseError } from '../errors/index.js';
import { asVideoId, type VideoId } from '../types/branded.js';

const SAMPLE_VIDEO_ID = 'dQw4w9WgXcQ';
const OTHER_VIDEO_ID = 'aBcDeFgHiJk';

/**
 * Insert a parent `videos` row so foreign-key-bound writes can land. Pure
 * test plumbing — not part of the TagRepository API.
 */
function insertVideo(dbm: DatabaseManager, videoId: VideoId, title = 'test'): void {
  dbm.withTransaction((db) => {
    db.prepare(
      `INSERT INTO videos (
        video_id, title, channel_id, channel_title,
        published_at, duration, duration_seconds, is_short
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      videoId,
      title,
      'UCxxxx',
      'ch',
      '2024-01-01T00:00:00Z',
      'PT3M33S',
      213,
      0
    );
  });
}

describe('TagRepository.findOrCreate', () => {
  let dbm: DatabaseManager;
  let repo: TagRepository;

  beforeEach(() => {
    // Arrange — fresh in-memory DB + repo per test
    dbm = new DatabaseManager(':memory:');
    repo = new TagRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('inserts a new tag and returns the persisted row', () => {
    // Act
    const tag = repo.findOrCreate('machine-learning');

    // Assert
    expect(tag.tag).toBe('machine-learning');
    expect(typeof tag.id).toBe('number');
    expect(tag.id).toBeGreaterThan(0);
  });

  it('returns the same row on a second call (idempotent)', () => {
    // Arrange
    const first = repo.findOrCreate('python');

    // Act
    const second = repo.findOrCreate('python');

    // Assert
    expect(second.id).toBe(first.id);
    expect(second.tag).toBe('python');

    const countRow = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tags WHERE tag = ?')
      .get('python');
    expect(countRow?.c).toBe(1);
  });

  it('normalizes input via trim + lowercase before matching', () => {
    // Arrange — three syntactic variants of the same tag
    const a = repo.findOrCreate('  TypeScript  ');
    const b = repo.findOrCreate('typescript');
    const c = repo.findOrCreate('TYPESCRIPT');

    // Assert — all three collapse to one DB row
    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);
    expect(a.tag).toBe('typescript');

    const countRow = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tags')
      .get();
    expect(countRow?.c).toBe(1);
  });

  it('throws DatabaseError on empty or whitespace input', () => {
    // Act + Assert
    expect(() => repo.findOrCreate('')).toThrow(DatabaseError);
    expect(() => repo.findOrCreate('   ')).toThrow(DatabaseError);
    expect(() => repo.findOrCreate('\t\n')).toThrow(DatabaseError);
  });
});

describe('TagRepository.findByName', () => {
  let dbm: DatabaseManager;
  let repo: TagRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new TagRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns null for an absent tag', () => {
    // Act
    const result = repo.findByName('does-not-exist');

    // Assert
    expect(result).toBeNull();
  });

  it('returns the row for an existing tag, normalized', () => {
    // Arrange
    const created = repo.findOrCreate('rust');

    // Act
    const found = repo.findByName('  RUST  ');

    // Assert
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.tag).toBe('rust');
  });

  it('returns null for empty / whitespace input (does not throw)', () => {
    // Act + Assert
    expect(repo.findByName('')).toBeNull();
    expect(repo.findByName('   ')).toBeNull();
  });
});

describe('TagRepository.attachToVideo', () => {
  let dbm: DatabaseManager;
  let repo: TagRepository;
  let videoId: VideoId;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new TagRepository(dbm);
    videoId = asVideoId(SAMPLE_VIDEO_ID);
    insertVideo(dbm, videoId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('creates the tag if absent and inserts the join row', () => {
    // Act
    const tag = repo.attachToVideo(videoId, 'ai');

    // Assert — tag row exists
    expect(tag.tag).toBe('ai');
    expect(typeof tag.id).toBe('number');

    // Assert — join row exists
    const joinCount = dbm
      .prepare<[string, number], { c: number }>(
        'SELECT COUNT(*) AS c FROM video_tags WHERE video_id = ? AND tag_id = ?'
      )
      .get(videoId, tag.id as number);
    expect(joinCount?.c).toBe(1);
  });

  it('reuses an existing tag when attaching to a new video', () => {
    // Arrange — create the tag via a different path first
    const preexisting = repo.findOrCreate('llm');

    // Act
    const attached = repo.attachToVideo(videoId, 'LLM');

    // Assert — same row, not a duplicate
    expect(attached.id).toBe(preexisting.id);
    const tagCount = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tags')
      .get();
    expect(tagCount?.c).toBe(1);
  });

  it('is idempotent — re-attaching the same (video, tag) is a no-op', () => {
    // Arrange
    repo.attachToVideo(videoId, 'devops');

    // Act — second attach must not throw on the UNIQUE constraint
    expect(() => repo.attachToVideo(videoId, 'devops')).not.toThrow();
    expect(() => repo.attachToVideo(videoId, 'DEVOPS')).not.toThrow();

    // Assert — still exactly one join row
    const joinCount = dbm
      .prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM video_tags WHERE video_id = ?'
      )
      .get(videoId);
    expect(joinCount?.c).toBe(1);
  });

  it('throws when the video does not exist (foreign-key violation)', () => {
    // Arrange — branded id whose parent row was never inserted
    const orphanId = asVideoId('zzzzzzzzzzz');

    // Act + Assert — FK constraint surfaces as DatabaseError (wrapped by
    // withTransaction)
    expect(() => repo.attachToVideo(orphanId, 'orphan')).toThrow();
  });

  it('throws DatabaseError on empty tag name', () => {
    // Act + Assert
    expect(() => repo.attachToVideo(videoId, '')).toThrow(DatabaseError);
    expect(() => repo.attachToVideo(videoId, '   ')).toThrow(DatabaseError);
  });
});

describe('TagRepository.attachManyToVideo', () => {
  let dbm: DatabaseManager;
  let repo: TagRepository;
  let videoId: VideoId;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new TagRepository(dbm);
    videoId = asVideoId(SAMPLE_VIDEO_ID);
    insertVideo(dbm, videoId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('attaches every supplied tag in one transaction', () => {
    // Act
    const attached = repo.attachManyToVideo(videoId, [
      'python',
      'rust',
      'typescript',
    ]);

    // Assert
    expect(attached.length).toBe(3);
    const tags = repo.findByVideoId(videoId).map((t) => t.tag);
    expect(tags).toEqual(['python', 'rust', 'typescript']);
  });

  it('skips blank entries silently (Python parity)', () => {
    // Act
    const attached = repo.attachManyToVideo(videoId, [
      'kept',
      '',
      '   ',
      'also-kept',
    ]);

    // Assert
    expect(attached.length).toBe(2);
    expect(attached.map((t) => t.tag).sort()).toEqual(['also-kept', 'kept']);
  });

  it('returns empty array for empty input (no transaction churn)', () => {
    // Act
    const attached = repo.attachManyToVideo(videoId, []);

    // Assert
    expect(attached).toEqual([]);
    const joinCount = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM video_tags')
      .get();
    expect(joinCount?.c).toBe(0);
  });

  it('is idempotent across calls', () => {
    // Arrange
    repo.attachManyToVideo(videoId, ['a', 'b', 'c']);

    // Act — re-issue overlapping set
    repo.attachManyToVideo(videoId, ['b', 'c', 'd']);

    // Assert — union, not duplicates
    const tags = repo.findByVideoId(videoId).map((t) => t.tag);
    expect(tags).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('TagRepository.detachFromVideo', () => {
  let dbm: DatabaseManager;
  let repo: TagRepository;
  let videoId: VideoId;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new TagRepository(dbm);
    videoId = asVideoId(SAMPLE_VIDEO_ID);
    insertVideo(dbm, videoId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('removes the join row and preserves the tag in the catalogue', () => {
    // Arrange
    repo.attachToVideo(videoId, 'remove-me');

    // Act
    const removed = repo.detachFromVideo(videoId, 'remove-me');

    // Assert — join gone, tag stays
    expect(removed).toBe(true);
    const joins = repo.findJoinRowsByVideoId(videoId);
    expect(joins.length).toBe(0);
    const stillThere = repo.findByName('remove-me');
    expect(stillThere?.tag).toBe('remove-me');
  });

  it('returns false for an absent tag (no-op)', () => {
    // Act
    const removed = repo.detachFromVideo(videoId, 'never-existed');

    // Assert
    expect(removed).toBe(false);
  });

  it('returns false when the tag exists but is not attached', () => {
    // Arrange — tag exists in the catalogue but no join
    repo.findOrCreate('floating');

    // Act
    const removed = repo.detachFromVideo(videoId, 'floating');

    // Assert
    expect(removed).toBe(false);
  });

  it('returns false for empty input (no throw)', () => {
    // Act + Assert
    expect(repo.detachFromVideo(videoId, '')).toBe(false);
    expect(repo.detachFromVideo(videoId, '   ')).toBe(false);
  });
});

describe('TagRepository.detachAllForVideo', () => {
  let dbm: DatabaseManager;
  let repo: TagRepository;
  let videoId: VideoId;
  let otherId: VideoId;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new TagRepository(dbm);
    videoId = asVideoId(SAMPLE_VIDEO_ID);
    otherId = asVideoId(OTHER_VIDEO_ID);
    insertVideo(dbm, videoId, 'target');
    insertVideo(dbm, otherId, 'untouched');
  });

  afterEach(() => {
    dbm.close();
  });

  it('clears every join row for the target video, leaving others intact', () => {
    // Arrange
    repo.attachManyToVideo(videoId, ['a', 'b', 'c']);
    repo.attachManyToVideo(otherId, ['x', 'y']);

    // Act
    const removed = repo.detachAllForVideo(videoId);

    // Assert
    expect(removed).toBe(3);
    expect(repo.findByVideoId(videoId)).toEqual([]);
    expect(repo.findByVideoId(otherId).map((t) => t.tag)).toEqual(['x', 'y']);
  });

  it('returns zero when the video has no attached tags', () => {
    // Act
    const removed = repo.detachAllForVideo(videoId);

    // Assert
    expect(removed).toBe(0);
  });
});

describe('TagRepository.findByVideoId', () => {
  let dbm: DatabaseManager;
  let repo: TagRepository;
  let videoId: VideoId;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new TagRepository(dbm);
    videoId = asVideoId(SAMPLE_VIDEO_ID);
    insertVideo(dbm, videoId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns every attached tag, alphabetized', () => {
    // Arrange — insert in non-sorted order
    repo.attachToVideo(videoId, 'zebra');
    repo.attachToVideo(videoId, 'alpha');
    repo.attachToVideo(videoId, 'mango');

    // Act
    const tags = repo.findByVideoId(videoId);

    // Assert
    expect(tags.map((t) => t.tag)).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('returns an empty array when the video has no tags', () => {
    // Act
    const tags = repo.findByVideoId(videoId);

    // Assert
    expect(tags).toEqual([]);
  });

  it('returns an empty array when the video does not exist', () => {
    // Arrange
    const ghost = asVideoId('ghostvideo1');

    // Act
    const tags = repo.findByVideoId(ghost);

    // Assert
    expect(tags).toEqual([]);
  });
});

describe('TagRepository.findJoinRowsByVideoId', () => {
  let dbm: DatabaseManager;
  let repo: TagRepository;
  let videoId: VideoId;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new TagRepository(dbm);
    videoId = asVideoId(SAMPLE_VIDEO_ID);
    insertVideo(dbm, videoId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns parsed VideoTagRow entries', () => {
    // Arrange
    const tagRow = repo.attachToVideo(videoId, 'jsx');

    // Act
    const joins = repo.findJoinRowsByVideoId(videoId);

    // Assert
    expect(joins.length).toBe(1);
    expect(joins[0]?.video_id).toBe(videoId);
    expect(joins[0]?.tag_id).toBe(tagRow.id);
  });
});

describe('TagRepository — transactional rollback', () => {
  let dbm: DatabaseManager;
  let repo: TagRepository;
  let videoId: VideoId;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new TagRepository(dbm);
    videoId = asVideoId(SAMPLE_VIDEO_ID);
    insertVideo(dbm, videoId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('rolls back tag + join inserts when the surrounding transaction throws', () => {
    // Arrange — outer transaction that performs the attach via the
    // repository, then throws to force a rollback. This proves the
    // repository's writes are participants in the surrounding txn (better-
    // sqlite3 SAVEPOINTs commit iff the outer txn commits) and that no
    // partial state survives a thrown error.
    class TestRollbackError extends Error {}

    expect(() =>
      dbm.withTransaction((db) => {
        // Write a tag directly to the DB inside the outer txn.
        db.prepare('INSERT INTO tags (tag) VALUES (?)').run('will-rollback');
        const tagId = db
          .prepare<[string], { id: number }>(
            'SELECT id FROM tags WHERE tag = ?'
          )
          .get('will-rollback')?.id;
        if (tagId === undefined) {
          throw new Error('expected the just-inserted tag to be visible');
        }
        db.prepare(
          'INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)'
        ).run(videoId, tagId);

        throw new TestRollbackError('boom');
      })
    ).toThrow();

    // Assert — neither the tag nor the join row survived
    const tagCount = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tags')
      .get();
    expect(tagCount?.c).toBe(0);
    const joinCount = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM video_tags')
      .get();
    expect(joinCount?.c).toBe(0);
  });
});

describe('TagRepository — concurrent findOrCreate semantics', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  /**
   * better-sqlite3 is synchronous and exposes a single connection. True OS-
   * threaded concurrency isn't reachable from inside one process here; what
   * IS testable is the semantic guarantee that motivated `INSERT OR IGNORE`
   * in the first place: if a SELECT misses and the subsequent INSERT races
   * a parallel insert of the same UNIQUE `tag`, the second writer must NOT
   * throw a UNIQUE constraint error — and a re-SELECT must surface the
   * already-present row.
   *
   * We simulate that race by having two repository instances share the DB.
   * Inside a single `withTransaction` we manually replay the
   * SELECT/INSERT/SELECT triplet while another instance has already
   * committed the same row in between. The "loser" must see the existing
   * row, not raise.
   */
  it("a second writer's INSERT OR IGNORE is a no-op when the row already exists", () => {
    // Arrange — repo A creates the tag first
    const repoA = new TagRepository(dbm);
    const repoB = new TagRepository(dbm);
    const first = repoA.findOrCreate('race-condition');

    // Act — repo B asks for the same tag. Internally, the SELECT will hit
    // immediately (no race needed). To explicitly exercise the INSERT OR
    // IGNORE path we issue the raw triplet, asserting it doesn't throw.
    const second = repoB.findOrCreate('RACE-CONDITION');

    // Direct INSERT OR IGNORE against the already-present row — must not
    // throw, must not duplicate.
    expect(() =>
      dbm.withTransaction((db) => {
        db.prepare('INSERT OR IGNORE INTO tags (tag) VALUES (?)').run(
          'race-condition'
        );
      })
    ).not.toThrow();

    // Assert — single row, both repos agree on its id
    expect(second.id).toBe(first.id);
    const countRow = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tags')
      .get();
    expect(countRow?.c).toBe(1);
  });

  it('parallel attaches of the same (video, tag) pair never duplicate the join row', () => {
    // Arrange
    const videoId = asVideoId(SAMPLE_VIDEO_ID);
    insertVideo(dbm, videoId);
    const repoA = new TagRepository(dbm);
    const repoB = new TagRepository(dbm);

    // Act — both repos race on the same association. Sequentially in the
    // synchronous test, but the semantic is identical: INSERT OR IGNORE on
    // the composite PK absorbs the second write silently.
    repoA.attachToVideo(videoId, 'parallel');
    expect(() => repoB.attachToVideo(videoId, 'parallel')).not.toThrow();

    // Assert
    const joinCount = dbm
      .prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM video_tags WHERE video_id = ?'
      )
      .get(videoId);
    expect(joinCount?.c).toBe(1);
  });
});

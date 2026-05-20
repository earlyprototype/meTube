/**
 * VideoRepository tests — Wave 2.
 *
 * No mocking of the DB layer; every `it` uses a fresh `:memory:`
 * `DatabaseManager`. The Zod parse on the read path is real, the
 * branded-ID round-trip is real, and the transaction rollback is
 * verified by throwing inside `createOrUpdate` and asserting the table
 * stays untouched (via a contrived scenario, since the repository's own
 * public methods are too well-behaved to throw mid-transaction).
 *
 * AAA structure on every test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseError, ValidationError } from '../errors/index.js';
import { asPlaylistId, asVideoId } from '../types/index.js';
import { DatabaseManager } from '../database/connection.js';
import { VideoRepository } from '../database/VideoRepository.js';

// --------------------------------------------------------------------
// Fixture helpers
// --------------------------------------------------------------------

/**
 * Minimal valid INSERT payload. The `videos` table requires
 * non-null `title`, `channel_id`, `channel_title`, `published_at`,
 * `duration`, `duration_seconds`, `is_short` — supply all six here so
 * tests are explicit about what the SQL surface needs.
 *
 * The branded `video_id` MUST be passed by the caller — every test
 * uses a different one so any cross-test leakage would surface
 * immediately as a missing-row assertion failure.
 */
function makeVideoInput(
  videoIdRaw: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    video_id: asVideoId(videoIdRaw),
    title: 'Default title',
    channel_id: 'UCdefaultchannelid',
    channel_title: 'Default Channel',
    published_at: '2024-01-01T00:00:00Z',
    duration: 'PT3M33S',
    duration_seconds: 213,
    is_short: 0,
    ...overrides,
  };
}

// --------------------------------------------------------------------
// findById
// --------------------------------------------------------------------

describe('VideoRepository.findById', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns null when no row matches the branded video ID', () => {
    // Arrange — fresh DB, no inserts performed.

    // Act
    const result = repo.findById(asVideoId('dQw4w9WgXcQ'));

    // Assert
    expect(result).toBeNull();
  });

  it('returns a parsed VideoRecord with a re-branded videoId when the row exists', () => {
    // Arrange
    const vid = asVideoId('dQw4w9WgXcQ');
    repo.createOrUpdate(makeVideoInput('dQw4w9WgXcQ', { title: 'Round-trip test' }));

    // Act
    const found = repo.findById(vid);

    // Assert — value, type-brand, and shape all align
    expect(found).not.toBeNull();
    expect(found?.video_id).toBe(vid);
    expect(found?.title).toBe('Round-trip test');
    expect(found?.duration_seconds).toBe(213);
    expect(found?.is_short).toBe(0);
  });
});

// --------------------------------------------------------------------
// findAll
// --------------------------------------------------------------------

describe('VideoRepository.findAll', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns an empty array when no videos exist', () => {
    // Arrange — empty DB.

    // Act
    const all = repo.findAll();

    // Assert
    expect(all).toEqual([]);
  });

  it('returns all rows in insertion order when no filters are supplied', () => {
    // Arrange — three rows inserted in a known order
    repo.createOrUpdate(makeVideoInput('aaaaaaaaaaa', { title: 'first' }));
    repo.createOrUpdate(makeVideoInput('bbbbbbbbbbb', { title: 'second' }));
    repo.createOrUpdate(makeVideoInput('ccccccccccc', { title: 'third' }));

    // Act
    const all = repo.findAll();

    // Assert
    expect(all).toHaveLength(3);
    expect(all.map((v) => v.title)).toEqual(['first', 'second', 'third']);
  });

  it('respects the shortsOnly filter (only is_short=1 rows returned)', () => {
    // Arrange — one regular, one short
    repo.createOrUpdate(
      makeVideoInput('aaaaaaaaaaa', { title: 'regular', is_short: 0 })
    );
    repo.createOrUpdate(
      makeVideoInput('bbbbbbbbbbb', { title: 'short', is_short: 1 })
    );

    // Act
    const shorts = repo.findAll({ shortsOnly: true });

    // Assert
    expect(shorts).toHaveLength(1);
    expect(shorts[0]?.title).toBe('short');
  });

  it('paginates correctly when limit and offset are supplied', () => {
    // Arrange — five videos
    for (let i = 0; i < 5; i += 1) {
      const id = `vid${String(i).padStart(8, '0')}`; // 11 chars
      repo.createOrUpdate(makeVideoInput(id, { title: `video-${i}` }));
    }

    // Act — second page of size 2
    const page = repo.findAll({ limit: 2, offset: 2 });

    // Assert
    expect(page).toHaveLength(2);
    expect(page.map((v) => v.title)).toEqual(['video-2', 'video-3']);
  });

  it('throws ValidationError when limit is negative', () => {
    // Arrange + Act + Assert
    expect(() => repo.findAll({ limit: -1 })).toThrow(ValidationError);
  });

  it('throws ValidationError when offset is negative', () => {
    // Arrange + Act + Assert
    expect(() => repo.findAll({ offset: -1 })).toThrow(ValidationError);
  });
});

// --------------------------------------------------------------------
// findByChannel
// --------------------------------------------------------------------

describe('VideoRepository.findByChannel', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns only rows belonging to the requested channel', () => {
    // Arrange
    repo.createOrUpdate(
      makeVideoInput('aaaaaaaaaaa', { channel_id: 'UCalpha', title: 'a1' })
    );
    repo.createOrUpdate(
      makeVideoInput('bbbbbbbbbbb', { channel_id: 'UCalpha', title: 'a2' })
    );
    repo.createOrUpdate(
      makeVideoInput('ccccccccccc', { channel_id: 'UCbeta', title: 'b1' })
    );

    // Act
    const alpha = repo.findByChannel('UCalpha');

    // Assert
    expect(alpha).toHaveLength(2);
    expect(alpha.every((v) => v.channel_id === 'UCalpha')).toBe(true);
  });

  it('throws ValidationError when channelId is an empty string', () => {
    // Arrange + Act + Assert
    expect(() => repo.findByChannel('')).toThrow(ValidationError);
  });
});

// --------------------------------------------------------------------
// findByPlaylist
// --------------------------------------------------------------------

describe('VideoRepository.findByPlaylist', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns videos joined through playlist_items in position order', () => {
    // Arrange — insert two videos, a playlist, and link them.
    repo.createOrUpdate(makeVideoInput('aaaaaaaaaaa', { title: 'first' }));
    repo.createOrUpdate(makeVideoInput('bbbbbbbbbbb', { title: 'second' }));

    // Insert the playlist + playlist_items via raw withTransaction.
    // VideoRepository owns videos; the rest is fixture setup.
    dbm.withTransaction((db) => {
      db.prepare(
        `INSERT INTO playlists (playlist_id, title) VALUES (?, ?)`
      ).run('PLtestlistxxx', 'Test playlist');
      db.prepare(
        `INSERT INTO playlist_items (playlist_id, video_id, position, added_at)
         VALUES (?, ?, ?, ?)`
      ).run('PLtestlistxxx', 'bbbbbbbbbbb', 1, '2024-01-02T00:00:00Z');
      db.prepare(
        `INSERT INTO playlist_items (playlist_id, video_id, position, added_at)
         VALUES (?, ?, ?, ?)`
      ).run('PLtestlistxxx', 'aaaaaaaaaaa', 2, '2024-01-01T00:00:00Z');
    });

    // Act
    const inPlaylist = repo.findByPlaylist(asPlaylistId('PLtestlistxxx'));

    // Assert — position 1 (second) comes before position 2 (first)
    expect(inPlaylist).toHaveLength(2);
    expect(inPlaylist.map((v) => v.title)).toEqual(['second', 'first']);
  });

  it('returns an empty array when the playlist has no items', () => {
    // Arrange — playlist exists, no items
    dbm.withTransaction((db) => {
      db.prepare(
        `INSERT INTO playlists (playlist_id, title) VALUES (?, ?)`
      ).run('PLempty12345', 'Empty');
    });

    // Act
    const result = repo.findByPlaylist(asPlaylistId('PLempty12345'));

    // Assert
    expect(result).toEqual([]);
  });
});

// --------------------------------------------------------------------
// search
// --------------------------------------------------------------------

describe('VideoRepository.search', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('matches a title substring', () => {
    // Arrange
    repo.createOrUpdate(
      makeVideoInput('aaaaaaaaaaa', { title: 'JavaScript Tutorial' })
    );
    repo.createOrUpdate(makeVideoInput('bbbbbbbbbbb', { title: 'Python Guide' }));

    // Act
    const results = repo.search('JavaScript');

    // Assert
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('JavaScript Tutorial');
  });

  it('matches a description substring', () => {
    // Arrange
    repo.createOrUpdate(
      makeVideoInput('aaaaaaaaaaa', {
        title: 'A title',
        description: 'Learn TypeScript here',
      })
    );

    // Act
    const results = repo.search('TypeScript');

    // Assert
    expect(results).toHaveLength(1);
  });

  it('is case-insensitive across ASCII characters (SQLite LIKE default)', () => {
    // Arrange
    repo.createOrUpdate(
      makeVideoInput('aaaaaaaaaaa', { title: 'JavaScript Tutorial' })
    );

    // Act
    const results = repo.search('javascript');

    // Assert
    expect(results).toHaveLength(1);
  });

  it('throws ValidationError on an empty query', () => {
    // Arrange + Act + Assert
    expect(() => repo.search('')).toThrow(ValidationError);
  });
});

// --------------------------------------------------------------------
// exists
// --------------------------------------------------------------------

describe('VideoRepository.exists', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns true when a row exists for the given videoId', () => {
    // Arrange
    repo.createOrUpdate(makeVideoInput('dQw4w9WgXcQ'));

    // Act
    const present = repo.exists(asVideoId('dQw4w9WgXcQ'));

    // Assert
    expect(present).toBe(true);
  });

  it('returns false when no row matches', () => {
    // Arrange — empty DB.

    // Act
    const present = repo.exists(asVideoId('dQw4w9WgXcQ'));

    // Assert
    expect(present).toBe(false);
  });
});

// --------------------------------------------------------------------
// createOrUpdate
// --------------------------------------------------------------------

describe('VideoRepository.createOrUpdate — insert path', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('inserts a new row and returns the parsed record with a branded ID', () => {
    // Arrange
    const input = makeVideoInput('dQw4w9WgXcQ', { title: 'first insert' });

    // Act
    const created = repo.createOrUpdate(input);

    // Assert
    expect(created.video_id).toBe(input.video_id);
    expect(created.title).toBe('first insert');
    expect(created.id).toBeGreaterThan(0);
    expect(created.created_at).toBeDefined();
  });

  it('coerces boolean is_short to 0/1 on insert', () => {
    // Arrange
    const input = makeVideoInput('dQw4w9WgXcQ', { is_short: true });

    // Act
    const created = repo.createOrUpdate(input);

    // Assert
    expect(created.is_short).toBe(1);
  });

  it('persists a NULL description when explicitly passed null', () => {
    // Arrange
    const input = makeVideoInput('dQw4w9WgXcQ', { description: null });

    // Act
    const created = repo.createOrUpdate(input);

    // Assert
    expect(created.description).toBeNull();
  });
});

describe('VideoRepository.createOrUpdate — update path', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('updates only the supplied columns on a second call with the same video_id', () => {
    // Arrange — initial INSERT with title=A
    repo.createOrUpdate(
      makeVideoInput('dQw4w9WgXcQ', {
        title: 'Original',
        channel_title: 'Original Channel',
      })
    );

    // Act — UPDATE only the title
    const updated = repo.createOrUpdate({
      video_id: asVideoId('dQw4w9WgXcQ'),
      title: 'Updated',
    });

    // Assert — title changed, channel_title preserved
    expect(updated.title).toBe('Updated');
    expect(updated.channel_title).toBe('Original Channel');
  });

  it('returns the existing row unchanged when no writable columns are supplied', () => {
    // Arrange
    const created = repo.createOrUpdate(makeVideoInput('dQw4w9WgXcQ'));

    // Act — only the branded ID, no patch fields
    const result = repo.createOrUpdate({ video_id: asVideoId('dQw4w9WgXcQ') });

    // Assert
    expect(result.id).toBe(created.id);
    expect(result.title).toBe(created.title);
  });

  it('preserves the AUTOINCREMENT id across an update', () => {
    // Arrange
    const created = repo.createOrUpdate(makeVideoInput('dQw4w9WgXcQ'));
    const originalId = created.id;

    // Act
    const updated = repo.createOrUpdate({
      video_id: asVideoId('dQw4w9WgXcQ'),
      title: 'Renamed',
    });

    // Assert
    expect(updated.id).toBe(originalId);
  });
});

// --------------------------------------------------------------------
// delete
// --------------------------------------------------------------------

describe('VideoRepository.delete', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns true and removes the row when it exists', () => {
    // Arrange
    repo.createOrUpdate(makeVideoInput('dQw4w9WgXcQ'));

    // Act
    const deleted = repo.delete(asVideoId('dQw4w9WgXcQ'));
    const after = repo.findById(asVideoId('dQw4w9WgXcQ'));

    // Assert
    expect(deleted).toBe(true);
    expect(after).toBeNull();
  });

  it('returns false when no row matches', () => {
    // Arrange — empty DB.

    // Act
    const deleted = repo.delete(asVideoId('dQw4w9WgXcQ'));

    // Assert
    expect(deleted).toBe(false);
  });

  it('cascades to dependent rows in tables with ON DELETE CASCADE', () => {
    // Arrange — video, transcript, and an extracted entity all keyed on
    // the same video_id. Cascade should remove everything when the
    // parent video row goes away.
    const vid = 'dQw4w9WgXcQ';
    repo.createOrUpdate(makeVideoInput(vid));

    dbm.withTransaction((db) => {
      db.prepare(
        `INSERT INTO transcripts (video_id, language, full_text)
         VALUES (?, ?, ?)`
      ).run(vid, 'en', 'transcript body');
      db.prepare(
        `INSERT INTO extracted_entities (video_id, entity_type, entity_value)
         VALUES (?, ?, ?)`
      ).run(vid, 'topic', 'machine-learning');
    });

    // Act
    repo.delete(asVideoId(vid));

    // Assert
    const transcriptCount = dbm
      .prepare<readonly string[], { c: number }>(
        'SELECT COUNT(*) AS c FROM transcripts WHERE video_id = ?'
      )
      .get(vid);
    const entityCount = dbm
      .prepare<readonly string[], { c: number }>(
        'SELECT COUNT(*) AS c FROM extracted_entities WHERE video_id = ?'
      )
      .get(vid);

    expect(transcriptCount?.c).toBe(0);
    expect(entityCount?.c).toBe(0);
  });
});

// --------------------------------------------------------------------
// Transaction discipline — rollback semantics
// --------------------------------------------------------------------

describe('VideoRepository — transaction rollback', () => {
  let dbm: DatabaseManager;
  let repo: VideoRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new VideoRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('rolls back when a write throws inside the same withTransaction as the repository write', () => {
    // Arrange — pre-insert a row, then invoke a withTransaction that
    // both writes through the repository AND throws. The repository's
    // own write must not be visible after the throw.
    //
    // The repository's createOrUpdate uses its own withTransaction
    // internally; better-sqlite3 nests via SAVEPOINT, and the outer
    // transaction's rollback discards the inner save points as well.

    class TestRollback extends Error {}

    expect(() =>
      dbm.withTransaction((db) => {
        // Write outside the repo (sanity tag).
        db.prepare(
          `INSERT INTO videos (video_id, title, channel_id, channel_title, published_at, duration, duration_seconds, is_short)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          'aaaaaaaaaaa',
          'sentinel-before-throw',
          'UCxxxx',
          'ch',
          '2024-01-01T00:00:00Z',
          'PT1S',
          1,
          0
        );

        // And write through the repository (also via withTransaction).
        repo.createOrUpdate(
          makeVideoInput('bbbbbbbbbbb', { title: 'through-repo' })
        );

        throw new TestRollback('cancel');
      })
    ).toThrow();

    // Act — query both rows after the outer rollback
    const sentinel = repo.findById(asVideoId('aaaaaaaaaaa'));
    const throughRepo = repo.findById(asVideoId('bbbbbbbbbbb'));

    // Assert — neither write survives
    expect(sentinel).toBeNull();
    expect(throughRepo).toBeNull();
  });
});

// --------------------------------------------------------------------
// Error propagation — DatabaseError on broken state
// --------------------------------------------------------------------

describe('VideoRepository — error propagation', () => {
  it('throws DatabaseError when called on a closed connection', () => {
    // Arrange
    const dbm = new DatabaseManager(':memory:');
    const repo = new VideoRepository(dbm);
    dbm.close();

    // Act + Assert
    expect(() => repo.findById(asVideoId('dQw4w9WgXcQ'))).toThrow(
      DatabaseError
    );
  });
});

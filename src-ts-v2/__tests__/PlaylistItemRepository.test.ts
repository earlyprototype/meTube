/**
 * Tests for `src-ts-v2/database/PlaylistItemRepository.ts`.
 *
 * No mocks. No filesystem. Every test runs against a fresh `:memory:`
 * SQLite database with the v2 schema bootstrapped by `DatabaseManager`'s
 * constructor.
 *
 * Layout: AAA per test. Each `describe` block reflects a single public
 * method (or invariant) of the repository.
 *
 * Regression coverage notes:
 *   - "actually inserts the row" — the v1 stub-bomb class (see
 *     `_archivedkanban.md` REVIEW 2026-05-19 audit, "PlaylistAddMine and
 *     PlaylistSync ... silently produce broken DB rows") is asserted
 *     against directly: the test counts rows before and after, AND
 *     reads back the inserted row to confirm the playlist_id stored is
 *     the playlist_id passed in. A no-op INSERT or an
 *     `undefined`-bearing row both fail.
 *   - "rollback leaves no row" — confirms `withTransaction` semantics
 *     reach into this repository's writes.
 *   - "FK rejects orphans" — confirms `PRAGMA foreign_keys = ON` is
 *     actually catching `playlist_id` references that don't exist.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../database/connection.js';
import { PlaylistItemRepository } from '../database/PlaylistItemRepository.js';
import { DatabaseError } from '../errors/index.js';
import { PlaylistItemRowSchema } from '../schemas/db.js';
import { asPlaylistId, asVideoId, type PlaylistId, type VideoId } from '../types/branded.js';

// --------------------------------------------------------------------------
// Test helpers — direct fixture inserts. The repositories these depend on
// (`PlaylistRepository`, `VideoRepository`) don't exist yet in v2; until
// they do, we seed the parent rows by hand through `withTransaction`.
// --------------------------------------------------------------------------

interface SeededPlaylist {
  readonly id: PlaylistId;
  readonly title: string;
}

interface SeededVideo {
  readonly id: VideoId;
  readonly title: string;
}

function seedPlaylist(dbm: DatabaseManager, raw: string, title = 'fixture playlist'): SeededPlaylist {
  const id = asPlaylistId(raw);
  dbm.withTransaction((db) => {
    db.prepare(
      `INSERT INTO playlists (playlist_id, title, description, video_count, enabled)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, title, null, 0, 1);
  });
  return { id, title };
}

function seedVideo(
  dbm: DatabaseManager,
  raw: string,
  title = 'fixture video',
  durationSeconds = 213
): SeededVideo {
  const id = asVideoId(raw);
  dbm.withTransaction((db) => {
    db.prepare(
      `INSERT INTO videos (video_id, title, channel_id, channel_title,
                           published_at, duration, duration_seconds, is_short)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      title,
      'UCfixture0001',
      'fixture channel',
      '2024-01-01T00:00:00Z',
      'PT3M33S',
      durationSeconds,
      0
    );
  });
  return { id, title };
}

// --------------------------------------------------------------------------
// addVideoToPlaylist
// --------------------------------------------------------------------------

describe('PlaylistItemRepository.addVideoToPlaylist', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistItemRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistItemRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('ACTUALLY inserts the row (v1 stub-bomb regression)', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLstubbomb01');
    const { id: videoId } = seedVideo(dbm, 'dQw4w9WgXcQ');

    const before = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM playlist_items')
      .get();
    expect(before?.c).toBe(0);

    // Act
    const inserted = repo.addVideoToPlaylist(playlistId, videoId, 1);

    // Assert — row count increased, AND the row we get back carries the
    // playlist_id we passed in (not `undefined`, not the empty string,
    // not the videoId by accident).
    const after = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM playlist_items')
      .get();
    expect(after?.c).toBe(1);

    expect(inserted.playlist_id).toBe(playlistId);
    expect(inserted.video_id).toBe(videoId);
    expect(inserted.position).toBe(1);
    expect(inserted.id).toBeGreaterThan(0);

    // And the row is readable independently of the return value — proves
    // the INSERT committed, not just that the in-flight closure synthesised
    // a return shape.
    const reread = dbm
      .prepare<[string, string], { playlist_id: string; video_id: string }>(
        'SELECT playlist_id, video_id FROM playlist_items WHERE playlist_id = ? AND video_id = ?'
      )
      .get(playlistId, videoId);

    expect(reread?.playlist_id).toBe(playlistId);
    expect(reread?.video_id).toBe(videoId);
  });

  it('is idempotent — second call returns the same row without inserting again', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLidemp00001');
    const { id: videoId } = seedVideo(dbm, 'idempotent1');

    // Act
    const first = repo.addVideoToPlaylist(playlistId, videoId, 0);
    const second = repo.addVideoToPlaylist(playlistId, videoId, 99);

    // Assert — same primary key, original position preserved (idempotent,
    // not "upsert"), and the table still has exactly one row for the pair.
    expect(second.id).toBe(first.id);
    expect(second.position).toBe(0);

    const count = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM playlist_items')
      .get();
    expect(count?.c).toBe(1);
  });

  it('returns a row that parses cleanly through PlaylistItemRowSchema', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLschema0001');
    const { id: videoId } = seedVideo(dbm, 'schemaroun1');

    // Act
    const inserted = repo.addVideoToPlaylist(playlistId, videoId, 5);

    // Assert — already parsed by the repo, but re-parsing must succeed too
    expect(() => PlaylistItemRowSchema.parse(inserted)).not.toThrow();
    expect(inserted.added_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects negative positions with DatabaseError', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLnegpos0001');
    const { id: videoId } = seedVideo(dbm, 'negposvideo');

    // Act + Assert
    expect(() => repo.addVideoToPlaylist(playlistId, videoId, -1)).toThrow(
      DatabaseError
    );

    const count = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM playlist_items')
      .get();
    expect(count?.c).toBe(0);
  });

  it('honours an explicit addedAt timestamp instead of "now"', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLtimestamp1');
    const { id: videoId } = seedVideo(dbm, 'timestamp01');
    const customAddedAt = '2020-05-04T03:02:01Z';

    // Act
    const row = repo.addVideoToPlaylist(playlistId, videoId, 0, customAddedAt);

    // Assert
    expect(row.added_at).toBe(customAddedAt);
  });

  it('rejects an INSERT against a missing playlist (FK violation -> DatabaseError)', () => {
    // Arrange — seed the video but NOT the playlist; FK on
    // playlist_items.playlist_id must reject.
    const ghostPlaylist = asPlaylistId('PLghost00001');
    const { id: videoId } = seedVideo(dbm, 'orphanvideo');

    // Act + Assert
    expect(() => repo.addVideoToPlaylist(ghostPlaylist, videoId)).toThrow(
      DatabaseError
    );

    const count = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM playlist_items')
      .get();
    expect(count?.c).toBe(0);
  });

  it('rejects an INSERT against a missing video (FK violation -> DatabaseError)', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLghostvid01');
    const ghostVideo = asVideoId('ghostvideo1');

    // Act + Assert
    expect(() => repo.addVideoToPlaylist(playlistId, ghostVideo)).toThrow(
      DatabaseError
    );
  });
});

// --------------------------------------------------------------------------
// Transaction discipline
// --------------------------------------------------------------------------

describe('PlaylistItemRepository — withTransaction rollback', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('rolls back the playlist_items row when an outer transaction throws', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLrollback01');
    const { id: videoId } = seedVideo(dbm, 'rollback001');
    const repo = new PlaylistItemRepository(dbm);

    class TestRollbackError extends Error {}

    // Act + Assert — the repository's own writes go through withTransaction
    // internally, but we additionally wrap the repo call in an OUTER
    // transaction that throws after the insert. better-sqlite3 uses
    // SAVEPOINTs for nested transactions; the inner call is supposed to
    // unwind iff the outer also commits — so the throw at the outer level
    // must leave NO playlist_items row behind.
    expect(() =>
      dbm.withTransaction((db) => {
        repo.addVideoToPlaylist(playlistId, videoId);

        // The repo's insert just landed; visible inside this txn:
        const inFlight = db
          .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM playlist_items')
          .get() as { c: number } | undefined;
        expect(inFlight?.c).toBe(1);

        throw new TestRollbackError('boom');
      })
    ).toThrow();

    const after = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM playlist_items')
      .get();
    expect(after?.c).toBe(0);
  });
});

// --------------------------------------------------------------------------
// removeVideoFromPlaylist
// --------------------------------------------------------------------------

describe('PlaylistItemRepository.removeVideoFromPlaylist', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistItemRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistItemRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns true and deletes the row when the pair exists', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLremove0001');
    const { id: videoId } = seedVideo(dbm, 'remove00001');
    repo.addVideoToPlaylist(playlistId, videoId, 0);

    // Act
    const removed = repo.removeVideoFromPlaylist(playlistId, videoId);

    // Assert
    expect(removed).toBe(true);
    expect(repo.exists(playlistId, videoId)).toBe(false);
  });

  it('returns false when the pair does not exist (no-op)', () => {
    // Arrange — seed both rows but no junction row
    const { id: playlistId } = seedPlaylist(dbm, 'PLnoop000001');
    const { id: videoId } = seedVideo(dbm, 'noopvideo01');

    // Act
    const removed = repo.removeVideoFromPlaylist(playlistId, videoId);

    // Assert
    expect(removed).toBe(false);
  });
});

// --------------------------------------------------------------------------
// getItemsWithVideos (explicit JOIN replaces SQLAlchemy joinedload)
// --------------------------------------------------------------------------

describe('PlaylistItemRepository.getItemsWithVideos', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistItemRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistItemRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns items joined with their videos, ordered by position', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLjoin000001', 'mixed bag');
    const { id: aId } = seedVideo(dbm, 'joinvideo01', 'A — first');
    const { id: bId } = seedVideo(dbm, 'joinvideo02', 'B — second');
    const { id: cId } = seedVideo(dbm, 'joinvideo03', 'C — third');

    // Intentionally insert out of order; the SELECT must re-order by position.
    repo.addVideoToPlaylist(playlistId, bId, 2);
    repo.addVideoToPlaylist(playlistId, cId, 3);
    repo.addVideoToPlaylist(playlistId, aId, 1);

    // Act
    const rows = repo.getItemsWithVideos(playlistId);

    // Assert — three rows, in (1, 2, 3) order, with both halves populated.
    expect(rows).toHaveLength(3);
    expect(rows[0]?.item.position).toBe(1);
    expect(rows[0]?.item.video_id).toBe(aId);
    expect(rows[0]?.video.title).toBe('A — first');

    expect(rows[1]?.item.position).toBe(2);
    expect(rows[1]?.video.video_id).toBe(bId);

    expect(rows[2]?.item.position).toBe(3);
    expect(rows[2]?.video.title).toBe('C — third');
  });

  it('returns an empty array for an unknown playlist (no throw)', () => {
    // Arrange — DON'T seed a playlist; the ghost has no rows in either table.
    const ghost = asPlaylistId('PLghostlist1');

    // Act
    const rows = repo.getItemsWithVideos(ghost);

    // Assert
    expect(rows).toHaveLength(0);
  });

  it('does NOT return items whose playlist matches a different ID', () => {
    // Arrange — two playlists share a video; result must be filtered correctly.
    const { id: keepId } = seedPlaylist(dbm, 'PLkeep000001');
    const { id: skipId } = seedPlaylist(dbm, 'PLskip000001');
    const { id: videoId } = seedVideo(dbm, 'sharedvideo');

    repo.addVideoToPlaylist(keepId, videoId, 1);
    repo.addVideoToPlaylist(skipId, videoId, 1);

    // Act
    const rows = repo.getItemsWithVideos(keepId);

    // Assert
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item.playlist_id).toBe(keepId);
  });

  it('getItemsWithVideos parses a joined row with NULL videos.created_at and videos.updated_at without throwing (closes A13 drift)', () => {
    // Arrange — seed a playlist normally, but craft a videos row with
    // EXPLICIT NULL timestamps via raw SQL. seedVideo() doesn't provide
    // created_at/updated_at, but SQLite fills its DEFAULT CURRENT_TIMESTAMP
    // when columns are absent — so to reproduce the legacy pre-A11/A6 data
    // shape we must spell out NULLs. This is exactly the blind spot the
    // 2026-06-04 audit identified for the original A13 finding.
    const { id: playlistId } = seedPlaylist(dbm, 'PLa13null001');
    const videoId = asVideoId('a13nullvid1');

    dbm.withTransaction((db) => {
      db.prepare(
        `INSERT INTO videos (
           video_id, title, channel_id, channel_title,
           published_at, duration, duration_seconds, is_short,
           created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
      ).run(
        videoId,
        'NULL-timestamp video',
        'UCfixture0001',
        'fixture channel',
        '2024-01-01T00:00:00Z',
        'PT3M33S',
        213,
        0
      );
    });

    repo.addVideoToPlaylist(playlistId, videoId, 1);

    // Sanity-check the DB really holds NULLs (guards against a future
    // schema migration that would invalidate the regression).
    const rawCheck = dbm
      .prepare<
        [string],
        { created_at: string | null; updated_at: string | null }
      >('SELECT created_at, updated_at FROM videos WHERE video_id = ?')
      .get(videoId);
    expect(rawCheck?.created_at).toBeNull();
    expect(rawCheck?.updated_at).toBeNull();

    // Act + Assert — pre-A13 fix, this would throw ZodError -> DatabaseError
    // because v_created_at / v_updated_at were `.string().optional()` and
    // refused null.
    const rows = repo.getItemsWithVideos(playlistId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.item.video_id).toBe(videoId);
    expect(rows[0]?.video.video_id).toBe(videoId);
    expect(rows[0]?.video.title).toBe('NULL-timestamp video');
    // The two columns must surface as `null` (not coerced to `undefined`),
    // so downstream callers can distinguish "absent" from "explicitly null".
    expect(rows[0]?.video.created_at).toBeNull();
    expect(rows[0]?.video.updated_at).toBeNull();
  });
});

// --------------------------------------------------------------------------
// getVideosInPlaylist
// --------------------------------------------------------------------------

describe('PlaylistItemRepository.getVideosInPlaylist', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistItemRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistItemRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns branded VideoIds in playlist order', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLorderlist1');
    const a = seedVideo(dbm, 'orderingaaa', 'A');
    const b = seedVideo(dbm, 'orderingbbb', 'B');

    repo.addVideoToPlaylist(playlistId, b.id, 2);
    repo.addVideoToPlaylist(playlistId, a.id, 1);

    // Act
    const ids = repo.getVideosInPlaylist(playlistId);

    // Assert — ids come back as branded VideoId (no type assertion needed
    // because asVideoId in the implementation already branded them).
    expect(ids).toEqual([a.id, b.id]);
  });
});

// --------------------------------------------------------------------------
// getItemsByPlaylist and getPlaylistsForVideo
// --------------------------------------------------------------------------

describe('PlaylistItemRepository — read accessors', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistItemRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistItemRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('getItemsByPlaylist returns parsed PlaylistItemRow[]', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLreadaccs01');
    const { id: aId } = seedVideo(dbm, 'readacc0001');
    const { id: bId } = seedVideo(dbm, 'readacc0002');

    repo.addVideoToPlaylist(playlistId, aId, 1);
    repo.addVideoToPlaylist(playlistId, bId, 2);

    // Act
    const items = repo.getItemsByPlaylist(playlistId);

    // Assert
    expect(items).toHaveLength(2);
    expect(items[0]?.video_id).toBe(aId);
    expect(items[1]?.video_id).toBe(bId);
    // Re-parse must succeed
    items.forEach((it) =>
      expect(() => PlaylistItemRowSchema.parse(it)).not.toThrow()
    );
  });

  it('getPlaylistsForVideo returns every junction row for a video', () => {
    // Arrange
    const p1 = seedPlaylist(dbm, 'PLforvideo01');
    const p2 = seedPlaylist(dbm, 'PLforvideo02');
    const { id: videoId } = seedVideo(dbm, 'multilist01');

    repo.addVideoToPlaylist(p1.id, videoId);
    repo.addVideoToPlaylist(p2.id, videoId);

    // Act
    const rows = repo.getPlaylistsForVideo(videoId);

    // Assert
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.playlist_id).sort();
    expect(ids).toEqual([p1.id, p2.id].sort());
  });
});

// --------------------------------------------------------------------------
// exists / countByPlaylist / clearPlaylist
// --------------------------------------------------------------------------

describe('PlaylistItemRepository — exists / count / clear', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistItemRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistItemRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('exists returns true after insert and false after remove', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLexists0001');
    const { id: videoId } = seedVideo(dbm, 'existsvideo');

    // Act + Assert
    expect(repo.exists(playlistId, videoId)).toBe(false);
    repo.addVideoToPlaylist(playlistId, videoId);
    expect(repo.exists(playlistId, videoId)).toBe(true);
    repo.removeVideoFromPlaylist(playlistId, videoId);
    expect(repo.exists(playlistId, videoId)).toBe(false);
  });

  it('countByPlaylist returns the number of items', () => {
    // Arrange
    const { id: playlistId } = seedPlaylist(dbm, 'PLcount00001');
    const a = seedVideo(dbm, 'countvideo1');
    const b = seedVideo(dbm, 'countvideo2');
    const c = seedVideo(dbm, 'countvideo3');

    repo.addVideoToPlaylist(playlistId, a.id);
    repo.addVideoToPlaylist(playlistId, b.id);
    repo.addVideoToPlaylist(playlistId, c.id);

    // Act + Assert
    expect(repo.countByPlaylist(playlistId)).toBe(3);
  });

  it('clearPlaylist removes every item for a playlist and returns the count', () => {
    // Arrange
    const { id: keepId } = seedPlaylist(dbm, 'PLclearkeep1');
    const { id: targetId } = seedPlaylist(dbm, 'PLcleartgt01');
    const a = seedVideo(dbm, 'clearvideo1');
    const b = seedVideo(dbm, 'clearvideo2');

    repo.addVideoToPlaylist(targetId, a.id);
    repo.addVideoToPlaylist(targetId, b.id);
    repo.addVideoToPlaylist(keepId, a.id);

    // Act
    const removed = repo.clearPlaylist(targetId);

    // Assert — target is empty, neighbour playlist is untouched
    expect(removed).toBe(2);
    expect(repo.countByPlaylist(targetId)).toBe(0);
    expect(repo.countByPlaylist(keepId)).toBe(1);
  });
});

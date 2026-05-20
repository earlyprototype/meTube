/**
 * StatisticsRepository tests.
 *
 * Exercises every public method against an in-memory SQLite database
 * bootstrapped through `DatabaseManager`. No mocks — real DDL, real
 * `withTransaction`, real Zod-parsed rows, real branded ids.
 *
 * Coverage:
 *   - recordSnapshot: writes, FK enforcement, returned row is parsed
 *   - recordSnapshot: rollback when a throw happens inside a wrapping
 *                    transaction (the canonical "all writes through
 *                    withTransaction" invariant)
 *   - findLatestByVideoId: latest by recorded_at DESC, id DESC; null when
 *                          no snapshots; isolation between videos
 *   - findHistoryByVideoId: full ordered history; empty array when none
 *   - aggregateTotalsAcrossVideos: sums LATEST snapshot per video only;
 *                                 zeroed-row case on empty table
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../database/connection.js';
import { StatisticsRepository } from '../database/StatisticsRepository.js';
import { asVideoId, type VideoId } from '../types/branded.js';
import { VideoStatisticRowSchema } from '../schemas/db.js';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const VIDEO_A: VideoId = asVideoId('dQw4w9WgXcQ');
const VIDEO_B: VideoId = asVideoId('jNQXAC9IVRw');
const UNRECORDED: VideoId = asVideoId('aaaaaaaaaaa');

/**
 * Insert a `videos` row directly. The FK constraint on
 * `video_statistics.video_id` requires the parent row to exist before any
 * snapshot can be recorded.
 */
function seedVideo(dbm: DatabaseManager, videoId: VideoId, title: string): void {
  dbm.withTransaction((db) => {
    db.prepare(
      `INSERT INTO videos (video_id, title, channel_id, channel_title, published_at, duration, duration_seconds, is_short)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      videoId,
      title,
      'UCseedchannel',
      'seed channel',
      '2024-01-01T00:00:00Z',
      'PT3M33S',
      213,
      0
    );
  });
}

// --------------------------------------------------------------------------
// recordSnapshot
// --------------------------------------------------------------------------

describe('StatisticsRepository.recordSnapshot', () => {
  let dbm: DatabaseManager;
  let repo: StatisticsRepository;

  beforeEach(() => {
    // Arrange — fresh in-memory DB per test
    dbm = new DatabaseManager(':memory:');
    repo = new StatisticsRepository(dbm);
    seedVideo(dbm, VIDEO_A, 'seed for snapshots');
  });

  afterEach(() => {
    dbm.close();
  });

  it('persists a snapshot and returns the validated row', () => {
    // Act
    const row = repo.recordSnapshot(VIDEO_A, {
      viewCount: 100,
      likeCount: 10,
      commentCount: 2,
    });

    // Assert — return value is shape-correct
    expect(row.video_id).toBe(VIDEO_A);
    expect(row.view_count).toBe(100);
    expect(row.like_count).toBe(10);
    expect(row.comment_count).toBe(2);
    expect(row.id).toBeGreaterThan(0);
    expect(row.recorded_at).toBeTypeOf('string');

    // Re-parse to prove the value satisfies the wire schema
    expect(() => VideoStatisticRowSchema.parse(row)).not.toThrow();

    // Assert — the row is actually visible to a subsequent read
    const count = dbm
      .prepare<[VideoId], { c: number }>(
        'SELECT COUNT(*) AS c FROM video_statistics WHERE video_id = ?'
      )
      .get(VIDEO_A);
    expect(count?.c).toBe(1);
  });

  it('defaults missing counts to 0 (Python add_snapshot parity)', () => {
    // Act — empty stats input
    const row = repo.recordSnapshot(VIDEO_A, {});

    // Assert
    expect(row.view_count).toBe(0);
    expect(row.like_count).toBe(0);
    expect(row.comment_count).toBe(0);
  });

  it('appends rather than replaces — each call writes a new row', () => {
    // Arrange + Act — three calls in succession
    repo.recordSnapshot(VIDEO_A, { viewCount: 1 });
    repo.recordSnapshot(VIDEO_A, { viewCount: 2 });
    repo.recordSnapshot(VIDEO_A, { viewCount: 3 });

    // Assert — three distinct rows, not one mutated row
    const count = dbm
      .prepare<[VideoId], { c: number }>(
        'SELECT COUNT(*) AS c FROM video_statistics WHERE video_id = ?'
      )
      .get(VIDEO_A);
    expect(count?.c).toBe(3);
  });

  it('honours the FK constraint and rejects snapshots for unknown videos', () => {
    // Act + Assert — UNRECORDED has no parent row in `videos`
    expect(() =>
      repo.recordSnapshot(UNRECORDED, { viewCount: 1 })
    ).toThrow();

    // And no orphan row was written
    const count = dbm
      .prepare<[VideoId], { c: number }>(
        'SELECT COUNT(*) AS c FROM video_statistics WHERE video_id = ?'
      )
      .get(UNRECORDED);
    expect(count?.c).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Rollback discipline
// --------------------------------------------------------------------------

describe('StatisticsRepository — rollback discipline', () => {
  let dbm: DatabaseManager;
  let repo: StatisticsRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new StatisticsRepository(dbm);
    seedVideo(dbm, VIDEO_A, 'seed for rollback');
  });

  afterEach(() => {
    dbm.close();
  });

  it('rolls back recordSnapshot when an outer transaction throws', () => {
    // Arrange — a sentinel error so we know exactly which throw fired.
    class TestRollbackError extends Error {}

    // Act + Assert — the inner recordSnapshot call writes a row, then the
    // outer transaction throws. better-sqlite3 nests via SAVEPOINTs and
    // the outer rollback must undo the inner write.
    expect(() =>
      dbm.withTransaction(() => {
        repo.recordSnapshot(VIDEO_A, { viewCount: 999 });
        throw new TestRollbackError('boom');
      })
    ).toThrow();

    // No row should remain for VIDEO_A
    const count = dbm
      .prepare<[VideoId], { c: number }>(
        'SELECT COUNT(*) AS c FROM video_statistics WHERE video_id = ?'
      )
      .get(VIDEO_A);
    expect(count?.c).toBe(0);
  });
});

// --------------------------------------------------------------------------
// findLatestByVideoId
// --------------------------------------------------------------------------

describe('StatisticsRepository.findLatestByVideoId', () => {
  let dbm: DatabaseManager;
  let repo: StatisticsRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new StatisticsRepository(dbm);
    seedVideo(dbm, VIDEO_A, 'video A');
    seedVideo(dbm, VIDEO_B, 'video B');
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns null when the video has no snapshots', () => {
    // Act
    const result = repo.findLatestByVideoId(VIDEO_A);

    // Assert
    expect(result).toBeNull();
  });

  it('returns the most recently inserted snapshot (id tiebreaker)', () => {
    // Arrange — three snapshots, growing view_count. With SQLite's
    // 1-second CURRENT_TIMESTAMP granularity we cannot rely on
    // recorded_at to distinguish back-to-back inserts; the repository's
    // `ORDER BY recorded_at DESC, id DESC` falls back to id, which IS
    // monotonic.
    repo.recordSnapshot(VIDEO_A, { viewCount: 1, likeCount: 1, commentCount: 1 });
    repo.recordSnapshot(VIDEO_A, { viewCount: 2, likeCount: 2, commentCount: 2 });
    repo.recordSnapshot(VIDEO_A, { viewCount: 3, likeCount: 3, commentCount: 3 });

    // Act
    const latest = repo.findLatestByVideoId(VIDEO_A);

    // Assert
    expect(latest).not.toBeNull();
    expect(latest?.view_count).toBe(3);
    expect(latest?.like_count).toBe(3);
    expect(latest?.comment_count).toBe(3);
  });

  it('isolates results between videos', () => {
    // Arrange
    repo.recordSnapshot(VIDEO_A, { viewCount: 100 });
    repo.recordSnapshot(VIDEO_B, { viewCount: 200 });

    // Act
    const a = repo.findLatestByVideoId(VIDEO_A);
    const b = repo.findLatestByVideoId(VIDEO_B);

    // Assert
    expect(a?.video_id).toBe(VIDEO_A);
    expect(a?.view_count).toBe(100);
    expect(b?.video_id).toBe(VIDEO_B);
    expect(b?.view_count).toBe(200);
  });
});

// --------------------------------------------------------------------------
// findHistoryByVideoId
// --------------------------------------------------------------------------

describe('StatisticsRepository.findHistoryByVideoId', () => {
  let dbm: DatabaseManager;
  let repo: StatisticsRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new StatisticsRepository(dbm);
    seedVideo(dbm, VIDEO_A, 'video A');
    seedVideo(dbm, VIDEO_B, 'video B');
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns an empty array when no snapshots exist', () => {
    // Act
    const history = repo.findHistoryByVideoId(VIDEO_A);

    // Assert
    expect(history).toEqual([]);
  });

  it('returns all snapshots in chronological insertion order', () => {
    // Arrange — three inserts whose order we know
    repo.recordSnapshot(VIDEO_A, { viewCount: 10 });
    repo.recordSnapshot(VIDEO_A, { viewCount: 20 });
    repo.recordSnapshot(VIDEO_A, { viewCount: 30 });

    // Act
    const history = repo.findHistoryByVideoId(VIDEO_A);

    // Assert — three rows, viewCount monotonically increasing
    expect(history).toHaveLength(3);
    expect(history[0]?.view_count).toBe(10);
    expect(history[1]?.view_count).toBe(20);
    expect(history[2]?.view_count).toBe(30);
  });

  it('does not include snapshots for other videos', () => {
    // Arrange
    repo.recordSnapshot(VIDEO_A, { viewCount: 1 });
    repo.recordSnapshot(VIDEO_B, { viewCount: 2 });
    repo.recordSnapshot(VIDEO_A, { viewCount: 3 });

    // Act
    const aHistory = repo.findHistoryByVideoId(VIDEO_A);
    const bHistory = repo.findHistoryByVideoId(VIDEO_B);

    // Assert
    expect(aHistory).toHaveLength(2);
    expect(bHistory).toHaveLength(1);
    expect(aHistory.every((r) => r.video_id === VIDEO_A)).toBe(true);
    expect(bHistory.every((r) => r.video_id === VIDEO_B)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// aggregateTotalsAcrossVideos
// --------------------------------------------------------------------------

describe('StatisticsRepository.aggregateTotalsAcrossVideos', () => {
  let dbm: DatabaseManager;
  let repo: StatisticsRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new StatisticsRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns a zeroed totals row on an empty table', () => {
    // Act
    const totals = repo.aggregateTotalsAcrossVideos();

    // Assert
    expect(totals).toEqual({
      totalViews: 0,
      totalLikes: 0,
      totalComments: 0,
      videoCount: 0,
    });
  });

  it('sums only the LATEST snapshot per video, not the full history', () => {
    // Arrange — VIDEO_A has 3 snapshots (1, 10, 100), VIDEO_B has 2 (5, 50)
    seedVideo(dbm, VIDEO_A, 'video A');
    seedVideo(dbm, VIDEO_B, 'video B');

    repo.recordSnapshot(VIDEO_A, { viewCount: 1, likeCount: 1, commentCount: 1 });
    repo.recordSnapshot(VIDEO_A, { viewCount: 10, likeCount: 2, commentCount: 2 });
    repo.recordSnapshot(VIDEO_A, { viewCount: 100, likeCount: 3, commentCount: 3 });

    repo.recordSnapshot(VIDEO_B, { viewCount: 5, likeCount: 4, commentCount: 4 });
    repo.recordSnapshot(VIDEO_B, { viewCount: 50, likeCount: 5, commentCount: 5 });

    // Act
    const totals = repo.aggregateTotalsAcrossVideos();

    // Assert — sum of LATEST only: 100 + 50 = 150 (not 1+10+100+5+50=166)
    expect(totals.totalViews).toBe(150);
    expect(totals.totalLikes).toBe(8); // latest A=3, latest B=5
    expect(totals.totalComments).toBe(8); // latest A=3, latest B=5
    expect(totals.videoCount).toBe(2);
  });

  it('excludes videos with zero snapshots from videoCount', () => {
    // Arrange — VIDEO_A has snapshots, VIDEO_B is seeded but never snapped
    seedVideo(dbm, VIDEO_A, 'video A');
    seedVideo(dbm, VIDEO_B, 'video B (no snapshots)');
    repo.recordSnapshot(VIDEO_A, { viewCount: 42 });

    // Act
    const totals = repo.aggregateTotalsAcrossVideos();

    // Assert
    expect(totals.videoCount).toBe(1);
    expect(totals.totalViews).toBe(42);
  });
});

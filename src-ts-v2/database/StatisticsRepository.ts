/**
 * StatisticsRepository — v2 port of `legacy/python/src/database/repository.py`
 * `class StatisticsRepository`.
 *
 * Important semantic note about the Python original (and this port):
 *
 *   The `video_statistics` table is APPEND-ONLY HISTORY, not key/value.
 *   The schema declares no UNIQUE constraint on `video_id` — every call to
 *   `add_snapshot` (Python) / `recordSnapshot` (here) inserts a new row.
 *   Therefore "upsert" is the wrong mental model for this table; there is
 *   no in-place update path. "Latest" is computed by sorting by
 *   `recorded_at` DESC.
 *
 * The public method names reflect this:
 *   - `recordSnapshot` — append a new statistics row (the only write path)
 *   - `findLatestByVideoId` — most recent snapshot (Python `get_latest`)
 *   - `findHistoryByVideoId` — full ordered history (Python `get_history`)
 *   - `aggregateTotalsAcrossVideos` — sum of latest views/likes/comments,
 *     one snapshot per video. Aggregation surface mirrors the consumer
 *     pattern in `legacy/python/src/reports/html_generator.py:280-284`.
 *
 * Invariants enforced at this layer:
 *   1. ALL writes go through `DatabaseManager.withTransaction<T>()` — there
 *      is no other public write path on the manager.
 *   2. ALL reads parse rows through `VideoStatisticRowSchema` before
 *      handing them back. Callers never see an unvalidated SQLite row.
 *   3. `videoId` parameters are branded `VideoId` — raw strings are
 *      compile-time-rejected at the call site.
 */

import type { Database } from 'better-sqlite3';

import { DatabaseError } from '../errors/index.js';
import { VideoStatisticRowSchema, type VideoStatisticRow } from '../schemas/db.js';
import type { VideoId } from '../types/branded.js';
import logger from '../utils/logger.js';
import type { DatabaseManager } from './connection.js';

/**
 * Inbound shape for a statistics snapshot. Matches the Python `stats` dict
 * passed to `add_snapshot`: `view_count`, `like_count`, `comment_count`,
 * each optional and defaulting to 0 on the DB side.
 *
 * Counts are non-negative integers (YouTube API contract). We do not
 * enforce non-negativity at this layer — the schema's `z.number().int()`
 * is the wire-boundary check; this DTO is a TS-only shape for the
 * write-path argument.
 */
export interface StatisticsInput {
  readonly viewCount?: number;
  readonly likeCount?: number;
  readonly commentCount?: number;
}

/**
 * Aggregated totals across all videos' LATEST snapshot. Mirrors the
 * Python report-generator pattern (sum the most recent snapshot per
 * video; do NOT sum the full history, which would double-count).
 */
export interface StatisticsTotals {
  readonly totalViews: number;
  readonly totalLikes: number;
  readonly totalComments: number;
  readonly videoCount: number;
}

const COLUMNS = 'id, video_id, view_count, like_count, comment_count, recorded_at';

/**
 * Repository for `video_statistics`. Constructed once per logical context
 * with a `DatabaseManager` (never a global singleton).
 */
export class StatisticsRepository {
  private readonly dbm: DatabaseManager;

  constructor(dbm: DatabaseManager) {
    this.dbm = dbm;
  }

  /**
   * Append a new statistics snapshot for `videoId`. Runs inside a single
   * `withTransaction` — any thrown error rolls back. The newly inserted
   * row is read back and Zod-parsed before being returned, so callers
   * always get a validated `VideoStatisticRow`.
   *
   * @param videoId - Branded YouTube video id. The associated row in
   *                  `videos` must exist (FK constraint).
   * @param stats   - Snapshot counts. Missing fields default to 0 to
   *                  match Python's `stats.get('...', 0)` semantics.
   * @returns The persisted row, validated by `VideoStatisticRowSchema`.
   * @throws {DatabaseError} On any SQLite failure (including FK violation
   *                         when the parent `videos` row is missing).
   */
  recordSnapshot(videoId: VideoId, stats: StatisticsInput): VideoStatisticRow {
    return this.dbm.withTransaction((db: Database): VideoStatisticRow => {
      const viewCount = stats.viewCount ?? 0;
      const likeCount = stats.likeCount ?? 0;
      const commentCount = stats.commentCount ?? 0;

      const insertResult = db
        .prepare(
          `INSERT INTO video_statistics (video_id, view_count, like_count, comment_count)
           VALUES (?, ?, ?, ?)`
        )
        .run(videoId, viewCount, likeCount, commentCount);

      const insertedId = Number(insertResult.lastInsertRowid);

      const raw = db
        .prepare(`SELECT ${COLUMNS} FROM video_statistics WHERE id = ?`)
        .get(insertedId);

      if (raw === undefined) {
        throw new DatabaseError('Inserted statistics row could not be read back', {
          operation: 'recordSnapshot',
          table: 'video_statistics',
          context: { videoId, insertedId },
        });
      }

      const parsed = VideoStatisticRowSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DatabaseError('video_statistics row failed schema validation', {
          operation: 'recordSnapshot',
          table: 'video_statistics',
          cause: parsed.error,
          context: { videoId, insertedId },
        });
      }

      logger.debug(
        {
          videoId,
          insertedId,
          viewCount,
          likeCount,
          commentCount,
        },
        'StatisticsRepository.recordSnapshot committed'
      );

      return parsed.data;
    });
  }

  /**
   * Return the most recent snapshot for `videoId`, or `null` if no
   * snapshots have ever been recorded for this video.
   *
   * Mirrors Python `StatisticsRepository.get_latest`.
   *
   * @param videoId - Branded video id to look up.
   * @returns The validated newest row, or `null` if none exist.
   * @throws {DatabaseError} If a row exists but fails schema validation.
   */
  findLatestByVideoId(videoId: VideoId): VideoStatisticRow | null {
    const raw = this.dbm
      .prepare<[VideoId], unknown>(
        `SELECT ${COLUMNS}
         FROM video_statistics
         WHERE video_id = ?
         ORDER BY recorded_at DESC, id DESC
         LIMIT 1`
      )
      .get(videoId);

    if (raw === undefined) {
      return null;
    }

    const parsed = VideoStatisticRowSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DatabaseError('video_statistics row failed schema validation', {
        operation: 'findLatestByVideoId',
        table: 'video_statistics',
        cause: parsed.error,
        context: { videoId },
      });
    }

    return parsed.data;
  }

  /**
   * Return every snapshot for `videoId` in chronological order
   * (oldest first). Returns an empty array if no snapshots exist.
   *
   * Mirrors Python `StatisticsRepository.get_history`.
   *
   * @param videoId - Branded video id to look up.
   * @returns Array of validated rows, ordered by `recorded_at ASC`.
   * @throws {DatabaseError} If any row fails schema validation.
   */
  findHistoryByVideoId(videoId: VideoId): VideoStatisticRow[] {
    const rows = this.dbm
      .prepare<[VideoId], unknown>(
        `SELECT ${COLUMNS}
         FROM video_statistics
         WHERE video_id = ?
         ORDER BY recorded_at ASC, id ASC`
      )
      .all(videoId);

    return rows.map((raw, index) => {
      const parsed = VideoStatisticRowSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DatabaseError('video_statistics row failed schema validation', {
          operation: 'findHistoryByVideoId',
          table: 'video_statistics',
          cause: parsed.error,
          context: { videoId, rowIndex: index },
        });
      }
      return parsed.data;
    });
  }

  /**
   * Aggregate the latest snapshot of every video into a single totals
   * object. Implements the read-side pattern used by the v1 report
   * generator (`legacy/python/src/reports/html_generator.py`):
   * iterate videos, pick latest stats per video, sum.
   *
   * NULL counts (the SQLite default if a row was inserted without a
   * value) are coalesced to 0 via `COALESCE(...)` so the totals stay
   * numeric.
   *
   * @returns Summed counts across the latest snapshot of every video
   *          that has at least one snapshot. Videos with no snapshots
   *          do not contribute.
   * @throws {DatabaseError} On SQL failure.
   */
  aggregateTotalsAcrossVideos(): StatisticsTotals {
    interface TotalsRow {
      total_views: number | null;
      total_likes: number | null;
      total_comments: number | null;
      video_count: number | null;
    }

    // "Latest" must match the canonical definition used by
    // `findLatestByVideoId` / `findHistoryByVideoId`:
    // ORDER BY recorded_at DESC, id DESC (id as tie-breaker on
    // identical timestamps). The previous MAX(id) approach picked the
    // numerically-highest insert id, which skews totals when a late
    // backfill inserts an older snapshot. We use a per-video window to
    // pick row #1 under the canonical ordering.
    const raw = this.dbm
      .prepare<[], TotalsRow>(
        `SELECT
           COALESCE(SUM(latest.view_count), 0)    AS total_views,
           COALESCE(SUM(latest.like_count), 0)    AS total_likes,
           COALESCE(SUM(latest.comment_count), 0) AS total_comments,
           COUNT(*)                                AS video_count
         FROM (
           SELECT vs.video_id,
                  vs.view_count,
                  vs.like_count,
                  vs.comment_count,
                  ROW_NUMBER() OVER (
                    PARTITION BY vs.video_id
                    ORDER BY vs.recorded_at DESC, vs.id DESC
                  ) AS rn
           FROM video_statistics vs
         ) AS latest
         WHERE latest.rn = 1`
      )
      .get();

    if (raw === undefined) {
      // Even on an empty table, the outer SELECT returns one zeroed row.
      // An undefined result here is genuinely unexpected.
      throw new DatabaseError('aggregateTotalsAcrossVideos returned no row', {
        operation: 'aggregateTotalsAcrossVideos',
        table: 'video_statistics',
      });
    }

    return {
      totalViews: raw.total_views ?? 0,
      totalLikes: raw.total_likes ?? 0,
      totalComments: raw.total_comments ?? 0,
      videoCount: raw.video_count ?? 0,
    };
  }
}

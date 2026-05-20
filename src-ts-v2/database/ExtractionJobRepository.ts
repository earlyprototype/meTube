/**
 * ExtractionJobRepository — audit-trail rows for playlist / video / update
 * extraction runs.
 *
 * Ported from `legacy/python/src/database/repository.py:ExtractionJobRepository`
 * (lines 283-319). This repository was ABSENT from v1's current TS code —
 * restored as part of Phase 2 Wave 2.
 *
 * Invariants enforced here (matching v2 cross-cutting invariants):
 *
 *   1. Every write goes through `DatabaseManager.withTransaction<T>()`. There
 *      is no path through this class that mutates the DB outside a
 *      transaction.
 *   2. Status strings are narrowed via `ExtractionJobStatusSchema` before
 *      they touch the DB. Random strings as `status` are rejected with
 *      `ValidationError`.
 *   3. Reads parse rows through `ExtractionJobRowSchema` before returning
 *      to the caller. A schema-broken row from SQLite throws instead of
 *      silently propagating as a stale TS shape.
 *   4. `PlaylistId` is branded in and out where the column references one.
 *      The DB stores it as a raw `TEXT`; the repository surface keeps the
 *      brand so callers cannot confuse a `PlaylistId` with a `VideoId`.
 *
 * The Python `update_status(**kwargs)` API is replaced with a typed
 * `UpdateStatusOptions` object — Python's loose `setattr` loop allowed
 * silent typos (`viedos_found=...`) to no-op without warning. TS surfaces
 * those as compile errors.
 */

import { DatabaseError, ValidationError } from '../errors/index.js';
import {
  ExtractionJobRowSchema,
  ExtractionJobStatusSchema,
  type ExtractionJobRow,
  type ExtractionJobStatus,
} from '../schemas/db.js';
import type { PlaylistId } from '../types/index.js';
import logger from '../utils/logger.js';
import type { DatabaseManager } from './connection.js';

/**
 * Input shape for `create()`. Mirrors the Python call sites
 * (`video_extractor.py:277-281` etc.) — `playlist_id`, `job_type`, and an
 * optional starting `status`. `started_at` is populated by the repository
 * (Python did `started_at=datetime.now()` unconditionally; v2 does the same
 * via the same UTC-ISO string format SQLite uses for `CURRENT_TIMESTAMP`).
 */
export interface ExtractionJobInput {
  /** Branded playlist ID, or `null` for video-/update-typed jobs that have no parent playlist. */
  readonly playlist_id: PlaylistId | null;
  /** Free-form job classifier. Python uses `'playlist'`, `'video'`, `'update'`. */
  readonly job_type: string;
  /** Initial status. Optional — defaults to `'pending'` to match the DB default. */
  readonly status?: ExtractionJobStatus;
  /** Initial counters. Optional — default to 0 to match the DB defaults. */
  readonly videos_found?: number;
  readonly videos_processed?: number;
  readonly new_videos?: number;
}

/**
 * Optional fields accepted by `updateStatus()`. Replaces Python's
 * `**kwargs` with explicit, typed columns. Adding a new field here is the
 * deliberate way to extend the surface; it cannot be done by silent typo.
 */
export interface UpdateStatusOptions {
  readonly videos_found?: number;
  readonly videos_processed?: number;
  readonly new_videos?: number;
  readonly error_message?: string | null;
  /**
   * Explicit `completed_at` override. When omitted, transitioning to
   * `'completed'` or `'failed'` auto-stamps the current time; transitioning
   * to `'pending'` or `'running'` does not touch `completed_at`.
   */
  readonly completed_at?: string | null;
}

/**
 * `id` column type for extraction jobs. SQLite's
 * `INTEGER PRIMARY KEY AUTOINCREMENT` returns `number | bigint` in
 * better-sqlite3 (bigint for values past 2^53); accept both at the API,
 * normalise to `number` internally.
 */
export type ExtractionJobId = number | bigint;

const TABLE = 'extraction_jobs';

/**
 * Statuses that cause `completed_at` to be auto-stamped when callers do not
 * pass an explicit value. Matches the Python behaviour for `'completed'`
 * and extends it to `'failed'` — a failure is also a terminal state, and
 * leaving `completed_at` null on a failed job loses signal.
 */
const TERMINAL_STATUSES: ReadonlySet<ExtractionJobStatus> = new Set<ExtractionJobStatus>([
  'completed',
  'failed',
]);

/**
 * Statuses considered "active" — used by `findActive()`.
 */
const ACTIVE_STATUSES: ReadonlyArray<ExtractionJobStatus> = ['pending', 'running'];

/**
 * Repository for the `extraction_jobs` table. One instance per
 * `DatabaseManager`. Stateless beyond the held DB reference.
 */
export class ExtractionJobRepository {
  constructor(private readonly db: DatabaseManager) {}

  /**
   * Create a new extraction-job row. Auto-populates `started_at` with the
   * current UTC time (ISO string, second precision — matches the format
   * SQLite emits for `CURRENT_TIMESTAMP`).
   *
   * @param input - Job metadata.
   * @returns The freshly-inserted row, validated through `ExtractionJobRowSchema`.
   * @throws {ValidationError} If `input.status` is not a known
   *                           `ExtractionJobStatus`.
   * @throws {DatabaseError} If the underlying INSERT or read-back fails.
   */
  create(input: ExtractionJobInput): ExtractionJobRow {
    const status = input.status ?? 'pending';
    // Narrow even the optional path — defends against `as` casts at the
    // call site.
    const parsedStatus = ExtractionJobStatusSchema.safeParse(status);
    if (!parsedStatus.success) {
      throw new ValidationError('Invalid extraction-job status', {
        field: 'status',
        value: status,
        context: { operation: 'create' },
      });
    }

    const startedAt = nowIso();

    return this.db.withTransaction<ExtractionJobRow>((handle) => {
      const insert = handle.prepare(
        `INSERT INTO ${TABLE}
           (playlist_id, job_type, status, videos_found, videos_processed,
            new_videos, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const result = insert.run(
        input.playlist_id,
        input.job_type,
        parsedStatus.data,
        input.videos_found ?? 0,
        input.videos_processed ?? 0,
        input.new_videos ?? 0,
        startedAt
      );

      const rowId = result.lastInsertRowid;
      const raw = handle
        .prepare(`SELECT * FROM ${TABLE} WHERE id = ?`)
        .get(rowId);
      if (raw === undefined) {
        // Should be impossible inside the same transaction, but surface
        // honestly if SQLite ever disagrees.
        throw new DatabaseError('INSERT returned no row on read-back', {
          operation: 'create',
          table: TABLE,
          context: { rowId: String(rowId) },
        });
      }
      logger.debug({ rowId: String(rowId), status: parsedStatus.data }, 'extraction job created');
      return ExtractionJobRowSchema.parse(raw);
    });
  }

  /**
   * Update an existing job's status and optional counter / error fields.
   *
   * Behaviour notes:
   *   - `status` is parsed via `ExtractionJobStatusSchema`; arbitrary
   *     strings throw `ValidationError`.
   *   - Transitioning to a terminal status (`'completed'` or `'failed'`)
   *     auto-stamps `completed_at` with the current UTC ISO time unless the
   *     caller passes an explicit `completed_at` (including `null` to
   *     suppress the auto-stamp).
   *   - If the job ID does not exist, returns `null` — matching Python's
   *     behaviour (silent no-op when filter returned no row). Callers that
   *     care about presence should `findById()` first.
   *
   * @returns The updated row, or `null` if no row matched `jobId`.
   */
  updateStatus(
    jobId: ExtractionJobId,
    status: ExtractionJobStatus,
    opts: UpdateStatusOptions = {}
  ): ExtractionJobRow | null {
    const parsedStatus = ExtractionJobStatusSchema.safeParse(status);
    if (!parsedStatus.success) {
      throw new ValidationError('Invalid extraction-job status', {
        field: 'status',
        value: status,
        context: { operation: 'updateStatus', jobId: String(jobId) },
      });
    }

    return this.db.withTransaction<ExtractionJobRow | null>((handle) => {
      const existing = handle
        .prepare(`SELECT id FROM ${TABLE} WHERE id = ?`)
        .get(jobId);
      if (existing === undefined) {
        logger.debug({ jobId: String(jobId) }, 'updateStatus: job not found');
        return null;
      }

      // Decide completed_at:
      //   - explicit value (including null) wins
      //   - terminal status without explicit value: stamp now
      //   - non-terminal status without explicit value: leave alone
      const explicitCompletedAt = Object.prototype.hasOwnProperty.call(
        opts,
        'completed_at'
      );
      const completedAtSentinel: string | null | undefined = explicitCompletedAt
        ? (opts.completed_at ?? null)
        : TERMINAL_STATUSES.has(parsedStatus.data)
          ? nowIso()
          : undefined;

      // Build the UPDATE dynamically over the columns that were actually
      // supplied. Keeps the SQL minimal and avoids overwriting unrelated
      // fields with `undefined` -> NULL.
      const sets: string[] = ['status = ?'];
      const params: Array<unknown> = [parsedStatus.data];

      if (opts.videos_found !== undefined) {
        sets.push('videos_found = ?');
        params.push(opts.videos_found);
      }
      if (opts.videos_processed !== undefined) {
        sets.push('videos_processed = ?');
        params.push(opts.videos_processed);
      }
      if (opts.new_videos !== undefined) {
        sets.push('new_videos = ?');
        params.push(opts.new_videos);
      }
      if (Object.prototype.hasOwnProperty.call(opts, 'error_message')) {
        sets.push('error_message = ?');
        params.push(opts.error_message ?? null);
      }
      if (completedAtSentinel !== undefined) {
        sets.push('completed_at = ?');
        params.push(completedAtSentinel);
      }

      params.push(jobId);
      handle
        .prepare(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params);

      const raw = handle
        .prepare(`SELECT * FROM ${TABLE} WHERE id = ?`)
        .get(jobId);
      logger.debug(
        { jobId: String(jobId), status: parsedStatus.data },
        'extraction job updated'
      );
      return ExtractionJobRowSchema.parse(raw);
    });
  }

  /**
   * Look up a job by its primary key.
   *
   * @returns The row, or `null` if no row matched.
   */
  findById(jobId: ExtractionJobId): ExtractionJobRow | null {
    const raw = this.db
      .prepare<readonly [ExtractionJobId], unknown>(
        `SELECT * FROM ${TABLE} WHERE id = ?`
      )
      .get(jobId);
    if (raw === undefined) {
      return null;
    }
    return ExtractionJobRowSchema.parse(raw);
  }

  /**
   * All jobs for a given playlist, most recent first.
   *
   * @param playlistId - Branded playlist ID.
   * @returns Array of rows (possibly empty).
   */
  findByPlaylistId(playlistId: PlaylistId): ExtractionJobRow[] {
    const rows = this.db
      .prepare<readonly [PlaylistId], unknown>(
        `SELECT * FROM ${TABLE}
         WHERE playlist_id = ?
         ORDER BY started_at DESC, id DESC`
      )
      .all(playlistId);
    return rows.map((row) => ExtractionJobRowSchema.parse(row));
  }

  /**
   * Jobs currently `pending` or `running`, oldest first (so callers see
   * the longest-running job at the top of the list).
   */
  findActive(): ExtractionJobRow[] {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare<readonly string[], unknown>(
        `SELECT * FROM ${TABLE}
         WHERE status IN (${placeholders})
         ORDER BY started_at ASC, id ASC`
      )
      .all(...ACTIVE_STATUSES);
    return rows.map((row) => ExtractionJobRowSchema.parse(row));
  }

  /**
   * Most-recent N jobs across the whole table, newest first. Mirrors
   * Python's `get_recent(limit=10)`.
   *
   * @param limit - Maximum rows to return. Defaults to 10. Must be a
   *                positive integer.
   * @throws {ValidationError} If `limit` is not a positive integer.
   */
  findRecent(limit = 10): ExtractionJobRow[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ValidationError('limit must be a positive integer', {
        field: 'limit',
        value: limit,
        context: { operation: 'findRecent' },
      });
    }
    const rows = this.db
      .prepare<readonly [number], unknown>(
        `SELECT * FROM ${TABLE}
         ORDER BY started_at DESC, id DESC
         LIMIT ?`
      )
      .all(limit);
    return rows.map((row) => ExtractionJobRowSchema.parse(row));
  }

  /**
   * Count jobs by status. Convenience for dashboards / health checks.
   *
   * @returns Map keyed by status; absent statuses count as 0.
   */
  countByStatus(): Record<ExtractionJobStatus, number> {
    const rows = this.db
      .prepare<readonly [], { status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM ${TABLE} GROUP BY status`
      )
      .all();
    const result: Record<ExtractionJobStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    };
    for (const row of rows) {
      const parsed = ExtractionJobStatusSchema.safeParse(row.status);
      if (parsed.success) {
        result[parsed.data] = row.n;
      }
    }
    return result;
  }
}

/**
 * UTC ISO timestamp, second precision. Matches the format SQLite emits for
 * `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`) by trimming the `T` and
 * milliseconds — keeps stored timestamps comparable as plain strings.
 */
function nowIso(): string {
  // `2026-05-20T12:34:56.789Z` -> `2026-05-20 12:34:56`
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

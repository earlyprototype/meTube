/**
 * v2 VideoRepository — repository for the `videos` table.
 *
 * Discipline:
 *   1. ALL writes go through `DatabaseManager.withTransaction(db => ...)`.
 *      There is no `this.db.run(...)` or raw `db.prepare(...).run(...)`
 *      outside a transaction in this file — verified by the sibling
 *      transaction-discipline test.
 *   2. ALL row outputs are parsed through `VideoRowSchema` before being
 *      shaped into `VideoRecord` and returned. Raw row maps never leak.
 *   3. Single-video inputs and outputs use branded `VideoId`, not raw
 *      `string`. The only ways into a `VideoId` are `asVideoId` (throws on
 *      malformed input) and `tryAsVideoId` (returns null).
 *
 * Ported from `legacy/python/src/database/repository.py:VideoRepository`.
 * Method-by-method correspondence:
 *
 *   Python                          | TypeScript v2
 *   --------------------------------+--------------------------------
 *   create_or_update(session, data) | createOrUpdate(input)
 *   get_by_video_id(session, id)    | findById(videoId)
 *   get_all(session, shorts_only)   | findAll({ shortsOnly, limit, offset })
 *   get_by_channel(session, cid)    | findByChannel(channelId)
 *   search(session, q)              | search(queryText)
 *   (n/a in Python — via cascade)   | delete(videoId)
 *   (n/a in Python — via filter)    | findByPlaylist(playlistId)
 *   (n/a in Python — via count)     | exists(videoId)
 *
 * `delete`, `findByPlaylist`, and `exists` are required by the Ink layer
 * (see `src-ts/{commands,components,extractors,reports}` consumers) and
 * by Phase 1 Python code that exercised them via inline SQLAlchemy
 * queries rather than via the repository class.
 */

import type { Database } from 'better-sqlite3';

import { DatabaseError, ValidationError } from '../errors/index.js';
import {
  VideoRowSchema,
  type VideoRow,
} from '../schemas/db.js';
import {
  asVideoId,
  asPlaylistId,
  type PlaylistId,
  type VideoId,
} from '../types/index.js';
import logger from '../utils/logger.js';
import { DatabaseManager } from './connection.js';

/**
 * Domain-shaped video record returned by `VideoRepository` methods.
 *
 * Mirrors `VideoRow` from `schemas/db.ts` column-for-column, with one
 * branding swap: `video_id` is exposed as a branded `VideoId` (re-derived
 * via `asVideoId` after the Zod parse), so callers receive an ID type
 * they cannot accidentally substitute with a `PlaylistId` or raw string.
 *
 * The 0/1-as-boolean SQLite columns (`is_short`, `caption`,
 * `licensed_content`) stay as integers here — converting to `boolean` is
 * a caller-side concern, and the underlying row schema models the wire
 * truth.
 */
export interface VideoRecord {
  readonly id?: number;
  readonly video_id: VideoId;
  readonly title: string;
  readonly description?: string | null;
  readonly channel_id: string;
  readonly channel_title: string;
  readonly published_at: string;
  readonly duration: string;
  readonly duration_seconds: number;
  readonly is_short: number;
  readonly category_id?: string | null;
  readonly category_name?: string | null;
  readonly definition?: string | null;
  readonly caption?: number | null;
  readonly licensed_content?: number | null;
  readonly created_at?: string;
  readonly updated_at?: string;
}

/**
 * Input shape for `createOrUpdate`. `video_id` is required and branded;
 * every other column is optional and may be partially supplied (the
 * Python repository supports patch-style updates and so do we).
 *
 * The repository owns the wire-shape contract — callers do not need to
 * know which fields are nullable in SQLite, only that:
 *
 *   - `video_id` (branded) is mandatory
 *   - On INSERT: all NOT-NULL columns without a SQLite default must be
 *     present; missing ones raise `DatabaseError` from SQLite at write
 *     time. The repository does not pre-validate them because the
 *     `schema.ts` DDL is the single source of truth.
 *   - On UPDATE: any subset of supplied columns is patched.
 */
export interface VideoInput {
  readonly video_id: VideoId;
  readonly title?: string;
  readonly description?: string | null;
  readonly channel_id?: string;
  readonly channel_title?: string;
  readonly published_at?: string;
  readonly duration?: string;
  readonly duration_seconds?: number;
  readonly is_short?: number | boolean;
  readonly category_id?: string | null;
  readonly category_name?: string | null;
  readonly definition?: string | null;
  readonly caption?: number | boolean | null;
  readonly licensed_content?: number | boolean | null;
}

/**
 * Filter options for `findAll`. All fields optional; supply none for a
 * full table scan ordered by insertion ID.
 */
export interface FindAllFilters {
  readonly shortsOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Columns the caller is allowed to set via `createOrUpdate`. Excludes
 * `id` (AUTOINCREMENT) and `video_id` (the row key, supplied separately
 * to the SQL). The set is checked at write-time so callers cannot
 * smuggle in arbitrary column names through `as`-cast.
 */
const WRITABLE_VIDEO_COLUMNS: ReadonlySet<string> = new Set<string>([
  'title',
  'description',
  'channel_id',
  'channel_title',
  'published_at',
  'duration',
  'duration_seconds',
  'is_short',
  'category_id',
  'category_name',
  'definition',
  'caption',
  'licensed_content',
]);

/**
 * Coerce a `VideoInput` value to its SQLite-bindable form. SQLite has no
 * boolean affinity — the `is_short` / `caption` / `licensed_content`
 * columns are INTEGER 0/1, so booleans must be normalised here.
 *
 * `null` is preserved (NULL maps to NULL). `undefined` indicates the
 * caller chose to omit the field and is filtered out before this
 * function is called.
 */
function coerceBindable(value: unknown): string | number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  // Anything else (object, function, symbol, undefined sneaking through)
  // is a programming error from the caller side. Refuse rather than emit
  // a meaningless SQL bind.
  throw new ValidationError('Unsupported value type for videos column', {
    field: 'value',
    value,
  });
}

/**
 * Re-brand a parsed `VideoRow` into the domain-shaped `VideoRecord`.
 * Throws `ValidationError` via `asVideoId` if the stored `video_id`
 * string is somehow malformed (defence in depth: schema.ts has no CHECK
 * constraint on the column shape, so a bad row from a future migration
 * would be caught here rather than silently typed as `VideoId`).
 */
function rowToRecord(row: VideoRow): VideoRecord {
  return {
    id: row.id,
    video_id: asVideoId(row.video_id),
    title: row.title,
    description: row.description ?? null,
    channel_id: row.channel_id,
    channel_title: row.channel_title,
    published_at: row.published_at,
    duration: row.duration,
    duration_seconds: row.duration_seconds,
    is_short: row.is_short,
    category_id: row.category_id ?? null,
    category_name: row.category_name ?? null,
    definition: row.definition ?? null,
    caption: row.caption ?? null,
    licensed_content: row.licensed_content ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Repository for `videos`-table operations. Holds a reference to a
 * `DatabaseManager`; one instance per logical command path (the Ink
 * layer opens one per command, tests open one per `it`).
 */
export class VideoRepository {
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  // ----------------------------------------------------------------
  // Reads
  // ----------------------------------------------------------------

  /**
   * Look up a single video by branded ID.
   *
   * @returns The video record, or `null` if no row matches. Returns
   *          `null` (not `undefined`) so the type-narrowing pattern at
   *          the caller side is uniform.
   * @throws {DatabaseError} On SQL failure.
   * @throws {ValidationError} If the persisted `video_id` cannot be
   *                           re-branded (data corruption sentinel).
   */
  findById(videoId: VideoId): VideoRecord | null {
    try {
      const raw = this.db
        .prepare<[string], unknown>('SELECT * FROM videos WHERE video_id = ?')
        .get(videoId);

      if (raw === undefined || raw === null) {
        return null;
      }

      const parsed = VideoRowSchema.parse(raw);
      return rowToRecord(parsed);
    } catch (error) {
      if (
        error instanceof DatabaseError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      throw new DatabaseError('Failed to load video by ID', {
        operation: 'findById',
        table: 'videos',
        cause: error,
        context: { videoId },
      });
    }
  }

  /**
   * List all videos, optionally restricted to YouTube Shorts and/or
   * paginated. Order is ascending by primary-key `id` (insertion order),
   * matching Python's implicit ORM order.
   *
   * @throws {ValidationError} If `limit` or `offset` are negative.
   * @throws {DatabaseError} On SQL failure.
   */
  findAll(filters: FindAllFilters = {}): VideoRecord[] {
    const { shortsOnly = false, limit, offset } = filters;

    if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
      throw new ValidationError('limit must be a non-negative number', {
        field: 'limit',
        value: limit,
      });
    }
    if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
      throw new ValidationError('offset must be a non-negative number', {
        field: 'offset',
        value: offset,
      });
    }

    const whereClause = shortsOnly ? 'WHERE is_short = 1' : '';
    const limitClause = limit !== undefined ? ' LIMIT ?' : '';
    const offsetClause = offset !== undefined ? ' OFFSET ?' : '';
    const sql = `SELECT * FROM videos ${whereClause} ORDER BY id ASC${limitClause}${offsetClause}`;

    const params: number[] = [];
    if (limit !== undefined) {
      params.push(limit);
    }
    if (offset !== undefined) {
      params.push(offset);
    }

    try {
      const rows = this.db
        .prepare<readonly number[], unknown>(sql)
        .all(...params);

      return rows.map((row) => rowToRecord(VideoRowSchema.parse(row)));
    } catch (error) {
      if (
        error instanceof DatabaseError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      throw new DatabaseError('Failed to list videos', {
        operation: 'findAll',
        table: 'videos',
        cause: error,
        context: { shortsOnly, limit, offset },
      });
    }
  }

  /**
   * List all videos uploaded by a given channel.
   *
   * @throws {ValidationError} If `channelId` is empty.
   * @throws {DatabaseError} On SQL failure.
   */
  findByChannel(channelId: string): VideoRecord[] {
    if (typeof channelId !== 'string' || channelId.length === 0) {
      throw new ValidationError('channelId must be a non-empty string', {
        field: 'channelId',
        value: channelId,
      });
    }

    try {
      const rows = this.db
        .prepare<readonly string[], unknown>(
          'SELECT * FROM videos WHERE channel_id = ? ORDER BY id ASC'
        )
        .all(channelId);

      return rows.map((row) => rowToRecord(VideoRowSchema.parse(row)));
    } catch (error) {
      if (
        error instanceof DatabaseError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      throw new DatabaseError('Failed to list videos by channel', {
        operation: 'findByChannel',
        table: 'videos',
        cause: error,
        context: { channelId },
      });
    }
  }

  /**
   * List all videos in a playlist, ordered by `position` then `added_at`.
   * Required by the Ink "remove playlist" confirmation flow and by the
   * playlist-summary report path.
   *
   * @throws {DatabaseError} On SQL failure.
   */
  findByPlaylist(playlistId: PlaylistId): VideoRecord[] {
    try {
      const rows = this.db
        .prepare<readonly string[], unknown>(
          `SELECT v.* FROM videos v
           JOIN playlist_items pi ON v.video_id = pi.video_id
           WHERE pi.playlist_id = ?
           ORDER BY pi.position, pi.added_at`
        )
        .all(playlistId);

      return rows.map((row) => rowToRecord(VideoRowSchema.parse(row)));
    } catch (error) {
      if (
        error instanceof DatabaseError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      throw new DatabaseError('Failed to list videos by playlist', {
        operation: 'findByPlaylist',
        table: 'videos',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Free-text search across `title` and `description`. Uses SQLite's
   * `LIKE` (case-insensitive for ASCII; SQLite's default `LIKE` is
   * case-insensitive on ASCII characters).
   *
   * @throws {ValidationError} If `queryText` is empty.
   * @throws {DatabaseError} On SQL failure.
   */
  search(queryText: string): VideoRecord[] {
    if (typeof queryText !== 'string' || queryText.length === 0) {
      throw new ValidationError('queryText must be a non-empty string', {
        field: 'queryText',
        value: queryText,
      });
    }

    const pattern = `%${queryText}%`;
    try {
      const rows = this.db
        .prepare<readonly string[], unknown>(
          'SELECT * FROM videos WHERE title LIKE ? OR description LIKE ? ORDER BY id ASC'
        )
        .all(pattern, pattern);

      return rows.map((row) => rowToRecord(VideoRowSchema.parse(row)));
    } catch (error) {
      if (
        error instanceof DatabaseError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      throw new DatabaseError('Failed to search videos', {
        operation: 'search',
        table: 'videos',
        cause: error,
        context: { queryText },
      });
    }
  }

  /**
   * Whether a row with the given `videoId` exists. Cheap COUNT(*).
   *
   * @throws {DatabaseError} On SQL failure.
   */
  exists(videoId: VideoId): boolean {
    try {
      const row = this.db
        .prepare<readonly string[], { c: number }>(
          'SELECT COUNT(*) AS c FROM videos WHERE video_id = ?'
        )
        .get(videoId);
      return (row?.c ?? 0) > 0;
    } catch (error) {
      throw new DatabaseError('Failed to check video existence', {
        operation: 'exists',
        table: 'videos',
        cause: error,
        context: { videoId },
      });
    }
  }

  // ----------------------------------------------------------------
  // Writes (all routed through DatabaseManager.withTransaction)
  // ----------------------------------------------------------------

  /**
   * Upsert a video by `video_id`. INSERTs if no row exists, otherwise
   * UPDATEs every supplied column. Returns the post-write record.
   *
   * Wrapped in `withTransaction` — read-modify-write is atomic so two
   * concurrent callers cannot race the SELECT.
   *
   * @throws {DatabaseError} On SQL failure (transaction is rolled back).
   * @throws {ValidationError} If the input contains an unsupported
   *                           value type or no column survives filtering.
   */
  createOrUpdate(video: VideoInput): VideoRecord {
    if (video.video_id === undefined || video.video_id === null) {
      throw new ValidationError('video_id is required for createOrUpdate', {
        field: 'video_id',
      });
    }

    // Filter the input down to (a) writable columns, (b) defined values.
    // Defined-but-null is preserved (callers may legitimately want to
    // NULL out `description`). Go through `unknown` because `VideoInput`
    // is a closed shape without an index signature, but `Object.entries`
    // typing wants one.
    const columnEntries: Array<readonly [string, unknown]> = Object.entries(
      video as unknown as Record<string, unknown>
    ).filter(
      ([key, value]) =>
        WRITABLE_VIDEO_COLUMNS.has(key) && value !== undefined
    );

    return this.db.withTransaction((db: Database): VideoRecord => {
      const existing = db
        .prepare('SELECT * FROM videos WHERE video_id = ?')
        .get(video.video_id) as unknown;

      if (existing) {
        // UPDATE path. If no writable columns supplied, no-op.
        if (columnEntries.length === 0) {
          const parsed = VideoRowSchema.parse(existing);
          logger.debug(
            { videoId: video.video_id },
            'createOrUpdate: no writable fields supplied, returning existing'
          );
          return rowToRecord(parsed);
        }

        const setClauses = columnEntries
          .map(([key]) => `${key} = ?`)
          .join(', ');
        const updateValues = columnEntries.map(([, value]) =>
          coerceBindable(value)
        );

        db.prepare(
          `UPDATE videos SET ${setClauses}, updated_at = datetime('now')
           WHERE video_id = ?`
        ).run(...updateValues, video.video_id);

        logger.debug(
          { videoId: video.video_id, columns: columnEntries.map(([k]) => k) },
          'createOrUpdate: updated existing video'
        );
      } else {
        // INSERT path. Always includes `video_id`; everything else is
        // optional (NOT-NULL columns missing here will surface as a SQL
        // error which we wrap below).
        const insertEntries: Array<readonly [string, unknown]> = [
          ['video_id', video.video_id],
          ...columnEntries,
        ];

        const columns = insertEntries.map(([key]) => key).join(', ');
        const placeholders = insertEntries.map(() => '?').join(', ');
        const insertValues = insertEntries.map(([, value]) =>
          coerceBindable(value)
        );

        try {
          db.prepare(
            `INSERT INTO videos (${columns}) VALUES (${placeholders})`
          ).run(...insertValues);
        } catch (error) {
          throw new DatabaseError('Failed to insert video', {
            operation: 'createOrUpdate.insert',
            table: 'videos',
            cause: error,
            context: { videoId: video.video_id },
          });
        }

        logger.debug(
          { videoId: video.video_id },
          'createOrUpdate: inserted new video'
        );
      }

      const afterRow = db
        .prepare('SELECT * FROM videos WHERE video_id = ?')
        .get(video.video_id) as unknown;
      if (afterRow === undefined || afterRow === null) {
        throw new DatabaseError(
          'Video disappeared between write and read-back',
          {
            operation: 'createOrUpdate.readBack',
            table: 'videos',
            context: { videoId: video.video_id },
          }
        );
      }
      const parsed = VideoRowSchema.parse(afterRow);
      return rowToRecord(parsed);
    });
  }

  /**
   * Delete a video by branded ID. Cascades to dependent rows via the
   * `ON DELETE CASCADE` foreign keys declared in `schema.ts`
   * (`video_statistics`, `transcripts`, `extracted_entities`,
   * `video_tags`, `playlist_items`, `ai_analysis`).
   *
   * Foreign keys MUST be enabled on the connection for cascade to fire;
   * `DatabaseManager.configurePragmas()` sets `PRAGMA foreign_keys = ON`.
   *
   * @returns `true` if a row was deleted, `false` if no row matched.
   * @throws {DatabaseError} On SQL failure (transaction is rolled back).
   */
  delete(videoId: VideoId): boolean {
    return this.db.withTransaction((db: Database): boolean => {
      const info = db
        .prepare('DELETE FROM videos WHERE video_id = ?')
        .run(videoId);
      const deleted = info.changes > 0;
      if (deleted) {
        logger.debug({ videoId }, 'Deleted video and cascaded children');
      }
      return deleted;
    });
  }
}

/**
 * Convenience helper for tests and callers that need to brand a raw
 * `PlaylistId` for `findByPlaylist`. Kept here so the repository's
 * public surface is self-contained.
 */
export const asPlaylistIdInput = asPlaylistId;

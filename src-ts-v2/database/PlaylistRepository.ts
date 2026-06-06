/**
 * PlaylistRepository — v2 data-access for `playlists`.
 *
 * Ported from `legacy/python/src/database/repository.py:PlaylistRepository`,
 * with shape-discipline grafted on at every boundary:
 *
 *   - WRITES go through `DatabaseManager.withTransaction<T>()` only. There is
 *     no public method on this class that touches the DB outside that
 *     wrapper, so callers cannot smuggle in an out-of-band write.
 *   - READS pull a raw row through the typed `prepare(...).get/all` surface
 *     and *immediately* parse it through `PlaylistRowSchema` before returning.
 *     The caller never sees an unvalidated row.
 *   - Branded `PlaylistId` is the only currency in/out. Construction is
 *     forced through `asPlaylistId(...)` in `types/branded.ts`, so the
 *     Python-era "is this a YouTube ID or a DB row id?" ambiguity is
 *     foreclosed at the type level.
 *
 * Surface (matches the Python class's caller-facing methods plus `exists()`,
 * which the v1 Ink layer relies on at `src-ts/utils/playlistResolver.ts`):
 *
 *   - `findById(playlistId)`         -> Python `get_by_id`
 *   - `findAll(filters?)`            -> Python `get_all(enabled_only)`
 *   - `createOrUpdate(playlist)`     -> Python `create_or_update`
 *   - `delete(playlistId)`           -> Python `delete`
 *   - `exists(playlistId)`           -> v1 addition, called by playlistResolver
 *
 * Returned `Playlist` objects are camelCase, branded, and normalize the
 * SQLite int-as-bool columns (`enabled`) to a real `boolean`. The DB stays
 * in 0/1 land; the application layer never sees that.
 */

import { DatabaseError, ValidationError } from '../errors/index.js';
import {
  PlaylistRowSchema,
  type PlaylistRow,
} from '../schemas/db.js';
import { asPlaylistId, type PlaylistId } from '../types/branded.js';
import logger from '../utils/logger.js';

import type { DatabaseManager } from './connection.js';

/**
 * Domain shape returned by all PlaylistRepository reads. camelCase,
 * branded ID, boolean for `enabled`. Storage shape (snake_case, int 0/1)
 * lives in `PlaylistRowSchema` and never crosses this boundary.
 */
export interface Playlist {
  id: number | undefined;
  playlistId: PlaylistId;
  title: string;
  description: string | null;
  lastChecked: string | null;
  videoCount: number;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Input shape for `createOrUpdate`. All fields beyond `playlistId` are
 * optional — partial updates are allowed (mirrors the Python `setattr`
 * loop). On a fresh insert, SQLite defaults fill `video_count = 0`,
 * `enabled = 1`, and the timestamps.
 */
export interface PlaylistInput {
  playlistId: PlaylistId;
  title?: string;
  description?: string | null;
  lastChecked?: string | null;
  videoCount?: number;
  enabled?: boolean;
}

/**
 * Optional filter for `findAll`. Mirrors Python's `enabled_only=True`
 * default — pass `{ enabledOnly: false }` to include disabled playlists.
 */
export interface PlaylistFilters {
  enabledOnly?: boolean;
}

/**
 * Convert a Zod-parsed `PlaylistRow` (storage shape) into the domain
 * `Playlist` shape used by the application layer.
 */
function rowToDomain(row: PlaylistRow): Playlist {
  return {
    id: row.id,
    playlistId: asPlaylistId(row.playlist_id),
    title: row.title,
    description: row.description ?? null,
    lastChecked: row.last_checked ?? null,
    videoCount: row.video_count ?? 0,
    enabled: (row.enabled ?? 1) === 1,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Parse a raw SQLite row through `PlaylistRowSchema`. Surfaces a
 * `DatabaseError` if the row shape on disk has drifted from the schema —
 * which would mean either schema-version skew or external corruption.
 */
function parseRowOrThrow(raw: unknown, operation: string): PlaylistRow {
  const result = PlaylistRowSchema.safeParse(raw);
  if (!result.success) {
    throw new DatabaseError('playlists row failed schema parse', {
      operation,
      table: 'playlists',
      context: { issues: result.error.issues },
      cause: result.error,
    });
  }
  return result.data;
}

export class PlaylistRepository {
  constructor(private readonly db: DatabaseManager) {}

  /**
   * Find a playlist by its branded YouTube ID. Returns `null` if no row
   * matches — does not throw on miss.
   *
   * @throws {DatabaseError} If the underlying read fails or the row on
   *   disk fails to parse through `PlaylistRowSchema`.
   */
  findById(playlistId: PlaylistId): Playlist | null {
    try {
      const raw = this.db
        .prepare<[string], unknown>(
          'SELECT * FROM playlists WHERE playlist_id = ?'
        )
        .get(playlistId);

      if (raw === undefined) {
        return null;
      }

      const parsed = parseRowOrThrow(raw, 'findById');
      return rowToDomain(parsed);
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Failed to find playlist by ID', {
        operation: 'findById',
        table: 'playlists',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Find all playlists, optionally filtered by enabled status. Mirrors
   * Python's `get_all(enabled_only=True)` default — pass
   * `{ enabledOnly: false }` to include disabled rows.
   *
   * @throws {DatabaseError} If the underlying read fails or any row on
   *   disk fails to parse through `PlaylistRowSchema`.
   */
  findAll(filters: PlaylistFilters = {}): Playlist[] {
    const enabledOnly = filters.enabledOnly ?? true;

    try {
      const sql = enabledOnly
        ? 'SELECT * FROM playlists WHERE enabled = 1 ORDER BY playlist_id'
        : 'SELECT * FROM playlists ORDER BY playlist_id';

      const rows = this.db.prepare<[], unknown>(sql).all();
      return rows.map((raw) => rowToDomain(parseRowOrThrow(raw, 'findAll')));
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Failed to find all playlists', {
        operation: 'findAll',
        table: 'playlists',
        cause: error,
        context: { enabledOnly },
      });
    }
  }

  /**
   * Upsert a playlist. If `playlistId` already exists, every supplied
   * field overwrites the row and `updated_at` is set to `CURRENT_TIMESTAMP`.
   * If it does not exist, a new row is inserted and SQLite defaults fill
   * unsupplied columns.
   *
   * All writes happen inside a single `withTransaction<T>` call — a throw
   * from inside the closure rolls back atomically.
   *
   * @throws {ValidationError} If `title` is required for a new row but
   *   missing.
   * @throws {DatabaseError} If the underlying write fails or the row
   *   cannot be read back.
   */
  createOrUpdate(input: PlaylistInput): Playlist {
    const playlistId = input.playlistId;

    // Pre-flight title check. `withTransaction` re-throws any non-
    // `DatabaseError` as `DatabaseError('Transaction rolled back', ...)`,
    // which would mask the validation cause. Doing the check before the
    // tx keeps the `ValidationError` type intact for the caller.
    //
    // The check needs to know whether this is an INSERT, so it peeks
    // through a separate `exists` lookup. There is a benign race here
    // (row could appear between this check and the tx) but the worst
    // case is: a title is required on insert that races with another
    // insert, the second caller sees a SQLite UNIQUE violation surface
    // as `DatabaseError('Transaction rolled back', ...)` — which is
    // the same outcome as before.
    if (input.title === undefined && !this.exists(playlistId)) {
      throw new ValidationError(
        'title is required when creating a new playlist',
        { field: 'title', value: input.title }
      );
    }

    return this.db.withTransaction((db) => {
      const existingRaw = db
        .prepare('SELECT * FROM playlists WHERE playlist_id = ?')
        .get(playlistId);

      if (existingRaw !== undefined) {
        // UPDATE path. Build the SET clause from supplied fields only;
        // omitted fields keep their existing values. `updated_at` is always
        // refreshed.
        const setClauses: string[] = [];
        const values: unknown[] = [];

        if (input.title !== undefined) {
          setClauses.push('title = ?');
          values.push(input.title);
        }
        if (input.description !== undefined) {
          setClauses.push('description = ?');
          values.push(input.description);
        }
        if (input.lastChecked !== undefined) {
          setClauses.push('last_checked = ?');
          values.push(input.lastChecked);
        }
        if (input.videoCount !== undefined) {
          setClauses.push('video_count = ?');
          values.push(input.videoCount);
        }
        if (input.enabled !== undefined) {
          setClauses.push('enabled = ?');
          values.push(input.enabled ? 1 : 0);
        }

        if (setClauses.length === 0) {
          // Nothing to change — return the existing row. Still parse it
          // so the caller never gets an unvalidated shape back.
          const parsed = parseRowOrThrow(existingRaw, 'createOrUpdate');
          return rowToDomain(parsed);
        }

        setClauses.push("updated_at = CURRENT_TIMESTAMP");
        values.push(playlistId);

        db.prepare(
          `UPDATE playlists SET ${setClauses.join(', ')} WHERE playlist_id = ?`
        ).run(...values);

        logger.info({ playlistId }, 'Playlist updated');
      } else {
        // INSERT path. Python's `Playlist(**data)` is permissive about
        // which columns are supplied; we require `title` because the
        // schema declares it NOT NULL. The pre-flight check above
        // already rejected the no-title case with `ValidationError`;
        // this assertion is a defense-in-depth narrow for the
        // SQLite NOT NULL contract.
        if (input.title === undefined) {
          throw new DatabaseError(
            'title is required when creating a new playlist',
            {
              operation: 'createOrUpdate',
              table: 'playlists',
              context: { playlistId },
            }
          );
        }

        db.prepare(
          `INSERT INTO playlists
             (playlist_id, title, description, last_checked, video_count, enabled)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          playlistId,
          input.title,
          input.description ?? null,
          input.lastChecked ?? null,
          input.videoCount ?? 0,
          input.enabled === undefined ? 1 : input.enabled ? 1 : 0
        );

        logger.info({ playlistId }, 'Playlist created');
      }

      const writtenRaw = db
        .prepare('SELECT * FROM playlists WHERE playlist_id = ?')
        .get(playlistId);

      if (writtenRaw === undefined) {
        throw new DatabaseError(
          'Failed to read back playlist after createOrUpdate',
          {
            operation: 'createOrUpdate',
            table: 'playlists',
            context: { playlistId },
          }
        );
      }

      const parsed = parseRowOrThrow(writtenRaw, 'createOrUpdate');
      return rowToDomain(parsed);
    });
  }

  /**
   * Delete a playlist by branded ID. No-op (no throw) if the row does
   * not exist — matches the Python `.delete()` semantics. Cascade rules
   * declared in `schema.ts` clean up `playlist_items` and the
   * `extraction_jobs` reference automatically.
   *
   * @throws {DatabaseError} If the underlying write fails.
   */
  delete(playlistId: PlaylistId): void {
    this.db.withTransaction((db) => {
      db.prepare('DELETE FROM playlists WHERE playlist_id = ?').run(
        playlistId
      );
    });
    logger.info({ playlistId }, 'Playlist deleted');
  }

  /**
   * Check whether a playlist exists. Cheap COUNT(*); does not parse a
   * full row.
   *
   * @throws {DatabaseError} If the underlying read fails.
   */
  exists(playlistId: PlaylistId): boolean {
    try {
      const row = this.db
        .prepare<[string], { c: number }>(
          'SELECT COUNT(*) AS c FROM playlists WHERE playlist_id = ?'
        )
        .get(playlistId);
      return (row?.c ?? 0) > 0;
    } catch (error) {
      throw new DatabaseError('Failed to check playlist existence', {
        operation: 'exists',
        table: 'playlists',
        cause: error,
        context: { playlistId },
      });
    }
  }
}

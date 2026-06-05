/**
 * Repository for the `playlist_items` join table.
 *
 * Ported from `legacy/python/src/database/repository.py::PlaylistItemRepository`.
 *
 * Discipline carried by this file:
 *   - **All writes go through `DatabaseManager.withTransaction<T>`.** There
 *     is no other write path, by construction of `DatabaseManager`.
 *   - **All reads parse through Zod before leaving the repository.**
 *     Single rows parse through `PlaylistItemRowSchema`; joined rows parse
 *     through `PlaylistItemWithVideoSchema` (defined here, since the join is
 *     a repository-level concern, not a base-table concern).
 *   - **Branded IDs (`PlaylistId`, `VideoId`) at the boundary.** The
 *     repository accepts branded inputs and re-brands the strings it reads
 *     back out — callers never see a raw `string` ID.
 *   - **No SQLAlchemy `joinedload`.** Python relied on the ORM's
 *     relationship-loader to attach `Video` rows; better-sqlite3 has no
 *     equivalent. `getItemsWithVideos` writes the JOIN explicitly.
 *   - **`addVideoToPlaylist` actually inserts.** v1's class of "stub bomb"
 *     bugs (`PlaylistAddMine` / `PlaylistSync` silently producing
 *     `playlist_id: undefined` rows; see `_archivedkanban.md` REVIEW
 *     section, 2026-05-19 audit) is foreclosed here by (a) branded IDs at
 *     the type level, (b) a regression test that asserts row count
 *     actually increased, and (c) FK on `playlist_id` rejecting orphans
 *     loudly at the SQLite layer.
 */

import { z } from 'zod';

import { DatabaseError } from '../errors/index.js';
import {
  PlaylistItemRowSchema,
  VideoRowSchema,
  type PlaylistItemRow,
  type VideoRow,
} from '../schemas/db.js';
import {
  asPlaylistId,
  asVideoId,
  type PlaylistId,
  type VideoId,
} from '../types/branded.js';
import logger from '../utils/logger.js';
import type { DatabaseManager } from './connection.js';

// --------------------------------------------------------------------------
// Joined-row Zod schema
// --------------------------------------------------------------------------

/**
 * Row shape returned by `getItemsWithVideos`. Combines every column of
 * `playlist_items` with every column of the joined `videos` row. We prefix
 * the join-table columns so the merged shape stays unambiguous when both
 * tables expose `id` / `video_id`.
 *
 * SQLite returns column aliases verbatim — the `AS` aliases in the SELECT
 * must match these field names exactly.
 */
export const PlaylistItemWithVideoSchema = z.object({
  // playlist_items columns (prefixed `pi_`)
  pi_id: z.number().int().optional(),
  pi_playlist_id: z.string(),
  pi_video_id: z.string(),
  pi_position: z.number().int().nullable().optional(),
  pi_added_at: z.string(),
  // videos columns (prefixed `v_`)
  v_id: z.number().int().optional(),
  v_video_id: z.string(),
  v_title: z.string(),
  v_description: z.string().nullable().optional(),
  v_channel_id: z.string(),
  v_channel_title: z.string(),
  v_published_at: z.string(),
  v_duration: z.string(),
  v_duration_seconds: z.number().int(),
  v_is_short: z.number().int(),
  v_category_id: z.string().nullable().optional(),
  v_category_name: z.string().nullable().optional(),
  v_definition: z.string().nullable().optional(),
  v_caption: z.number().int().nullable().optional(),
  v_licensed_content: z.number().int().nullable().optional(),
  v_created_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL) — mirrors VideoRowSchema; closes A13 drift
  v_updated_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL) — mirrors VideoRowSchema; closes A13 drift
});

export type PlaylistItemWithVideoRaw = z.infer<typeof PlaylistItemWithVideoSchema>;

/**
 * Caller-facing shape: split back into the two original row shapes after
 * parsing the flat aliased row. This is what `getItemsWithVideos` returns.
 */
export interface PlaylistItemWithVideo {
  readonly item: PlaylistItemRow;
  readonly video: VideoRow;
}

// --------------------------------------------------------------------------
// PlaylistItemRepository
// --------------------------------------------------------------------------

export class PlaylistItemRepository {
  constructor(private readonly db: DatabaseManager) {}

  /**
   * Add a video to a playlist, idempotently.
   *
   * - If the row `(playlistId, videoId)` already exists, returns it
   *   unchanged (no UPDATE).
   * - Otherwise inserts a new row and returns it.
   *
   * Both the lookup and the insert run inside a single transaction so
   * concurrent callers cannot race the existence check. better-sqlite3 is
   * synchronous so this is paranoia, not necessity, but the discipline is
   * the point — every write goes through `withTransaction`.
   *
   * @param playlistId - Branded YouTube playlist ID. Must reference an
   *                     existing row in `playlists` (FK enforced).
   * @param videoId    - Branded YouTube video ID. Must reference an
   *                     existing row in `videos` (FK enforced).
   * @param position   - Optional ordering position. Negative values are
   *                     rejected at the call site (the type-level boundary
   *                     is `number`, but the runtime check below catches
   *                     negative numbers as a defence-in-depth).
   * @param addedAt    - Optional ISO timestamp. Defaults to "now" in UTC.
   * @returns The persisted `PlaylistItemRow` (existing or newly created).
   * @throws {DatabaseError} On FK violation, statement failure, or any
   *                         other SQLite error. Cause is preserved.
   */
  addVideoToPlaylist(
    playlistId: PlaylistId,
    videoId: VideoId,
    position?: number,
    addedAt?: string
  ): PlaylistItemRow {
    if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
      throw new DatabaseError('position must be a non-negative integer', {
        operation: 'addVideoToPlaylist',
        table: 'playlist_items',
        context: { playlistId, videoId, position },
      });
    }

    const added = addedAt ?? new Date().toISOString();

    try {
      const row = this.db.withTransaction((db) => {
        const existing = db
          .prepare(
            'SELECT * FROM playlist_items WHERE playlist_id = ? AND video_id = ?'
          )
          .get(playlistId, videoId) as unknown;

        if (existing !== undefined) {
          return existing;
        }

        const info = db
          .prepare(
            `INSERT INTO playlist_items (playlist_id, video_id, position, added_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(playlistId, videoId, position ?? null, added);

        if (info.changes !== 1) {
          // Guard against the v1 stub-bomb class — if the INSERT silently
          // produces zero rows we want a loud, traceable failure here, not
          // a missing playlist item discovered three commands later.
          throw new DatabaseError(
            'INSERT into playlist_items did not produce a row',
            {
              operation: 'addVideoToPlaylist',
              table: 'playlist_items',
              context: { playlistId, videoId, position, addedAt: added, changes: info.changes },
            }
          );
        }

        const created = db
          .prepare('SELECT * FROM playlist_items WHERE id = ?')
          .get(info.lastInsertRowid) as unknown;

        if (created === undefined) {
          throw new DatabaseError(
            'Failed to read back newly inserted playlist_items row',
            {
              operation: 'addVideoToPlaylist',
              table: 'playlist_items',
              context: { playlistId, videoId, lastInsertRowid: String(info.lastInsertRowid) },
            }
          );
        }

        return created;
      });

      const parsed = PlaylistItemRowSchema.parse(row);
      logger.debug({ playlistId, videoId, position }, 'addVideoToPlaylist resolved');
      return parsed;
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Failed to add video to playlist', {
        operation: 'addVideoToPlaylist',
        table: 'playlist_items',
        cause: error,
        context: { playlistId, videoId, position },
      });
    }
  }

  /**
   * Remove a video from a playlist.
   *
   * @returns `true` if a row was deleted, `false` if the row did not exist.
   */
  removeVideoFromPlaylist(playlistId: PlaylistId, videoId: VideoId): boolean {
    try {
      const changes = this.db.withTransaction((db) => {
        const info = db
          .prepare(
            'DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?'
          )
          .run(playlistId, videoId);
        return info.changes;
      });
      logger.debug({ playlistId, videoId, changes }, 'removeVideoFromPlaylist resolved');
      return changes > 0;
    } catch (error) {
      throw new DatabaseError('Failed to remove video from playlist', {
        operation: 'removeVideoFromPlaylist',
        table: 'playlist_items',
        cause: error,
        context: { playlistId, videoId },
      });
    }
  }

  /**
   * Get every playlist item for a playlist, with the joined `videos` row.
   *
   * Python used SQLAlchemy `joinedload(PlaylistItem.video)` — that does not
   * translate to better-sqlite3. We write the JOIN explicitly here, alias
   * columns with `pi_` / `v_` prefixes so the flat result row is parseable
   * by a single Zod schema, then split into `{ item, video }` pairs for
   * the caller.
   *
   * Ordering matches Python: `ORDER BY pi.position` (NULLs sort last in
   * SQLite by default).
   *
   * @param playlistId - Branded YouTube playlist ID.
   * @returns Items in playlist order, each paired with its `videos` row.
   *          Empty array if the playlist has no items (or does not exist).
   */
  getItemsWithVideos(playlistId: PlaylistId): readonly PlaylistItemWithVideo[] {
    const SQL = `
      SELECT
        pi.id              AS pi_id,
        pi.playlist_id     AS pi_playlist_id,
        pi.video_id        AS pi_video_id,
        pi.position        AS pi_position,
        pi.added_at        AS pi_added_at,
        v.id               AS v_id,
        v.video_id         AS v_video_id,
        v.title            AS v_title,
        v.description      AS v_description,
        v.channel_id       AS v_channel_id,
        v.channel_title    AS v_channel_title,
        v.published_at     AS v_published_at,
        v.duration         AS v_duration,
        v.duration_seconds AS v_duration_seconds,
        v.is_short         AS v_is_short,
        v.category_id      AS v_category_id,
        v.category_name    AS v_category_name,
        v.definition       AS v_definition,
        v.caption          AS v_caption,
        v.licensed_content AS v_licensed_content,
        v.created_at       AS v_created_at,
        v.updated_at       AS v_updated_at
      FROM playlist_items pi
      INNER JOIN videos v ON v.video_id = pi.video_id
      WHERE pi.playlist_id = ?
      ORDER BY pi.position, pi.added_at
    `;

    try {
      const rawRows = this.db
        .prepare<[string], unknown>(SQL)
        .all(playlistId);

      return rawRows.map((raw) => {
        const flat = PlaylistItemWithVideoSchema.parse(raw);

        const item: PlaylistItemRow = {
          id: flat.pi_id,
          playlist_id: flat.pi_playlist_id,
          video_id: flat.pi_video_id,
          position: flat.pi_position,
          added_at: flat.pi_added_at,
        };

        const video: VideoRow = {
          id: flat.v_id,
          video_id: flat.v_video_id,
          title: flat.v_title,
          description: flat.v_description,
          channel_id: flat.v_channel_id,
          channel_title: flat.v_channel_title,
          published_at: flat.v_published_at,
          duration: flat.v_duration,
          duration_seconds: flat.v_duration_seconds,
          is_short: flat.v_is_short,
          category_id: flat.v_category_id,
          category_name: flat.v_category_name,
          definition: flat.v_definition,
          caption: flat.v_caption,
          licensed_content: flat.v_licensed_content,
          created_at: flat.v_created_at,
          updated_at: flat.v_updated_at,
        };

        return { item, video };
      });
    } catch (error) {
      throw new DatabaseError('Failed to load playlist items with videos', {
        operation: 'getItemsWithVideos',
        table: 'playlist_items',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Get the ordered list of `VideoId`s in a playlist.
   *
   * Mirrors Python's `get_videos_in_playlist`. Used by `cli.py:548` and
   * `cli.py:1036` to decide which videos a downstream extractor should
   * process.
   *
   * @returns Branded `VideoId[]` in playlist order. Empty if the playlist
   *          has no items.
   */
  getVideosInPlaylist(playlistId: PlaylistId): readonly VideoId[] {
    try {
      const rows = this.db
        .prepare<[string], unknown>(
          `SELECT video_id FROM playlist_items
           WHERE playlist_id = ?
           ORDER BY position, added_at`
        )
        .all(playlistId);

      // Each row is `{ video_id: string }`. Parse via PlaylistItemRowSchema
      // would require us to include the other columns; using a tiny inline
      // schema here keeps the parse honest without smuggling unparsed
      // values out of the repository.
      const RowSchema = z.object({ video_id: z.string() });
      return rows.map((raw) => asVideoId(RowSchema.parse(raw).video_id));
    } catch (error) {
      throw new DatabaseError('Failed to list video IDs in playlist', {
        operation: 'getVideosInPlaylist',
        table: 'playlist_items',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Get every `playlist_items` row for a playlist, parsed but not joined.
   *
   * Equivalent to v1's `PlaylistItemRepository.getByPlaylist`. Returns the
   * raw join-table rows — callers that want video metadata should use
   * `getItemsWithVideos` instead.
   */
  getItemsByPlaylist(playlistId: PlaylistId): readonly PlaylistItemRow[] {
    try {
      const rows = this.db
        .prepare<[string], unknown>(
          `SELECT * FROM playlist_items
           WHERE playlist_id = ?
           ORDER BY position, added_at`
        )
        .all(playlistId);

      return rows.map((raw) => PlaylistItemRowSchema.parse(raw));
    } catch (error) {
      throw new DatabaseError('Failed to list playlist items', {
        operation: 'getItemsByPlaylist',
        table: 'playlist_items',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Get every playlist that contains a given video.
   *
   * Equivalent to v1's `PlaylistItemRepository.getByVideo`. Returns the
   * raw join-table rows; callers that want playlist metadata should look
   * those up via `PlaylistRepository`.
   */
  getPlaylistsForVideo(videoId: VideoId): readonly PlaylistItemRow[] {
    try {
      const rows = this.db
        .prepare<[string], unknown>(
          'SELECT * FROM playlist_items WHERE video_id = ?'
        )
        .all(videoId);
      return rows.map((raw) => PlaylistItemRowSchema.parse(raw));
    } catch (error) {
      throw new DatabaseError('Failed to list playlists for video', {
        operation: 'getPlaylistsForVideo',
        table: 'playlist_items',
        cause: error,
        context: { videoId },
      });
    }
  }

  /**
   * Quick membership check. Does NOT load the row — uses a `LIMIT 1`
   * existence query so it's cheap even for very large playlists.
   */
  exists(playlistId: PlaylistId, videoId: VideoId): boolean {
    try {
      const row = this.db
        .prepare<[string, string], { one: number }>(
          `SELECT 1 AS one FROM playlist_items
           WHERE playlist_id = ? AND video_id = ?
           LIMIT 1`
        )
        .get(playlistId, videoId);
      return row !== undefined;
    } catch (error) {
      throw new DatabaseError('Failed to check playlist item existence', {
        operation: 'exists',
        table: 'playlist_items',
        cause: error,
        context: { playlistId, videoId },
      });
    }
  }

  /**
   * Count of items in a playlist. Convenience over `getItemsByPlaylist().length`
   * because it lets SQLite do the counting rather than materializing rows
   * in JS just to discard them.
   */
  countByPlaylist(playlistId: PlaylistId): number {
    try {
      const row = this.db
        .prepare<[string], { c: number }>(
          'SELECT COUNT(*) AS c FROM playlist_items WHERE playlist_id = ?'
        )
        .get(playlistId);
      return row?.c ?? 0;
    } catch (error) {
      throw new DatabaseError('Failed to count playlist items', {
        operation: 'countByPlaylist',
        table: 'playlist_items',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Delete every item in a playlist. Returns the number of rows removed.
   * Used by the sync path to reset playlist membership before re-inserting
   * from the YouTube API response.
   */
  clearPlaylist(playlistId: PlaylistId): number {
    try {
      const changes = this.db.withTransaction((db) => {
        const info = db
          .prepare('DELETE FROM playlist_items WHERE playlist_id = ?')
          .run(playlistId);
        return info.changes;
      });
      logger.debug({ playlistId, changes }, 'clearPlaylist resolved');
      return changes;
    } catch (error) {
      throw new DatabaseError('Failed to clear playlist items', {
        operation: 'clearPlaylist',
        table: 'playlist_items',
        cause: error,
        context: { playlistId },
      });
    }
  }
}

// --------------------------------------------------------------------------
// Re-exports for consumers that want branded helpers alongside the repo
// --------------------------------------------------------------------------

export { asPlaylistId, asVideoId };
export type { PlaylistId, VideoId, PlaylistItemRow, VideoRow };

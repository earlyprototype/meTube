/**
 * v2 TagRepository — normalized tag catalogue + many-to-many video association.
 *
 * Ported from `legacy/python/src/database/repository.py::class TagRepository`.
 * The Python original was a thin SQLAlchemy wrapper exposing two public
 * statics: `get_or_create(session, tag_name)` and
 * `add_tags_to_video(session, video_id, tag_names)`.
 *
 * v2 expands the surface to match how the pipeline actually uses the data
 * (detach / find-by-video / clear-for-video) while keeping the semantic
 * contract identical to Python:
 *
 *   - Tag names are stored lower-cased and trimmed. Find / attach / detach
 *     all normalize the same way so "ML", "ml", and " ml " collapse to one
 *     row.
 *   - `findOrCreate` is the "get-or-insert" primitive. SELECT first; if the
 *     row is missing, `INSERT OR IGNORE` and re-SELECT. The whole pair runs
 *     inside `withTransaction` so the read-then-write race is held by
 *     SQLite's per-connection write lock. `INSERT OR IGNORE` makes the
 *     write half idempotent against concurrent inserts of the same unique
 *     `tag` value — a parallel commit that won the race leaves an
 *     already-present row, which the post-insert SELECT picks up.
 *   - `attachToVideo` / `attachManyToVideo` are also `INSERT OR IGNORE` on
 *     the join table, so re-attaching the same (video_id, tag) pair is a
 *     no-op rather than a unique-constraint failure.
 *   - `findByVideoId` joins `video_tags` -> `tags` and returns full rows
 *     parsed through `TagRowSchema`.
 *
 * Discipline:
 *   - All writes go through `DatabaseManager.withTransaction<T>()`.
 *   - All reads parse through `TagRowSchema` / `VideoTagRowSchema`. Raw
 *     `unknown` from `better-sqlite3` never escapes the repository.
 *   - The branded `VideoId` is the only legal entry point for the video
 *     side; a raw `string` won't compile.
 */

import type { Database } from 'better-sqlite3';

import { DatabaseError } from '../errors/index.js';
import { TagRowSchema, VideoTagRowSchema, type TagRow, type VideoTagRow } from '../schemas/db.js';
import type { VideoId } from '../types/branded.js';
import type { DatabaseManager } from './connection.js';

/**
 * Normalize a user-supplied tag string. Returns `null` for empty / whitespace
 * input so callers can short-circuit cleanly rather than persisting blanks.
 *
 * Lowercased to match Python's `tag_name.lower()` behaviour and to keep the
 * `UNIQUE` constraint on `tags.tag` case-insensitive in practice.
 */
function normalizeTag(raw: string): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

/**
 * Repository for the `tags` catalogue and the `video_tags` join table.
 *
 * Stateless apart from the `DatabaseManager` reference — safe to share across
 * the lifetime of a CLI command. One instance per logical context.
 */
export class TagRepository {
  private readonly dbm: DatabaseManager;

  constructor(dbm: DatabaseManager) {
    this.dbm = dbm;
  }

  /**
   * Get an existing tag row by normalized name, or insert a new one.
   *
   * Semantics:
   *   1. Normalize `tagName` (trim + lower).
   *   2. SELECT the row by `tag`.
   *   3. If absent, `INSERT OR IGNORE` then re-SELECT.
   *
   * Both halves run inside a single `withTransaction` so the read-then-write
   * pair is atomic from the caller's perspective. `INSERT OR IGNORE`
   * tolerates the case where a concurrent commit inserted the same `tag`
   * between our SELECT and INSERT — the re-SELECT picks up whichever row
   * landed first.
   *
   * @param tagName - User-supplied tag name. Trimmed and lowercased.
   * @returns The persisted `TagRow` (always present after this call).
   * @throws {DatabaseError} If `tagName` normalizes to empty, or any
   *                         underlying write fails.
   */
  findOrCreate(tagName: string): TagRow {
    const normalized = normalizeTag(tagName);
    if (normalized === null) {
      throw new DatabaseError('Tag name cannot be empty after normalization', {
        operation: 'TagRepository.findOrCreate',
        table: 'tags',
        context: { tagName },
      });
    }

    return this.dbm.withTransaction<TagRow>((db: Database): TagRow => {
      const existing = this.selectByNormalizedName(db, normalized);
      if (existing !== null) {
        return existing;
      }

      db.prepare('INSERT OR IGNORE INTO tags (tag) VALUES (?)').run(normalized);

      const inserted = this.selectByNormalizedName(db, normalized);
      if (inserted === null) {
        // Should be unreachable: INSERT OR IGNORE leaves either our row or
        // a concurrent-inserter's row present; in either case the SELECT
        // must hit.
        throw new DatabaseError('Tag row missing immediately after INSERT OR IGNORE', {
          operation: 'TagRepository.findOrCreate',
          table: 'tags',
          context: { normalized },
        });
      }
      return inserted;
    });
  }

  /**
   * Find a tag row by name without inserting. Returns `null` when no row
   * matches (or when the normalized name is empty).
   *
   * Pure read — no transaction wrapping required, since better-sqlite3 is
   * synchronous and reads see a consistent snapshot.
   *
   * @param tagName - User-supplied tag name. Trimmed and lowercased.
   * @returns The matching `TagRow`, or `null` if none exists.
   */
  findByName(tagName: string): TagRow | null {
    const normalized = normalizeTag(tagName);
    if (normalized === null) {
      return null;
    }
    const stmt = this.dbm.prepare<[string], unknown>(
      'SELECT id, tag, created_at FROM tags WHERE tag = ?'
    );
    const raw = stmt.get(normalized);
    if (raw === undefined) {
      return null;
    }
    return TagRowSchema.parse(raw);
  }

  /**
   * Attach a single tag to a video. Both the tag and the join-table row are
   * idempotent — re-attaching the same `(videoId, tagName)` pair is a no-op
   * rather than an error.
   *
   * @param videoId - Branded YouTube video ID. The caller must have already
   *                  inserted the parent `videos` row; foreign-key failure
   *                  surfaces as a `DatabaseError`.
   * @param tagName - Tag name; normalized as in `findOrCreate`.
   * @returns The persisted `TagRow` that is now linked to the video.
   * @throws {DatabaseError} On normalization failure or write failure.
   */
  attachToVideo(videoId: VideoId, tagName: string): TagRow {
    const normalized = normalizeTag(tagName);
    if (normalized === null) {
      throw new DatabaseError('Tag name cannot be empty after normalization', {
        operation: 'TagRepository.attachToVideo',
        table: 'tags',
        context: { tagName, videoId },
      });
    }

    return this.dbm.withTransaction<TagRow>((db: Database): TagRow => {
      const tagRow = this.findOrCreateInTx(db, normalized);
      const tagId = tagRow.id;
      if (tagId === undefined) {
        throw new DatabaseError('Persisted tag row missing id', {
          operation: 'TagRepository.attachToVideo',
          table: 'tags',
          context: { normalized },
        });
      }
      db.prepare('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(
        videoId,
        tagId
      );
      return tagRow;
    });
  }

  /**
   * Attach many tags to a single video in one transaction. Mirrors Python's
   * `add_tags_to_video(session, video_id, tag_names)`. Each tag is
   * normalized; blank / whitespace-only entries are silently skipped (Python
   * behaviour, kept).
   *
   * @param videoId - Branded YouTube video ID.
   * @param tagNames - Names to associate with the video.
   * @returns The persisted `TagRow`s actually attached (i.e. excludes blanks).
   * @throws {DatabaseError} If the underlying write fails. A foreign-key
   *                         violation (video not present) is surfaced rather
   *                         than swallowed.
   */
  attachManyToVideo(videoId: VideoId, tagNames: readonly string[]): TagRow[] {
    if (tagNames.length === 0) {
      return [];
    }
    return this.dbm.withTransaction<TagRow[]>((db: Database): TagRow[] => {
      const attached: TagRow[] = [];
      for (const raw of tagNames) {
        const normalized = normalizeTag(raw);
        if (normalized === null) {
          continue;
        }
        const tagRow = this.findOrCreateInTx(db, normalized);
        const tagId = tagRow.id;
        if (tagId === undefined) {
          throw new DatabaseError('Persisted tag row missing id', {
            operation: 'TagRepository.attachManyToVideo',
            table: 'tags',
            context: { normalized },
          });
        }
        db.prepare('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(
          videoId,
          tagId
        );
        attached.push(tagRow);
      }
      return attached;
    });
  }

  /**
   * Remove the association between a video and a single tag. Leaves the tag
   * row itself intact (the catalogue is shared across videos). If the tag
   * does not exist, or the association was never present, this is a no-op
   * — no error.
   *
   * @param videoId - Branded YouTube video ID.
   * @param tagName - Tag name; normalized as in `findOrCreate`.
   * @returns `true` if a join-table row was removed, `false` otherwise.
   */
  detachFromVideo(videoId: VideoId, tagName: string): boolean {
    const normalized = normalizeTag(tagName);
    if (normalized === null) {
      return false;
    }
    return this.dbm.withTransaction<boolean>((db: Database): boolean => {
      const tagRow = this.selectByNormalizedName(db, normalized);
      if (tagRow === null || tagRow.id === undefined) {
        return false;
      }
      const info = db
        .prepare('DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?')
        .run(videoId, tagRow.id);
      return info.changes > 0;
    });
  }

  /**
   * Remove all tag associations for a video. The tag rows themselves remain
   * in the catalogue. Useful when re-deriving tags from scratch on
   * re-extraction. Returns the number of join-table rows removed.
   *
   * @param videoId - Branded YouTube video ID.
   * @returns Number of rows deleted from `video_tags`.
   */
  detachAllForVideo(videoId: VideoId): number {
    return this.dbm.withTransaction<number>((db: Database): number => {
      const info = db.prepare('DELETE FROM video_tags WHERE video_id = ?').run(videoId);
      return info.changes;
    });
  }

  /**
   * List every tag attached to a given video, ordered by tag name for
   * deterministic output.
   *
   * Pure read; no transaction. Rows are parsed through `TagRowSchema` so
   * raw `unknown` from `better-sqlite3` never crosses the repository edge.
   *
   * @param videoId - Branded YouTube video ID.
   * @returns Array of `TagRow`s; empty if the video has no tags or does not
   *          exist (we don't distinguish — callers should look up the video
   *          row separately if they need that signal).
   */
  findByVideoId(videoId: VideoId): TagRow[] {
    const stmt = this.dbm.prepare<[string], unknown>(
      `SELECT t.id AS id, t.tag AS tag, t.created_at AS created_at
       FROM tags t
       INNER JOIN video_tags vt ON vt.tag_id = t.id
       WHERE vt.video_id = ?
       ORDER BY t.tag ASC`
    );
    const rawRows = stmt.all(videoId);
    return rawRows.map((raw) => TagRowSchema.parse(raw));
  }

  /**
   * List the raw `video_tags` join rows for a given video. Lower-level than
   * `findByVideoId`; useful for diagnostics or bulk re-syncs that want to
   * compare attached IDs without materializing tag names.
   *
   * @param videoId - Branded YouTube video ID.
   * @returns Array of `VideoTagRow`s (composite-key shape).
   */
  findJoinRowsByVideoId(videoId: VideoId): VideoTagRow[] {
    const stmt = this.dbm.prepare<[string], unknown>(
      'SELECT video_id, tag_id FROM video_tags WHERE video_id = ?'
    );
    const rawRows = stmt.all(videoId);
    return rawRows.map((raw) => VideoTagRowSchema.parse(raw));
  }

  /**
   * Internal: SELECT by normalized name using a caller-supplied `Database`
   * handle. Used inside `withTransaction` callbacks so the SELECT sees
   * uncommitted writes from the same transaction (read-your-own-writes).
   */
  private selectByNormalizedName(db: Database, normalized: string): TagRow | null {
    const raw = db.prepare('SELECT id, tag, created_at FROM tags WHERE tag = ?').get(normalized);
    if (raw === undefined) {
      return null;
    }
    return TagRowSchema.parse(raw);
  }

  /**
   * Internal: get-or-create against a caller-supplied `Database` handle so
   * `attachToVideo` / `attachManyToVideo` can chain the read-write pair
   * inside a single outer transaction (better-sqlite3 supports nesting via
   * SAVEPOINT, but reusing the open handle is cheaper and clearer).
   */
  private findOrCreateInTx(db: Database, normalized: string): TagRow {
    const existing = this.selectByNormalizedName(db, normalized);
    if (existing !== null) {
      return existing;
    }
    db.prepare('INSERT OR IGNORE INTO tags (tag) VALUES (?)').run(normalized);
    const inserted = this.selectByNormalizedName(db, normalized);
    if (inserted === null) {
      throw new DatabaseError('Tag row missing immediately after INSERT OR IGNORE', {
        operation: 'TagRepository.findOrCreateInTx',
        table: 'tags',
        context: { normalized },
      });
    }
    return inserted;
  }
}

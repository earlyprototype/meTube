/**
 * EntityRepository — extracted entities (topics, github_repos, websites, people).
 *
 * Ported from `legacy/python/src/database/repository.py::EntityRepository`.
 *
 * Audit observation that shapes this port: the Python `add_entities` loop
 * pushes the whole batch through a single `session.add(...)` + `session.flush()`
 * (one logical unit of work per video, not per entity). The v2 port preserves
 * that semantics by wrapping the entire batch in ONE `withTransaction` call —
 * one BEGIN/COMMIT for all entities of a video, never one per entity.
 *
 * Discipline at the API surface:
 *
 *   1. Reads parse through `ExtractedEntityRowSchema` at the wire boundary —
 *      callers never see an un-validated row shape.
 *   2. Writes narrow `entity_type` through `EntityTypeSchema` (z.enum)
 *      BEFORE the INSERT — the DB never sees a stringly-typed entity_type
 *      that the rest of the codebase cannot account for.
 *   3. `VideoId` is branded — the type system forecloses passing a raw
 *      string or a `PlaylistId` as the foreign-key target.
 *   4. The only write path is `withTransaction` on the supplied
 *      `DatabaseManager`. There is no direct `db` access here.
 *
 * Method surface (mirrors Python + adds typed conveniences):
 *
 *   - `findByVideoId(videoId)`              — all entities for a video
 *   - `findByVideoIdAndType(videoId, type)` — typed filter
 *   - `countByVideoId(videoId)`             — count without materialising rows
 *   - `insertMany(videoId, entities)`       — bulk insert, one transaction
 *   - `deleteByVideoId(videoId)`            — cascade-friendly cleanup
 */

import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { DatabaseError, ValidationError } from '../errors/index.js';
import {
  EntityTypeSchema,
  ExtractedEntityRowSchema,
  type EntityType,
  type ExtractedEntityRow,
} from '../schemas/db.js';
import { asVideoId, type VideoId } from '../types/branded.js';
import logger from '../utils/logger.js';
import { DatabaseManager } from './connection.js';

/**
 * Input shape callers supply to `insertMany`. The `type` field is parsed
 * through `EntityTypeSchema` at write time, so passing an out-of-enum value
 * fails fast inside `insertMany` rather than committing a stringly-typed row.
 *
 * Mirrors the dict shape produced by
 * `legacy/python/src/parsers/llm_parser.py::extract_entities_for_database`
 * and `description_parser.py::extract_entities_for_database`.
 */
export interface EntityInput {
  /**
   * Logical entity category. Validated against `EntityTypeSchema` on insert.
   * Accept `string` here so callers can pass parser output without an upfront
   * cast — the schema narrows on the inside.
   */
  type: EntityType | string;
  /** Display value (topic name, repo full name, URL host, person name). */
  value: string;
  /** Canonical URL, if applicable. `null` for topics and people. */
  url?: string | null;
  /** 0-100 confidence; defaults to 100 to match Python behaviour. */
  confidence?: number | null;
}

/**
 * Validated, narrow form of `EntityInput` produced after `EntityTypeSchema`
 * has accepted the raw input. Internal-only; not exported.
 */
interface ValidatedEntityInput {
  type: EntityType;
  value: string;
  url: string | null;
  confidence: number;
}

/**
 * Default confidence Python uses when callers omit the field (see
 * `repository.py::add_entities`).
 */
const DEFAULT_CONFIDENCE = 100;

/**
 * Schema for `EntityInput` shape validation before per-field narrowing. We
 * keep it permissive about `type` (string) and narrow with `EntityTypeSchema`
 * separately, so type-mismatch errors surface with the actual offending
 * `type` value in the message — not "expected one of [topic, github_repo,
 * website, person], received <object>".
 */
const EntityInputShapeSchema = z.object({
  type: z.string().min(1),
  value: z.string().min(1),
  url: z.string().nullable().optional(),
  confidence: z.number().int().nullable().optional(),
});

export class EntityRepository {
  constructor(private readonly dbm: DatabaseManager) {}

  /**
   * All entities for a video, oldest-first by insertion order.
   *
   * @param videoId - Branded YouTube video id. Foreign key target on
   *                  `extracted_entities.video_id`.
   * @returns Validated `ExtractedEntityRow[]`. Empty array if no rows.
   */
  findByVideoId(videoId: VideoId): ExtractedEntityRow[] {
    const stmt = this.dbm.prepare<[VideoId], unknown>(
      `SELECT id, video_id, entity_type, entity_value, entity_url, confidence, extracted_at
       FROM extracted_entities
       WHERE video_id = ?
       ORDER BY id ASC`
    );
    return this.parseRows(stmt.all(videoId), 'findByVideoId', videoId);
  }

  /**
   * Entities for a video filtered to a single `entity_type`. The `type`
   * parameter is typed `EntityType` so callers cannot ask for an
   * out-of-enum filter (compile-time fence).
   *
   * @param videoId - Branded YouTube video id.
   * @param type    - One of the values in `EntityTypeSchema`.
   * @returns Validated rows whose `entity_type === type`.
   */
  findByVideoIdAndType(videoId: VideoId, type: EntityType): ExtractedEntityRow[] {
    const stmt = this.dbm.prepare<[VideoId, EntityType], unknown>(
      `SELECT id, video_id, entity_type, entity_value, entity_url, confidence, extracted_at
       FROM extracted_entities
       WHERE video_id = ? AND entity_type = ?
       ORDER BY id ASC`
    );
    return this.parseRows(stmt.all(videoId, type), 'findByVideoIdAndType', videoId);
  }

  /**
   * Count of entities for a video, without materialising rows. Useful for
   * the rollback test ("zero rows after a partial failure") and for the
   * report layer's "videos with >= N entities" filters.
   */
  countByVideoId(videoId: VideoId): number {
    const stmt = this.dbm.prepare<[VideoId], { c: number }>(
      'SELECT COUNT(*) AS c FROM extracted_entities WHERE video_id = ?'
    );
    const row = stmt.get(videoId);
    return row?.c ?? 0;
  }

  /**
   * Bulk-insert all `entities` for a single `videoId` inside ONE transaction.
   *
   * Hard invariants:
   *   - Single BEGIN / COMMIT for the whole batch (not one per entity).
   *   - Every `entity.type` is parsed through `EntityTypeSchema` BEFORE the
   *     INSERT runs. An invalid type aborts the batch without writing
   *     anything (better-sqlite3 rolls back the whole transaction on throw).
   *   - Empty array is a no-op — returns 0 without opening a transaction.
   *
   * @param videoId  - Branded video id. Foreign key target.
   * @param entities - Array of `EntityInput`. May be empty.
   * @returns Number of rows actually inserted.
   * @throws {ValidationError} If any `entity.type` is not in `EntityTypeSchema`.
   *                           The error is raised inside the transaction
   *                           callback so better-sqlite3 rolls back the entire
   *                           batch.
   * @throws {DatabaseError}   If the underlying SQLite INSERT fails for any
   *                           other reason (cause preserved).
   */
  insertMany(videoId: VideoId, entities: readonly EntityInput[]): number {
    if (entities.length === 0) {
      logger.debug({ videoId }, 'EntityRepository.insertMany: empty batch, skipping transaction');
      return 0;
    }

    // Validate + narrow the full batch BEFORE opening a transaction.
    //
    // Discipline trade-off considered: doing the enum narrow inside the
    // transaction would make the rollback hot-path (better-sqlite3 throws
    // and rolls back) carry the validation, but it also means
    // `withTransaction` re-wraps `ValidationError` as `DatabaseError`
    // (see `connection.ts::withTransaction` — non-`DatabaseError` causes
    // are wrapped). Surfacing the *typed* error to callers wins: the
    // upfront-validate path throws `ValidationError` cleanly, no INSERT
    // has run, no rollback is needed because no BEGIN has happened.
    // Rollback semantics still hold for *any* error inside the
    // transaction callback (e.g. SQLite constraint violations on insert).
    const narrowed: ValidatedEntityInput[] = entities.map((raw, index) => {
      const shapeResult = EntityInputShapeSchema.safeParse(raw);
      if (!shapeResult.success) {
        throw new ValidationError('EntityInput shape invalid', {
          field: `entities[${index}]`,
          value: raw,
          context: {
            videoId,
            zodIssues: shapeResult.error.issues,
          },
        });
      }
      return this.narrowEntity(raw, videoId, index);
    });

    return this.dbm.withTransaction((db: Database): number => {
      const insert = db.prepare(
        `INSERT INTO extracted_entities
           (video_id, entity_type, entity_value, entity_url, confidence)
         VALUES (?, ?, ?, ?, ?)`
      );

      let inserted = 0;
      for (const entity of narrowed) {
        const info = insert.run(videoId, entity.type, entity.value, entity.url, entity.confidence);
        // changes is `number | bigint` in better-sqlite3 types; ours never
        // overflows JS-safe-int for a single INSERT.
        inserted += Number(info.changes);
      }

      logger.debug({ videoId, count: inserted }, 'EntityRepository.insertMany committed');
      return inserted;
    });
  }

  /**
   * Delete every entity row for a video. Returns the row count actually
   * removed. Foreign-key cascade from `videos` will also clean these rows
   * up; this method is for callers who need to re-extract without dropping
   * the parent `video` row (matches Python `delete_by_video`).
   */
  deleteByVideoId(videoId: VideoId): number {
    return this.dbm.withTransaction((db: Database): number => {
      const info = db.prepare('DELETE FROM extracted_entities WHERE video_id = ?').run(videoId);
      const removed = Number(info.changes);
      logger.debug({ videoId, removed }, 'EntityRepository.deleteByVideoId committed');
      return removed;
    });
  }

  /**
   * Narrow `EntityInput` to `ValidatedEntityInput` — applies `EntityTypeSchema`
   * to `type` and `DEFAULT_CONFIDENCE` to a missing confidence value.
   *
   * Called inside the transaction so a bad enum value aborts the whole
   * batch (rollback discipline).
   */
  private narrowEntity(raw: EntityInput, videoId: VideoId, index: number): ValidatedEntityInput {
    const typeResult = EntityTypeSchema.safeParse(raw.type);
    if (!typeResult.success) {
      throw new ValidationError('Invalid entity_type', {
        field: `entities[${index}].type`,
        value: raw.type,
        context: {
          videoId,
          allowed: EntityTypeSchema.options,
        },
      });
    }

    return {
      type: typeResult.data,
      value: raw.value,
      url: raw.url ?? null,
      confidence: raw.confidence ?? DEFAULT_CONFIDENCE,
    };
  }

  /**
   * Parse a result set through `ExtractedEntityRowSchema`. A schema failure
   * here means the DB contains a row whose shape no longer matches the
   * declared invariants — that is a corruption signal, not a user error,
   * so it surfaces as `DatabaseError`.
   */
  private parseRows(rows: unknown[], operation: string, videoId: VideoId): ExtractedEntityRow[] {
    return rows.map((row, index) => {
      const result = ExtractedEntityRowSchema.safeParse(row);
      if (!result.success) {
        throw new DatabaseError('Row failed ExtractedEntityRowSchema parse', {
          operation,
          table: 'extracted_entities',
          context: {
            videoId,
            rowIndex: index,
            zodIssues: result.error.issues,
          },
        });
      }
      return result.data;
    });
  }
}

/**
 * Convenience helper for tests / callers that want a branded `VideoId`
 * straight from a raw string. Re-exports `asVideoId` so consumers don't
 * have to dig through `../types/branded.js`.
 */
export { asVideoId };

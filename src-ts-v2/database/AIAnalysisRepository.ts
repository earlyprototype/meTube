/**
 * AIAnalysisRepository — Phase 2 Wave 2.
 *
 * Ported from `legacy/python/src/database/repository.py:AIAnalysisRepository`.
 *
 * **Why this repository exists (audit context):** v1 had a stubbed
 * `getAnalysisData` in `src-ts/reports/HTMLReportGenerator.ts:391-394` that
 * returned `undefined` unconditionally. The AI analysis section was silently
 * empty in every video report. The v2 contract makes that class of bug
 * impossible: `getByVideo(videoId)` MUST return the persisted analysis when
 * one exists, and the test suite includes a stub-bomb closure test that
 * asserts a stored analysis comes back parsed (not undefined).
 *
 * Discipline (per `CLAUDE.md` v2 invariants):
 *   1. ALL writes route through `DatabaseManager.withTransaction` — there is
 *      no other public write path on the manager, by construction.
 *   2. Wire-boundary input is parsed via `GeminiResponseSchema` before any
 *      SQL touches it. A caller cannot smuggle untrusted shape past the door.
 *   3. Reads run through `AIAnalysisRowSchema` before returning to caller —
 *      a corrupted row fails loudly instead of silently widening the type.
 *   4. `VideoId` is the only video-shaped input — raw strings will not
 *      type-check.
 */

import { ZodError } from 'zod';

import { DatabaseError } from '../errors/index.js';
import {
  AIAnalysisRowSchema,
  type AIAnalysisRow,
} from '../schemas/db.js';
import {
  GeminiResponseSchema,
  type GeminiResponse,
} from '../schemas/gemini.js';
import type { VideoId } from '../types/index.js';
import logger from '../utils/logger.js';

import type { DatabaseManager } from './connection.js';

// --------------------------------------------------------------------------
// Public surface — typed projection of an `ai_analysis` row
// --------------------------------------------------------------------------

/**
 * The analysis projection returned to callers. Mirrors the
 * `AIAnalysisRow` Zod-inferred shape but renames `analyzed_at` to a clearer
 * surface and exposes `keyPoints` as a parsed `string[] | null` rather than
 * a raw JSON string, so report code does not have to re-parse downstream.
 *
 * Stays a `readonly` interface — repository projections are immutable from
 * the caller's perspective.
 */
export interface AIAnalysis {
  readonly id: number;
  readonly videoId: VideoId;
  readonly summary: string | null;
  readonly keyPoints: readonly string[] | null;
  readonly sentiment: string | null;
  readonly contentType: string | null;
  readonly modelUsed: string | null;
  readonly analyzedAt: string | null;
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

/**
 * Parse `key_points` (stored as a JSON-encoded string array) into a typed
 * `string[]`, or return null if absent / malformed. Malformed JSON is
 * logged once and downgraded to null — a corrupted report-side string
 * should not crash report rendering.
 */
function parseKeyPoints(raw: string | null | undefined): readonly string[] | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const stringsOnly = parsed.filter((v): v is string => typeof v === 'string');
    return stringsOnly;
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        rawLength: raw.length,
      },
      'AIAnalysisRepository.parseKeyPoints: malformed JSON in key_points'
    );
    return null;
  }
}

/**
 * Map a parsed `AIAnalysisRow` into the public `AIAnalysis` projection.
 * `videoId` is re-branded by the caller because the brand requires a
 * `VideoId` already in scope (input arg or asVideoId() at the caller's edge).
 */
function rowToAnalysis(row: AIAnalysisRow, videoId: VideoId): AIAnalysis {
  return {
    id: row.id ?? 0,
    videoId,
    summary: row.summary ?? null,
    keyPoints: parseKeyPoints(row.key_points ?? null),
    sentiment: row.sentiment ?? null,
    contentType: row.content_type ?? null,
    modelUsed: row.model_used ?? null,
    analyzedAt: row.analyzed_at ?? null,
  };
}

// --------------------------------------------------------------------------
// Repository
// --------------------------------------------------------------------------

/**
 * Repository for `ai_analysis` rows. Constructed with a `DatabaseManager`
 * (not the raw `Database`) so the write-discipline invariant — "writes
 * happen only inside `withTransaction`" — is enforced at the type level.
 */
export class AIAnalysisRepository {
  constructor(private readonly db: DatabaseManager) {}

  /**
   * Fetch the persisted analysis for a video.
   *
   * **This is the v1 stub-bomb closure point.** Unlike v1's stubbed
   * `getAnalysisData(_videoId)` which always returned undefined, this
   * implementation actually queries `ai_analysis`, parses the row, and
   * returns the projection. The repository test suite includes an
   * explicit "stored analysis is returned (not undefined)" test guarding
   * the class of regression.
   *
   * @param videoId - Branded video identifier.
   * @returns The analysis projection, or `null` when no row exists.
   * @throws {DatabaseError} If the row exists but fails schema parse —
   *                         loud failure is preferred to silent widening.
   */
  getByVideo(videoId: VideoId): AIAnalysis | null {
    const raw = this.db
      .prepare<[string], unknown>(
        `SELECT id, video_id, summary, key_points, sentiment, content_type, model_used, analyzed_at
         FROM ai_analysis
         WHERE video_id = ?`
      )
      .get(videoId);

    if (raw === undefined || raw === null) {
      return null;
    }

    try {
      const parsed = AIAnalysisRowSchema.parse(raw);
      return rowToAnalysis(parsed, videoId);
    } catch (error) {
      throw new DatabaseError('ai_analysis row failed schema parse', {
        operation: 'getByVideo',
        table: 'ai_analysis',
        cause: error,
        context: { videoId },
      });
    }
  }

  /**
   * Insert-or-update the analysis for a video, in a single transaction.
   *
   * The incoming `analysis` value is parsed through `GeminiResponseSchema`
   * before any SQL is run — the wire-boundary check. This catches a
   * truncated / malformed LLM response and refuses to persist it. `topics`
   * from the Gemini response are JSON-encoded into the `key_points` column
   * so report code can surface them; this is a deliberate mapping decision
   * (v2 reports treat "topics" as the key-points-equivalent rendered in
   * the analysis block).
   *
   * @param videoId - Branded video identifier.
   * @param analysis - The full Gemini response. Will be re-validated.
   * @param modelUsed - Name of the LLM that produced the response (e.g.
   *                    `gemini-3-flash-preview`). Recorded for provenance.
   * @returns The persisted projection (a fresh read of the just-written row).
   * @throws {DatabaseError} If the Zod parse fails or the SQL throws.
   */
  upsert(
    videoId: VideoId,
    analysis: GeminiResponse,
    modelUsed: string
  ): AIAnalysis {
    let validated: GeminiResponse;
    try {
      validated = GeminiResponseSchema.parse(analysis);
    } catch (error) {
      throw new DatabaseError('Gemini analysis failed wire-boundary parse', {
        operation: 'upsert',
        table: 'ai_analysis',
        cause: error,
        context: {
          videoId,
          zodIssues: error instanceof ZodError ? error.issues : undefined,
        },
      });
    }

    const summary = validated.summary;
    const contentType = validated.content_type;
    const sentiment = validated.sentiment;
    const keyPointsJson = JSON.stringify(validated.topics);

    this.db.withTransaction((conn) => {
      // ai_analysis.video_id has a UNIQUE constraint, so ON CONFLICT
      // upserts via DO UPDATE — a single round-trip, atomic by virtue
      // of the surrounding withTransaction.
      conn
        .prepare(
          `INSERT INTO ai_analysis
             (video_id, summary, key_points, sentiment, content_type, model_used, analyzed_at)
           VALUES
             (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(video_id) DO UPDATE SET
             summary = excluded.summary,
             key_points = excluded.key_points,
             sentiment = excluded.sentiment,
             content_type = excluded.content_type,
             model_used = excluded.model_used,
             analyzed_at = CURRENT_TIMESTAMP`
        )
        .run(
          videoId,
          summary,
          keyPointsJson,
          sentiment,
          contentType,
          modelUsed
        );
    });

    const persisted = this.getByVideo(videoId);
    if (persisted === null) {
      // The row was just written inside a successful transaction; the only
      // way this branch fires is if SQLite somehow lost the write between
      // commit and the follow-up read — surface loudly rather than return
      // a silent default.
      throw new DatabaseError('ai_analysis upsert read-back returned null', {
        operation: 'upsert',
        table: 'ai_analysis',
        context: { videoId },
      });
    }
    return persisted;
  }

  /**
   * Delete the analysis row for a video, if any. Returns the number of
   * rows actually removed (0 or 1, given the `UNIQUE` constraint).
   *
   * Wrapped in `withTransaction` for parity with other write paths — the
   * BEGIN/COMMIT framing is cheap, and the "all writes go through
   * `withTransaction`" invariant holds without exception.
   */
  deleteByVideo(videoId: VideoId): number {
    return this.db.withTransaction((conn) => {
      const info = conn
        .prepare(`DELETE FROM ai_analysis WHERE video_id = ?`)
        .run(videoId);
      return Number(info.changes);
    });
  }

  /**
   * Return true if an analysis row exists for the given video. Avoids
   * materialising the row when callers only need an existence check.
   */
  exists(videoId: VideoId): boolean {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM ai_analysis WHERE video_id = ?`
      )
      .get(videoId);
    return (row?.c ?? 0) > 0;
  }

  /**
   * Count the total number of analysis rows in the table. Mainly for
   * tooling / dashboards; not part of the original Python surface but a
   * trivial extension that some callers (report-side stats) ask for.
   */
  count(): number {
    const row = this.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ai_analysis`)
      .get();
    return row?.c ?? 0;
  }
}

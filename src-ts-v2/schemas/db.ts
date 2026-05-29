/**
 * Zod schemas for the row shapes returned by `src-ts-v2/database/schema.ts`.
 *
 * Discipline: each schema mirrors the columns declared in `schema.ts`
 * column-for-column. SQLite affinities map as follows:
 *   - `INTEGER PRIMARY KEY AUTOINCREMENT`  -> `z.number().int()`
 *   - `INTEGER` (non-null)                  -> `z.number().int()`
 *   - `INTEGER` (nullable)                  -> `z.number().int().nullable()`
 *   - `TEXT NOT NULL`                       -> `z.string()`
 *   - `TEXT` (nullable)                     -> `z.string().nullable()`
 *   - `INTEGER` used as boolean (0/1)       -> `z.number().int()` with a
 *                                              dedicated `.transform` left
 *                                              to callers if they want
 *                                              `boolean`. The DB sees ints,
 *                                              so the row shape stays an
 *                                              int.
 *   - `TEXT DEFAULT CURRENT_TIMESTAMP`       -> `z.string()` (SQLite emits
 *                                              an ISO-ish string for the
 *                                              default). Schemas accept
 *                                              both populated and absent
 *                                              forms (`.optional()` where
 *                                              SQLite would fill the
 *                                              default).
 *
 * NOTE: When the schemas are used to parse rows *coming out of* SQLite,
 * defaulted columns are always present (SQLite materializes them). When
 * the schemas are used to parse *inputs* about to be inserted, callers may
 * omit defaulted columns and SQLite will fill them. Both use cases are
 * supported by marking default-bearing columns `.optional()`.
 *
 * Uses the Zod v3 API surface (project depends on `zod ^3.25.76`).
 */

import { z } from 'zod';

// --------------------------------------------------------------------------
// schema_version
// --------------------------------------------------------------------------

export const SchemaVersionRowSchema = z.object({
  version: z.number().int(),
  applied_at: z.string().optional(), // NOT NULL DEFAULT CURRENT_TIMESTAMP per schema.ts: never NULL on disk
});

// --------------------------------------------------------------------------
// videos
// --------------------------------------------------------------------------

export const VideoRowSchema = z.object({
  id: z.number().int().optional(), // AUTOINCREMENT; absent on insert
  video_id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  channel_id: z.string(),
  channel_title: z.string(),
  published_at: z.string(),
  duration: z.string(),
  duration_seconds: z.number().int(),
  is_short: z.number().int(), // 0 or 1
  category_id: z.string().nullable().optional(),
  category_name: z.string().nullable().optional(),
  definition: z.string().nullable().optional(),
  caption: z.number().int().nullable().optional(), // 0 or 1
  licensed_content: z.number().int().nullable().optional(), // 0 or 1
  created_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL)
  updated_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL)
});

// --------------------------------------------------------------------------
// video_statistics
// --------------------------------------------------------------------------

export const VideoStatisticRowSchema = z.object({
  id: z.number().int().optional(),
  video_id: z.string(),
  view_count: z.number().int().nullable().optional(),
  like_count: z.number().int().nullable().optional(),
  comment_count: z.number().int().nullable().optional(),
  recorded_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL)
});

// --------------------------------------------------------------------------
// transcripts
// --------------------------------------------------------------------------

export const TranscriptRowSchema = z.object({
  id: z.number().int().optional(),
  video_id: z.string(),
  language: z.string(),
  full_text: z.string(),
  segments_json: z.string().nullable().optional(),
  is_auto_generated: z.number().int().nullable().optional(),
  extracted_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL)
});

// --------------------------------------------------------------------------
// extracted_entities
// --------------------------------------------------------------------------

/**
 * Entity types persisted by the v2 extractor. Mirrors the Python comment:
 * `# 'topic', 'repo', 'website', 'person'`. v2 normalizes `repo` to
 * `github_repo` to match the GeminiParser output key for cleaner joins.
 */
export const EntityTypeSchema = z.enum(['topic', 'github_repo', 'website', 'person']);

export const ExtractedEntityRowSchema = z.object({
  id: z.number().int().optional(),
  video_id: z.string(),
  entity_type: z.string(), // narrow with EntityTypeSchema at write-time
  entity_value: z.string(),
  entity_url: z.string().nullable().optional(),
  confidence: z.number().int().nullable().optional(),
  extracted_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL)
});

// --------------------------------------------------------------------------
// tags
// --------------------------------------------------------------------------

export const TagRowSchema = z.object({
  id: z.number().int().optional(),
  tag: z.string(),
  created_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL)
});

// --------------------------------------------------------------------------
// video_tags (join table)
// --------------------------------------------------------------------------

export const VideoTagRowSchema = z.object({
  video_id: z.string(),
  tag_id: z.number().int(),
});

// --------------------------------------------------------------------------
// playlists
// --------------------------------------------------------------------------

export const PlaylistRowSchema = z.object({
  id: z.number().int().optional(),
  playlist_id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  last_checked: z.string().nullable().optional(),
  video_count: z.number().int().nullable().optional(),
  enabled: z.number().int().nullable().optional(),
  created_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL)
  updated_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL)
});

// --------------------------------------------------------------------------
// playlist_items
// --------------------------------------------------------------------------

export const PlaylistItemRowSchema = z.object({
  id: z.number().int().optional(),
  playlist_id: z.string(),
  video_id: z.string(),
  position: z.number().int().nullable().optional(),
  added_at: z.string(),
});

// --------------------------------------------------------------------------
// extraction_jobs
// --------------------------------------------------------------------------

export const ExtractionJobStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);

export const ExtractionJobRowSchema = z.object({
  id: z.number().int().optional(),
  playlist_id: z.string().nullable().optional(),
  job_type: z.string(),
  status: z.string(), // narrow with ExtractionJobStatusSchema at write-time
  videos_found: z.number().int().nullable().optional(),
  videos_processed: z.number().int().nullable().optional(),
  new_videos: z.number().int().nullable().optional(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
});

// --------------------------------------------------------------------------
// ai_analysis
// --------------------------------------------------------------------------

export const AIAnalysisRowSchema = z.object({
  id: z.number().int().optional(),
  video_id: z.string(),
  summary: z.string().nullable().optional(),
  key_points: z.string().nullable().optional(), // JSON string
  sentiment: z.string().nullable().optional(),
  content_type: z.string().nullable().optional(),
  model_used: z.string().nullable().optional(),
  analyzed_at: z.string().nullable().optional(), // nullable per schema.ts: TEXT DEFAULT (no NOT NULL)
});

// --------------------------------------------------------------------------
// Inferred TypeScript types
// --------------------------------------------------------------------------

export type SchemaVersionRow = z.infer<typeof SchemaVersionRowSchema>;
export type VideoRow = z.infer<typeof VideoRowSchema>;
export type VideoStatisticRow = z.infer<typeof VideoStatisticRowSchema>;
export type TranscriptRow = z.infer<typeof TranscriptRowSchema>;
export type EntityType = z.infer<typeof EntityTypeSchema>;
export type ExtractedEntityRow = z.infer<typeof ExtractedEntityRowSchema>;
export type TagRow = z.infer<typeof TagRowSchema>;
export type VideoTagRow = z.infer<typeof VideoTagRowSchema>;
export type PlaylistRow = z.infer<typeof PlaylistRowSchema>;
export type PlaylistItemRow = z.infer<typeof PlaylistItemRowSchema>;
export type ExtractionJobStatus = z.infer<typeof ExtractionJobStatusSchema>;
export type ExtractionJobRow = z.infer<typeof ExtractionJobRowSchema>;
export type AIAnalysisRow = z.infer<typeof AIAnalysisRowSchema>;

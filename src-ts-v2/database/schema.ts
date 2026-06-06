/**
 * Self-bootstrapping SQLite schema for meTube v2.
 *
 * Ported from `legacy/python/src/database/models.py`. SQLite-native:
 * `DEFAULT CURRENT_TIMESTAMP` replaces SQLAlchemy's `func.now()`, and there is
 * no Python or external migration step — `initSchema()` is the only path.
 *
 * Column types are SQLite affinities (TEXT/INTEGER/REAL/BLOB). Row-shape
 * branding (`VideoId`, `PlaylistId`, etc.) lives in Zod schemas under
 * `src-ts-v2/schemas/db.ts`, not at the DDL layer.
 */

import type { Database } from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

/**
 * Tables expected to exist after `initSchema()` runs. Exported so tests and
 * tooling can assert exhaustively without re-deriving the list.
 */
export const EXPECTED_TABLES: readonly string[] = Object.freeze([
  'videos',
  'video_statistics',
  'transcripts',
  'extracted_entities',
  'tags',
  'video_tags',
  'playlists',
  'playlist_items',
  'extraction_jobs',
  'ai_analysis',
  'schema_version',
]);

const DDL_STATEMENTS: readonly string[] = Object.freeze([
  // Schema version registry. Single-row table; updated only by future
  // migration code. v2 starts at SCHEMA_VERSION = 1.
  `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Core video metadata. Mirrors Python Video model.
  `CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    channel_id TEXT NOT NULL,
    channel_title TEXT NOT NULL,
    published_at TEXT NOT NULL,
    duration TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    is_short INTEGER NOT NULL DEFAULT 0,
    category_id TEXT,
    category_name TEXT,
    definition TEXT,
    caption INTEGER DEFAULT 0,
    licensed_content INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS ix_videos_video_id ON videos(video_id)`,
  `CREATE INDEX IF NOT EXISTS ix_videos_channel_id ON videos(channel_id)`,
  `CREATE INDEX IF NOT EXISTS ix_videos_is_short ON videos(is_short)`,

  // Historical statistics tracking. Many rows per video.
  `CREATE TABLE IF NOT EXISTS video_statistics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    recorded_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS ix_video_statistics_video_id ON video_statistics(video_id)`,
  `CREATE INDEX IF NOT EXISTS ix_video_statistics_recorded_at ON video_statistics(recorded_at)`,

  // Transcripts. One row per video (UNIQUE constraint on video_id).
  `CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE REFERENCES videos(video_id) ON DELETE CASCADE,
    language TEXT NOT NULL,
    full_text TEXT NOT NULL,
    segments_json TEXT,
    is_auto_generated INTEGER DEFAULT 1,
    extracted_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  // LLM/regex-extracted entities. Many per video.
  `CREATE TABLE IF NOT EXISTS extracted_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_value TEXT NOT NULL,
    entity_url TEXT,
    confidence INTEGER DEFAULT 100,
    extracted_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS ix_extracted_entities_video_id ON extracted_entities(video_id)`,
  `CREATE INDEX IF NOT EXISTS ix_extracted_entities_type ON extracted_entities(entity_type)`,
  `CREATE INDEX IF NOT EXISTS ix_entities_type_value ON extracted_entities(entity_type, entity_value)`,

  // Normalised tag catalogue.
  `CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS ix_tags_tag ON tags(tag)`,

  // Many-to-many association: videos <-> tags. Composite primary key.
  `CREATE TABLE IF NOT EXISTS video_tags (
    video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (video_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_video_tags_tag_id ON video_tags(tag_id)`,

  // Tracked playlists.
  `CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    last_checked TEXT,
    video_count INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS ix_playlists_playlist_id ON playlists(playlist_id)`,

  // Many-to-many association: playlists <-> videos, with ordering metadata.
  `CREATE TABLE IF NOT EXISTS playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id TEXT NOT NULL REFERENCES playlists(playlist_id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
    position INTEGER,
    added_at TEXT NOT NULL,
    UNIQUE (playlist_id, video_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_playlist_items_playlist ON playlist_items(playlist_id)`,
  `CREATE INDEX IF NOT EXISTS ix_playlist_items_video ON playlist_items(video_id)`,

  // Extraction job audit trail.
  `CREATE TABLE IF NOT EXISTS extraction_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id TEXT REFERENCES playlists(playlist_id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    videos_found INTEGER DEFAULT 0,
    videos_processed INTEGER DEFAULT 0,
    new_videos INTEGER DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_jobs_status ON extraction_jobs(status)`,
  `CREATE INDEX IF NOT EXISTS ix_jobs_started ON extraction_jobs(started_at)`,

  // AI-generated analysis. One row per video.
  `CREATE TABLE IF NOT EXISTS ai_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE REFERENCES videos(video_id) ON DELETE CASCADE,
    summary TEXT,
    key_points TEXT,
    sentiment TEXT,
    content_type TEXT,
    model_used TEXT,
    analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
]);

/**
 * Create all tables and indexes from scratch. Idempotent — uses
 * `CREATE TABLE IF NOT EXISTS` throughout. Also seeds the
 * `schema_version` row at `SCHEMA_VERSION`.
 *
 * PRAGMA configuration belongs in the connection layer, not the schema
 * layer; this function deals exclusively with DDL.
 */
export function initSchema(db: Database): void {
  for (const stmt of DDL_STATEMENTS) {
    db.exec(stmt);
  }

  const insertVersion = db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)');
  insertVersion.run(SCHEMA_VERSION);
}

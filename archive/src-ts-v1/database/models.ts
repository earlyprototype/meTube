/**
 * TypeScript interfaces matching SQLAlchemy database models
 * Maps directly to existing metube.db schema
 */

export interface Video {
  id?: number;
  video_id: string;
  title: string;
  description?: string;
  channel_id: string;
  channel_title: string;
  published_at: string; // ISO date string
  duration: string; // ISO 8601 format
  duration_seconds: number;
  is_short: boolean;
  category_id?: string;
  category_name?: string;
  definition?: string; // 'hd' or 'sd'
  caption?: boolean;
  licensed_content?: boolean;
  created_at?: string; // ISO date string
  updated_at?: string; // ISO date string

  // Relationships (optional, loaded when needed)
  transcript?: Transcript;
  statistics?: VideoStatistic[];
  entities?: ExtractedEntity[];
  tags?: Tag[];
  playlist_items?: PlaylistItem[];
}

export interface VideoStatistic {
  id?: number;
  video_id: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  recorded_at?: string; // ISO date string
}

export interface Transcript {
  id?: number;
  video_id: string;
  language: string;
  full_text: string;
  segments_json?: string; // JSON string of segments array
  is_auto_generated: boolean;
  extracted_at?: string; // ISO date string
}

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

export interface ExtractedEntity {
  id?: number;
  video_id: string;
  entity_type: string; // 'topic', 'repo', 'website', 'person', 'tag'
  entity_value: string;
  entity_url?: string;
  confidence?: number; // 0-100
  extracted_at?: string; // ISO date string
}

export interface Tag {
  id?: number;
  tag: string;
  created_at?: string; // ISO date string
}

export interface Playlist {
  id?: number;
  playlist_id: string;
  title: string;
  description?: string;
  last_checked?: string; // ISO date string
  video_count: number;
  enabled: boolean;
  created_at?: string; // ISO date string
  updated_at?: string; // ISO date string

  // Relationships (optional, loaded when needed)
  playlist_items?: PlaylistItem[];
  extraction_jobs?: ExtractionJob[];
}

export interface PlaylistItem {
  id?: number;
  playlist_id: string;
  video_id: string;
  position?: number;
  added_at: string; // ISO date string

  // Relationships (optional)
  playlist?: Playlist;
  video?: Video;
}

export interface ExtractionJob {
  id?: number;
  playlist_id?: string;
  job_type: string; // 'playlist', 'video', 'update'
  status: string; // 'pending', 'running', 'completed', 'failed'
  videos_found: number;
  videos_processed: number;
  new_videos: number;
  started_at?: string; // ISO date string
  completed_at?: string; // ISO date string
  error_message?: string;
}

export interface AIAnalysis {
  id?: number;
  video_id: string;
  summary?: string;
  key_points?: string; // JSON string of key points array
  sentiment?: string; // 'positive', 'negative', 'neutral'
  content_type?: string; // 'tutorial', 'review', 'entertainment', etc.
  model_used?: string; // 'gemini-1.5-pro'
  analyzed_at?: string; // ISO date string
}

/**
 * Type guards for runtime checking
 */
export function isVideo(obj: any): obj is Video {
  return (
    typeof obj === 'object' && typeof obj.video_id === 'string' && typeof obj.title === 'string'
  );
}

export function isPlaylist(obj: any): obj is Playlist {
  return (
    typeof obj === 'object' && typeof obj.playlist_id === 'string' && typeof obj.title === 'string'
  );
}

/**
 * Database row types (what comes directly from better-sqlite3)
 * These match the actual column names and types in SQLite
 */
export type VideoRow = Video;
export type PlaylistRow = Playlist;
export type TranscriptRow = Transcript;
export type ExtractedEntityRow = ExtractedEntity;
export type PlaylistItemRow = PlaylistItem;

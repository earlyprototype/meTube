/**
 * Type definitions for HTML report generation.
 *
 * Lifted KEEP-AS-IS from `src-ts/reports/types.ts` per `docs/PORT_PLAN.md`
 * Wave 4. The template-side shapes (`ReportVideoData`,
 * `CompletePlaylistReportData`, etc.) are pure view-model DTOs — they have
 * no DB coupling, no `any`, and no `console.*` — so they port across
 * unchanged. The only "adjustment" needed is none: these interfaces use
 * raw `string` for IDs because the Handlebars templates render strings,
 * not branded brands. `HTMLReportGenerator` takes branded `VideoId` /
 * `PlaylistId` at its public surface and unwraps them into the raw
 * strings the template DTOs expect.
 */

/**
 * Video data for report templates.
 */
export interface ReportVideoData {
  video_id: string;
  title: string;
  description?: string;
  channel_title: string;
  channel_id: string;
  published_at: string;
  duration_seconds: number;
  is_short: boolean;
  view_count: number;
  like_count: number;
  comment_count: number;
  thumbnail_url: string;
}

/**
 * Transcript segment for report.
 */
export interface ReportTranscriptSegment {
  start: number;
  timestamp: string;
  text: string;
}

/**
 * Transcript data for report.
 */
export interface ReportTranscriptData {
  language: string;
  is_auto_generated: boolean;
  full_text: string;
  segments: ReportTranscriptSegment[];
  word_count: number;
}

/**
 * Entity with URL for reports.
 */
export interface ReportEntity {
  name: string;
  url?: string;
  description?: string;
}

/**
 * Grouped entities for report.
 */
export interface ReportEntities {
  topics: string[];
  github_repos: ReportEntity[];
  websites: ReportEntity[];
  people: string[];
}

/**
 * AI analysis data for report.
 */
export interface ReportAnalysisData {
  summary: string;
  content_type?: string;
  sentiment?: string;
  model_used?: string;
}

/**
 * Complete video report data — the root object passed to the
 * `video_report.html` Handlebars template.
 */
export interface VideoReportData {
  video: ReportVideoData;
  transcript?: ReportTranscriptData;
  entities: ReportEntities;
  tags: string[];
  analysis?: ReportAnalysisData;
  generated_at: string;
}

/**
 * Playlist overview data for report.
 */
export interface PlaylistReportData {
  playlist_id: string;
  title: string;
  description?: string;
  video_count: number;
  total_duration: string;
  total_views: string;
  videos_with_transcripts: number;
  transcript_percentage: number;
}

/**
 * Video summary for playlist report.
 */
export interface PlaylistVideoSummary {
  video_id: string;
  title: string;
  channel_title: string;
  published_at: string;
  duration_seconds: number;
  view_count: number;
  like_count: number;
  has_transcript: boolean;
  thumbnail_url: string;
  summary?: string;
  topics: string[];
}

/**
 * Aggregated topic with frequency.
 */
export interface AggregatedTopic {
  name: string;
  count: number;
  videos: Array<{ video_id: string; title: string }>;
}

/**
 * Aggregated entity (repo/website) with occurrences.
 */
export interface AggregatedEntity {
  name: string;
  url?: string;
  description?: string;
  videos: Array<{ video_id: string; title: string }>;
}

/**
 * Aggregated person with frequency.
 */
export interface AggregatedPerson {
  name: string;
  count: number;
  videos: Array<{ video_id: string; title: string }>;
}

/**
 * Playlist statistics.
 */
export interface PlaylistStats {
  total_topics: number;
  total_repos: number;
  total_websites: number;
  total_people: number;
}

/**
 * Complete playlist report data — the root object passed to the
 * `playlist_report.html` Handlebars template.
 */
export interface CompletePlaylistReportData {
  playlist: PlaylistReportData;
  stats: PlaylistStats;
  videos: PlaylistVideoSummary[];
  top_topics: AggregatedTopic[];
  github_repos: AggregatedEntity[];
  websites: AggregatedEntity[];
  people: AggregatedPerson[];
  generated_at: string;
}

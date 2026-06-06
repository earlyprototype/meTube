/**
 * v2 API types — layered with branded `VideoId` / `PlaylistId` so the
 * compile-time invariant from `types/branded.ts` extends across the wire
 * boundary.
 *
 * The shapes below are the v2 backend's *internal* domain types — the
 * post-Zod-parse, post-mapping representation that flows from
 * `YouTubeClient` into repositories. The Zod schemas in
 * `schemas/youtube.ts` model the raw YouTube Data API v3 responses; this
 * file models what the v2 backend hands to its callers (Ink layer,
 * extractors, repositories).
 *
 * Differences from v1's `src-ts/api/types.ts`:
 *   - `id` becomes `videoId: VideoId` on video shapes, `playlistId:
 *     PlaylistId` on playlist shapes. No ambiguous `id` field.
 *   - `viewCount` / `likeCount` / `commentCount` are coerced to `number`
 *     by `YouTubeClient` (YouTube returns these as strings).
 *   - `RateLimiterConfig` / `RetryConfig` lifted unchanged.
 */
import type { VideoId, PlaylistId } from '../types/branded.js';

/**
 * Internal v2 representation of a YouTube playlist. Constructed by
 * `YouTubeClient.getPlaylistById` and `getMyPlaylists` after Zod parse.
 *
 * NOTE: the public field is `playlistId: PlaylistId`, not `id: string` —
 * branded IDs are the type-system foreclosure for the v1
 * `playlistId`/`id` class of drift.
 */
export interface YouTubePlaylist {
  playlistId: PlaylistId;
  title: string;
  description: string;
  itemCount: number;
  thumbnailUrl?: string;
  channelId?: string;
  channelTitle?: string;
  publishedAt?: string;
  privacyStatus?: string;
}

/**
 * Internal v2 representation of a YouTube video. Constructed by
 * `YouTubeClient.getVideoById` and `getMultipleVideoDetails` after Zod
 * parse.
 */
export interface YouTubeVideo {
  videoId: VideoId;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  duration: string;
  durationSeconds: number;
  isShort: boolean;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  thumbnailUrl?: string;
  tags?: string[];
  categoryId?: string;
  caption?: boolean;
  licensedContent?: boolean;
  topicCategories?: string[];
}

/**
 * Internal v2 representation of a playlist item (video-in-playlist
 * relationship row).
 */
export interface YouTubePlaylistItem {
  videoId: VideoId;
  playlistId: PlaylistId;
  position: number;
  title?: string;
  channelId?: string;
  channelTitle?: string;
  addedAt?: string;
  thumbnailUrl?: string;
}

/**
 * Token bucket rate limiter configuration. Lifted unchanged from
 * v1 — the algorithm is correct.
 */
export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  costFunction?: (operation: string) => number;
}

/**
 * Retry handler configuration with exponential backoff. Lifted unchanged
 * from v1 — the algorithm is correct.
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors: string[];
}

/**
 * YouTube Data API v3 quota costs (per the public quota table). v1 used
 * these values; carried forward unchanged.
 *
 * Notes:
 *   - `search.list` is 100 units — expensive. Callers should rate-limit
 *     and cache aggressively.
 *   - Read-list endpoints (`videos.list`, `playlists.list`,
 *     `playlistItems.list`) are 1 unit each, regardless of `part=` count
 *     in practice.
 */
export const YOUTUBE_API_COSTS = {
  'playlists.list': 1,
  'playlistItems.list': 1,
  'videos.list': 1,
  'channels.list': 1,
  'search.list': 100,
} as const;

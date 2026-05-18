/**
 * YouTube API types for video and playlist data
 */

/**
 * YouTube playlist information
 */
export interface YouTubePlaylist {
  id: string;
  title: string;
  description: string;
  itemCount: number;
  thumbnailUrl?: string;
  channelId?: string;
  channelTitle?: string;
  publishedAt?: string;
}

/**
 * YouTube video information
 */
export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  duration: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  thumbnailUrl?: string;
  tags?: string[];
}

/**
 * YouTube playlist item (video in a playlist)
 */
export interface YouTubePlaylistItem {
  videoId: string;
  playlistId: string;
  position: number;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
}

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  maxRequests: number; // Max requests per window
  windowMs: number; // Time window in milliseconds
  costFunction?: (operation: string) => number;
}

/**
 * Retry handler configuration
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors: string[];
}

/**
 * YouTube API quota costs (approximations)
 */
export const YOUTUBE_API_COSTS = {
  'playlists.list': 1,
  'playlistItems.list': 1,
  'videos.list': 1,
  'channels.list': 1,
  'search.list': 100, // Expensive!
} as const;

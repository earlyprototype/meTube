/**
 * Zod schemas for the YouTube Data API v3 response shapes that v2 actually
 * consumes. Mirrors the field selection in
 * `legacy/python/src/api/youtube_client.py`:
 *
 *   - `get_video_details`  -> videos.list?part=snippet,contentDetails,statistics,topicDetails
 *   - `get_playlist_info`  -> playlists.list?part=snippet,contentDetails
 *   - `get_playlist_videos` -> playlistItems.list?part=snippet,contentDetails
 *
 * Discipline: only fields the v2 backend reads are required. Fields the
 * YouTube response carries but we ignore are permitted (no `.strict()`) so
 * unexpected API additions don't crash the parser. Optional fields use
 * `.optional()` for "may be absent" and `.nullable()` only where the API
 * actively returns `null`.
 *
 * Uses the Zod v3 API surface (project depends on `zod ^3.25.76`).
 */

import { z } from 'zod';

// --------------------------------------------------------------------------
// Building blocks
// --------------------------------------------------------------------------

/**
 * YouTube thumbnail entry. Each key is a size keyword; the value carries
 * the URL and dimensions. Width/height are optional because the API
 * occasionally returns the entry without them for unusual content.
 */
export const YouTubeThumbnailSchema = z.object({
  url: z.string().url(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});

/**
 * Standard "thumbnails" container — keys are size names (`default`,
 * `medium`, `high`, `standard`, `maxres`). Only `default` is consistently
 * present; the rest are optional.
 */
export const YouTubeThumbnailsSchema = z.object({
  default: YouTubeThumbnailSchema,
  medium: YouTubeThumbnailSchema.optional(),
  high: YouTubeThumbnailSchema.optional(),
  standard: YouTubeThumbnailSchema.optional(),
  maxres: YouTubeThumbnailSchema.optional(),
});

// --------------------------------------------------------------------------
// videos.list response — used by get_video_details
// --------------------------------------------------------------------------

const YouTubeVideoSnippetSchema = z.object({
  publishedAt: z.string(),
  channelId: z.string(),
  title: z.string(),
  description: z.string(),
  channelTitle: z.string(),
  categoryId: z.string().optional(),
  thumbnails: YouTubeThumbnailsSchema,
  tags: z.array(z.string()).optional(),
});

const YouTubeVideoContentDetailsSchema = z.object({
  duration: z.string(), // ISO 8601 e.g. 'PT1M30S'
  definition: z.string().optional(), // 'hd' or 'sd'
  caption: z.string().optional(), // YouTube returns 'true' / 'false' as strings
  licensedContent: z.boolean().optional(),
});

const YouTubeVideoStatisticsSchema = z.object({
  // YouTube returns these as strings in JSON; callers must coerce.
  viewCount: z.string().optional(),
  likeCount: z.string().optional(),
  commentCount: z.string().optional(),
});

const YouTubeVideoTopicDetailsSchema = z.object({
  topicCategories: z.array(z.string()).optional(),
});

/**
 * A single video resource as returned by
 * `videos.list?part=snippet,contentDetails,statistics,topicDetails`.
 *
 * Items in the v1 codebase (and Python) only ever read these subfields.
 * Other parts (`status`, `liveStreamingDetails`, etc.) are permitted but
 * unmodeled.
 */
export const YouTubeVideoSchema = z.object({
  id: z.string(),
  snippet: YouTubeVideoSnippetSchema,
  contentDetails: YouTubeVideoContentDetailsSchema,
  statistics: YouTubeVideoStatisticsSchema.optional(),
  topicDetails: YouTubeVideoTopicDetailsSchema.optional(),
});

// --------------------------------------------------------------------------
// playlists.list response — used by get_playlist_info / get_my_playlists
// --------------------------------------------------------------------------

const YouTubePlaylistSnippetSchema = z.object({
  publishedAt: z.string(),
  channelId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  channelTitle: z.string(),
  thumbnails: YouTubeThumbnailsSchema.optional(),
});

const YouTubePlaylistContentDetailsSchema = z.object({
  itemCount: z.number().int(),
});

const YouTubePlaylistStatusSchema = z.object({
  privacyStatus: z.string().optional(),
});

/**
 * A single playlist resource as returned by
 * `playlists.list?part=snippet,contentDetails[,status]`.
 */
export const YouTubePlaylistSchema = z.object({
  id: z.string(),
  snippet: YouTubePlaylistSnippetSchema,
  contentDetails: YouTubePlaylistContentDetailsSchema,
  status: YouTubePlaylistStatusSchema.optional(),
});

// --------------------------------------------------------------------------
// playlistItems.list response — used by get_playlist_videos
// --------------------------------------------------------------------------

const YouTubePlaylistItemSnippetSchema = z.object({
  publishedAt: z.string(),
  channelId: z.string(),
  title: z.string(),
  channelTitle: z.string(),
  playlistId: z.string(),
  position: z.number().int(),
  thumbnails: YouTubeThumbnailsSchema,
});

const YouTubePlaylistItemContentDetailsSchema = z.object({
  videoId: z.string(),
  videoPublishedAt: z.string().optional(),
});

/**
 * A single item inside a playlist (the wrapper that links a playlist to a
 * specific video), as returned by
 * `playlistItems.list?part=snippet,contentDetails`.
 */
export const YouTubePlaylistItemSchema = z.object({
  id: z.string(),
  snippet: YouTubePlaylistItemSnippetSchema,
  contentDetails: YouTubePlaylistItemContentDetailsSchema,
});

// --------------------------------------------------------------------------
// Generic paged-response wrapper
// --------------------------------------------------------------------------

/**
 * Generic factory for a YouTube paginated response. The API consistently
 * returns `{ items: T[], nextPageToken?: string, prevPageToken?: string,
 * pageInfo?: ... }` regardless of resource type; this schema captures only
 * the fields the v2 pagination loop reads.
 *
 * @typeParam T - Zod schema for an individual item.
 */
export function YouTubePageResponseSchema<T extends z.ZodTypeAny>(
  itemSchema: T
): z.ZodObject<{
  items: z.ZodArray<T>;
  nextPageToken: z.ZodOptional<z.ZodString>;
  prevPageToken: z.ZodOptional<z.ZodString>;
}> {
  return z.object({
    items: z.array(itemSchema),
    nextPageToken: z.string().optional(),
    prevPageToken: z.string().optional(),
  });
}

// --------------------------------------------------------------------------
// Inferred TypeScript types
// --------------------------------------------------------------------------

export type YouTubeThumbnail = z.infer<typeof YouTubeThumbnailSchema>;
export type YouTubeThumbnails = z.infer<typeof YouTubeThumbnailsSchema>;
export type YouTubeVideo = z.infer<typeof YouTubeVideoSchema>;
export type YouTubePlaylist = z.infer<typeof YouTubePlaylistSchema>;
export type YouTubePlaylistItem = z.infer<typeof YouTubePlaylistItemSchema>;

/**
 * Convenience aliases for the most-used paged responses. Callers building
 * other shapes can call `YouTubePageResponseSchema(MySchema)` directly.
 */
export const YouTubeVideosPageSchema = YouTubePageResponseSchema(YouTubeVideoSchema);
export const YouTubePlaylistsPageSchema = YouTubePageResponseSchema(YouTubePlaylistSchema);
export const YouTubePlaylistItemsPageSchema = YouTubePageResponseSchema(YouTubePlaylistItemSchema);

export type YouTubeVideosPage = z.infer<typeof YouTubeVideosPageSchema>;
export type YouTubePlaylistsPage = z.infer<typeof YouTubePlaylistsPageSchema>;
export type YouTubePlaylistItemsPage = z.infer<typeof YouTubePlaylistItemsPageSchema>;

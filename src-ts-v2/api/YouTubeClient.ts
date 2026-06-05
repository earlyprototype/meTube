/**
 * v2 YouTube Data API v3 client.
 *
 * Differentiators from v1's `src-ts/api/YouTubeClient.ts`:
 *   1. **Zod parse at every response.** Every raw `youtube.*.list`
 *      response is `parse()`d through a schema from `schemas/youtube.ts`
 *      *before* becoming a typed domain object. No
 *      `response.data.items[0] as YouTubeVideo` casts. This is the v2
 *      foreclosure of the v1 "JSON.parse → blind cast" pattern.
 *   2. **Branded IDs at every public boundary.** Callers pass `VideoId`
 *      / `PlaylistId`, not raw strings. The compile-time forbids
 *      crossing the wires. Drops v1's runtime `validateYouTubeId(...)`
 *      calls — branded IDs are pre-validated by construction.
 *   3. **Pagination is built in.** `getPlaylistItems` and
 *      `getMyPlaylists` paginate to completion via `nextPageToken`,
 *      with a hard safety ceiling. v1's bug class
 *      (`getPlaylistVideos` returning at most 50 because the loop was
 *      single-shot) cannot be reproduced — the public method returns
 *      the full list.
 *   4. **OAuth2Client is passed in, not loaded.** This file does not
 *      touch the filesystem. The caller (YouTubeAuth, Wave 3) hands a
 *      configured `OAuth2Client` to the constructor. `tokens.json` is
 *      YouTubeAuth's concern.
 *   5. **Pino logging only** (no `console.print` carried from Python).
 *   6. **No `any`** — all narrowing goes through Zod.
 *
 * Maps to: `legacy/python/src/api/youtube_client.py`.
 */
import { google, youtube_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';

import { AppError, ValidationError } from '../errors/index.js';
import logger from '../utils/logger.js';
import { asVideoId, asPlaylistId } from '../types/index.js';
import type { VideoId, PlaylistId } from '../types/index.js';
import {
  YouTubeVideoSchema,
  YouTubePlaylistSchema,
  YouTubePlaylistItemSchema,
  YouTubePageResponseSchema,
} from '../schemas/youtube.js';
import {
  YOUTUBE_API_COSTS,
  type YouTubePlaylist,
  type YouTubeVideo,
  type YouTubePlaylistItem,
} from './types.js';
import { RateLimiter } from './RateLimiter.js';
import { RetryHandler } from './RetryHandler.js';

/**
 * Internal pagination safety ceiling. Even at 50 items/page this allows
 * 5,000 items per call — well beyond any realistic personal playlist.
 * Prevents infinite-loop pathologies if YouTube ever returns a
 * non-terminating `nextPageToken`.
 */
const MAX_PAGES = 100;

/**
 * Schema for the `search.list` API response items. Only modeled here
 * because `searchPlaylists` is the one method that consumes it; if
 * other callers grow, lift to `schemas/youtube.ts`.
 *
 * The `search.list?type=playlist` response wraps the playlist's real ID
 * inside `id.playlistId` (the resource ID is *not* a flat string).
 */
const YouTubeSearchPlaylistItemSchema = z.object({
  id: z.object({
    kind: z.string(),
    playlistId: z.string(),
  }),
  snippet: z.object({
    title: z.string(),
    description: z.string().optional(),
    channelId: z.string(),
    channelTitle: z.string(),
    publishedAt: z.string(),
  }),
});

const YouTubeSearchPlaylistsPageSchema = YouTubePageResponseSchema(
  YouTubeSearchPlaylistItemSchema
);

/**
 * v2 lightweight search-result type. Distinct from `YouTubePlaylist`
 * because `search.list` does NOT return `contentDetails.itemCount` —
 * callers wanting the full playlist must follow up with
 * `getPlaylistById(asPlaylistId(result.playlistId))`.
 */
export interface YouTubePlaylistSearchResult {
  playlistId: PlaylistId;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
}

/**
 * Constructor options for `YouTubeClient`. Optional dependencies allow
 * tests to inject custom rate limiters and retry handlers; production
 * callers pass only the OAuth2Client.
 */
export interface YouTubeClientOptions {
  rateLimiter?: RateLimiter;
  retryHandler?: RetryHandler;
}

export class YouTubeClient {
  private readonly youtube: youtube_v3.Youtube;
  private readonly rateLimiter: RateLimiter;
  private readonly retryHandler: RetryHandler;

  /**
   * Create a new YouTubeClient.
   *
   * @param oauth2Client - Authenticated OAuth2 client (from `YouTubeAuth`)
   * @param options - Optional rate limiter / retry handler overrides
   * @throws {ValidationError} If `oauth2Client` is missing
   */
  constructor(oauth2Client: OAuth2Client, options: YouTubeClientOptions = {}) {
    if (!oauth2Client) {
      throw new ValidationError('OAuth2Client is required', {
        field: 'oauth2Client',
      });
    }

    this.youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client,
    });

    this.rateLimiter =
      options.rateLimiter ??
      new RateLimiter({
        maxRequests: 100,
        windowMs: 60 * 1000,
      });

    this.retryHandler =
      options.retryHandler ??
      new RetryHandler({
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        retryableErrors: ['503', 'ECONNRESET', 'ETIMEDOUT', 'rate limit', 'quota'],
      });

    logger.info('YouTubeClient initialized with rate limiting and retry logic');
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Parse an ISO 8601 duration (e.g. `'PT1H2M10S'`) into seconds.
   *
   * Mirrors `legacy/python/src/api/youtube_client.py:parse_duration`.
   *
   * @param duration - ISO 8601 duration string. Empty string → 0.
   * @returns Total seconds, or 0 if the input is unparseable.
   */
  private parseDuration(duration: string): number {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;

    const hours = parseInt(match[1] ?? '0', 10);
    const minutes = parseInt(match[2] ?? '0', 10);
    const seconds = parseInt(match[3] ?? '0', 10);

    return hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * Parse a YouTube statistic field (returned as a string in JSON) into
   * a number. Returns `undefined` if the field is absent.
   */
  private parseStat(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  }

  /**
   * Parse YouTube's pseudo-boolean `'true'` / `'false'` string into a
   * real boolean. Anything else maps to `undefined`.
   */
  private parseBoolStr(raw: string | undefined): boolean | undefined {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }

  /**
   * Convert a Zod-parsed YouTube video resource into the v2 domain
   * shape, branding the ID at the wire boundary.
   *
   * @param parsed - Schema-validated video item
   * @returns Branded `YouTubeVideo` domain object
   */
  private toVideo(parsed: z.infer<typeof YouTubeVideoSchema>): YouTubeVideo {
    const durationSeconds = this.parseDuration(parsed.contentDetails.duration);
    return {
      videoId: asVideoId(parsed.id),
      title: parsed.snippet.title,
      description: parsed.snippet.description,
      channelId: parsed.snippet.channelId,
      channelTitle: parsed.snippet.channelTitle,
      publishedAt: parsed.snippet.publishedAt,
      duration: parsed.contentDetails.duration,
      durationSeconds,
      isShort: durationSeconds > 0 && durationSeconds <= 60,
      viewCount: this.parseStat(parsed.statistics?.viewCount),
      likeCount: this.parseStat(parsed.statistics?.likeCount),
      commentCount: this.parseStat(parsed.statistics?.commentCount),
      thumbnailUrl: parsed.snippet.thumbnails.default.url,
      tags: parsed.snippet.tags,
      categoryId: parsed.snippet.categoryId,
      caption: this.parseBoolStr(parsed.contentDetails.caption),
      licensedContent: parsed.contentDetails.licensedContent,
      topicCategories: parsed.topicDetails?.topicCategories,
    };
  }

  /**
   * Convert a Zod-parsed YouTube playlist resource into the v2 domain
   * shape, branding the ID at the wire boundary.
   *
   * @param parsed - Schema-validated playlist item
   * @returns Branded `YouTubePlaylist` domain object
   */
  private toPlaylist(parsed: z.infer<typeof YouTubePlaylistSchema>): YouTubePlaylist {
    return {
      playlistId: asPlaylistId(parsed.id),
      title: parsed.snippet.title,
      description: parsed.snippet.description ?? '',
      itemCount: parsed.contentDetails.itemCount,
      thumbnailUrl: parsed.snippet.thumbnails?.default.url,
      channelId: parsed.snippet.channelId,
      channelTitle: parsed.snippet.channelTitle,
      publishedAt: parsed.snippet.publishedAt,
      privacyStatus: parsed.status?.privacyStatus,
    };
  }

  /**
   * Convert a Zod-parsed playlistItems.list resource into the v2
   * domain shape, branding both IDs at the wire boundary.
   *
   * @param parsed - Schema-validated playlist item
   * @returns Branded `YouTubePlaylistItem` domain object
   */
  private toPlaylistItem(
    parsed: z.infer<typeof YouTubePlaylistItemSchema>
  ): YouTubePlaylistItem {
    return {
      videoId: asVideoId(parsed.contentDetails.videoId),
      playlistId: asPlaylistId(parsed.snippet.playlistId),
      position: parsed.snippet.position,
      title: parsed.snippet.title,
      channelId: parsed.snippet.channelId,
      channelTitle: parsed.snippet.channelTitle,
      addedAt: parsed.snippet.publishedAt,
      thumbnailUrl: parsed.snippet.thumbnails.default.url,
    };
  }

  /**
   * Parse a raw API response payload through a Zod schema, throwing a
   * typed `AppError` on shape mismatch. Centralizes the
   * "untrusted-external → validated" boundary.
   *
   * @typeParam T - Zod schema type
   * @param schema - Schema to parse against
   * @param data - Raw response data from `youtube.*.list().then(r => r.data)`
   * @param context - Identifying context for the error (e.g. operation
   *                  name + IDs)
   * @returns Parsed payload typed by the schema
   * @throws {AppError} If the payload fails to parse
   */
  private parseResponse<T extends z.ZodTypeAny>(
    schema: T,
    data: unknown,
    context: Record<string, unknown>
  ): z.infer<T> {
    const result = schema.safeParse(data);
    if (!result.success) {
      logger.error(
        { errors: result.error.flatten(), ...context },
        'YouTube API response failed schema validation'
      );
      throw new AppError('YouTube API response shape mismatch', {
        code: 'YOUTUBE_API_PARSE_ERROR',
        cause: result.error,
        context,
      });
    }
    return result.data;
  }

  // ------------------------------------------------------------------
  // Public methods
  // ------------------------------------------------------------------

  /**
   * Fetch a single video by branded ID.
   *
   * Maps to `legacy/python/src/api/youtube_client.py:get_single_video`.
   *
   * @param videoId - Branded YouTube video ID
   * @returns The video domain object, or `null` if not found
   * @throws {AppError} On API failure or schema mismatch
   */
  async getVideoById(videoId: VideoId): Promise<YouTubeVideo | null> {
    await this.rateLimiter.waitForToken('videos.list', YOUTUBE_API_COSTS['videos.list']);

    return this.retryHandler.execute('getVideoById', async () => {
      logger.info({ videoId }, 'Fetching video by ID');

      try {
        const response = await this.youtube.videos.list({
          part: ['snippet', 'contentDetails', 'statistics', 'topicDetails'],
          id: [videoId],
        });

        const items = response.data.items ?? [];
        if (items.length === 0) {
          logger.warn({ videoId }, 'Video not found');
          return null;
        }

        const parsed = this.parseResponse(YouTubeVideoSchema, items[0], {
          method: 'getVideoById',
          videoId,
        });

        return this.toVideo(parsed);
      } catch (error) {
        if (error instanceof AppError) throw error;
        logger.error({ error, videoId }, 'Failed to fetch video');
        throw new AppError('Failed to fetch video', {
          cause: error,
          code: 'YOUTUBE_API_ERROR',
          context: { videoId },
        });
      }
    });
  }

  /**
   * Fetch a single playlist by branded ID.
   *
   * Maps to `legacy/python/src/api/youtube_client.py:get_playlist_info`.
   *
   * @param playlistId - Branded YouTube playlist ID
   * @returns The playlist domain object, or `null` if not found
   * @throws {AppError} On API failure or schema mismatch
   */
  async getPlaylistById(playlistId: PlaylistId): Promise<YouTubePlaylist | null> {
    await this.rateLimiter.waitForToken(
      'playlists.list',
      YOUTUBE_API_COSTS['playlists.list']
    );

    return this.retryHandler.execute('getPlaylistById', async () => {
      logger.info({ playlistId }, 'Fetching playlist by ID');

      try {
        const response = await this.youtube.playlists.list({
          part: ['snippet', 'contentDetails', 'status'],
          id: [playlistId],
        });

        const items = response.data.items ?? [];
        if (items.length === 0) {
          logger.warn({ playlistId }, 'Playlist not found');
          return null;
        }

        const parsed = this.parseResponse(YouTubePlaylistSchema, items[0], {
          method: 'getPlaylistById',
          playlistId,
        });

        return this.toPlaylist(parsed);
      } catch (error) {
        if (error instanceof AppError) throw error;
        logger.error({ error, playlistId }, 'Failed to fetch playlist');
        throw new AppError('Failed to fetch playlist', {
          cause: error,
          code: 'YOUTUBE_API_ERROR',
          context: { playlistId },
        });
      }
    });
  }

  /**
   * Fetch ALL items from a playlist, paginating to completion via
   * `nextPageToken`. This is the v2 foreclosure of v1's 50-cap bug in
   * `getPlaylistVideos`.
   *
   * Maps to `legacy/python/src/api/youtube_client.py:get_playlist_videos`.
   *
   * @param playlistId - Branded YouTube playlist ID
   * @returns Every item in the playlist, in API page order
   * @throws {AppError} On API failure or schema mismatch
   */
  async getPlaylistItems(playlistId: PlaylistId): Promise<YouTubePlaylistItem[]> {
    const allItems: YouTubePlaylistItem[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;

    do {
      pageCount += 1;

      // Safety: refuse to paginate forever even if YouTube misbehaves.
      if (pageCount > MAX_PAGES) {
        logger.error(
          { playlistId, pageCount, totalSoFar: allItems.length },
          'Pagination safety ceiling reached — playlist exceeds maximum fetchable size'
        );
        throw new AppError(
          `Playlist exceeds maximum fetchable size (${MAX_PAGES} pages, ~${MAX_PAGES * 50} items)`,
          {
            code: 'PLAYLIST_TOO_LARGE',
            context: { playlistId, pageCount, itemsFetched: allItems.length },
          }
        );
      }

      await this.rateLimiter.waitForToken(
        'playlistItems.list',
        YOUTUBE_API_COSTS['playlistItems.list']
      );

      const page = await this.retryHandler.execute<{
        items: YouTubePlaylistItem[];
        nextPageToken?: string;
      }>('getPlaylistItems', async () => {
        logger.debug({ playlistId, pageToken, pageCount }, 'Fetching playlist page');

        try {
          const response = await this.youtube.playlistItems.list({
            part: ['snippet', 'contentDetails'],
            playlistId,
            maxResults: 50,
            pageToken: pageToken ?? undefined,
          });

          const parsedPage = this.parseResponse(
            YouTubePageResponseSchema(YouTubePlaylistItemSchema),
            response.data,
            { method: 'getPlaylistItems', playlistId, pageCount }
          );

          return {
            items: parsedPage.items.map((it) => this.toPlaylistItem(it)),
            nextPageToken: parsedPage.nextPageToken,
          };
        } catch (error) {
          if (error instanceof AppError) throw error;
          logger.error({ error, playlistId, pageCount }, 'Failed to fetch playlist page');
          throw new AppError('Failed to fetch playlist items', {
            cause: error,
            code: 'YOUTUBE_API_ERROR',
            context: { playlistId, pageCount },
          });
        }
      });

      allItems.push(...page.items);
      pageToken = page.nextPageToken;
    } while (pageToken);

    logger.info(
      { playlistId, totalItems: allItems.length, pages: pageCount },
      'Fetched all playlist items'
    );

    return allItems;
  }

  /**
   * Fetch ALL playlists owned by the authenticated user, paginating to
   * completion via `nextPageToken`.
   *
   * Maps to `legacy/python/src/api/youtube_client.py:get_my_playlists`.
   *
   * @returns Every playlist owned by the authenticated account
   * @throws {AppError} On API failure or schema mismatch
   */
  async getMyPlaylists(): Promise<YouTubePlaylist[]> {
    const allPlaylists: YouTubePlaylist[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;

    do {
      pageCount += 1;

      if (pageCount > MAX_PAGES) {
        logger.error(
          { pageCount, totalSoFar: allPlaylists.length },
          'Pagination safety ceiling reached — user has too many playlists'
        );
        throw new AppError(
          `User has too many playlists (exceeds ${MAX_PAGES} pages, ~${MAX_PAGES * 50} playlists)`,
          {
            code: 'TOO_MANY_PLAYLISTS',
            context: { pageCount, playlistsFetched: allPlaylists.length },
          }
        );
      }

      await this.rateLimiter.waitForToken(
        'playlists.list',
        YOUTUBE_API_COSTS['playlists.list']
      );

      const page = await this.retryHandler.execute<{
        items: YouTubePlaylist[];
        nextPageToken?: string;
      }>('getMyPlaylists', async () => {
        logger.debug({ pageToken, pageCount }, 'Fetching my playlists page');

        try {
          const response = await this.youtube.playlists.list({
            part: ['snippet', 'contentDetails', 'status'],
            mine: true,
            maxResults: 50,
            pageToken: pageToken ?? undefined,
          });

          const parsedPage = this.parseResponse(
            YouTubePageResponseSchema(YouTubePlaylistSchema),
            response.data,
            { method: 'getMyPlaylists', pageCount }
          );

          return {
            items: parsedPage.items.map((it) => this.toPlaylist(it)),
            nextPageToken: parsedPage.nextPageToken,
          };
        } catch (error) {
          if (error instanceof AppError) throw error;
          logger.error({ error, pageCount }, 'Failed to fetch playlists page');
          throw new AppError('Failed to fetch playlists', {
            cause: error,
            code: 'YOUTUBE_API_ERROR',
            context: { pageCount },
          });
        }
      });

      allPlaylists.push(...page.items);
      pageToken = page.nextPageToken;
    } while (pageToken);

    logger.info(
      { totalPlaylists: allPlaylists.length, pages: pageCount },
      'Fetched all user playlists'
    );

    return allPlaylists;
  }

  /**
   * Search YouTube for playlists matching a query. Uses `search.list`
   * with `type=playlist` — note the 100-unit quota cost per call (see
   * `YOUTUBE_API_COSTS`).
   *
   * Returns lightweight `YouTubePlaylistSearchResult` shapes — the
   * `search.list` endpoint does not include `contentDetails.itemCount`.
   * Callers needing full playlist data should follow up with
   * `getPlaylistById` per hit.
   *
   * @param query - Free-form search query
   * @returns Up to 50 matching playlists
   * @throws {ValidationError} If the query is empty
   * @throws {AppError} On API failure or schema mismatch
   */
  async searchPlaylists(query: string): Promise<YouTubePlaylistSearchResult[]> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new ValidationError('Search query must be a non-empty string', {
        field: 'query',
        value: query,
      });
    }

    await this.rateLimiter.waitForToken('search.list', YOUTUBE_API_COSTS['search.list']);

    return this.retryHandler.execute('searchPlaylists', async () => {
      logger.info({ query }, 'Searching playlists');

      try {
        const response = await this.youtube.search.list({
          part: ['snippet'],
          q: query,
          type: ['playlist'],
          maxResults: 50,
        });

        const parsedPage = this.parseResponse(
          YouTubeSearchPlaylistsPageSchema,
          response.data,
          { method: 'searchPlaylists', query }
        );

        const results: YouTubePlaylistSearchResult[] = parsedPage.items.map((it) => ({
          playlistId: asPlaylistId(it.id.playlistId),
          title: it.snippet.title,
          description: it.snippet.description ?? '',
          channelId: it.snippet.channelId,
          channelTitle: it.snippet.channelTitle,
          publishedAt: it.snippet.publishedAt,
        }));

        logger.info({ query, count: results.length }, 'Playlist search complete');
        return results;
      } catch (error) {
        if (error instanceof AppError) throw error;
        logger.error({ error, query }, 'Failed to search playlists');
        throw new AppError('Failed to search playlists', {
          cause: error,
          code: 'YOUTUBE_API_ERROR',
          context: { query },
        });
      }
    });
  }
}

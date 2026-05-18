import { google, youtube_v3 } from 'googleapis';
import { YouTubeAuth } from '../auth/YouTubeAuth.js';
import { ValidationError, AppError } from '../errors/index.js';
import logger from '../utils/logger.js';
import { validateYouTubeId } from '../utils/validation.js';
import { YouTubePlaylist, YouTubeVideo, YouTubePlaylistItem, YOUTUBE_API_COSTS } from './types.js';
import { RateLimiter } from './RateLimiter.js';
import { RetryHandler } from './RetryHandler.js';

/**
 * YouTubeClient wraps the YouTube Data API v3
 *
 * Features:
 * - Fetches playlists, videos, and video details
 * - Automatic token refresh
 * - Rate limiting (respects YouTube quotas)
 * - Retry logic with exponential backoff
 * - Error handling and logging
 * - Input validation
 */
export class YouTubeClient {
  private youtube: youtube_v3.Youtube;
  private auth: YouTubeAuth;
  private rateLimiter: RateLimiter;
  private retryHandler: RetryHandler;

  /**
   * Create a new YouTubeClient instance
   *
   * @param auth - YouTubeAuth instance with valid credentials
   * @param rateLimiter - Optional custom rate limiter (defaults to 100 req/min)
   * @param retryHandler - Optional custom retry handler (defaults to 3 retries)
   * @throws {ValidationError} If auth is invalid
   */
  constructor(
    auth: YouTubeAuth,
    rateLimiter?: RateLimiter,
    retryHandler?: RetryHandler
  ) {
    if (!auth) {
      throw new ValidationError('YouTubeAuth instance is required');
    }

    this.auth = auth;
    this.youtube = google.youtube({
      version: 'v3',
      auth: auth.getOAuth2Client(),
    });

    // Initialize rate limiter (conservative: 100 requests per minute)
    this.rateLimiter =
      rateLimiter ||
      new RateLimiter({
        maxRequests: 100,
        windowMs: 60 * 1000, // 1 minute
      });

    // Initialize retry handler (3 retries with exponential backoff)
    this.retryHandler =
      retryHandler ||
      new RetryHandler({
        maxRetries: 3,
        baseDelayMs: 1000, // Start with 1 second
        maxDelayMs: 30000, // Max 30 seconds
        retryableErrors: ['503', 'ECONNRESET', 'ETIMEDOUT', 'rate limit', 'quota'],
      });

    logger.info('YouTubeClient initialized with rate limiting and retry logic');
  }

  /**
   * Ensure we have valid authentication before making API calls
   *
   * @throws {AppError} If authentication fails
   */
  private async ensureAuthenticated(): Promise<void> {
    try {
      await this.auth.ensureValidTokens();
    } catch (error) {
      logger.error({ error }, 'Authentication check failed');
      throw new AppError('YouTube API authentication required', {
        cause: error,
        code: 'AUTH_REQUIRED',
      });
    }
  }

  /**
   * Parse ISO 8601 duration to seconds
   *
   * @param duration - ISO 8601 duration string (e.g., "PT1H2M10S")
   * @returns Duration in seconds
   */
  private parseDuration(duration: string): number {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;

    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseInt(match[3] || '0', 10);

    return hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * Map YouTube API playlist response to our PlaylistData interface
   *
   * @param item - YouTube API playlist item
   * @returns Mapped playlist data
   */
  private mapPlaylist(item: youtube_v3.Schema$Playlist): YouTubePlaylist {
    return {
      id: item.id || '',
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
      itemCount: item.contentDetails?.itemCount || 0,
      thumbnailUrl: item.snippet?.thumbnails?.default?.url || undefined,
      channelId: item.snippet?.channelId || undefined,
      channelTitle: item.snippet?.channelTitle || undefined,
      publishedAt: item.snippet?.publishedAt || undefined,
    };
  }

  /**
   * Map YouTube API video response to our VideoData interface
   *
   * @param item - YouTube API video item
   * @returns Mapped video data
   */
  private mapVideo(item: youtube_v3.Schema$Video): YouTubeVideo {
    const viewCount = item.statistics?.viewCount
      ? parseInt(item.statistics.viewCount, 10)
      : undefined;
    const likeCount = item.statistics?.likeCount
      ? parseInt(item.statistics.likeCount, 10)
      : undefined;
    const commentCount = item.statistics?.commentCount
      ? parseInt(item.statistics.commentCount, 10)
      : undefined;

    return {
      id: item.id || '',
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
      channelId: item.snippet?.channelId || '',
      channelTitle: item.snippet?.channelTitle || '',
      publishedAt: item.snippet?.publishedAt || '',
      duration: item.contentDetails?.duration || '',
      viewCount,
      likeCount,
      commentCount,
      thumbnailUrl: item.snippet?.thumbnails?.default?.url || undefined,
      tags: item.snippet?.tags || undefined,
    };
  }

  /**
   * Fetch user's YouTube playlists
   *
   * @param maxResults - Maximum number of playlists to fetch (1-50, default: 50)
   * @param pageToken - Page token for pagination (optional)
   * @returns Array of playlist objects
   * @throws {ValidationError} If maxResults is invalid
   * @throws {AppError} If API request fails
   */
  async getPlaylists(
    maxResults = 50,
    pageToken?: string
  ): Promise<{ playlists: YouTubePlaylist[]; nextPageToken?: string }> {
    if (maxResults < 1 || maxResults > 50) {
      throw new ValidationError('maxResults must be between 1 and 50', {
        field: 'maxResults',
        value: maxResults,
      });
    }

    if (pageToken && (typeof pageToken !== 'string' || pageToken.trim().length === 0)) {
      throw new ValidationError('pageToken must be a non-empty string', {
        field: 'pageToken',
      });
    }

    await this.ensureAuthenticated();

    // Apply rate limiting
    await this.rateLimiter.waitForToken('playlists.list', YOUTUBE_API_COSTS['playlists.list']);

    // Execute with retry logic
    return this.retryHandler.execute('getPlaylists', async () => {
      try {
        logger.info({ maxResults, pageToken }, 'Fetching user playlists');

        const response = await this.youtube.playlists.list({
          part: ['snippet', 'contentDetails'],
          mine: true,
          maxResults,
          pageToken: pageToken || undefined,
        });

        if (!response.data.items || response.data.items.length === 0) {
          logger.warn('No playlists found');
          return { playlists: [], nextPageToken: undefined };
        }

        const playlists = response.data.items.map((item) => this.mapPlaylist(item));
        logger.info({ count: playlists.length }, 'Playlists fetched successfully');

        return {
          playlists,
          nextPageToken: response.data.nextPageToken || undefined,
        };
      } catch (error) {
        logger.error({ error, maxResults }, 'Failed to fetch playlists');
        throw new AppError('Failed to fetch YouTube playlists', {
          cause: error,
          code: 'YOUTUBE_API_ERROR',
        });
      }
    });
  }

  /**
   * Fetch a single playlist by ID
   *
   * @param playlistId - YouTube playlist ID
   * @returns Playlist object
   * @throws {ValidationError} If playlistId is invalid
   * @throws {AppError} If API request fails or playlist not found
   */
  async getPlaylistById(playlistId: string): Promise<YouTubePlaylist> {
    validateYouTubeId(playlistId, 'playlist');

    await this.ensureAuthenticated();

    // Apply rate limiting
    await this.rateLimiter.waitForToken('playlists.list', YOUTUBE_API_COSTS['playlists.list']);

    // Execute with retry logic
    return this.retryHandler.execute('getPlaylistById', async () => {
      try {
        logger.info({ playlistId }, 'Fetching playlist by ID');

        const response = await this.youtube.playlists.list({
          part: ['snippet', 'contentDetails', 'status'],
          id: [playlistId],
        });

        if (!response.data.items || response.data.items.length === 0) {
          throw new AppError('Playlist not found', {
            code: 'PLAYLIST_NOT_FOUND',
            context: { playlistId },
          });
        }

        const playlist = this.mapPlaylist(response.data.items[0]);
        logger.info({ playlistId }, 'Playlist fetched successfully');
        return playlist;
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
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
   * Fetch videos from a playlist
   *
   * @param playlistId - YouTube playlist ID
   * @param maxResults - Maximum videos to fetch (1-50, default: 50)
   * @param pageToken - Page token for pagination (optional)
   * @returns Array of playlist items
   * @throws {ValidationError} If playlistId or maxResults is invalid
   * @throws {AppError} If API request fails
   */
  async getPlaylistVideos(
    playlistId: string,
    maxResults = 50,
    pageToken?: string
  ): Promise<{ items: YouTubePlaylistItem[]; nextPageToken?: string }> {
    validateYouTubeId(playlistId, 'playlist');

    if (maxResults < 1 || maxResults > 50) {
      throw new ValidationError('maxResults must be between 1 and 50', {
        field: 'maxResults',
        value: maxResults,
      });
    }

    if (pageToken && (typeof pageToken !== 'string' || pageToken.trim().length === 0)) {
      throw new ValidationError('pageToken must be a non-empty string', {
        field: 'pageToken',
      });
    }

    await this.ensureAuthenticated();

    // Apply rate limiting
    await this.rateLimiter.waitForToken('playlistItems.list', YOUTUBE_API_COSTS['playlistItems.list']);

    // Execute with retry logic
    return this.retryHandler.execute('getPlaylistVideos', async () => {
      try {
        logger.info({ playlistId, maxResults, pageToken }, 'Fetching playlist videos');

        const response = await this.youtube.playlistItems.list({
          part: ['snippet', 'contentDetails'],
          playlistId,
          maxResults,
          pageToken: pageToken || undefined,
        });

        if (!response.data.items || response.data.items.length === 0) {
          logger.warn({ playlistId }, 'No videos found in playlist');
          return { items: [], nextPageToken: undefined };
        }

      const items: YouTubePlaylistItem[] = response.data.items
        .filter((item) => !!item.contentDetails?.videoId)
        .map((item, index) => ({
          videoId: item.contentDetails!.videoId!,
          playlistId,
          position: item.snippet?.position ?? index,
          title: item.snippet?.title || undefined,
          description: item.snippet?.description || undefined,
          thumbnailUrl: item.snippet?.thumbnails?.default?.url || undefined,
        }));

        logger.info(
          { playlistId, count: items.length },
          'Playlist videos fetched successfully'
        );

        return {
          items,
          nextPageToken: response.data.nextPageToken || undefined,
        };
      } catch (error) {
        logger.error({ error, playlistId }, 'Failed to fetch playlist videos');
        throw new AppError('Failed to fetch playlist videos', {
          cause: error,
          code: 'YOUTUBE_API_ERROR',
          context: { playlistId },
        });
      }
    });
  }

  /**
   * Fetch detailed information for a video
   *
   * @param videoId - YouTube video ID
   * @returns Video details object
   * @throws {ValidationError} If videoId is invalid
   * @throws {AppError} If API request fails or video not found
   */
  async getVideoDetails(videoId: string): Promise<YouTubeVideo> {
    validateYouTubeId(videoId, 'video');

    await this.ensureAuthenticated();

    // Apply rate limiting
    await this.rateLimiter.waitForToken('videos.list', YOUTUBE_API_COSTS['videos.list']);

    // Execute with retry logic
    return this.retryHandler.execute('getVideoDetails', async () => {
      try {
        logger.info({ videoId }, 'Fetching video details');

        const response = await this.youtube.videos.list({
          part: ['snippet', 'contentDetails', 'statistics'],
          id: [videoId],
        });

        if (!response.data.items || response.data.items.length === 0) {
          throw new AppError('Video not found', {
            code: 'VIDEO_NOT_FOUND',
            context: { videoId },
          });
        }

        const video = this.mapVideo(response.data.items[0]);
        logger.info({ videoId, title: video.title }, 'Video details fetched successfully');
        return video;
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        logger.error({ error, videoId }, 'Failed to fetch video details');
        throw new AppError('Failed to fetch video details', {
          cause: error,
          code: 'YOUTUBE_API_ERROR',
          context: { videoId },
        });
      }
    });
  }

  /**
   * Fetch details for multiple videos in a single API call
   *
   * @param videoIds - Array of YouTube video IDs (max 50)
   * @returns Array of video details
   * @throws {ValidationError} If videoIds array is invalid
   * @throws {AppError} If API request fails
   */
  async getMultipleVideoDetails(videoIds: string[]): Promise<YouTubeVideo[]> {
    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      throw new ValidationError('videoIds must be a non-empty array', {
        field: 'videoIds',
      });
    }

    if (videoIds.length > 50) {
      throw new ValidationError('videoIds array cannot contain more than 50 items', {
        field: 'videoIds',
        value: videoIds.length,
      });
    }

    // Validate each video ID
    videoIds.forEach((id, index) => {
      try {
        validateYouTubeId(id, 'video');
      } catch (error) {
        throw new ValidationError(`Invalid video ID at index ${index}`, {
          field: `videoIds[${index}]`,
          value: id,
          cause: error,
        });
      }
    });

    await this.ensureAuthenticated();

    // Apply rate limiting
    await this.rateLimiter.waitForToken('videos.list', YOUTUBE_API_COSTS['videos.list']);

    // Execute with retry logic
    return this.retryHandler.execute('getMultipleVideoDetails', async () => {
      try {
        logger.info({ count: videoIds.length }, 'Fetching multiple video details');

        const response = await this.youtube.videos.list({
          part: ['snippet', 'contentDetails', 'statistics'],
          id: videoIds,
        });

        if (!response.data.items || response.data.items.length === 0) {
          logger.warn({ videoIds }, 'No videos found');
          return [];
        }

        const videos = response.data.items.map((item) => this.mapVideo(item));
        logger.info({ requested: videoIds.length, found: videos.length }, 'Videos fetched');
        return videos;
      } catch (error) {
        logger.error({ error, count: videoIds.length }, 'Failed to fetch videos');
        throw new AppError('Failed to fetch video details', {
          cause: error,
          code: 'YOUTUBE_API_ERROR',
        });
      }
    });
  }

  /**
   * Fetch all videos from a playlist (handles pagination automatically)
   *
   * @param playlistId - YouTube playlist ID
   * @returns Array of all playlist items
   * @throws {ValidationError} If playlistId is invalid
   * @throws {AppError} If API request fails
   */
  async getAllPlaylistVideos(playlistId: string): Promise<YouTubePlaylistItem[]> {
    validateYouTubeId(playlistId, 'playlist');

    logger.info({ playlistId }, 'Fetching all videos from playlist');

    const allItems: YouTubePlaylistItem[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;

    do {
      const result = await this.getPlaylistVideos(playlistId, 50, pageToken);
      allItems.push(...result.items);
      pageToken = result.nextPageToken;
      pageCount++;

      logger.debug(
        { playlistId, pageCount, totalItems: allItems.length },
        'Fetched playlist page'
      );

      // Safety limit: prevent infinite loops
      if (pageCount > 100) {
        logger.warn({ playlistId, pageCount }, 'Pagination limit reached');
        break;
      }
    } while (pageToken);

    logger.info(
      { playlistId, totalItems: allItems.length, pages: pageCount },
      'Fetched all playlist videos'
    );

    return allItems;
  }
}

/**
 * Main video extraction pipeline orchestrator
 * Coordinates all extractors, parsers, and database operations
 */

import { DatabaseManager } from '../database/connection.js';
import { YouTubeClient } from '../api/YouTubeClient.js';
import { TranscriptExtractor } from './TranscriptExtractor.js';
import { WhisperExtractor } from './WhisperExtractor.js';
import { DescriptionParser } from '../parsers/DescriptionParser.js';
import { GeminiParser } from '../parsers/GeminiParser.js';
import {
  VideoRepository,
  PlaylistRepository,
  PlaylistItemRepository,
  TranscriptRepository,
  EntityRepository,
} from '../database/repositories.js';
import logger from '../utils/logger.js';
import { ValidationError, AppError, DatabaseError } from '../errors/index.js';
import type { TranscriptData } from './TranscriptExtractor.js';
import type { ParsedTranscript } from '../parsers/GeminiParser.js';

/**
 * Video extraction result
 */
export interface VideoExtractionResult {
  videoData: any;
  transcriptData: TranscriptData | null;
  parsedEntities: ParsedTranscript | null;
}

/**
 * Playlist extraction result
 */
export interface PlaylistExtractionResult {
  total: number;
  processed: number;
  new: number;
  skipped: number;
  failed: number;
}

/**
 * Progress callback for playlist extraction
 */
export interface PlaylistProgressCallback {
  (progress: {
    current: number;
    total: number;
    videoId: string;
    videoTitle: string;
    status: 'processing' | 'complete' | 'failed' | 'skipped';
  }): void;
}

/**
 * Whisper progress callback
 */
export interface WhisperProgressCallback {
  (progress: {
    stage: 'downloading' | 'transcribing' | 'complete';
    percentage?: number;
    message?: string;
  }): void;
}

/**
 * VideoExtractor configuration
 */
export interface VideoExtractorConfig {
  autoTranscript?: boolean;
  autoLlmParse?: boolean;
  geminiApiKey?: string;
  languages?: string[];
  transcriptRateLimit?: number;
  enableWhisper?: boolean;
  onProgress?: PlaylistProgressCallback;
  onWhisperProgress?: WhisperProgressCallback;
}

/**
 * Main extraction pipeline for videos
 */
export class VideoExtractor {
  private readonly youtubeClient: YouTubeClient;
  private readonly db: DatabaseManager;
  private readonly autoTranscript: boolean;
  private readonly autoLlmParse: boolean;
  private readonly transcriptExtractor: TranscriptExtractor;
  private readonly descriptionParser: DescriptionParser;
  private readonly llmParser: GeminiParser | null;
  private readonly videoRepository: VideoRepository;
  private readonly transcriptRepository: TranscriptRepository;
  private readonly entityRepository: EntityRepository;
  private readonly playlistItemRepository: PlaylistItemRepository;
  private readonly playlistRepository: PlaylistRepository;
  private readonly onProgress?: PlaylistProgressCallback;

  /**
   * Create a new VideoExtractor instance
   *
   * @param youtubeClient - Authenticated YouTube API client
   * @param db - Database manager instance
   * @param config - Extractor configuration
   */
  constructor(
    youtubeClient: YouTubeClient,
    db: DatabaseManager,
    config: VideoExtractorConfig = {}
  ) {
    this.youtubeClient = youtubeClient;
    this.db = db;
    this.autoTranscript = config.autoTranscript ?? true;
    this.autoLlmParse = config.autoLlmParse ?? true;
    this.onProgress = config.onProgress;

    // Initialize repositories
    this.videoRepository = new VideoRepository(db);
    this.transcriptRepository = new TranscriptRepository(db);
    this.entityRepository = new EntityRepository(db);
    this.playlistRepository = new PlaylistRepository(db);
    this.playlistItemRepository = new PlaylistItemRepository(db);

    // Initialize Whisper if enabled
    let whisperExtractor: WhisperExtractor | undefined;
    if (config.enableWhisper) {
      whisperExtractor = new WhisperExtractor({
        enabled: true,
        onProgress: config.onWhisperProgress,
      });
      if (!whisperExtractor.isAvailable()) {
        logger.warn(
          {
            reason: whisperExtractor.getUnavailableReason(),
          },
          'Whisper enabled but not available'
        );
      }
    }

    // Initialize transcript extractor
    this.transcriptExtractor = new TranscriptExtractor({
      languages: config.languages,
      rateLimitDelay: config.transcriptRateLimit,
      whisperExtractor,
    });

    // Initialize description parser
    this.descriptionParser = new DescriptionParser();

    // Initialize LLM parser
    if (this.autoLlmParse) {
      try {
        this.llmParser = new GeminiParser(config.geminiApiKey);
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to initialize GeminiParser'
        );
        logger.warn('LLM parsing will be disabled');
        this.llmParser = null;
      }
    } else {
      this.llmParser = null;
    }

    logger.info(
      {
        autoTranscript: this.autoTranscript,
        autoLlmParse: this.autoLlmParse && this.llmParser !== null,
        hasWhisper: !!whisperExtractor,
      },
      'VideoExtractor initialized'
    );
  }

  /**
   * Extract complete data for a single video
   *
   * @param videoId - YouTube video ID
   * @param skipTranscript - Skip transcript extraction
   * @param skipLlm - Skip LLM parsing
   * @returns Extraction result or null if failed
   * @throws {ValidationError} If video ID is invalid
   */
  async extractSingleVideo(
    videoId: string,
    skipTranscript = false,
    skipLlm = false
  ): Promise<VideoExtractionResult | null> {
    // Validate video ID
    if (typeof videoId !== 'string' || !videoId.trim()) {
      throw new ValidationError('videoId must be a non-empty string');
    }

    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      throw new ValidationError('Invalid YouTube video ID format');
    }

    logger.info({ videoId }, 'Starting video extraction');

    try {
      // Step 1: Get video metadata
      logger.debug({ videoId }, 'Fetching metadata');
      const videoData = await this.youtubeClient.getVideoDetails(videoId);

      if (!videoData) {
        logger.error({ videoId }, 'Failed to fetch video metadata');
        return null;
      }

      logger.info(
        {
          videoId,
          title: videoData.title?.substring(0, 60) || videoData.title || 'No title',
          channelTitle:
            videoData.channelTitle?.substring(0, 40) || videoData.channelTitle || 'No channel',
          duration: videoData.duration,
        },
        'Fetched video metadata'
      );

      // Step 2: Save video to database
      await this.saveVideoToDatabase(videoData);

      // Step 3: Parse description for GitHub repos and URLs
      const descriptionParsed = await this.parseDescription(
        videoId,
        videoData.title,
        videoData.description
      );

      // Step 4: Extract transcript
      let transcriptData: TranscriptData | null = null;
      if (this.autoTranscript && !skipTranscript) {
        transcriptData = await this.extractTranscript(videoId);
      }

      // Step 5: Parse with LLM
      let parsedEntities: ParsedTranscript | null = null;
      if (this.autoLlmParse && !skipLlm && transcriptData && this.llmParser) {
        parsedEntities = await this.parseTranscriptWithLlm(
          videoId,
          transcriptData,
          videoData.title
        );
      }

      logger.info({ videoId }, 'Video extraction complete');

      return {
        videoData,
        transcriptData,
        parsedEntities,
      };
    } catch (error) {
      logger.error(
        {
          videoId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Failed to extract video'
      );

      throw new AppError('Video extraction failed', {
        cause: error,
        code: 'EXTRACTION_FAILED',
      });
    }
  }

  /**
   * Extract all videos from a playlist
   *
   * @param playlistId - YouTube playlist ID
   * @param skipExisting - Skip videos already in database
   * @param maxVideos - Maximum number of videos to process
   * @returns Extraction summary
   * @throws {ValidationError} If playlist ID is invalid
   */
  async extractPlaylist(
    playlistId: string,
    skipExisting = true,
    maxVideos?: number
  ): Promise<PlaylistExtractionResult> {
    // Validate playlist ID
    if (typeof playlistId !== 'string' || !playlistId.trim()) {
      throw new ValidationError('playlistId must be a non-empty string');
    }

    logger.info({ playlistId, skipExisting, maxVideos }, 'Starting playlist extraction');

    try {
      // Get playlist info
      const playlistResponse = await this.youtubeClient.getPlaylists();
      const playlist = playlistResponse.playlists.find((p) => p.id === playlistId);

      if (!playlist) {
        throw new ValidationError('Playlist not found');
      }

      logger.info(
        {
          playlistId,
          title: playlist.title.substring(0, 60),
          videoCount: playlist.itemCount,
        },
        'Found playlist'
      );

      // Save playlist to database
      await this.savePlaylistToDatabase(playlist);

      // Get all videos from playlist — paginate until YouTube returns no more.
      // YouTube's playlistItems.list maxResults caps at 50 per page, so a playlist
      // with >50 videos needs multiple calls. Without pagination we silently dropped
      // tail videos (observed on the meTube Ai playlist: 86 in YouTube, 50 received).
      logger.debug({ playlistId, maxVideos }, 'Fetching playlist videos (paginating)');
      const PAGE_SIZE = 50;
      const allItems: typeof playlist.itemCount extends never
        ? never[]
        : Awaited<ReturnType<typeof this.youtubeClient.getPlaylistVideos>>['items'] = [];
      let pageToken: string | undefined = undefined;
      let pages = 0;
      do {
        const remaining = maxVideos !== undefined ? maxVideos - allItems.length : PAGE_SIZE;
        if (maxVideos !== undefined && remaining <= 0) break;
        const pageSize = Math.min(PAGE_SIZE, remaining > 0 ? remaining : PAGE_SIZE);
        const pageResponse = await this.youtubeClient.getPlaylistVideos(
          playlistId,
          pageSize,
          pageToken
        );
        allItems.push(...pageResponse.items);
        pageToken = pageResponse.nextPageToken;
        pages += 1;
      } while (pageToken);
      const playlistVideos = maxVideos !== undefined ? allItems.slice(0, maxVideos) : allItems;
      logger.info(
        {
          playlistId,
          pages,
          fetched: allItems.length,
          considered: playlistVideos.length,
        },
        'Fetched playlist videos'
      );

      // Filter out existing videos if requested
      let videosToProcess = playlistVideos;
      let skippedCount = 0;

      if (skipExisting) {
        const existingVideos = new Set<string>();

        for (const video of playlistVideos) {
          const existing = this.videoRepository.getByVideoId(video.videoId);
          const hasTranscript = existing
            ? this.transcriptRepository.getByVideoId(video.videoId)
            : null;

          // Only skip if BOTH video AND transcript exist
          if (existing && hasTranscript) {
            existingVideos.add(video.videoId);
            // Still save to playlist items
            await this.savePlaylistItem(playlistId, video);
          }
        }

        videosToProcess = playlistVideos.filter((v) => !existingVideos.has(v.videoId));
        skippedCount = playlistVideos.length - videosToProcess.length;

        logger.info(
          {
            total: playlistVideos.length,
            toProcess: videosToProcess.length,
            skipped: skippedCount,
          },
          'Filtered existing videos (with transcripts)'
        );
      }

      // Process videos
      const results: PlaylistExtractionResult = {
        total: playlistVideos.length,
        processed: 0,
        new: 0,
        skipped: skippedCount,
        failed: 0,
      };

      for (let idx = 0; idx < videosToProcess.length; idx++) {
        const video = videosToProcess[idx];
        const videoId = video.videoId;

        logger.info(
          {
            index: idx + 1,
            total: videosToProcess.length,
            videoId,
            title: video.title?.substring(0, 50),
          },
          'Processing video'
        );

        // Report progress - processing
        if (this.onProgress) {
          this.onProgress({
            current: idx + 1,
            total: videosToProcess.length,
            videoId,
            videoTitle: video.title || 'Unknown',
            status: 'processing',
          });
        }

        try {
          await this.extractSingleVideo(videoId);

          // Add to playlist items
          await this.savePlaylistItem(playlistId, video);

          results.processed++;
          results.new++;

          // Report progress - complete
          if (this.onProgress) {
            this.onProgress({
              current: idx + 1,
              total: videosToProcess.length,
              videoId,
              videoTitle: video.title || 'Unknown',
              status: 'complete',
            });
          }
        } catch (error) {
          logger.error(
            {
              videoId,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to process video'
          );
          results.failed++;

          // Report progress - failed
          if (this.onProgress) {
            this.onProgress({
              current: idx + 1,
              total: videosToProcess.length,
              videoId,
              videoTitle: video.title || 'Unknown',
              status: 'failed',
            });
          }
        }
      }

      logger.info(results, 'Playlist extraction complete');

      return results;
    } catch (error) {
      logger.error(
        {
          playlistId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to extract playlist'
      );

      throw new AppError('Playlist extraction failed', {
        cause: error,
        code: 'PLAYLIST_EXTRACTION_FAILED',
      });
    }
  }

  /**
   * Save video to database
   * Saves video metadata to videos table and statistics to video_statistics table
   */
  private async saveVideoToDatabase(videoData: any): Promise<void> {
    try {
      const videoId = videoData.id || videoData.video_id;

      // Map YouTubeVideo (camelCase) to database schema (snake_case)
      const publishedAt = videoData.publishedAt || videoData.published_at;
      const videoRecord = {
        video_id: videoId,
        title: videoData.title,
        description: videoData.description || '',
        channel_id: videoData.channelId || videoData.channel_id,
        channel_title: videoData.channelTitle || videoData.channel_title,
        published_at: publishedAt ? new Date(publishedAt).toISOString() : new Date().toISOString(),
        duration: videoData.duration || 'PT0S',
        duration_seconds: this.parseDurationToSeconds(videoData.duration) || 0,
        is_short: Boolean(videoData.is_short),
        category_id: videoData.category_id || null,
        definition: videoData.definition || 'sd',
        caption: Boolean(videoData.caption),
        licensed_content: Boolean(videoData.licensed_content),
      };

      // Save video metadata
      this.videoRepository.createOrUpdate(videoRecord);

      // Save video statistics separately
      const viewCount = videoData.viewCount || videoData.view_count || 0;
      const likeCount = videoData.likeCount || videoData.like_count || 0;
      const commentCount = videoData.commentCount || videoData.comment_count || 0;

      if (viewCount > 0 || likeCount > 0 || commentCount > 0) {
        const statisticRecord = {
          video_id: videoId,
          view_count: viewCount,
          like_count: likeCount,
          comment_count: commentCount,
          recorded_at: new Date(),
        };

        // Use raw SQL for now (can create StatisticsRepository later if needed)
        this.db.run(
          `INSERT INTO video_statistics (video_id, view_count, like_count, comment_count, recorded_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            statisticRecord.video_id,
            statisticRecord.view_count,
            statisticRecord.like_count,
            statisticRecord.comment_count,
            statisticRecord.recorded_at.toISOString(),
          ]
        );
      }

      logger.debug(
        {
          video_id: videoId,
        },
        'Saved video to database'
      );
    } catch (error) {
      const errorDetails =
        error instanceof Error
          ? { message: error.message, stack: error.stack, cause: (error as any).cause }
          : String(error);

      logger.error(
        {
          video_id: videoData.id || videoData.video_id,
          error: errorDetails,
        },
        'Failed to save video to database'
      );

      console.error('\n=== FULL DATABASE ERROR ===');
      console.error('Video ID:', videoData.id || videoData.video_id);
      console.error('Error:', error);
      if (error instanceof Error) {
        console.error('Stack:', error.stack);
        console.error('Cause:', (error as any).cause);
      }
      console.error('=== END ERROR ===\n');

      throw new DatabaseError('Failed to save video', { cause: error });
    }
  }

  /**
   * Parse ISO 8601 duration to seconds
   */
  private parseDurationToSeconds(duration: string): number {
    if (!duration || !duration.startsWith('PT')) {
      return 0;
    }

    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) {
      return 0;
    }

    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseInt(match[3] || '0', 10);

    return hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * Parse description for entities
   */
  private async parseDescription(
    videoId: string,
    title: string,
    description: string
  ): Promise<void> {
    try {
      logger.debug({ videoId }, 'Parsing description');

      const descriptionParsed = this.descriptionParser.parse(title, description);

      if (descriptionParsed.github_repos.length > 0 || descriptionParsed.websites.length > 0) {
        logger.info(
          {
            videoId,
            github_repos: descriptionParsed.github_repos.length,
            websites: descriptionParsed.websites.length,
          },
          'Found entities in description'
        );

        // Add entities from description
        const descEntities = this.descriptionParser.extractEntitiesForDatabase(descriptionParsed);
        if (descEntities.length > 0) {
          // Convert null to undefined for url field
          const entities = descEntities.map((e) => ({
            ...e,
            url: e.url || undefined,
          }));
          this.entityRepository.addEntities(videoId, entities);
        }
      } else {
        logger.debug({ videoId }, 'No links found in description');
      }
    } catch (error) {
      logger.error(
        {
          videoId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse description'
      );
      // Don't throw - continue with extraction
    }
  }

  /**
   * Extract transcript for video
   */
  private async extractTranscript(videoId: string): Promise<TranscriptData | null> {
    try {
      logger.debug({ videoId }, 'Extracting transcript');

      const transcriptData = await this.transcriptExtractor.extract(videoId);

      if (transcriptData) {
        const source = transcriptData.from_whisper ? 'Whisper' : 'YouTube';
        logger.info(
          {
            videoId,
            source,
            length: transcriptData.full_text.length,
            segments: transcriptData.segments.length,
          },
          'Transcript extracted'
        );

        // Save transcript to database
        this.transcriptRepository.create(videoId, transcriptData);

        return transcriptData;
      } else {
        logger.warn({ videoId }, 'No transcript available');
        return null;
      }
    } catch (error) {
      logger.error(
        {
          videoId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to extract transcript'
      );
      return null;
    }
  }

  /**
   * Parse transcript with LLM
   */
  private async parseTranscriptWithLlm(
    videoId: string,
    transcriptData: TranscriptData,
    videoTitle: string
  ): Promise<ParsedTranscript | null> {
    if (!this.llmParser) {
      return null;
    }

    try {
      logger.debug({ videoId }, 'Parsing with Gemini AI');

      const parsedEntities = await this.llmParser.parseTranscript(
        transcriptData.full_text,
        videoTitle
      );

      logger.info(
        {
          videoId,
          topics: parsedEntities.topics.length,
          github_repos: parsedEntities.github_repos.length,
          websites: parsedEntities.websites.length,
          people: parsedEntities.people.length,
        },
        'Parsed transcript with Gemini'
      );

      // Delete old entities
      this.entityRepository.deleteByVideo(videoId);

      // Add new entities
      const entities = this.llmParser.extractEntitiesForDatabase(parsedEntities);
      // Convert null to undefined for url field
      const entitiesFixed = entities.map((e) => ({
        ...e,
        url: e.url || undefined,
      }));
      this.entityRepository.addEntities(videoId, entitiesFixed);

      return parsedEntities;
    } catch (error) {
      logger.error(
        {
          videoId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse transcript with LLM'
      );
      return null;
    }
  }

  /**
   * Save playlist to database
   */
  private async savePlaylistToDatabase(playlist: any): Promise<void> {
    try {
      const playlistRecord = {
        playlist_id: playlist.id,
        title: playlist.title,
        description: playlist.description || '',
        video_count: playlist.video_count || 0,
        enabled: true,
      };

      this.playlistRepository.createOrUpdate(playlistRecord);

      logger.debug(
        {
          playlist_id: playlist.id,
        },
        'Saved playlist to database'
      );
    } catch (error) {
      logger.error(
        {
          playlist_id: playlist.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to save playlist to database'
      );

      throw new DatabaseError('Failed to save playlist', { cause: error });
    }
  }

  /**
   * Save playlist item to database
   */
  private async savePlaylistItem(
    playlistId: string,
    video: { videoId: string; position?: number }
  ): Promise<void> {
    try {
      this.playlistItemRepository.addVideoToPlaylist(playlistId, video.videoId, video.position);
      logger.debug({ playlistId, videoId: video.videoId }, 'Saved playlist_items linkage');
    } catch (error) {
      logger.error(
        {
          playlistId,
          videoId: video.videoId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to save playlist_items linkage'
      );
      // Don't throw - a playlist-link failure shouldn't kill the whole extraction.
    }
  }
}

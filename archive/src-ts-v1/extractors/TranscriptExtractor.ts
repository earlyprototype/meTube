/**
 * Transcript extraction using youtube-transcript-api
 * Extracts transcripts from YouTube videos with rate limiting and retry logic
 */

import { YoutubeTranscript } from 'youtube-transcript';
import logger from '../utils/logger.js';
import { ValidationError, AppError } from '../errors/index.js';

/**
 * Transcript segment with timing
 */
export interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

/**
 * Extracted transcript data
 */
export interface TranscriptData {
  full_text: string;
  segments: TranscriptSegment[];
  language: string;
  is_auto_generated: boolean;
  from_whisper?: boolean;
}

/**
 * Options for transcript extraction
 */
export interface TranscriptExtractorOptions {
  languages?: string[];
  rateLimitDelay?: number;
  whisperExtractor?: any;
}

/**
 * TranscriptExtractor class for extracting transcripts from YouTube
 */
export class TranscriptExtractor {
  private readonly languages: string[];
  private readonly rateLimitDelay: number;
  private lastRequestTime: number;
  private readonly whisperExtractor: any;

  /**
   * Create a new TranscriptExtractor instance
   *
   * @param options - Extractor options
   */
  constructor(options: TranscriptExtractorOptions = {}) {
    this.languages = options.languages || ['en', 'en-GB', 'en-US'];
    this.rateLimitDelay = options.rateLimitDelay || 2000; // 2 seconds default
    this.lastRequestTime = 0;
    this.whisperExtractor = options.whisperExtractor;

    logger.info(
      {
        languages: this.languages,
        rateLimitDelay: this.rateLimitDelay,
        hasWhisperFallback: !!this.whisperExtractor,
      },
      'TranscriptExtractor initialized'
    );
  }

  /**
   * Extract transcript for a video
   *
   * @param videoId - YouTube video ID
   * @param maxRetries - Maximum number of retries on rate limit (default: 3)
   * @param useWhisperFallback - Whether to fallback to Whisper if YouTube fails (default: true)
   * @returns Transcript data or null if unavailable
   * @throws {ValidationError} If video ID is invalid
   * @throws {AppError} If extraction fails after retries
   */
  async extract(
    videoId: string,
    maxRetries = 3,
    useWhisperFallback = true
  ): Promise<TranscriptData | null> {
    // Validate video ID
    if (typeof videoId !== 'string' || !videoId.trim()) {
      throw new ValidationError('videoId must be a non-empty string');
    }

    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      throw new ValidationError('Invalid YouTube video ID format');
    }

    // Rate limiting: wait before making request
    await this.waitForRateLimit();

    // Try YouTube transcript API first
    let retryCount = 0;
    let youtubeFailedReason: string | null = null;

    while (retryCount <= maxRetries) {
      try {
        const transcriptData = await this.extractTranscript(videoId);
        if (transcriptData) {
          logger.info(
            {
              videoId,
              language: transcriptData.language,
              segmentCount: transcriptData.segments.length,
            },
            'Successfully extracted YouTube transcript'
          );
          return transcriptData;
        }
        youtubeFailedReason = 'No transcript available';
        break; // No transcript available, don't retry
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if it's a rate limit error
        if (errorMessage.toLowerCase().includes('rate limit')) {
          retryCount++;
          if (retryCount <= maxRetries) {
            // Exponential backoff: wait longer each time
            const waitTime = this.rateLimitDelay * Math.pow(2, retryCount);
            logger.warn(
              {
                videoId,
                retryCount,
                maxRetries,
                waitTime,
              },
              'Rate limited - applying exponential backoff'
            );
            await this.sleep(waitTime);
          } else {
            youtubeFailedReason = 'Rate limit exceeded';
            logger.error(
              {
                videoId,
                retries: retryCount,
              },
              'YouTube transcript unavailable (rate limit)'
            );
            break;
          }
        } else {
          // Non-rate-limit error, don't retry
          youtubeFailedReason = errorMessage;
          logger.debug(
            {
              videoId,
              error: errorMessage,
            },
            'YouTube transcript extraction failed'
          );
          break;
        }
      }
    }

    // Fallback to Whisper if YouTube transcript failed and Whisper is available
    if (youtubeFailedReason) {
      if (useWhisperFallback && this.whisperExtractor) {
        try {
          logger.info({ videoId }, 'Trying Whisper fallback');
          const whisperTranscript = await this.whisperExtractor.extract(videoId);
          if (whisperTranscript) {
            logger.info({ videoId }, 'Successfully extracted Whisper transcript');
            return whisperTranscript;
          } else {
            logger.warn({ videoId }, 'Whisper transcription failed');
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message.split('\n')[0].substring(0, 100) : String(error);
          logger.error(
            {
              videoId,
              error: errorMessage,
            },
            'Whisper extraction error'
          );
        }
      } else {
        logger.info(
          {
            videoId,
            reason: youtubeFailedReason,
          },
          'No transcript available'
        );
      }
    }

    return null;
  }

  /**
   * Extract transcript (internal method without rate limiting logic)
   *
   * @param videoId - YouTube video ID
   * @returns Transcript data or null if unavailable
   */
  private async extractTranscript(videoId: string): Promise<TranscriptData | null> {
    try {
      // Fetch transcript from YouTube
      const transcript = await YoutubeTranscript.fetchTranscript(videoId, {
        lang: this.languages[0], // youtube-transcript takes a single lang
      });

      if (!transcript || transcript.length === 0) {
        return null;
      }

      // Convert to our format
      const segments: TranscriptSegment[] = transcript.map((segment) => ({
        start: segment.offset / 1000, // Convert ms to seconds
        duration: segment.duration / 1000, // Convert ms to seconds
        text: segment.text,
      }));

      // Combine all text
      const fullText = segments.map((seg) => seg.text).join(' ');

      return {
        full_text: fullText,
        segments,
        language: 'en', // youtube-transcript doesn't return language info
        is_auto_generated: true, // youtube-transcript doesn't distinguish
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for specific error types
      if (
        errorMessage.includes('Transcript is disabled') ||
        errorMessage.includes('No transcript')
      ) {
        logger.debug({ videoId }, 'YouTube transcripts disabled for video');
        return null;
      }

      if (errorMessage.includes('Video unavailable')) {
        logger.warn({ videoId }, 'Video unavailable');
        return null;
      }

      // Re-throw for rate limit errors to be handled by retry logic
      if (errorMessage.toLowerCase().includes('rate limit')) {
        throw error;
      }

      // Log other errors but return null (graceful degradation)
      const errorType = error instanceof Error ? error.constructor.name : 'Error';
      logger.debug(
        {
          videoId,
          errorType,
          message: errorMessage.substring(0, 80),
        },
        'Transcript extraction error'
      );

      return null;
    }
  }

  /**
   * Extract transcripts for multiple videos
   *
   * @param videoIds - List of YouTube video IDs
   * @returns Map of video ID to transcript data
   */
  async extractBatch(videoIds: string[]): Promise<Record<string, TranscriptData | null>> {
    if (!Array.isArray(videoIds)) {
      throw new ValidationError('videoIds must be an array');
    }

    const results: Record<string, TranscriptData | null> = {};

    for (const videoId of videoIds) {
      try {
        results[videoId] = await this.extract(videoId);
      } catch (error) {
        logger.error(
          {
            videoId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to extract transcript in batch'
        );
        results[videoId] = null;
      }
    }

    return results;
  }

  /**
   * Wait for rate limit delay
   */
  private async waitForRateLimit(): Promise<void> {
    const currentTime = Date.now();
    const timeSinceLast = currentTime - this.lastRequestTime;

    if (timeSinceLast < this.rateLimitDelay) {
      const waitTime = this.rateLimitDelay - timeSinceLast;
      logger.debug({ waitTime }, 'Rate limit delay');
      await this.sleep(waitTime);
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Sleep for specified milliseconds
   *
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Format transcript with timestamps
   *
   * @param transcriptData - Transcript data
   * @returns Formatted transcript string
   */
  formatTranscriptWithTimestamps(transcriptData: TranscriptData): string {
    if (!transcriptData || !transcriptData.segments) {
      return '';
    }

    const formattedLines: string[] = [];

    for (const segment of transcriptData.segments) {
      const timestamp = this.formatTimestamp(segment.start);
      const text = segment.text.trim();
      formattedLines.push(`[${timestamp}] ${text}`);
    }

    return formattedLines.join('\n');
  }

  /**
   * Format seconds as MM:SS or HH:MM:SS
   *
   * @param seconds - Time in seconds
   * @returns Formatted timestamp string
   */
  private formatTimestamp(seconds: number): string {
    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Generate YouTube URL with timestamp
   *
   * @param videoId - YouTube video ID
   * @param seconds - Time in seconds
   * @returns YouTube URL with timestamp parameter
   */
  generateYouTubeTimestampUrl(videoId: string, seconds: number): string {
    const timestampSeconds = Math.floor(seconds);
    return `https://youtube.com/watch?v=${videoId}&t=${timestampSeconds}s`;
  }

  /**
   * Calculate statistics about a transcript
   *
   * @param transcriptData - Transcript data
   * @returns Statistics dictionary
   */
  getTranscriptStats(transcriptData: TranscriptData): {
    word_count: number;
    char_count: number;
    segment_count: number;
    duration_seconds: number;
    language: string;
    is_auto_generated: boolean;
  } {
    if (!transcriptData) {
      return {
        word_count: 0,
        char_count: 0,
        segment_count: 0,
        duration_seconds: 0,
        language: 'unknown',
        is_auto_generated: true,
      };
    }

    const fullText = transcriptData.full_text || '';
    const segments = transcriptData.segments || [];

    const wordCount = fullText.split(/\s+/).filter((w) => w).length;
    const charCount = fullText.length;
    const segmentCount = segments.length;

    // Calculate total duration
    let durationSeconds = 0;
    if (segments.length > 0) {
      const lastSegment = segments[segments.length - 1];
      durationSeconds = lastSegment.start + lastSegment.duration;
    }

    return {
      word_count: wordCount,
      char_count: charCount,
      segment_count: segmentCount,
      duration_seconds: Math.floor(durationSeconds),
      language: transcriptData.language || 'unknown',
      is_auto_generated: transcriptData.is_auto_generated ?? true,
    };
  }
}

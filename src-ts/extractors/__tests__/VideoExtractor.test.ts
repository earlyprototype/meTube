import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VideoExtractor } from '../VideoExtractor.js';
import { YouTubeClient } from '../../api/YouTubeClient.js';
import { DatabaseConnection } from '../../database/connection.js';
import { ValidationError, AppError } from '../../errors/index.js';

// Mock all dependencies
vi.mock('../../api/YouTubeClient.js');
vi.mock('../../database/connection.js');
vi.mock('../../database/repositories.js', () => ({
  VideoRepository: {
    createOrUpdate: vi.fn(),
    getByVideoId: vi.fn().mockReturnValue(null),
  },
  PlaylistRepository: {
    createOrUpdate: vi.fn(),
  },
  TranscriptRepository: {
    create: vi.fn(),
  },
  EntityRepository: {
    addEntities: vi.fn(),
    deleteByVideo: vi.fn(),
  },
}));
vi.mock('../TranscriptExtractor.js', () => ({
  TranscriptExtractor: class MockTranscriptExtractor {
    constructor() {}
    async extract() {
      return null;
    }
  },
}));
vi.mock('../WhisperExtractor.js', () => ({
  WhisperExtractor: class MockWhisperExtractor {
    constructor() {}
    isAvailable() {
      return false;
    }
    getUnavailableReason() {
      return 'Stub implementation';
    }
  },
}));
vi.mock('../../parsers/DescriptionParser.js', () => ({
  DescriptionParser: class MockDescriptionParser {
    parse() {
      return {
        github_repos: [],
        websites: [],
        topics: [],
        people: [],
        key_concepts: [],
        summary: null,
      };
    }
    extractEntitiesForDatabase() {
      return [];
    }
  },
}));
vi.mock('../../parsers/GeminiParser.js', () => ({
  GeminiParser: class MockGeminiParser {
    constructor() {}
    async parseTranscript() {
      return {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral',
      };
    }
    extractEntitiesForDatabase() {
      return [];
    }
  },
}));

describe('VideoExtractor', () => {
  let extractor: VideoExtractor;
  let mockYouTubeClient: any;
  let mockDb: any; // Mock Database.Database connection

  const mockVideoData = {
    video_id: 'dQw4w9WgXcQ',
    title: 'Test Video',
    description: 'Test description https://github.com/test/repo',
    channel_id: 'UCtest',
    channel_title: 'Test Channel',
    published_at: '2024-01-01T00:00:00Z',
    duration: 'PT5M',
    duration_seconds: 300,
    view_count: 1000,
    like_count: 50,
    comment_count: 10,
    is_short: false,
    category_id: '22',
    definition: 'hd',
    caption: true,
    licensed_content: false,
  };

  const mockTranscriptData = {
    full_text: 'This is a test transcript',
    segments: [{ start: 0, duration: 5, text: 'This is a test transcript' }],
    language: 'en',
    is_auto_generated: true,
  };

  const mockParsedEntities = {
    topics: ['Testing'],
    github_repos: [],
    websites: [],
    people: [],
    tags: ['test'],
    summary: 'A test video',
    content_type: 'tutorial',
    sentiment: 'neutral',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock YouTube client
    mockYouTubeClient = {
      getVideoDetails: vi.fn().mockResolvedValue(mockVideoData),
      getPlaylists: vi.fn().mockResolvedValue([
        {
          id: 'PLtest',
          title: 'Test Playlist',
          description: 'Test playlist desc',
          video_count: 2,
          channel_id: 'UCtest',
          channel_title: 'Test Channel',
        },
      ]),
      getPlaylistVideos: vi.fn().mockResolvedValue([
        { video_id: 'dQw4w9WgXcQ', title: 'Video 1' },
        { video_id: 'jNQXAC9IVRw', title: 'Video 2' },
      ]),
    };

    // Create mock database
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn(),
      }),
    };

    // Create extractor without LLM for basic tests
    extractor = new VideoExtractor(mockYouTubeClient as any, mockDb as any, {
      autoTranscript: true,
      autoLlmParse: false, // Disable to simplify tests
    });
  });

  describe('constructor', () => {
    it('should create extractor with default config', () => {
      const defaultExtractor = new VideoExtractor(
        mockYouTubeClient as any,
        mockDb as any
      );
      expect(defaultExtractor).toBeInstanceOf(VideoExtractor);
    });

    it('should create extractor with custom config', () => {
      const customExtractor = new VideoExtractor(
        mockYouTubeClient as any,
        mockDb as any,
        {
          autoTranscript: false,
          autoLlmParse: false,
          languages: ['en', 'es'],
          transcriptRateLimit: 5000,
        }
      );
      expect(customExtractor).toBeInstanceOf(VideoExtractor);
    });

    it('should handle missing Gemini API key gracefully', () => {
      const extractorWithLlm = new VideoExtractor(
        mockYouTubeClient as any,
        mockDb as any,
        {
          autoLlmParse: true,
          // No API key provided
        }
      );
      expect(extractorWithLlm).toBeInstanceOf(VideoExtractor);
    });
  });

  describe('extractSingleVideo()', () => {
    it('should extract video successfully', async () => {
      const result = await extractor.extractSingleVideo('dQw4w9WgXcQ');

      expect(result).not.toBeNull();
      expect(result?.videoData).toEqual(mockVideoData);
      expect(mockYouTubeClient.getVideoDetails).toHaveBeenCalledWith('dQw4w9WgXcQ');
    });

    it('should return null if video metadata fetch fails', async () => {
      mockYouTubeClient.getVideoDetails.mockResolvedValue(null);

      const result = await extractor.extractSingleVideo('dQw4w9WgXcQ');

      expect(result).toBeNull();
    });

    it('should throw ValidationError for empty video ID', async () => {
      await expect(extractor.extractSingleVideo('')).rejects.toThrow(
        ValidationError
      );
      await expect(extractor.extractSingleVideo('')).rejects.toThrow(
        'must be a non-empty string'
      );
    });

    it('should throw ValidationError for non-string video ID', async () => {
      await expect(extractor.extractSingleVideo(123 as any)).rejects.toThrow(
        ValidationError
      );
    });

    it('should throw ValidationError for invalid video ID format', async () => {
      await expect(extractor.extractSingleVideo('invalid')).rejects.toThrow(
        ValidationError
      );
      await expect(extractor.extractSingleVideo('invalid')).rejects.toThrow(
        'Invalid YouTube video ID format'
      );
    });

    it('should handle database save errors gracefully', async () => {
      // Mock VideoRepository to throw error
      const { VideoRepository } = await import('../../database/repositories.js');
      (VideoRepository.createOrUpdate as any) = vi
        .fn()
        .mockImplementation(() => {
          throw new Error('Database error');
        });

      await expect(extractor.extractSingleVideo('dQw4w9WgXcQ')).rejects.toThrow(
        AppError
      );

      // Reset mock
      (VideoRepository.createOrUpdate as any) = vi.fn();
    });

    it('should skip transcript extraction when requested', async () => {
      const result = await extractor.extractSingleVideo('dQw4w9WgXcQ', true);

      expect(result).not.toBeNull();
      expect(result?.transcriptData).toBeNull();
    });

    it('should skip LLM parsing when requested', async () => {
      const extractorWithLlm = new VideoExtractor(
        mockYouTubeClient as any,
        mockDb as any,
        {
          autoLlmParse: true,
          geminiApiKey: 'test-key',
        }
      );

      const result = await extractorWithLlm.extractSingleVideo(
        'dQw4w9WgXcQ',
        false,
        true
      );

      expect(result).not.toBeNull();
      expect(result?.parsedEntities).toBeNull();
    });

    it('should handle transcript extraction failure gracefully', async () => {
      // Transcript extractor will return null by default (mocked)
      const result = await extractor.extractSingleVideo('dQw4w9WgXcQ');

      expect(result).not.toBeNull();
      expect(result?.videoData).toEqual(mockVideoData);
      // Should continue even if transcript fails
    });
  });

  describe('extractPlaylist()', () => {
    it('should extract playlist successfully', async () => {
      const result = await extractor.extractPlaylist('PLtest');

      expect(result).toEqual({
        total: 2,
        processed: 2,
        new: 2,
        skipped: 0,
        failed: 0,
      });

      expect(mockYouTubeClient.getPlaylists).toHaveBeenCalled();
      expect(mockYouTubeClient.getPlaylistVideos).toHaveBeenCalledWith(
        'PLtest',
        undefined
      );
    });

    it('should throw ValidationError for empty playlist ID', async () => {
      await expect(extractor.extractPlaylist('')).rejects.toThrow(
        ValidationError
      );
      await expect(extractor.extractPlaylist('')).rejects.toThrow(
        'must be a non-empty string'
      );
    });

    it('should throw ValidationError for non-string playlist ID', async () => {
      await expect(extractor.extractPlaylist(123 as any)).rejects.toThrow(
        ValidationError
      );
    });

    it('should throw error if playlist not found', async () => {
      mockYouTubeClient.getPlaylists.mockResolvedValue([]);

      await expect(extractor.extractPlaylist('PLnonexistent')).rejects.toThrow(
        AppError
      );
      await expect(extractor.extractPlaylist('PLnonexistent')).rejects.toThrow(
        'Playlist extraction failed'
      );
    });

    it('should respect maxVideos limit', async () => {
      await extractor.extractPlaylist('PLtest', false, 1);

      expect(mockYouTubeClient.getPlaylistVideos).toHaveBeenCalledWith(
        'PLtest',
        1
      );
    });

    it('should skip existing videos when requested', async () => {
      // Mock VideoRepository to return existing video for first video ID
      const { VideoRepository } = await import('../../database/repositories.js');
      (VideoRepository.getByVideoId as any) = vi
        .fn()
        .mockReturnValueOnce({ video_id: 'dQw4w9WgXcQ' }) // First call: exists
        .mockReturnValueOnce(null); // Second call: doesn't exist

      const result = await extractor.extractPlaylist('PLtest', true);

      // Should have skipped 1, processed 1
      expect(result.skipped).toBeGreaterThan(0);
    });

    it('should not skip videos when skipExisting is false', async () => {
      const result = await extractor.extractPlaylist('PLtest', false);

      expect(result.skipped).toBe(0);
      expect(result.processed).toBe(2);
    });

    it('should handle individual video failures gracefully', async () => {
      // Make first video extraction fail
      mockYouTubeClient.getVideoDetails
        .mockRejectedValueOnce(new Error('Video fetch failed'))
        .mockResolvedValueOnce(mockVideoData);

      const result = await extractor.extractPlaylist('PLtest', false);

      expect(result.failed).toBe(1);
      expect(result.processed).toBe(1);
    });

    it('should throw AppError if playlist fetch fails', async () => {
      mockYouTubeClient.getPlaylists.mockRejectedValue(
        new Error('API error')
      );

      await expect(extractor.extractPlaylist('PLtest')).rejects.toThrow(AppError);
      await expect(extractor.extractPlaylist('PLtest')).rejects.toThrow(
        'Playlist extraction failed'
      );
    });
  });
});

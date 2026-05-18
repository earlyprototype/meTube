import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranscriptExtractor } from '../TranscriptExtractor.js';
import { ValidationError } from '../../errors/index.js';

// Mock the youtube-transcript module
vi.mock('youtube-transcript', () => {
  return {
    YoutubeTranscript: {
      fetchTranscript: vi.fn(),
    },
  };
});

// Import the mocked module to access the mock function
import { YoutubeTranscript } from 'youtube-transcript';
const mockFetchTranscript = YoutubeTranscript.fetchTranscript as any;

describe('TranscriptExtractor', () => {
  let extractor: TranscriptExtractor;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    mockFetchTranscript.mockReset();

    // Create extractor with minimal rate limit for testing
    extractor = new TranscriptExtractor({
      languages: ['en'],
      rateLimitDelay: 10, // 10ms for fast tests
    });
  });

  describe('constructor', () => {
    it('should create extractor with default options', () => {
      const defaultExtractor = new TranscriptExtractor();
      expect(defaultExtractor).toBeInstanceOf(TranscriptExtractor);
    });

    it('should create extractor with custom options', () => {
      const customExtractor = new TranscriptExtractor({
        languages: ['en', 'es'],
        rateLimitDelay: 5000,
      });
      expect(customExtractor).toBeInstanceOf(TranscriptExtractor);
    });

    it('should accept whisper extractor', () => {
      const mockWhisper = { extract: vi.fn() };
      const extractorWithWhisper = new TranscriptExtractor({
        whisperExtractor: mockWhisper,
      });
      expect(extractorWithWhisper).toBeInstanceOf(TranscriptExtractor);
    });
  });

  describe('extract()', () => {
    it('should extract transcript successfully', async () => {
      const mockResponse = [
        { offset: 0, duration: 2000, text: 'Hello world' },
        { offset: 2000, duration: 3000, text: 'This is a test' },
      ];

      mockFetchTranscript.mockResolvedValue(mockResponse);

      const result = await extractor.extract('dQw4w9WgXcQ');

      expect(result).not.toBeNull();
      expect(result?.full_text).toBe('Hello world This is a test');
      expect(result?.segments).toHaveLength(2);
      expect(result?.segments[0]).toEqual({
        start: 0,
        duration: 2,
        text: 'Hello world',
      });
      expect(result?.segments[1]).toEqual({
        start: 2,
        duration: 3,
        text: 'This is a test',
      });
      expect(result?.language).toBe('en');
      expect(result?.is_auto_generated).toBe(true);
    });

    it('should return null for empty transcript', async () => {
      mockFetchTranscript.mockResolvedValue([]);

      const result = await extractor.extract('dQw4w9WgXcQ');

      expect(result).toBeNull();
    });

    it('should return null when transcript is disabled', async () => {
      mockFetchTranscript.mockRejectedValue(
        new Error('Transcript is disabled on this video')
      );

      const result = await extractor.extract('dQw4w9WgXcQ');

      expect(result).toBeNull();
    });

    it('should return null when video is unavailable', async () => {
      mockFetchTranscript.mockRejectedValue(new Error('Video unavailable'));

      const result = await extractor.extract('dQw4w9WgXcQ');

      expect(result).toBeNull();
    });

    it('should throw ValidationError for empty video ID', async () => {
      await expect(extractor.extract('')).rejects.toThrow(ValidationError);
      await expect(extractor.extract('')).rejects.toThrow('must be a non-empty string');
    });

    it('should throw ValidationError for non-string video ID', async () => {
      await expect(extractor.extract(123 as any)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid video ID format', async () => {
      await expect(extractor.extract('invalid')).rejects.toThrow(ValidationError);
      await expect(extractor.extract('invalid')).rejects.toThrow('Invalid YouTube video ID format');
    });

    it('should apply rate limiting between requests', async () => {
      const mockResponse = [{ offset: 0, duration: 1000, text: 'Test' }];
      mockFetchTranscript.mockResolvedValue(mockResponse);

      const startTime = Date.now();

      await extractor.extract('dQw4w9WgXcQ');
      await extractor.extract('dQw4w9WgXcQ');

      const elapsedTime = Date.now() - startTime;

      // Should have waited at least the rate limit delay (10ms)
      expect(elapsedTime).toBeGreaterThanOrEqual(10);
    });

    it('should retry on rate limit with exponential backoff', async () => {
      let attemptCount = 0;
      mockFetchTranscript.mockImplementation(() => {
        attemptCount++;
        if (attemptCount <= 2) {
          return Promise.reject(new Error('Rate limit exceeded'));
        }
        return Promise.resolve([{ offset: 0, duration: 1000, text: 'Success' }]);
      });

      const result = await extractor.extract('dQw4w9WgXcQ', 3);

      expect(result).not.toBeNull();
      expect(result?.full_text).toBe('Success');
      expect(attemptCount).toBe(3);
    });

    it('should return null after max retries on rate limit', async () => {
      mockFetchTranscript.mockRejectedValue(new Error('Rate limit exceeded'));

      const result = await extractor.extract('dQw4w9WgXcQ', 2);

      expect(result).toBeNull();
      expect(mockFetchTranscript).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should fallback to Whisper when YouTube fails', async () => {
      const mockWhisper = {
        extract: vi.fn().mockResolvedValue({
          full_text: 'Whisper transcript',
          segments: [{ start: 0, duration: 1, text: 'Whisper transcript' }],
          language: 'en',
          is_auto_generated: false,
          from_whisper: true,
        }),
      };

      const extractorWithWhisper = new TranscriptExtractor({
        whisperExtractor: mockWhisper,
        rateLimitDelay: 10,
      });

      mockFetchTranscript.mockRejectedValue(new Error('No transcript'));

      const result = await extractorWithWhisper.extract('dQw4w9WgXcQ');

      expect(result).not.toBeNull();
      expect(result?.full_text).toBe('Whisper transcript');
      expect(result?.from_whisper).toBe(true);
      expect(mockWhisper.extract).toHaveBeenCalledWith('dQw4w9WgXcQ');
    });

    it('should return null if Whisper also fails', async () => {
      const mockWhisper = {
        extract: vi.fn().mockResolvedValue(null),
      };

      const extractorWithWhisper = new TranscriptExtractor({
        whisperExtractor: mockWhisper,
        rateLimitDelay: 10,
      });

      mockFetchTranscript.mockRejectedValue(new Error('No transcript'));

      const result = await extractorWithWhisper.extract('dQw4w9WgXcQ');

      expect(result).toBeNull();
    });

    it('should handle Whisper errors gracefully', async () => {
      const mockWhisper = {
        extract: vi.fn().mockRejectedValue(new Error('Whisper failed')),
      };

      const extractorWithWhisper = new TranscriptExtractor({
        whisperExtractor: mockWhisper,
        rateLimitDelay: 10,
      });

      mockFetchTranscript.mockRejectedValue(new Error('No transcript'));

      const result = await extractorWithWhisper.extract('dQw4w9WgXcQ');

      expect(result).toBeNull();
    });

    it('should not use Whisper if useWhisperFallback is false', async () => {
      const mockWhisper = {
        extract: vi.fn(),
      };

      const extractorWithWhisper = new TranscriptExtractor({
        whisperExtractor: mockWhisper,
        rateLimitDelay: 10,
      });

      mockFetchTranscript.mockRejectedValue(new Error('No transcript'));

      const result = await extractorWithWhisper.extract('dQw4w9WgXcQ', 3, false);

      expect(result).toBeNull();
      expect(mockWhisper.extract).not.toHaveBeenCalled();
    });
  });

  describe('extractBatch()', () => {
    it('should extract transcripts for multiple videos', async () => {
      const mockResponse = [{ offset: 0, duration: 1000, text: 'Test' }];
      mockFetchTranscript.mockResolvedValue(mockResponse);

      const results = await extractor.extractBatch(['dQw4w9WgXcQ', 'jNQXAC9IVRw']);

      expect(Object.keys(results)).toHaveLength(2);
      expect(results['dQw4w9WgXcQ']).not.toBeNull();
      expect(results['jNQXAC9IVRw']).not.toBeNull();
    });

    it('should handle mixed success and failures', async () => {
      let callCount = 0;
      mockFetchTranscript.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([{ offset: 0, duration: 1000, text: 'Success' }]);
        } else {
          return Promise.reject(new Error('Failed'));
        }
      });

      const results = await extractor.extractBatch(['dQw4w9WgXcQ', 'jNQXAC9IVRw']);

      expect(results['dQw4w9WgXcQ']).not.toBeNull();
      expect(results['jNQXAC9IVRw']).toBeNull();
    });

    it('should throw ValidationError for non-array input', async () => {
      await expect(extractor.extractBatch('not-array' as any)).rejects.toThrow(
        ValidationError
      );
    });
  });

  describe('formatTranscriptWithTimestamps()', () => {
    it('should format transcript with timestamps', () => {
      const transcriptData = {
        full_text: 'Hello world',
        segments: [
          { start: 0, duration: 2, text: 'Hello world' },
          { start: 2, duration: 3, text: 'Test text' },
        ],
        language: 'en',
        is_auto_generated: true,
      };

      const formatted = extractor.formatTranscriptWithTimestamps(transcriptData);

      expect(formatted).toContain('[00:00] Hello world');
      expect(formatted).toContain('[00:02] Test text');
    });

    it('should format hours correctly', () => {
      const transcriptData = {
        full_text: 'Long video',
        segments: [{ start: 3661, duration: 1, text: 'One hour in' }],
        language: 'en',
        is_auto_generated: true,
      };

      const formatted = extractor.formatTranscriptWithTimestamps(transcriptData);

      expect(formatted).toContain('[01:01:01]');
    });

    it('should return empty string for null transcript', () => {
      const formatted = extractor.formatTranscriptWithTimestamps(null as any);
      expect(formatted).toBe('');
    });
  });

  describe('generateYouTubeTimestampUrl()', () => {
    it('should generate URL with timestamp', () => {
      const url = extractor.generateYouTubeTimestampUrl('dQw4w9WgXcQ', 42);
      expect(url).toBe('https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
    });

    it('should floor fractional seconds', () => {
      const url = extractor.generateYouTubeTimestampUrl('dQw4w9WgXcQ', 42.7);
      expect(url).toBe('https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
    });
  });

  describe('getTranscriptStats()', () => {
    it('should calculate stats correctly', () => {
      const transcriptData = {
        full_text: 'Hello world this is a test',
        segments: [
          { start: 0, duration: 2, text: 'Hello world' },
          { start: 2, duration: 3, text: 'this is a test' },
        ],
        language: 'en',
        is_auto_generated: true,
      };

      const stats = extractor.getTranscriptStats(transcriptData);

      expect(stats.word_count).toBe(6);
      expect(stats.char_count).toBe(26);
      expect(stats.segment_count).toBe(2);
      expect(stats.duration_seconds).toBe(5);
      expect(stats.language).toBe('en');
      expect(stats.is_auto_generated).toBe(true);
    });

    it('should handle null transcript', () => {
      const stats = extractor.getTranscriptStats(null as any);

      expect(stats.word_count).toBe(0);
      expect(stats.char_count).toBe(0);
      expect(stats.segment_count).toBe(0);
      expect(stats.duration_seconds).toBe(0);
      expect(stats.language).toBe('unknown');
      expect(stats.is_auto_generated).toBe(true);
    });

    it('should handle empty segments', () => {
      const transcriptData = {
        full_text: '',
        segments: [],
        language: 'en',
        is_auto_generated: false,
      };

      const stats = extractor.getTranscriptStats(transcriptData);

      expect(stats.word_count).toBe(0);
      expect(stats.segment_count).toBe(0);
      expect(stats.duration_seconds).toBe(0);
    });
  });
});

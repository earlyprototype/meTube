import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GeminiParser } from '../GeminiParser.js';
import { ValidationError, AppError } from '../../errors/index.js';

// Mock the Google Generative AI module
const mockGenerateContent = vi.fn();

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class MockGoogleGenerativeAI {
      constructor(_apiKey: string) {}
      getGenerativeModel(_config: any) {
        return {
          generateContent: mockGenerateContent,
        };
      }
    },
  };
});

describe('GeminiParser', () => {
  let parser: GeminiParser;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    mockGenerateContent.mockReset();

    // Set up mock API key
    process.env.GEMINI_API_KEY = 'test-api-key';

    // Create parser
    parser = new GeminiParser();
  });

  describe('constructor', () => {
    it('should create parser with API key from parameter', () => {
      const customParser = new GeminiParser('custom-key', 'gemini-1.5-pro');
      expect(customParser).toBeInstanceOf(GeminiParser);
    });

    it('should create parser with API key from environment', () => {
      expect(parser).toBeInstanceOf(GeminiParser);
    });

    it('should throw ValidationError if no API key provided', () => {
      delete process.env.GEMINI_API_KEY;

      expect(() => {
        new GeminiParser();
      }).toThrow(ValidationError);
      expect(() => {
        new GeminiParser();
      }).toThrow('Gemini API key not provided');
    });

    it('should use default model if not specified', () => {
      const defaultParser = new GeminiParser('test-key');
      expect(defaultParser).toBeInstanceOf(GeminiParser);
    });
  });

  describe('parseTranscript()', () => {
    it('should parse transcript successfully', async () => {
      const mockResponse = {
        topics: ['TypeScript', 'Testing'],
        github_repos: [{ name: 'vitest', url: 'https://github.com/vitest-dev/vitest' }],
        websites: [{ name: 'example.com', url: 'https://example.com' }],
        people: ['John Doe'],
        tags: ['tutorial', 'testing'],
        summary: 'A tutorial about testing with Vitest',
        content_type: 'tutorial',
        sentiment: 'positive',
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(mockResponse),
        },
      });

      const result = await parser.parseTranscript('This is a test transcript', 'Test Video');

      expect(result.topics).toEqual(['TypeScript', 'Testing']);
      expect(result.github_repos).toHaveLength(1);
      expect(result.github_repos[0].name).toBe('vitest');
      expect(result.websites).toHaveLength(1);
      expect(result.people).toContain('John Doe');
      expect(result.tags).toContain('tutorial');
      expect(result.summary).toBe('A tutorial about testing with Vitest');
      expect(result.content_type).toBe('tutorial');
      expect(result.sentiment).toBe('positive');
    });

    it('should handle markdown code blocks in response', async () => {
      const mockResponse = {
        topics: ['Test'],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: 'Test summary',
        content_type: 'unknown',
        sentiment: 'neutral',
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => `\`\`\`json\n${JSON.stringify(mockResponse)}\n\`\`\``,
        },
      });

      const result = await parser.parseTranscript('Test transcript', 'Test');

      expect(result.topics).toEqual(['Test']);
    });

    it('should return empty result for empty transcript', async () => {
      const result = await parser.parseTranscript('', 'Test Video');

      expect(result.topics).toHaveLength(0);
      expect(result.github_repos).toHaveLength(0);
      expect(result.summary).toBe('');
      expect(result.content_type).toBe('unknown');
      expect(result.sentiment).toBe('neutral');
    });

    it('should throw ValidationError for non-string transcript', async () => {
      await expect(parser.parseTranscript(123 as any, 'Test')).rejects.toThrow(ValidationError);
      await expect(parser.parseTranscript(123 as any, 'Test')).rejects.toThrow(
        'transcriptText must be a string'
      );
    });

    it('should throw ValidationError for non-string title', async () => {
      await expect(parser.parseTranscript('Test transcript', 123 as any)).rejects.toThrow(
        ValidationError
      );
      await expect(parser.parseTranscript('Test transcript', 123 as any)).rejects.toThrow(
        'videoTitle must be a string'
      );
    });

    it('should throw AppError for invalid JSON response', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => 'This is not valid JSON',
        },
      });

      await expect(parser.parseTranscript('Test transcript', 'Test')).rejects.toThrow(AppError);
      await expect(parser.parseTranscript('Test transcript', 'Test')).rejects.toThrow(
        'Gemini returned invalid JSON response'
      );
    });

    it('should throw AppError for API errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API rate limit exceeded'));

      await expect(parser.parseTranscript('Test transcript', 'Test')).rejects.toThrow(AppError);
      await expect(parser.parseTranscript('Test transcript', 'Test')).rejects.toThrow(
        'Gemini API request failed'
      );
    });

    it('should normalize result with limits', async () => {
      const mockResponse = {
        topics: Array(30).fill('Topic'), // Should limit to 20
        github_repos: Array(15)
          .fill(null)
          .map((_, i) => ({ name: `repo${i}` })), // Should limit to 10
        websites: Array(25)
          .fill(null)
          .map((_, i) => ({ name: `site${i}` })), // Should limit to 20
        people: Array(25).fill('Person'), // Should limit to 20
        tags: Array(20).fill('tag'), // Should limit to 15
        summary: 'A'.repeat(2000), // Should limit to 1000
        content_type: 'tutorial',
        sentiment: 'positive',
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(mockResponse),
        },
      });

      const result = await parser.parseTranscript('Test transcript', 'Test');

      expect(result.topics).toHaveLength(20);
      expect(result.github_repos).toHaveLength(10);
      expect(result.websites).toHaveLength(20);
      expect(result.people).toHaveLength(20);
      expect(result.tags).toHaveLength(15);
      expect(result.summary.length).toBeLessThanOrEqual(1000);
    });

    it('should convert tags to lowercase', async () => {
      const mockResponse = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: ['Tutorial', 'TESTING', 'TypeScript'],
        summary: 'Test',
        content_type: 'tutorial',
        sentiment: 'neutral',
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(mockResponse),
        },
      });

      const result = await parser.parseTranscript('Test transcript', 'Test');

      expect(result.tags).toEqual(['tutorial', 'testing', 'typescript']);
    });

    it('should filter invalid github_repos', async () => {
      const mockResponse = {
        topics: [],
        github_repos: [{ name: 'valid-repo' }, 'invalid-string', null, { invalid: 'no-name' }],
        websites: [],
        people: [],
        tags: [],
        summary: 'Test',
        content_type: 'tutorial',
        sentiment: 'neutral',
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(mockResponse),
        },
      });

      const result = await parser.parseTranscript('Test transcript', 'Test');

      expect(result.github_repos).toHaveLength(1);
      expect(result.github_repos[0].name).toBe('valid-repo');
    });

    it('should filter invalid websites', async () => {
      const mockResponse = {
        topics: [],
        github_repos: [],
        websites: [{ name: 'valid-site' }, 'invalid-string', null],
        people: [],
        tags: [],
        summary: 'Test',
        content_type: 'tutorial',
        sentiment: 'neutral',
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(mockResponse),
        },
      });

      const result = await parser.parseTranscript('Test transcript', 'Test');

      expect(result.websites).toHaveLength(1);
      expect(result.websites[0].name).toBe('valid-site');
    });

    it('should handle missing fields gracefully', async () => {
      const mockResponse = {
        // Missing most fields
        topics: ['Test'],
      };

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(mockResponse),
        },
      });

      const result = await parser.parseTranscript('Test transcript', 'Test');

      expect(result.topics).toEqual(['Test']);
      expect(result.github_repos).toHaveLength(0);
      expect(result.websites).toHaveLength(0);
      expect(result.people).toHaveLength(0);
      expect(result.tags).toHaveLength(0);
      expect(result.summary).toBe('');
      expect(result.content_type).toBe('unknown');
      expect(result.sentiment).toBe('neutral');
    });
  });

  describe('extractEntitiesForDatabase()', () => {
    it('should convert all entity types to database format', () => {
      const parsed = {
        topics: ['TypeScript', 'Testing'],
        github_repos: [{ name: 'vitest', url: 'https://github.com/vitest-dev/vitest' }],
        websites: [{ name: 'example.com', url: 'https://example.com' }],
        people: ['John Doe'],
        tags: [],
        summary: '',
        content_type: 'tutorial',
        sentiment: 'neutral',
      };

      const entities = parser.extractEntitiesForDatabase(parsed);

      expect(entities).toHaveLength(5);

      // Check topics
      expect(entities[0]).toEqual({
        type: 'topic',
        value: 'TypeScript',
        url: null,
        confidence: 90,
      });

      // Check github_repo
      expect(entities[2]).toEqual({
        type: 'github_repo',
        value: 'vitest',
        url: 'https://github.com/vitest-dev/vitest',
        confidence: 95,
      });

      // Check website
      expect(entities[3]).toEqual({
        type: 'website',
        value: 'example.com',
        url: 'https://example.com',
        confidence: 90,
      });

      // Check person
      expect(entities[4]).toEqual({
        type: 'person',
        value: 'John Doe',
        url: null,
        confidence: 85,
      });
    });

    it('should handle missing URLs', () => {
      const parsed = {
        topics: [],
        github_repos: [{ name: 'repo-without-url' }],
        websites: [{ name: 'site-without-url' }],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral',
      };

      const entities = parser.extractEntitiesForDatabase(parsed);

      expect(entities[0].url).toBeNull();
      expect(entities[1].url).toBeNull();
    });

    it('should return empty array for empty result', () => {
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral',
      };

      const entities = parser.extractEntitiesForDatabase(parsed);

      expect(entities).toHaveLength(0);
    });
  });

  describe('getTags()', () => {
    it('should return tags from parsed result', () => {
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: ['tutorial', 'testing', 'typescript'],
        summary: '',
        content_type: 'tutorial',
        sentiment: 'neutral',
      };

      const tags = parser.getTags(parsed);

      expect(tags).toEqual(['tutorial', 'testing', 'typescript']);
    });

    it('should return empty array if no tags', () => {
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral',
      };

      const tags = parser.getTags(parsed);

      expect(tags).toHaveLength(0);
    });
  });

  describe('getAnalysis()', () => {
    it('should return AI analysis data', () => {
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: 'Test summary',
        content_type: 'tutorial',
        sentiment: 'positive',
      };

      const analysis = parser.getAnalysis(parsed);

      expect(analysis).toEqual({
        summary: 'Test summary',
        content_type: 'tutorial',
        sentiment: 'positive',
        model_used: 'gemini-1.5-flash',
      });
    });

    it('should handle missing fields with defaults', () => {
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral',
      };

      const analysis = parser.getAnalysis(parsed);

      expect(analysis.summary).toBe('');
      expect(analysis.content_type).toBe('unknown');
      expect(analysis.sentiment).toBe('neutral');
      expect(analysis.model_used).toBe('gemini-1.5-flash');
    });
  });
});

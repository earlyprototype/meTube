/**
 * Tests for `GeminiParser` — the wire-boundary discipline is the test target.
 *
 * Every Gemini response must flow through `GeminiResponseSchema.parse(...)`
 * before reaching the caller. These tests pin that:
 *   - Valid response → typed `GeminiResponse`.
 *   - Malformed JSON (no parse) → `ValidationError`.
 *   - JSON-valid but shape-wrong (e.g. `topics: 'string'` instead of `string[]`)
 *     → `ValidationError` (wrapping a `ZodError`).
 *   - Partial response → defaults applied by the schema.
 *   - SDK rejection → `AppError` with code `GEMINI_API_ERROR`.
 *   - Missing API key on construct → `ValidationError`.
 *
 * The Google SDK is mocked at the module boundary; we never hit the network.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { GeminiParser } from '../parsers/GeminiParser.js';
import { AppError, ValidationError } from '../errors/index.js';

// Mock the Google Generative AI module at the import boundary.
const mockGenerateContent = vi.fn();

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class MockGoogleGenerativeAI {
      constructor(_apiKey: string) {
        // intentionally empty — constructor just stores the key in the real SDK
      }
      getGenerativeModel(_config: { model: string }) {
        return {
          generateContent: mockGenerateContent,
        };
      }
    },
  };
});

// Helper to wrap a parsed JSON object in the SDK's response shape.
// Uses `mockResolvedValue` (not `Once`) so tests that invoke
// `parseTranscript` multiple times — e.g. `await expect(...).rejects.toThrow(A)`
// followed by `await expect(...).rejects.toThrow(B)` — see the same mock
// each call. Each test still calls `mockReset` in `beforeEach`.
function mockResponse(payload: unknown): void {
  mockGenerateContent.mockResolvedValue({
    response: {
      text: () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    },
  });
}

describe('GeminiParser', () => {
  let parser: GeminiParser;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent.mockReset();
    process.env.GEMINI_API_KEY = 'test-api-key';
    parser = new GeminiParser();
  });

  describe('constructor', () => {
    it('creates a parser from an explicit API key', () => {
      const custom = new GeminiParser('custom-key', 'gemini-1.5-pro');
      expect(custom).toBeInstanceOf(GeminiParser);
    });

    it('creates a parser from GEMINI_API_KEY env var', () => {
      expect(parser).toBeInstanceOf(GeminiParser);
    });

    it('throws ValidationError if no API key is available', () => {
      delete process.env.GEMINI_API_KEY;

      expect(() => new GeminiParser()).toThrow(ValidationError);
      expect(() => new GeminiParser()).toThrow('Gemini API key not provided');
    });

    it('uses the default model when none specified', () => {
      const defaultParser = new GeminiParser('test-key');
      // Indirect check: getAnalysis exposes model_used; tested below in
      // its own block. Here we just verify construction succeeds.
      expect(defaultParser).toBeInstanceOf(GeminiParser);
    });
  });

  describe('parseTranscript() — happy path', () => {
    it('parses a valid Gemini response into the typed GeminiResponse shape', async () => {
      // Arrange
      const validPayload = {
        topics: ['TypeScript', 'Testing'],
        github_repos: [{ name: 'vitest', url: 'https://github.com/vitest-dev/vitest' }],
        websites: [{ name: 'example.com', url: 'https://example.com' }],
        people: ['John Doe'],
        tags: ['tutorial', 'testing'],
        summary: 'A tutorial about testing with Vitest',
        content_type: 'tutorial',
        sentiment: 'positive',
      };
      mockResponse(validPayload);

      // Act
      const result = await parser.parseTranscript({
        transcript: 'This is a test transcript',
        videoTitle: 'Test Video',
      });

      // Assert
      expect(result.topics).toEqual(['TypeScript', 'Testing']);
      expect(result.github_repos).toHaveLength(1);
      expect(result.github_repos[0]).toEqual({
        name: 'vitest',
        url: 'https://github.com/vitest-dev/vitest',
      });
      expect(result.websites).toHaveLength(1);
      expect(result.people).toContain('John Doe');
      expect(result.tags).toEqual(['tutorial', 'testing']);
      expect(result.summary).toBe('A tutorial about testing with Vitest');
      expect(result.content_type).toBe('tutorial');
      expect(result.sentiment).toBe('positive');
    });

    it('strips ```json markdown fences from the response', async () => {
      const payload = {
        topics: ['Test'],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: 'Test summary',
        content_type: 'unknown',
        sentiment: 'neutral',
      };
      mockResponse(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``);

      const result = await parser.parseTranscript({
        transcript: 'Test transcript',
        videoTitle: 'Test',
      });

      expect(result.topics).toEqual(['Test']);
    });

    it('strips bare ``` (no language tag) markdown fences', async () => {
      const payload = {
        topics: ['Bare'],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral',
      };
      mockResponse(`\`\`\`\n${JSON.stringify(payload)}\n\`\`\``);

      const result = await parser.parseTranscript({
        transcript: 'Test transcript',
        videoTitle: 'Test',
      });

      expect(result.topics).toEqual(['Bare']);
    });
  });

  describe('parseTranscript() — defaults via the schema', () => {
    it('returns an empty (schema-default) result for empty transcript without calling the API', async () => {
      const result = await parser.parseTranscript({
        transcript: '',
        videoTitle: 'Test Video',
      });

      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(result.topics).toEqual([]);
      expect(result.github_repos).toEqual([]);
      expect(result.websites).toEqual([]);
      expect(result.people).toEqual([]);
      expect(result.tags).toEqual([]);
      expect(result.summary).toBe('');
      expect(result.content_type).toBe('unknown');
      expect(result.sentiment).toBe('neutral');
    });

    it('returns an empty result for whitespace-only transcript', async () => {
      const result = await parser.parseTranscript({
        transcript: '   \n\t  ',
        videoTitle: 'Test',
      });

      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(result.summary).toBe('');
    });

    it('applies schema defaults when the model omits optional arrays', async () => {
      // Only `topics` provided; everything else absent. Schema must default
      // each missing list to `[]`, sentiment to `'neutral'`, etc.
      mockResponse({ topics: ['JustOne'] });

      const result = await parser.parseTranscript({
        transcript: 'transcript',
        videoTitle: 'title',
      });

      expect(result.topics).toEqual(['JustOne']);
      expect(result.github_repos).toEqual([]);
      expect(result.websites).toEqual([]);
      expect(result.people).toEqual([]);
      expect(result.tags).toEqual([]);
      expect(result.summary).toBe('');
      expect(result.content_type).toBe('unknown');
      expect(result.sentiment).toBe('neutral');
    });

    it('applies the default sentiment when the field is absent', async () => {
      mockResponse({
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: 's',
        content_type: 'c',
        // sentiment absent
      });

      const result = await parser.parseTranscript({
        transcript: 'x',
        videoTitle: 'y',
      });

      expect(result.sentiment).toBe('neutral');
    });
  });

  describe('parseTranscript() — input validation', () => {
    it('throws ValidationError when transcript is not a string', async () => {
      await expect(
        parser.parseTranscript({
          transcript: 123 as unknown as string,
          videoTitle: 'Test',
        })
      ).rejects.toThrow(ValidationError);
      await expect(
        parser.parseTranscript({
          transcript: 123 as unknown as string,
          videoTitle: 'Test',
        })
      ).rejects.toThrow('transcript must be a string');
    });

    it('throws ValidationError when videoTitle is not a string', async () => {
      await expect(
        parser.parseTranscript({
          transcript: 'Test transcript',
          videoTitle: 123 as unknown as string,
        })
      ).rejects.toThrow(ValidationError);
      await expect(
        parser.parseTranscript({
          transcript: 'Test transcript',
          videoTitle: 123 as unknown as string,
        })
      ).rejects.toThrow('videoTitle must be a string');
    });
  });

  describe('parseTranscript() — malformed JSON', () => {
    it('throws ValidationError when the model returns unparseable text', async () => {
      mockResponse('This is not valid JSON at all');

      await expect(
        parser.parseTranscript({ transcript: 'Test transcript', videoTitle: 'Test' })
      ).rejects.toThrow(ValidationError);
      await expect(
        parser.parseTranscript({ transcript: 'Test transcript', videoTitle: 'Test' })
      ).rejects.toThrow('Gemini returned invalid JSON response');
    });

    it('JSON parse failures do NOT become AppError (they are validation, not API errors)', async () => {
      mockResponse('not json');

      await expect(
        parser.parseTranscript({ transcript: 'Test', videoTitle: 'Test' })
      ).rejects.not.toThrow(/Gemini API request failed/);
    });
  });

  describe('parseTranscript() — schema validation (wire boundary)', () => {
    it('throws ValidationError when topics is a string instead of an array', async () => {
      mockResponse({
        topics: 'not-an-array',
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: 's',
        content_type: 'c',
        sentiment: 'positive',
      });

      await expect(
        parser.parseTranscript({ transcript: 't', videoTitle: 'v' })
      ).rejects.toThrow(ValidationError);
      await expect(
        parser.parseTranscript({ transcript: 't', videoTitle: 'v' })
      ).rejects.toThrow(/schema validation/);
    });

    it('throws ValidationError when github_repos entry is missing required name', async () => {
      mockResponse({
        topics: [],
        github_repos: [{ url: 'https://github.com/x/y' }], // no name
        websites: [],
        people: [],
        tags: [],
        summary: 's',
        content_type: 'c',
        sentiment: 'positive',
      });

      await expect(
        parser.parseTranscript({ transcript: 't', videoTitle: 'v' })
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when sentiment is outside the enum', async () => {
      mockResponse({
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: 's',
        content_type: 'c',
        sentiment: 'enthusiastic',
      });

      await expect(
        parser.parseTranscript({ transcript: 't', videoTitle: 'v' })
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when people contains non-string entries', async () => {
      mockResponse({
        topics: [],
        github_repos: [],
        websites: [],
        people: [{ name: 'wrapped-in-object' }],
        tags: [],
        summary: 's',
        content_type: 'c',
        sentiment: 'positive',
      });

      await expect(
        parser.parseTranscript({ transcript: 't', videoTitle: 'v' })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('parseTranscript() — SDK errors', () => {
    it('wraps SDK rejections as AppError with code GEMINI_API_ERROR', async () => {
      // Persistent rejection so all three awaited calls see the same failure.
      mockGenerateContent.mockRejectedValue(new Error('API rate limit exceeded'));

      await expect(
        parser.parseTranscript({ transcript: 'Test transcript', videoTitle: 'Test' })
      ).rejects.toThrow(AppError);
      await expect(
        parser.parseTranscript({ transcript: 'Test transcript', videoTitle: 'Test' })
      ).rejects.toThrow('Gemini API request failed');

      try {
        await parser.parseTranscript({ transcript: 'Test transcript', videoTitle: 'Test' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('GEMINI_API_ERROR');
      }
    });

    it('throws AppError with isOperational true and statusCode 500 for SDK failures', async () => {
      // `AppError.cause` propagation is governed by `AppError`'s own
      // constructor; this test pins the SHAPE we expose: an AppError with
      // GEMINI_API_ERROR code, operational, statusCode 500. The wrapping
      // message must not leak the raw stack/preserve cause-equality is an
      // AppError concern, not a parser concern.
      const original = new Error('underlying SDK failure');
      mockGenerateContent.mockRejectedValue(original);

      try {
        await parser.parseTranscript({ transcript: 'transcript', videoTitle: 'v' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        const appErr = err as AppError;
        expect(appErr.code).toBe('GEMINI_API_ERROR');
        expect(appErr.statusCode).toBe(500);
        expect(appErr.isOperational).toBe(true);
        expect(appErr.message).toBe('Gemini API request failed');
      }
    });
  });

  describe('parseTranscript() — prompt shape (P9 contract)', () => {
    it('passes the prompt without the embedded "# Limit to avoid token limits" comment', async () => {
      mockResponse({
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral',
      });

      await parser.parseTranscript({
        transcript: 'a'.repeat(100),
        videoTitle: 'Title',
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const call = mockGenerateContent.mock.calls[0][0];
      const promptText: string = call.contents[0].parts[0].text;
      expect(promptText).not.toContain('# Limit to avoid token limits');
      expect(promptText).toContain('Video Title: Title');
    });

    it('slices the transcript at MAX_TRANSCRIPT_CHARS (8000) before insertion', async () => {
      mockResponse({
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral',
      });

      const longTranscript = 'x'.repeat(9000);
      await parser.parseTranscript({
        transcript: longTranscript,
        videoTitle: 'Title',
      });

      const call = mockGenerateContent.mock.calls[0][0];
      const promptText: string = call.contents[0].parts[0].text;
      // The prompt must contain a run of 8000 x's, but not 9000.
      expect(promptText).toContain('x'.repeat(8000));
      expect(promptText).not.toContain('x'.repeat(8001));
    });
  });

  describe('extractEntitiesForDatabase()', () => {
    it('converts all entity types to the database row format', () => {
      const parsed = {
        topics: ['TypeScript', 'Testing'],
        github_repos: [{ name: 'vitest', url: 'https://github.com/vitest-dev/vitest' }],
        websites: [{ name: 'example.com', url: 'https://example.com' }],
        people: ['John Doe'],
        tags: [],
        summary: '',
        content_type: 'tutorial',
        sentiment: 'neutral' as const,
      };

      const entities = parser.extractEntitiesForDatabase(parsed);

      expect(entities).toHaveLength(5);
      expect(entities[0]).toEqual({
        type: 'topic',
        value: 'TypeScript',
        url: null,
        confidence: 90,
      });
      expect(entities[2]).toEqual({
        type: 'github_repo',
        value: 'vitest',
        url: 'https://github.com/vitest-dev/vitest',
        confidence: 95,
      });
      expect(entities[3]).toEqual({
        type: 'website',
        value: 'example.com',
        url: 'https://example.com',
        confidence: 90,
      });
      expect(entities[4]).toEqual({
        type: 'person',
        value: 'John Doe',
        url: null,
        confidence: 85,
      });
    });

    it('emits null URLs when GitHub repo / website entries omit them', () => {
      const parsed = {
        topics: [],
        github_repos: [{ name: 'repo-without-url' }],
        websites: [{ name: 'site-without-url' }],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral' as const,
      };

      const entities = parser.extractEntitiesForDatabase(parsed);

      expect(entities[0].url).toBeNull();
      expect(entities[1].url).toBeNull();
    });

    it('returns an empty array for an empty parsed result', () => {
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral' as const,
      };

      expect(parser.extractEntitiesForDatabase(parsed)).toHaveLength(0);
    });
  });

  describe('getTags()', () => {
    it('returns the tags from the parsed result', () => {
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: ['tutorial', 'testing', 'typescript'],
        summary: '',
        content_type: 'tutorial',
        sentiment: 'neutral' as const,
      };

      expect(parser.getTags(parsed)).toEqual(['tutorial', 'testing', 'typescript']);
    });

    it('returns an empty array when no tags are present', () => {
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral' as const,
      };

      expect(parser.getTags(parsed)).toHaveLength(0);
    });
  });

  describe('getAnalysis()', () => {
    it('returns the AI analysis record with the configured model name', () => {
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: 'Test summary',
        content_type: 'tutorial',
        sentiment: 'positive' as const,
      };

      expect(parser.getAnalysis(parsed)).toEqual({
        summary: 'Test summary',
        content_type: 'tutorial',
        sentiment: 'positive',
        model_used: 'gemini-1.5-flash',
      });
    });

    it('uses the model name passed at construction time', () => {
      const customParser = new GeminiParser('test-key', 'gemini-1.5-pro');
      const parsed = {
        topics: [],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: '',
        content_type: 'unknown',
        sentiment: 'neutral' as const,
      };

      expect(customParser.getAnalysis(parsed).model_used).toBe('gemini-1.5-pro');
    });
  });
});

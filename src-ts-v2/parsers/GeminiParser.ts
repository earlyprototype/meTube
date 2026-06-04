/**
 * LLM-based entity extraction using Google Gemini.
 *
 * Wire-boundary discipline: every Gemini response is parsed through
 * `GeminiResponseSchema` BEFORE returning to the caller. The previous v1
 * parser cast `JSON.parse(...) as ParsedTranscript` — that's an unchecked
 * assertion, exactly the pattern the v2 invariants foreclose. Here the
 * inferred `GeminiResponse` type is the schema's output type; the parse
 * step is the only way to construct it.
 *
 * Canonical Python reference:
 *   `legacy/python/src/parsers/llm_parser.py`
 *   - prompt shape: `_build_extraction_prompt`
 *   - normalization (now performed by Zod): `_normalize_result`
 *   - empty-result fallback: `_empty_result`
 *
 * Phase 1 fix P9: stripped the embedded comment
 * `# Limit to avoid token limits` from the prompt template. The slicing
 * still happens — that's `MAX_TRANSCRIPT_CHARS` below — but the comment
 * no longer pollutes the prompt the model receives.
 *
 * Error contract:
 *   - SDK errors (network, rate-limit, invalid API key) → AppError
 *     with code `'GEMINI_API_ERROR'`
 *   - JSON parse failure → ValidationError
 *   - Zod schema validation failure → ValidationError (wrapping ZodError)
 *   - Missing API key on construct → ValidationError
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ZodError } from 'zod';

import { AppError, ValidationError } from '../errors/index.js';
import logger from '../utils/logger.js';
import { GeminiResponseSchema, type GeminiResponse } from '../schemas/gemini.js';

/**
 * Maximum characters of transcript passed to Gemini. Matches the Python
 * `MAX_TRANSCRIPT_CHARS` constant. Beyond this length we slice the input
 * to stay within the model's token budget for non-pro models.
 */
const MAX_TRANSCRIPT_CHARS = 8000;

/**
 * Default Gemini model. Matches the Python default. Override by passing
 * `model` to the constructor.
 */
const DEFAULT_MODEL = 'gemini-1.5-flash';

/**
 * Lower temperature for more deterministic structured output. The prompt
 * asks for strict JSON; we want minimal creativity.
 */
const GENERATION_TEMPERATURE = 0.1;
const GENERATION_TOP_P = 0.95;
const GENERATION_TOP_K = 40;
const GENERATION_MAX_OUTPUT_TOKENS = 2048;

/**
 * Input shape for `parseTranscript` — a typed object so the call site is
 * unambiguous (which is the transcript vs which is the title).
 */
export interface ParseTranscriptInput {
  transcript: string;
  videoTitle: string;
}

/**
 * AI analysis data for database storage. Derived from the GeminiResponse
 * plus the model name used.
 */
export interface AIAnalysis {
  summary: string;
  content_type: string;
  sentiment: string;
  model_used: string;
}

/**
 * Database entity format — same shape as DescriptionParser's.
 */
export interface DatabaseEntity {
  type: string;
  value: string;
  url: string | null;
  confidence: number;
}

/**
 * GeminiParser class for parsing transcripts using Google Gemini.
 *
 * Single entry point: `parseTranscript({ transcript, videoTitle })`. Every
 * non-empty response flows through `GeminiResponseSchema.parse(...)`.
 */
export class GeminiParser {
  private readonly genAI: GoogleGenerativeAI;
  private readonly modelName: string;

  /**
   * Create a new GeminiParser instance.
   *
   * @param apiKey - Google Gemini API key. If absent, falls back to
   *                 `process.env.GEMINI_API_KEY`.
   * @param model - Gemini model id. Defaults to `gemini-1.5-flash`.
   * @throws {ValidationError} If no API key is available from either source.
   */
  constructor(apiKey?: string, model: string = DEFAULT_MODEL) {
    const key = apiKey || process.env.GEMINI_API_KEY;

    if (!key) {
      throw new ValidationError(
        'Gemini API key not provided. Set GEMINI_API_KEY environment variable or pass apiKey parameter.'
      );
    }

    this.genAI = new GoogleGenerativeAI(key);
    this.modelName = model;

    logger.info({ model: this.modelName }, 'GeminiParser initialized');
  }

  /**
   * Parse a transcript into structured entities + summary.
   *
   * Pipeline:
   *   1. Validate inputs are strings; empty transcript → empty result.
   *   2. Build prompt with title + transcript (sliced at MAX_TRANSCRIPT_CHARS).
   *   3. Call Gemini.
   *   4. Strip optional ```json fences from the response text.
   *   5. `JSON.parse` — failure → ValidationError.
   *   6. `GeminiResponseSchema.parse` — failure → ValidationError.
   *   7. Return the typed `GeminiResponse`.
   *
   * @param input - `{ transcript, videoTitle }`
   * @returns Validated, schema-conformant `GeminiResponse`.
   * @throws {ValidationError} If inputs are not strings, JSON is malformed,
   *                           or the response shape fails Zod validation.
   * @throws {AppError} (code `GEMINI_API_ERROR`) If the SDK call itself fails.
   */
  async parseTranscript(input: ParseTranscriptInput): Promise<GeminiResponse> {
    const { transcript, videoTitle } = input;

    // Validate inputs at the boundary.
    if (typeof transcript !== 'string') {
      throw new ValidationError('transcript must be a string');
    }
    if (typeof videoTitle !== 'string') {
      throw new ValidationError('videoTitle must be a string');
    }

    // Empty transcript → empty result. Parse `{}` so all schema defaults
    // apply. The result is indistinguishable from a model that returned a
    // shape-valid empty payload.
    if (!transcript.trim()) {
      logger.warn({ videoTitle }, 'Empty transcript provided');
      return GeminiResponseSchema.parse({});
    }

    const prompt = this.buildExtractionPrompt(transcript, videoTitle);

    logger.info(
      {
        model: this.modelName,
        videoTitle,
        transcriptLength: transcript.length,
      },
      'Calling Gemini API'
    );

    // SDK boundary. Anything thrown from here that isn't already an
    // AppError/ValidationError gets wrapped as GEMINI_API_ERROR.
    let rawText: string;
    try {
      const model = this.genAI.getGenerativeModel({ model: this.modelName });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: GENERATION_TEMPERATURE,
          topP: GENERATION_TOP_P,
          topK: GENERATION_TOP_K,
          maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
        },
      });

      rawText = result.response.text().trim();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const cleanMessage = errorMessage.split('\n')[0].substring(0, 200);

      logger.error(
        {
          error: cleanMessage,
          videoTitle,
        },
        'Gemini API error'
      );

      throw new AppError('Gemini API request failed', {
        cause: error,
        code: 'GEMINI_API_ERROR',
      });
    }

    logger.debug(
      {
        length: rawText.length,
        preview: rawText.substring(0, 100),
      },
      'Received Gemini response'
    );

    // Strip markdown code fences if the model wrapped its JSON.
    const stripped = this.stripJsonFence(rawText);

    // JSON parse — failure is a ValidationError because the shape is malformed.
    let candidate: unknown;
    try {
      candidate = JSON.parse(stripped);
    } catch (jsonError) {
      logger.error(
        {
          error: jsonError instanceof Error ? jsonError.message : String(jsonError),
          preview: stripped.substring(0, 200),
        },
        'Gemini returned invalid JSON'
      );
      throw new ValidationError('Gemini returned invalid JSON response', {
        cause: jsonError,
      });
    }

    // Wire boundary: every Gemini response goes through Zod. No casts.
    try {
      const parsed = GeminiResponseSchema.parse(candidate);

      logger.info(
        {
          topics: parsed.topics.length,
          github_repos: parsed.github_repos.length,
          websites: parsed.websites.length,
          people: parsed.people.length,
          tags: parsed.tags.length,
        },
        'Successfully parsed transcript with Gemini'
      );

      return parsed;
    } catch (zodError) {
      const issues =
        (zodError as ZodError).issues
          ?.map((i) => `${i.path.join('.')}: ${i.message}`)
          .slice(0, 5)
          .join('; ') || 'unknown shape error';

      logger.error(
        {
          issues,
          preview: stripped.substring(0, 200),
        },
        'Gemini response failed schema validation'
      );

      throw new ValidationError(`Gemini response failed schema validation: ${issues}`, {
        cause: zodError,
      });
    }
  }

  /**
   * Build the extraction prompt for Gemini.
   *
   * Lifted from Python `_build_extraction_prompt` post-P9: the
   * `# Limit to avoid token limits` comment that previously appeared
   * inside the f-string is now gone. The slicing is still done — we just
   * don't tell the model about it.
   *
   * @param transcriptText - Full transcript text. Sliced to
   *                         `MAX_TRANSCRIPT_CHARS` before insertion.
   * @param videoTitle - Video title.
   * @returns Formatted prompt string.
   */
  private buildExtractionPrompt(transcriptText: string, videoTitle: string): string {
    const limitedTranscript = transcriptText.substring(0, MAX_TRANSCRIPT_CHARS);

    return `Analyse the following YouTube video transcript and extract structured information.

Video Title: ${videoTitle}

Transcript:
${limitedTranscript}

Please extract the following information and return as JSON:

1. **topics**: List of main topics/subjects discussed (e.g., ["Machine Learning", "Python", "Data Science"])
2. **github_repos**: List of GitHub repositories mentioned with format {"name": "repo-name", "url": "full-url"}
3. **websites**: List of websites mentioned (exclude YouTube, generic social media) with format {"name": "site-name", "url": "full-url"}
4. **people**: List of people/experts mentioned by name
5. **tags**: List of 5-10 relevant keywords for categorisation
6. **summary**: Brief 2-3 sentence summary of the video content
7. **content_type**: Single word categorising the content (e.g., "tutorial", "review", "entertainment", "educational", "news", "vlog")
8. **sentiment**: Overall sentiment ("positive", "negative", "neutral")

Important guidelines:
- Only include information explicitly mentioned in the transcript
- For GitHub repos and websites, extract the actual URLs if mentioned
- If a URL is mentioned but not complete, try to infer the full URL
- Keep people names as they appear in the transcript
- Tags should be lowercase, single words or short phrases
- Be concise and accurate

Return ONLY valid JSON with this exact structure:
{
  "topics": ["topic1", "topic2"],
  "github_repos": [{"name": "repo-name", "url": "https://github.com/user/repo"}],
  "websites": [{"name": "site-name", "url": "https://example.com"}],
  "people": ["Person Name1", "Person Name2"],
  "tags": ["tag1", "tag2", "tag3"],
  "summary": "Brief summary here",
  "content_type": "tutorial",
  "sentiment": "positive"
}`;
  }

  /**
   * Strip leading ```json / trailing ``` markdown fences if present.
   * Matches Python's `re.sub(r'^```json\s*', '', ...)` /
   * `re.sub(r'\s*```$', '', ...)` behavior.
   */
  private stripJsonFence(text: string): string {
    return text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  /**
   * Convert parsed result to database entity format.
   *
   * Mirrors Python `extract_entities_for_database`. Confidence scores
   * match the Python source: topic=90, github_repo=95, website=90,
   * person=85.
   *
   * @param parsedResult - Output of `parseTranscript`.
   * @returns List of entity rows for database storage.
   */
  extractEntitiesForDatabase(parsedResult: GeminiResponse): DatabaseEntity[] {
    const entities: DatabaseEntity[] = [];

    for (const topic of parsedResult.topics) {
      entities.push({
        type: 'topic',
        value: topic,
        url: null,
        confidence: 90,
      });
    }

    for (const repo of parsedResult.github_repos) {
      entities.push({
        type: 'github_repo',
        value: repo.name,
        url: repo.url ?? null,
        confidence: 95,
      });
    }

    for (const site of parsedResult.websites) {
      entities.push({
        type: 'website',
        value: site.name,
        url: site.url ?? null,
        confidence: 90,
      });
    }

    for (const person of parsedResult.people) {
      entities.push({
        type: 'person',
        value: person,
        url: null,
        confidence: 85,
      });
    }

    return entities;
  }

  /**
   * Extract tags from parsed result.
   *
   * @param parsedResult - Output of `parseTranscript`.
   * @returns Tag list (may be empty).
   */
  getTags(parsedResult: GeminiResponse): string[] {
    return parsedResult.tags;
  }

  /**
   * Extract AI analysis for database storage.
   *
   * @param parsedResult - Output of `parseTranscript`.
   * @returns Analysis record with summary, content_type, sentiment, and
   *          the model used.
   */
  getAnalysis(parsedResult: GeminiResponse): AIAnalysis {
    return {
      summary: parsedResult.summary,
      content_type: parsedResult.content_type,
      sentiment: parsedResult.sentiment,
      model_used: this.modelName,
    };
  }
}

/**
 * LLM-based entity extraction using Google Gemini
 * Extracts topics, people, GitHub repos, websites, and generates summaries from transcripts
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../utils/logger.js';
import { ValidationError, AppError } from '../errors/index.js';

/**
 * GitHub repository mention in transcript
 */
export interface GitHubRepoMention {
  name: string;
  url?: string;
}

/**
 * Website mention in transcript
 */
export interface WebsiteMention {
  name: string;
  url?: string;
}

/**
 * Parsed transcript result from Gemini
 */
export interface ParsedTranscript {
  topics: string[];
  github_repos: GitHubRepoMention[];
  websites: WebsiteMention[];
  people: string[];
  tags: string[];
  summary: string;
  content_type: string;
  sentiment: string;
}

/**
 * Database entity format
 */
export interface DatabaseEntity {
  type: string;
  value: string;
  url: string | null;
  confidence: number;
}

/**
 * AI analysis data for database
 */
export interface AIAnalysis {
  summary: string;
  content_type: string;
  sentiment: string;
  model_used: string;
}

/**
 * GeminiParser class for parsing transcripts using Google Gemini
 */
export class GeminiParser {
  private readonly genAI: GoogleGenerativeAI;
  private readonly modelName: string;

  /**
   * Create a new GeminiParser instance
   *
   * @param apiKey - Google Gemini API key (or from GEMINI_API_KEY env var)
   * @param model - Gemini model to use (default: gemini-1.5-flash)
   * @throws {ValidationError} If API key is not provided
   */
  constructor(apiKey?: string, model = 'gemini-1.5-flash') {
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
   * Parse transcript to extract entities and generate summary
   *
   * @param transcriptText - Full transcript text
   * @param videoTitle - Video title for context
   * @returns Parsed entities and analysis
   * @throws {AppError} If parsing fails
   */
  async parseTranscript(
    transcriptText: string,
    videoTitle = ''
  ): Promise<ParsedTranscript> {
    // Validate inputs
    if (typeof transcriptText !== 'string') {
      throw new ValidationError('transcriptText must be a string');
    }

    if (typeof videoTitle !== 'string') {
      throw new ValidationError('videoTitle must be a string');
    }

    if (!transcriptText.trim()) {
      logger.warn({ videoTitle }, 'Empty transcript provided');
      return this.emptyResult();
    }

    try {
      const prompt = this.buildExtractionPrompt(transcriptText, videoTitle);

      logger.info({
        model: this.modelName,
        videoTitle,
        transcriptLength: transcriptText.length,
      }, 'Calling Gemini API');

      const model = this.genAI.getGenerativeModel({ model: this.modelName });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 2048,
        },
      });

      const response = result.response;
      let resultText = response.text().trim();

      logger.debug({
        length: resultText.length,
        preview: resultText.substring(0, 100),
      }, 'Received Gemini response');

      // Remove markdown code blocks if present
      resultText = resultText.replace(/^```json\s*/i, '');
      resultText = resultText.replace(/\s*```$/i, '');
      resultText = resultText.trim();

      // Parse JSON response
      let parsedResult: any;
      try {
        parsedResult = JSON.parse(resultText);
      } catch (jsonError) {
        logger.error({
          error: jsonError instanceof Error ? jsonError.message : String(jsonError),
          preview: resultText.substring(0, 200),
        }, 'Gemini returned invalid JSON');
        throw new AppError('Gemini returned invalid JSON response', {
          cause: jsonError,
          code: 'GEMINI_INVALID_JSON',
        });
      }

      // Normalize and validate the result
      const normalized = this.normalizeResult(parsedResult);

      logger.info({
        topics: normalized.topics.length,
        github_repos: normalized.github_repos.length,
        websites: normalized.websites.length,
        people: normalized.people.length,
        tags: normalized.tags.length,
      }, 'Successfully parsed transcript with Gemini');

      return normalized;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof AppError) {
        throw error;
      }

      // Extract clean error message
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const cleanMessage = errorMessage.split('\n')[0].substring(0, 200);

      logger.error({
        error: cleanMessage,
        videoTitle,
      }, 'Gemini API error');

      throw new AppError('Gemini API request failed', {
        cause: error,
        code: 'GEMINI_API_ERROR',
      });
    }
  }

  /**
   * Build the extraction prompt for Gemini
   *
   * @param transcriptText - Full transcript text
   * @param videoTitle - Video title
   * @returns Formatted prompt
   */
  private buildExtractionPrompt(
    transcriptText: string,
    videoTitle: string
  ): string {
    // Limit transcript to avoid token limits (approximately 8000 chars)
    const limitedTranscript = transcriptText.substring(0, 8000);

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
   * Normalize and validate the parsed result
   *
   * @param result - Raw result from Gemini
   * @returns Normalized and validated result
   */
  private normalizeResult(result: any): ParsedTranscript {
    const normalized: ParsedTranscript = {
      topics: Array.isArray(result.topics) ? result.topics.slice(0, 20) : [],
      github_repos: Array.isArray(result.github_repos)
        ? result.github_repos.slice(0, 10)
        : [],
      websites: Array.isArray(result.websites)
        ? result.websites.slice(0, 20)
        : [],
      people: Array.isArray(result.people) ? result.people.slice(0, 20) : [],
      tags: Array.isArray(result.tags)
        ? result.tags.map((t: string) => String(t).toLowerCase()).slice(0, 15)
        : [],
      summary:
        typeof result.summary === 'string'
          ? result.summary.substring(0, 1000)
          : '',
      content_type:
        typeof result.content_type === 'string' ? result.content_type : 'unknown',
      sentiment:
        typeof result.sentiment === 'string' ? result.sentiment : 'neutral',
    };

    // Ensure github_repos have proper structure
    normalized.github_repos = normalized.github_repos.filter(
      (repo: any) =>
        typeof repo === 'object' && repo !== null && typeof repo.name === 'string'
    );

    // Ensure websites have proper structure
    normalized.websites = normalized.websites.filter(
      (site: any) =>
        typeof site === 'object' && site !== null && typeof site.name === 'string'
    );

    return normalized;
  }

  /**
   * Return empty result structure
   *
   * @returns Empty parsed transcript result
   */
  private emptyResult(): ParsedTranscript {
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

  /**
   * Convert parsed result to database entity format
   *
   * @param parsedResult - Result from parseTranscript
   * @returns List of entity dictionaries for database storage
   */
  extractEntitiesForDatabase(parsedResult: ParsedTranscript): DatabaseEntity[] {
    const entities: DatabaseEntity[] = [];

    // Topics
    for (const topic of parsedResult.topics) {
      entities.push({
        type: 'topic',
        value: topic,
        url: null,
        confidence: 90,
      });
    }

    // GitHub repos
    for (const repo of parsedResult.github_repos) {
      entities.push({
        type: 'github_repo',
        value: repo.name,
        url: repo.url || null,
        confidence: 95,
      });
    }

    // Websites
    for (const site of parsedResult.websites) {
      entities.push({
        type: 'website',
        value: site.name,
        url: site.url || null,
        confidence: 90,
      });
    }

    // People
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
   * Extract tags from parsed result
   *
   * @param parsedResult - Result from parseTranscript
   * @returns List of tags
   */
  getTags(parsedResult: ParsedTranscript): string[] {
    return parsedResult.tags || [];
  }

  /**
   * Extract AI analysis for database storage
   *
   * @param parsedResult - Result from parseTranscript
   * @returns AI analysis data
   */
  getAnalysis(parsedResult: ParsedTranscript): AIAnalysis {
    return {
      summary: parsedResult.summary || '',
      content_type: parsedResult.content_type || 'unknown',
      sentiment: parsedResult.sentiment || 'neutral',
      model_used: this.modelName,
    };
  }
}

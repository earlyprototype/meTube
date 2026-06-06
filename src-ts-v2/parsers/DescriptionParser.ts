/**
 * Parse video descriptions and titles for entities without LLM.
 *
 * Deterministic regex-only parser: extracts GitHub repositories and URLs from
 * the combined title+description text. Lifted KEEP-AS-IS from
 * `src-ts/parsers/DescriptionParser.ts` per `docs/PORT_PLAN.md` Wave 3.
 *
 * Canonical Python reference: `legacy/python/src/parsers/description_parser.py`.
 *
 * Known gap (P7 disposition, documented in `docs/MIGRATION_NOTES.md`):
 * `topics` and `people` are returned as empty arrays. The Python parent has
 * the same gap by design — these slots exist so the downstream extractor
 * pipeline can merge in Gemini's output without changing the shape. The
 * regex-only parser never populates them; Gemini does.
 */

import logger from '../utils/logger.js';
import { ValidationError } from '../errors/index.js';

/**
 * Extracted GitHub repository information
 */
export interface GitHubRepo {
  url: string;
  owner: string;
  name: string;
  full_name: string;
}

/**
 * Parsed description result
 */
export interface ParsedDescription {
  github_repos: GitHubRepo[];
  websites: string[];
  topics: string[];
  people: string[];
  key_concepts: string[];
  summary: string | null;
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
 * DescriptionParser class for extracting entities from video descriptions
 */
export class DescriptionParser {
  private readonly githubRegex: RegExp;
  private readonly urlRegex: RegExp;

  /**
   * Regex patterns for extraction
   */
  private static readonly GITHUB_REPO_PATTERN =
    /github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/gi;
  private static readonly URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

  constructor() {
    this.githubRegex = new RegExp(DescriptionParser.GITHUB_REPO_PATTERN.source, 'gi');
    this.urlRegex = new RegExp(DescriptionParser.URL_PATTERN.source, 'gi');
  }

  /**
   * Parse title and description for entities
   *
   * @param title - Video title
   * @param description - Video description
   * @returns Parsed entities
   * @throws {ValidationError} If inputs are invalid
   */
  parse(title: string, description: string): ParsedDescription {
    // Validate inputs
    if (typeof title !== 'string') {
      throw new ValidationError('title must be a string');
    }

    if (typeof description !== 'string') {
      throw new ValidationError('description must be a string');
    }

    try {
      // Combine title and description for parsing
      const combinedText = `${title}\n${description}`;

      // Extract GitHub repos
      const github_repos = this.extractGitHubRepos(combinedText);

      // Extract all URLs
      const allUrls = this.extractUrls(combinedText);

      // Filter out GitHub URLs from general websites
      const githubDomains = new Set(['github.com', 'raw.githubusercontent.com', 'gist.github.com']);

      const websites = allUrls.filter((url) => {
        try {
          const urlObj = new URL(url);
          return !githubDomains.has(urlObj.hostname.toLowerCase());
        } catch {
          return false;
        }
      });

      logger.debug(
        {
          github_repos_count: github_repos.length,
          websites_count: websites.length,
        },
        'Parsed description'
      );

      return {
        github_repos,
        websites,
        topics: [],
        people: [],
        key_concepts: [],
        summary: null,
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }

      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse description'
      );

      throw new ValidationError('Failed to parse description', {
        cause: error,
      });
    }
  }

  /**
   * Extract GitHub repository URLs
   *
   * @param text - Text to extract from
   * @returns Array of GitHub repo objects
   */
  private extractGitHubRepos(text: string): GitHubRepo[] {
    const repos: GitHubRepo[] = [];
    const seen = new Set<string>();

    // Reset regex state
    this.githubRegex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = this.githubRegex.exec(text)) !== null) {
      const owner = match[1];
      let repoName = match[2];

      // Clean repo name (remove trailing dots, etc)
      repoName = repoName.replace(/\.+$/, '');

      const repoKey = `${owner}/${repoName}`.toLowerCase();

      if (!seen.has(repoKey)) {
        seen.add(repoKey);
        repos.push({
          url: `https://github.com/${owner}/${repoName}`,
          owner,
          name: repoName,
          full_name: `${owner}/${repoName}`,
        });
      }
    }

    return repos;
  }

  /**
   * Extract all URLs from text
   *
   * @param text - Text to extract from
   * @returns Array of URLs
   */
  private extractUrls(text: string): string[] {
    const urls: string[] = [];
    const seen = new Set<string>();

    // Reset regex state
    this.urlRegex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = this.urlRegex.exec(text)) !== null) {
      let url = match[0];

      // Clean up trailing punctuation
      url = url.replace(/[.,;:)\]}]+$/, '');

      const urlLower = url.toLowerCase();
      if (!seen.has(urlLower)) {
        seen.add(urlLower);
        urls.push(url);
      }
    }

    return urls;
  }

  /**
   * Convert parsed data to database entity format
   *
   * @param parsedData - Output from parse()
   * @returns List of entity dictionaries for database storage
   * @throws {ValidationError} If parsed data is invalid
   */
  extractEntitiesForDatabase(parsedData: ParsedDescription): DatabaseEntity[] {
    if (!parsedData || typeof parsedData !== 'object') {
      throw new ValidationError('parsedData must be an object');
    }

    const entities: DatabaseEntity[] = [];

    try {
      // Add GitHub repos
      if (Array.isArray(parsedData.github_repos)) {
        for (const repo of parsedData.github_repos) {
          entities.push({
            type: 'github_repo',
            value: repo.full_name,
            url: repo.url,
            confidence: 100,
          });
        }
      }

      // Add websites
      if (Array.isArray(parsedData.websites)) {
        for (const website of parsedData.websites) {
          entities.push({
            type: 'website',
            value: website,
            url: website,
            confidence: 100,
          });
        }
      }

      return entities;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to extract entities for database'
      );

      throw new ValidationError('Failed to extract entities for database', {
        cause: error,
      });
    }
  }

  /**
   * Extract tags from parsed data
   *
   * @param parsedData - Output from parse()
   * @returns List of tags
   * @throws {ValidationError} If parsed data is invalid
   */
  getTags(parsedData: ParsedDescription): string[] {
    if (!parsedData || typeof parsedData !== 'object') {
      throw new ValidationError('parsedData must be an object');
    }

    const tags: string[] = [];

    try {
      // Add 'github' tag if repos found
      if (Array.isArray(parsedData.github_repos) && parsedData.github_repos.length > 0) {
        tags.push('github');
      }

      // Add 'has-links' tag if websites found
      if (Array.isArray(parsedData.websites) && parsedData.websites.length > 0) {
        tags.push('has-links');
      }

      return tags;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to extract tags'
      );

      return [];
    }
  }
}

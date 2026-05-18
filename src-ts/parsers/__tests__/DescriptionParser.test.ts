import { describe, it, expect, beforeEach } from 'vitest';
import { DescriptionParser } from '../DescriptionParser.js';
import { ValidationError } from '../../errors/index.js';

describe('DescriptionParser', () => {
  let parser: DescriptionParser;

  beforeEach(() => {
    parser = new DescriptionParser();
  });

  describe('parse()', () => {
    it('should extract GitHub repos from description', () => {
      const title = 'Test Video';
      const description =
        'Check out https://github.com/microsoft/vscode and https://github.com/facebook/react';

      const result = parser.parse(title, description);

      expect(result.github_repos).toHaveLength(2);
      expect(result.github_repos[0]).toEqual({
        url: 'https://github.com/microsoft/vscode',
        owner: 'microsoft',
        name: 'vscode',
        full_name: 'microsoft/vscode',
      });
      expect(result.github_repos[1]).toEqual({
        url: 'https://github.com/facebook/react',
        owner: 'facebook',
        name: 'react',
        full_name: 'facebook/react',
      });
    });

    it('should extract URLs excluding GitHub', () => {
      const title = 'Test Video';
      const description =
        'Visit https://example.com and https://github.com/test/repo and https://nodejs.org';

      const result = parser.parse(title, description);

      expect(result.websites).toContain('https://example.com');
      expect(result.websites).toContain('https://nodejs.org');
      expect(result.websites).not.toContain('https://github.com/test/repo');
    });

    it('should handle descriptions with no links', () => {
      const title = 'No Links Here';
      const description = 'This is just plain text with no URLs at all.';

      const result = parser.parse(title, description);

      expect(result.github_repos).toHaveLength(0);
      expect(result.websites).toHaveLength(0);
    });

    it('should deduplicate GitHub repos', () => {
      const title = 'Test Video';
      const description =
        'Check out https://github.com/test/repo and also https://github.com/test/repo again';

      const result = parser.parse(title, description);

      expect(result.github_repos).toHaveLength(1);
      expect(result.github_repos[0].full_name).toBe('test/repo');
    });

    it('should deduplicate URLs', () => {
      const title = 'Test Video';
      const description = 'Visit https://example.com and https://example.com again';

      const result = parser.parse(title, description);

      expect(result.websites).toHaveLength(1);
      expect(result.websites[0]).toBe('https://example.com');
    });

    it('should handle trailing punctuation in URLs', () => {
      const title = 'Test Video';
      const description =
        'Visit https://example.com. Also check https://test.org, and https://site.net;';

      const result = parser.parse(title, description);

      expect(result.websites).toContain('https://example.com');
      expect(result.websites).toContain('https://test.org');
      expect(result.websites).toContain('https://site.net');
    });

    it('should handle trailing dots in repo names', () => {
      const title = 'Test Video';
      const description = 'Check out https://github.com/owner/repo.git.';

      const result = parser.parse(title, description);

      expect(result.github_repos).toHaveLength(1);
      expect(result.github_repos[0].name).toBe('repo.git');
    });

    it('should parse from both title and description', () => {
      const title = 'Tutorial: https://github.com/test/title-repo';
      const description = 'And also https://github.com/test/desc-repo';

      const result = parser.parse(title, description);

      expect(result.github_repos).toHaveLength(2);
      const repoNames = result.github_repos.map((r) => r.name);
      expect(repoNames).toContain('title-repo');
      expect(repoNames).toContain('desc-repo');
    });

    it('should throw ValidationError for non-string title', () => {
      expect(() => {
        parser.parse(123 as any, 'description');
      }).toThrow(ValidationError);
      expect(() => {
        parser.parse(123 as any, 'description');
      }).toThrow('title must be a string');
    });

    it('should throw ValidationError for non-string description', () => {
      expect(() => {
        parser.parse('title', null as any);
      }).toThrow(ValidationError);
      expect(() => {
        parser.parse('title', null as any);
      }).toThrow('description must be a string');
    });

    it('should handle empty strings', () => {
      const result = parser.parse('', '');

      expect(result.github_repos).toHaveLength(0);
      expect(result.websites).toHaveLength(0);
      expect(result.topics).toHaveLength(0);
      expect(result.people).toHaveLength(0);
      expect(result.summary).toBeNull();
    });

    it('should handle malformed URLs gracefully', () => {
      const title = 'Test';
      const description = 'Not a URL: htt://broken and https://valid.com';

      const result = parser.parse(title, description);

      expect(result.websites).toContain('https://valid.com');
      expect(result.websites).toHaveLength(1);
    });
  });

  describe('extractEntitiesForDatabase()', () => {
    it('should convert GitHub repos to database format', () => {
      const parsed = parser.parse('Test', 'https://github.com/test/repo');
      const entities = parser.extractEntitiesForDatabase(parsed);

      expect(entities).toHaveLength(1);
      expect(entities[0]).toEqual({
        type: 'github_repo',
        value: 'test/repo',
        url: 'https://github.com/test/repo',
        confidence: 100,
      });
    });

    it('should convert websites to database format', () => {
      const parsed = parser.parse('Test', 'Visit https://example.com');
      const entities = parser.extractEntitiesForDatabase(parsed);

      expect(entities).toHaveLength(1);
      expect(entities[0]).toEqual({
        type: 'website',
        value: 'https://example.com',
        url: 'https://example.com',
        confidence: 100,
      });
    });

    it('should convert both repos and websites', () => {
      const parsed = parser.parse('Test', 'https://github.com/test/repo and https://example.com');
      const entities = parser.extractEntitiesForDatabase(parsed);

      expect(entities).toHaveLength(2);
      expect(entities[0].type).toBe('github_repo');
      expect(entities[1].type).toBe('website');
    });

    it('should return empty array for no entities', () => {
      const parsed = parser.parse('Test', 'No links here');
      const entities = parser.extractEntitiesForDatabase(parsed);

      expect(entities).toHaveLength(0);
    });

    it('should throw ValidationError for invalid input', () => {
      expect(() => {
        parser.extractEntitiesForDatabase(null as any);
      }).toThrow(ValidationError);
      expect(() => {
        parser.extractEntitiesForDatabase(null as any);
      }).toThrow('parsedData must be an object');
    });
  });

  describe('getTags()', () => {
    it('should return github tag when repos found', () => {
      const parsed = parser.parse('Test', 'https://github.com/test/repo');
      const tags = parser.getTags(parsed);

      expect(tags).toContain('github');
    });

    it('should return has-links tag when websites found', () => {
      const parsed = parser.parse('Test', 'https://example.com');
      const tags = parser.getTags(parsed);

      expect(tags).toContain('has-links');
    });

    it('should return both tags when both found', () => {
      const parsed = parser.parse('Test', 'https://github.com/test/repo and https://example.com');
      const tags = parser.getTags(parsed);

      expect(tags).toContain('github');
      expect(tags).toContain('has-links');
    });

    it('should return empty array when no links found', () => {
      const parsed = parser.parse('Test', 'No links');
      const tags = parser.getTags(parsed);

      expect(tags).toHaveLength(0);
    });

    it('should throw ValidationError for invalid input', () => {
      expect(() => {
        parser.getTags(null as any);
      }).toThrow(ValidationError);
      expect(() => {
        parser.getTags(null as any);
      }).toThrow('parsedData must be an object');
    });

    it('should return empty array on error', () => {
      const invalidParsed = {
        github_repos: 'not an array',
        websites: null,
      } as any;

      const tags = parser.getTags(invalidParsed);
      expect(tags).toHaveLength(0);
    });
  });
});

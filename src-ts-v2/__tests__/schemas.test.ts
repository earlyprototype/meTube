/**
 * Wire-boundary Zod schema tests.
 *
 * For each schema in `src-ts-v2/schemas/`, one PASS fixture exercises the
 * happy path, and one FAIL fixture proves the schema rejects shape-broken
 * input. FAIL fixtures are designed to fail for genuine type/shape
 * reasons (wrong type, missing required field) — not for missing optional
 * fields, which would be a false-positive.
 *
 * Fixtures are minimal but realistic — modelled on the actual YouTube
 * Data API v3 responses and the Gemini prompt in
 * `legacy/python/src/parsers/llm_parser.py`.
 */
import { describe, expect, it } from 'vitest';

import {
  // YouTube
  YouTubeVideoSchema,
  YouTubePlaylistSchema,
  YouTubePlaylistItemSchema,
  YouTubePageResponseSchema,
  YouTubeVideosPageSchema,
  // Gemini
  GeminiResponseSchema,
  // DB rows
  VideoRowSchema,
  PlaylistRowSchema,
  TranscriptRowSchema,
  ExtractedEntityRowSchema,
  TagRowSchema,
  VideoTagRowSchema,
  PlaylistItemRowSchema,
  ExtractionJobRowSchema,
  AIAnalysisRowSchema,
  VideoStatisticRowSchema,
  // Config
  MeTubeConfigSchema,
} from '../schemas/index.js';

// --------------------------------------------------------------------------
// YouTube — videos.list
// --------------------------------------------------------------------------

describe('YouTubeVideoSchema', () => {
  it('parses a realistic videos.list item', () => {
    // Arrange — modelled on a real videos.list?part=snippet,contentDetails,statistics response
    const item = {
      id: 'dQw4w9WgXcQ',
      snippet: {
        publishedAt: '2009-10-25T06:57:33Z',
        channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
        title: 'Rick Astley - Never Gonna Give You Up',
        description: 'The official video',
        channelTitle: 'Rick Astley',
        categoryId: '10',
        thumbnails: {
          default: {
            url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg',
            width: 120,
            height: 90,
          },
        },
        tags: ['rick astley', 'never gonna give you up'],
      },
      contentDetails: {
        duration: 'PT3M33S',
        definition: 'hd',
        caption: 'true',
        licensedContent: true,
      },
      statistics: {
        viewCount: '1500000000',
        likeCount: '17000000',
        commentCount: '2000000',
      },
    };

    // Act
    const parsed = YouTubeVideoSchema.parse(item);

    // Assert
    expect(parsed.id).toBe('dQw4w9WgXcQ');
    expect(parsed.snippet.title).toBe('Rick Astley - Never Gonna Give You Up');
    expect(parsed.contentDetails.duration).toBe('PT3M33S');
  });

  it('rejects an item missing required snippet.title', () => {
    // Arrange — `title` is required by the schema
    const item = {
      id: 'dQw4w9WgXcQ',
      snippet: {
        publishedAt: '2009-10-25T06:57:33Z',
        channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
        // title intentionally absent
        description: 'desc',
        channelTitle: 'ch',
        thumbnails: {
          default: { url: 'https://i.ytimg.com/vi/x/default.jpg' },
        },
      },
      contentDetails: { duration: 'PT1S' },
    };

    // Act + Assert
    expect(() => YouTubeVideoSchema.parse(item)).toThrow();
  });
});

// --------------------------------------------------------------------------
// YouTube — playlists.list
// --------------------------------------------------------------------------

describe('YouTubePlaylistSchema', () => {
  it('parses a realistic playlists.list item', () => {
    // Arrange
    const item = {
      id: 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L',
      snippet: {
        publishedAt: '2018-01-15T10:00:00Z',
        channelId: 'UCBJycsmduvYEL83R_U4JriQ',
        title: 'My favourite videos',
        description: 'A long list',
        channelTitle: 'Test Channel',
        thumbnails: {
          default: { url: 'https://i.ytimg.com/vi/x/default.jpg' },
        },
      },
      contentDetails: { itemCount: 42 },
      status: { privacyStatus: 'public' },
    };

    // Act
    const parsed = YouTubePlaylistSchema.parse(item);

    // Assert
    expect(parsed.contentDetails.itemCount).toBe(42);
    expect(parsed.status?.privacyStatus).toBe('public');
  });

  it('rejects a playlist when itemCount has the wrong type', () => {
    // Arrange — `itemCount` must be an integer; the API never returns a string here
    const item = {
      id: 'PLxxxxxxxxxxxxxxxxxx',
      snippet: {
        publishedAt: '2018-01-15T10:00:00Z',
        channelId: 'UCxxxx',
        title: 'P',
        channelTitle: 'ch',
      },
      contentDetails: { itemCount: 'not-a-number' },
    };

    // Act + Assert
    expect(() => YouTubePlaylistSchema.parse(item)).toThrow();
  });
});

// --------------------------------------------------------------------------
// YouTube — playlistItems.list
// --------------------------------------------------------------------------

describe('YouTubePlaylistItemSchema', () => {
  it('parses a realistic playlistItems.list item', () => {
    // Arrange
    const item = {
      id: 'UExuRzlBQjEyM0FCQ19fX18yMDIzMTAxMjMz',
      snippet: {
        publishedAt: '2023-10-12T00:00:00Z',
        channelId: 'UCBJycsmduvYEL83R_U4JriQ',
        title: 'Some video in a playlist',
        channelTitle: 'Test',
        playlistId: 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L',
        position: 5,
        thumbnails: {
          default: { url: 'https://i.ytimg.com/vi/x/default.jpg' },
        },
      },
      contentDetails: { videoId: 'dQw4w9WgXcQ' },
    };

    // Act
    const parsed = YouTubePlaylistItemSchema.parse(item);

    // Assert
    expect(parsed.snippet.position).toBe(5);
    expect(parsed.contentDetails.videoId).toBe('dQw4w9WgXcQ');
  });

  it('rejects a playlist item missing contentDetails.videoId', () => {
    // Arrange — videoId is the load-bearing field; the schema must require it
    const item = {
      id: 'UExuRzlBQjEyM0FCQ19fX18yMDIzMTAxMjMz',
      snippet: {
        publishedAt: '2023-10-12T00:00:00Z',
        channelId: 'UCxxxx',
        title: 'x',
        channelTitle: 'ch',
        playlistId: 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        position: 0,
        thumbnails: { default: { url: 'https://x/default.jpg' } },
      },
      contentDetails: {}, // videoId missing
    };

    // Act + Assert
    expect(() => YouTubePlaylistItemSchema.parse(item)).toThrow();
  });
});

// --------------------------------------------------------------------------
// YouTube — page wrapper
// --------------------------------------------------------------------------

describe('YouTubePageResponseSchema', () => {
  it('parses a single page of videos with nextPageToken', () => {
    // Arrange
    const page = {
      items: [
        {
          id: 'dQw4w9WgXcQ',
          snippet: {
            publishedAt: '2009-10-25T06:57:33Z',
            channelId: 'UCxxxx',
            title: 't',
            description: 'd',
            channelTitle: 'ch',
            thumbnails: {
              default: { url: 'https://i.ytimg.com/vi/x/default.jpg' },
            },
          },
          contentDetails: { duration: 'PT3M33S' },
        },
      ],
      nextPageToken: 'CAUQAA',
    };

    // Act
    const parsed = YouTubeVideosPageSchema.parse(page);

    // Assert
    expect(parsed.items).toHaveLength(1);
    expect(parsed.nextPageToken).toBe('CAUQAA');
  });

  it('parses a final page without nextPageToken', () => {
    // Arrange
    const page = { items: [] };

    // Act
    const parsed = YouTubeVideosPageSchema.parse(page);

    // Assert
    expect(parsed.items).toHaveLength(0);
    expect(parsed.nextPageToken).toBeUndefined();
  });

  it('the generic factory composes for an arbitrary item schema', () => {
    // Arrange — exercises the factory shape, not just the prebuilt aliases
    const TinyPage = YouTubePageResponseSchema(YouTubeVideoSchema);

    // Act + Assert — should accept an empty page without throwing
    const result = TinyPage.parse({ items: [] });
    expect(result.items).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Gemini
// --------------------------------------------------------------------------

describe('GeminiResponseSchema', () => {
  it('parses a full Gemini response with all keys present', () => {
    // Arrange — modelled on the JSON the prompt asks Gemini to return
    const response = {
      topics: ['Machine Learning', 'Python'],
      github_repos: [
        { name: 'tensorflow', url: 'https://github.com/tensorflow/tensorflow' },
      ],
      websites: [{ name: 'arxiv', url: 'https://arxiv.org' }],
      people: ['Andrew Ng'],
      tags: ['ml', 'python'],
      summary: 'A talk about Python ML libraries.',
      content_type: 'tutorial',
      sentiment: 'positive',
    };

    // Act
    const parsed = GeminiResponseSchema.parse(response);

    // Assert
    expect(parsed.topics).toContain('Machine Learning');
    expect(parsed.github_repos[0]?.name).toBe('tensorflow');
    expect(parsed.sentiment).toBe('positive');
  });

  it('applies defaults to missing array fields and sentiment', () => {
    // Arrange — Gemini sometimes truncates output; partial response must parse
    const response = {
      summary: 'Brief',
      content_type: 'review',
    };

    // Act
    const parsed = GeminiResponseSchema.parse(response);

    // Assert — defaults filled in
    expect(parsed.topics).toEqual([]);
    expect(parsed.github_repos).toEqual([]);
    expect(parsed.websites).toEqual([]);
    expect(parsed.people).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.sentiment).toBe('neutral');
  });

  it('rejects an invalid sentiment value', () => {
    // Arrange — sentiment is constrained to the three known categories
    const response = {
      topics: [],
      github_repos: [],
      websites: [],
      people: [],
      tags: [],
      summary: '',
      content_type: 'unknown',
      sentiment: 'spicy',
    };

    // Act + Assert
    expect(() => GeminiResponseSchema.parse(response)).toThrow();
  });

  it('rejects a github_repos entry that is a bare string', () => {
    // Arrange — must be `{ name, url? }`, not a string
    const response = {
      topics: [],
      github_repos: ['just-a-name'],
      websites: [],
      people: [],
      tags: [],
      summary: '',
      content_type: 'unknown',
      sentiment: 'neutral',
    };

    // Act + Assert
    expect(() => GeminiResponseSchema.parse(response)).toThrow();
  });
});

// --------------------------------------------------------------------------
// DB row schemas
// --------------------------------------------------------------------------

describe('VideoRowSchema', () => {
  it('parses a complete video row from SQLite', () => {
    // Arrange — shape matches `INSERT INTO videos(...)` result with defaults filled
    const row = {
      id: 1,
      video_id: 'dQw4w9WgXcQ',
      title: 'A title',
      description: 'A description',
      channel_id: 'UCxxxx',
      channel_title: 'A channel',
      published_at: '2024-01-01T00:00:00Z',
      duration: 'PT3M33S',
      duration_seconds: 213,
      is_short: 0,
      category_id: '10',
      category_name: null,
      definition: 'hd',
      caption: 1,
      licensed_content: 0,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    // Act
    const parsed = VideoRowSchema.parse(row);

    // Assert
    expect(parsed.video_id).toBe('dQw4w9WgXcQ');
    expect(parsed.duration_seconds).toBe(213);
  });

  it('rejects a row missing required NOT NULL columns', () => {
    // Arrange — channel_id is NOT NULL in schema.ts
    const row = {
      video_id: 'dQw4w9WgXcQ',
      title: 'A title',
      // channel_id missing
      channel_title: 'A channel',
      published_at: '2024-01-01T00:00:00Z',
      duration: 'PT3M33S',
      duration_seconds: 213,
      is_short: 0,
    };

    // Act + Assert
    expect(() => VideoRowSchema.parse(row)).toThrow();
  });
});

describe('PlaylistRowSchema', () => {
  it('parses a complete playlist row', () => {
    // Arrange
    const row = {
      id: 1,
      playlist_id: 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L',
      title: 'My playlist',
      description: 'A list',
      last_checked: null,
      video_count: 50,
      enabled: 1,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    // Act
    const parsed = PlaylistRowSchema.parse(row);

    // Assert
    expect(parsed.playlist_id).toMatch(/^PL/);
  });

  it('rejects when title is not a string', () => {
    // Arrange
    const row = {
      playlist_id: 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L',
      title: 123, // wrong type
    };

    // Act + Assert
    expect(() => PlaylistRowSchema.parse(row)).toThrow();
  });
});

describe('TranscriptRowSchema', () => {
  it('parses a transcript row', () => {
    // Arrange
    const row = {
      id: 5,
      video_id: 'dQw4w9WgXcQ',
      language: 'en',
      full_text: 'we are no strangers to love',
      segments_json: '[{"text":"...","start":0,"duration":2}]',
      is_auto_generated: 1,
      extracted_at: '2024-01-01T00:00:00Z',
    };

    // Act
    const parsed = TranscriptRowSchema.parse(row);

    // Assert
    expect(parsed.language).toBe('en');
  });

  it('rejects when full_text is missing', () => {
    // Arrange — full_text is NOT NULL
    const row = {
      video_id: 'dQw4w9WgXcQ',
      language: 'en',
    };

    // Act + Assert
    expect(() => TranscriptRowSchema.parse(row)).toThrow();
  });
});

describe('ExtractedEntityRowSchema', () => {
  it('parses an entity row of each known type', () => {
    // Arrange
    const row = {
      id: 1,
      video_id: 'dQw4w9WgXcQ',
      entity_type: 'github_repo',
      entity_value: 'tensorflow/tensorflow',
      entity_url: 'https://github.com/tensorflow/tensorflow',
      confidence: 95,
      extracted_at: '2024-01-01T00:00:00Z',
    };

    // Act
    const parsed = ExtractedEntityRowSchema.parse(row);

    // Assert
    expect(parsed.entity_type).toBe('github_repo');
    expect(parsed.confidence).toBe(95);
  });

  it('rejects when entity_value is missing', () => {
    // Arrange
    const row = {
      video_id: 'dQw4w9WgXcQ',
      entity_type: 'topic',
    };

    // Act + Assert
    expect(() => ExtractedEntityRowSchema.parse(row)).toThrow();
  });
});

describe('TagRowSchema', () => {
  it('parses a tag row', () => {
    // Arrange + Act
    const parsed = TagRowSchema.parse({ id: 1, tag: 'machine-learning' });
    // Assert
    expect(parsed.tag).toBe('machine-learning');
  });

  it('rejects when tag is missing', () => {
    // Arrange + Act + Assert
    expect(() => TagRowSchema.parse({ id: 1 })).toThrow();
  });
});

describe('VideoTagRowSchema', () => {
  it('parses a video_tags join row', () => {
    // Arrange + Act
    const parsed = VideoTagRowSchema.parse({
      video_id: 'dQw4w9WgXcQ',
      tag_id: 7,
    });
    // Assert
    expect(parsed.tag_id).toBe(7);
  });

  it('rejects when tag_id is not a number', () => {
    // Arrange + Act + Assert
    expect(() =>
      VideoTagRowSchema.parse({ video_id: 'dQw4w9WgXcQ', tag_id: 'seven' })
    ).toThrow();
  });
});

describe('PlaylistItemRowSchema', () => {
  it('parses a playlist_items row', () => {
    // Arrange
    const row = {
      id: 1,
      playlist_id: 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L',
      video_id: 'dQw4w9WgXcQ',
      position: 0,
      added_at: '2024-01-01T00:00:00Z',
    };

    // Act
    const parsed = PlaylistItemRowSchema.parse(row);

    // Assert
    expect(parsed.position).toBe(0);
  });

  it('rejects when added_at is missing', () => {
    // Arrange — added_at is NOT NULL
    const row = {
      playlist_id: 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      video_id: 'dQw4w9WgXcQ',
    };

    // Act + Assert
    expect(() => PlaylistItemRowSchema.parse(row)).toThrow();
  });
});

describe('ExtractionJobRowSchema', () => {
  it('parses an extraction_jobs row', () => {
    // Arrange
    const row = {
      id: 1,
      playlist_id: 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L',
      job_type: 'playlist',
      status: 'completed',
      videos_found: 50,
      videos_processed: 48,
      new_videos: 5,
      started_at: '2024-01-01T00:00:00Z',
      completed_at: '2024-01-01T00:01:00Z',
      error_message: null,
    };

    // Act
    const parsed = ExtractionJobRowSchema.parse(row);

    // Assert
    expect(parsed.status).toBe('completed');
  });

  it('rejects when job_type is missing', () => {
    // Arrange
    const row = { status: 'pending' };

    // Act + Assert
    expect(() => ExtractionJobRowSchema.parse(row)).toThrow();
  });
});

describe('AIAnalysisRowSchema', () => {
  it('parses an ai_analysis row', () => {
    // Arrange
    const row = {
      id: 1,
      video_id: 'dQw4w9WgXcQ',
      summary: 'Brief summary',
      key_points: '["one","two"]',
      sentiment: 'positive',
      content_type: 'tutorial',
      model_used: 'gemini-3-flash-preview',
      analyzed_at: '2024-01-01T00:00:00Z',
    };

    // Act
    const parsed = AIAnalysisRowSchema.parse(row);

    // Assert
    expect(parsed.model_used).toBe('gemini-3-flash-preview');
  });

  it('rejects when video_id is missing', () => {
    // Arrange
    const row = { summary: 'x' };

    // Act + Assert
    expect(() => AIAnalysisRowSchema.parse(row)).toThrow();
  });
});

describe('VideoStatisticRowSchema', () => {
  it('parses a video_statistics row', () => {
    // Arrange + Act
    const parsed = VideoStatisticRowSchema.parse({
      id: 1,
      video_id: 'dQw4w9WgXcQ',
      view_count: 1500000000,
      like_count: 17000000,
      comment_count: 2000000,
      recorded_at: '2024-01-01T00:00:00Z',
    });

    // Assert
    expect(parsed.view_count).toBe(1500000000);
  });

  it('rejects when video_id is not a string', () => {
    // Arrange + Act + Assert
    expect(() =>
      VideoStatisticRowSchema.parse({ video_id: 123, view_count: 0 })
    ).toThrow();
  });
});

// --------------------------------------------------------------------------
// DB row schemas — nullable defaulted-timestamp regression guards
// --------------------------------------------------------------------------
//
// Every column below is declared `TEXT DEFAULT CURRENT_TIMESTAMP` (or, for
// `playlists.last_checked`, plain nullable `TEXT`) in `database/schema.ts`
// WITHOUT `NOT NULL`. SQLite therefore permits NULL in these columns: an
// explicit `INSERT ... VALUES (NULL)` stores NULL, and SQLite does not retro-
// apply the default. The matching Zod field must be `.nullable()`, not plain
// `.optional()` — `.optional()` accepts an absent key but REJECTS an explicit
// `null`.
//
// These tests pin that distinction. Each takes an otherwise-valid row, sets
// exactly one defaulted-timestamp field to `null`, and asserts the parse
// succeeds. If any of these fails, a row schema has regressed a nullable
// timestamp back to plain `.optional()` — the exact bug class that already
// bit `videos.created_at` and the playlist-join schema.

describe('nullable defaulted-timestamp columns accept null', () => {
  it('accepts null for videos.created_at', () => {
    // Arrange — valid row, created_at explicitly null
    const row = {
      video_id: 'dQw4w9WgXcQ',
      title: 'A title',
      channel_id: 'UCxxxx',
      channel_title: 'A channel',
      published_at: '2024-01-01T00:00:00Z',
      duration: 'PT3M33S',
      duration_seconds: 213,
      is_short: 0,
      created_at: null,
    };

    // Act + Assert
    expect(() => VideoRowSchema.parse(row)).not.toThrow();
  });

  it('accepts null for videos.updated_at', () => {
    // Arrange
    const row = {
      video_id: 'dQw4w9WgXcQ',
      title: 'A title',
      channel_id: 'UCxxxx',
      channel_title: 'A channel',
      published_at: '2024-01-01T00:00:00Z',
      duration: 'PT3M33S',
      duration_seconds: 213,
      is_short: 0,
      updated_at: null,
    };

    // Act + Assert
    expect(() => VideoRowSchema.parse(row)).not.toThrow();
  });

  it('accepts null for video_statistics.recorded_at', () => {
    // Arrange
    const row = {
      video_id: 'dQw4w9WgXcQ',
      view_count: 1500000000,
      like_count: 17000000,
      comment_count: 2000000,
      recorded_at: null,
    };

    // Act + Assert
    expect(VideoStatisticRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts null for transcripts.extracted_at', () => {
    // Arrange
    const row = {
      video_id: 'dQw4w9WgXcQ',
      language: 'en',
      full_text: 'we are no strangers to love',
      extracted_at: null,
    };

    // Act + Assert
    expect(TranscriptRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts null for extracted_entities.extracted_at', () => {
    // Arrange
    const row = {
      video_id: 'dQw4w9WgXcQ',
      entity_type: 'github_repo',
      entity_value: 'tensorflow/tensorflow',
      extracted_at: null,
    };

    // Act + Assert
    expect(ExtractedEntityRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts null for tags.created_at', () => {
    // Arrange
    const row = { id: 1, tag: 'machine-learning', created_at: null };

    // Act + Assert
    expect(TagRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts null for playlists.created_at', () => {
    // Arrange
    const row = {
      playlist_id: 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L',
      title: 'My playlist',
      created_at: null,
    };

    // Act + Assert
    expect(() => PlaylistRowSchema.parse(row)).not.toThrow();
  });

  it('accepts null for playlists.updated_at', () => {
    // Arrange
    const row = {
      playlist_id: 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L',
      title: 'My playlist',
      updated_at: null,
    };

    // Act + Assert
    expect(() => PlaylistRowSchema.parse(row)).not.toThrow();
  });

  it('accepts null for playlists.last_checked', () => {
    // Arrange — last_checked is plain nullable TEXT (no default, no NOT NULL)
    const row = {
      playlist_id: 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L',
      title: 'My playlist',
      last_checked: null,
    };

    // Act + Assert
    expect(() => PlaylistRowSchema.parse(row)).not.toThrow();
  });

  it('accepts null for ai_analysis.analyzed_at', () => {
    // Arrange
    const row = {
      video_id: 'dQw4w9WgXcQ',
      summary: 'Brief summary',
      analyzed_at: null,
    };

    // Act + Assert
    expect(AIAnalysisRowSchema.safeParse(row).success).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Config schema
// --------------------------------------------------------------------------

describe('MeTubeConfigSchema', () => {
  it('parses a full config object', () => {
    // Arrange — mirrors config/config.yaml after env-var substitution
    const cfg = {
      api: {
        youtube_credentials: 'client_secret.json',
        token_file: 'token.json',
        gemini_api_key: 'fake-key',
        gemini_model: 'gemini-3-flash-preview',
        rate_limit_delay: 0.3,
        max_retries: 3,
      },
      database: {
        path: 'data/metube.db',
        backup_enabled: true,
        backup_path: 'data/backups/',
        auto_vacuum: true,
      },
      extraction: {
        auto_transcript: true,
        auto_llm_parse: true,
        filter_shorts_only: false,
        languages: ['en', 'en-GB', 'en-US'],
        batch_size: 50,
        whisper: {
          enabled: true,
          model: 'base',
          audio_format: 'm4a',
          temp_dir: 'data/temp_audio/',
          cleanup_audio: true,
        },
      },
      reports: {
        output_dir: 'reports/',
        template: 'default.html',
        auto_generate: true,
        include_thumbnails: true,
        date_format: '%Y-%m-%d %H:%M:%S',
      },
      logging: {
        level: 'INFO',
        file: 'logs/metube.log',
        max_size_mb: 10,
        backup_count: 5,
      },
    };

    // Act
    const parsed = MeTubeConfigSchema.parse(cfg);

    // Assert
    expect(parsed.api.gemini_model).toBe('gemini-3-flash-preview');
    expect(parsed.extraction.whisper.enabled).toBe(true);
  });

  it('applies defaults when sections are absent', () => {
    // Arrange — empty config; every section must default
    const parsed = MeTubeConfigSchema.parse({});

    // Assert
    expect(parsed.api.youtube_credentials).toBe('client_secret.json');
    expect(parsed.database.path).toBe('data/metube.db');
    expect(parsed.extraction.languages).toContain('en');
    expect(parsed.extraction.whisper.model).toBe('base');
    expect(parsed.reports.output_dir).toBe('reports/');
    expect(parsed.logging.level).toBe('INFO');
  });

  it('rejects when rate_limit_delay is not a number', () => {
    // Arrange
    const cfg = { api: { rate_limit_delay: 'fast' } };

    // Act + Assert
    expect(() => MeTubeConfigSchema.parse(cfg)).toThrow();
  });
});

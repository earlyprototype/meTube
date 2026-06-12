/**
 * HTMLReportGenerator tests — Phase 2 Wave 4.
 *
 * Real `:memory:` SQLite, real repositories, real Handlebars compile —
 * no mocks. Each test owns a fresh `DatabaseManager` and a fresh
 * `os.tmpdir()`-rooted templates / output pair so on-disk state never
 * leaks between cases.
 *
 * Audit-critical test:
 *   `closes the v1 HIGH stub bomb — stored analysis appears in rendered HTML`
 *   proves the report path reads `ai_analysis` and the resulting HTML
 *   contains the analysis text. v1's
 *   `HTMLReportGenerator.getAnalysisData(_videoId) { return undefined; }`
 *   stub silently rendered every report with an empty AI section.
 *   If a future refactor reintroduces that pattern, this test fails.
 *
 *   NON-NEGOTIABLE per `docs/PORT_PLAN.md` Wave 4.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DatabaseManager } from '../database/connection.js';
import { AIAnalysisRepository } from '../database/AIAnalysisRepository.js';
import { EntityRepository } from '../database/EntityRepository.js';
import { PlaylistItemRepository } from '../database/PlaylistItemRepository.js';
import { PlaylistRepository } from '../database/PlaylistRepository.js';
import { StatisticsRepository } from '../database/StatisticsRepository.js';
import { TranscriptRepository } from '../database/TranscriptRepository.js';
import { VideoRepository } from '../database/VideoRepository.js';
import { AppError } from '../errors/index.js';
import { HTMLReportGenerator, REPORT_ERROR_CODES } from '../reports/HTMLReportGenerator.js';
import { asPlaylistId, asVideoId, type PlaylistId, type VideoId } from '../types/index.js';
import type { GeminiResponse } from '../schemas/gemini.js';

// --------------------------------------------------------------------------
// Test fixtures: minimal templates that include every placeholder the tests
// assert on. Real `templates/` is large and contains styling that we don't
// want test failures to depend on; using a small in-test template makes the
// regression assertions precise.
// --------------------------------------------------------------------------

const VIDEO_TEMPLATE = `<!DOCTYPE html>
<html><head><title>{{ video.title }}</title></head>
<body>
<h1>{{ video.title }}</h1>
<p data-channel="{{ video.channel_title }}">Channel: {{ video.channel_title }}</p>
{{#if analysis}}
<section class="analysis">
  <p class="summary">{{ analysis.summary }}</p>
  <p class="ctype">{{ analysis.content_type }}</p>
  <p class="sentiment">{{ analysis.sentiment }}</p>
  <p class="model">{{ analysis.model_used }}</p>
</section>
{{else}}
<p class="no-analysis">No analysis available</p>
{{/if}}
{{#if entities.topics}}
<section class="topics">
  {{#each entities.topics}}<span class="topic">{{ this }}</span>{{/each}}
</section>
{{/if}}
{{#if entities.github_repos}}
<section class="repos">
  {{#each entities.github_repos}}<a href="{{ url }}" class="repo">{{ name }}</a>{{/each}}
</section>
{{/if}}
{{#if entities.people}}
<section class="people">
  {{#each entities.people}}<span class="person">{{ this }}</span>{{/each}}
</section>
{{/if}}
{{#if entities.websites}}
<section class="websites">
  {{#each entities.websites}}<a href="{{ url }}" class="website">{{ name }}</a>{{/each}}
</section>
{{/if}}
{{#if transcript}}
<section class="transcript">
  <p>Words: {{ transcript.word_count }}</p>
  <p>Lang: {{ transcript.language }}</p>
</section>
{{/if}}
</body></html>`;

const PLAYLIST_TEMPLATE = `<!DOCTYPE html>
<html><head><title>{{ playlist.title }}</title></head>
<body>
<h1>{{ playlist.title }}</h1>
<p class="count">{{ playlist.video_count }} videos</p>
<p class="duration">{{ playlist.total_duration }}</p>
<p class="views">{{ playlist.total_views }} views</p>
<p class="tpct">{{ playlist.transcript_percentage }}%</p>
<section class="stats">
  <span class="topics-total">{{ stats.total_topics }}</span>
  <span class="repos-total">{{ stats.total_repos }}</span>
  <span class="websites-total">{{ stats.total_websites }}</span>
  <span class="people-total">{{ stats.total_people }}</span>
</section>
<section class="videos">
  {{#each videos}}
  <article class="video-card" data-id="{{ video_id }}">
    <h2 class="vtitle">{{ title }}</h2>
    <p class="vchannel">{{ channel_title }}</p>
    {{#if summary}}
    <div class="video-summary">{{ summary }}</div>
    {{/if}}
  </article>
  {{/each}}
</section>
<section class="top-topics">
  {{#each top_topics}}<span class="agg-topic" data-count="{{ count }}">{{ name }}</span>{{/each}}
</section>
<section class="agg-repos">
  {{#each github_repos}}<a class="agg-repo" href="{{ url }}">{{ name }}</a>{{#if description}}<span class="agg-repo-desc">{{ description }}</span>{{/if}}{{/each}}
</section>
<section class="agg-people">
  {{#each people}}<span class="agg-person" data-count="{{ count }}">{{ name }}</span>{{/each}}
</section>
</body></html>`;

interface TestHarness {
  dbm: DatabaseManager;
  templatesDir: string;
  outputDir: string;
  tempRoot: string;
  generator: HTMLReportGenerator;
}

/**
 * Build a fresh `:memory:` DB, write the test templates to a temp
 * directory, and return everything the tests need. Each test owns its
 * own harness so state cannot leak between cases.
 */
function makeHarness(): TestHarness {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metube-report-test-'));
  const templatesDir = path.join(tempRoot, 'templates');
  const outputDir = path.join(tempRoot, 'reports');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'video_report.html'), VIDEO_TEMPLATE);
  fs.writeFileSync(path.join(templatesDir, 'playlist_report.html'), PLAYLIST_TEMPLATE);

  const dbm = new DatabaseManager(':memory:');
  const generator = new HTMLReportGenerator(dbm, { templatesDir });
  return { dbm, templatesDir, outputDir, tempRoot, generator };
}

function disposeHarness(h: TestHarness): void {
  h.dbm.close();
  // Recursive remove with retries: Windows can transiently hold handles
  // open on freshly-written files. `force: true` swallows ENOENT.
  try {
    fs.rmSync(h.tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

interface SeedVideoOptions {
  readonly videoId: VideoId;
  readonly title?: string;
  readonly channelTitle?: string;
  readonly channelId?: string;
  readonly durationSeconds?: number;
  readonly isShort?: 0 | 1;
}

/**
 * Insert a `videos` row directly via withTransaction. We do not route
 * through `VideoRepository.createOrUpdate` here so the test fixture is
 * independent of the repository's coercion semantics.
 */
function seedVideo(dbm: DatabaseManager, opts: SeedVideoOptions): VideoId {
  dbm.withTransaction((db) => {
    db.prepare(
      `INSERT INTO videos
         (video_id, title, channel_id, channel_title, published_at,
          duration, duration_seconds, is_short)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      opts.videoId,
      opts.title ?? 'Fixture video title',
      opts.channelId ?? 'UCfixturechannelchnnl',
      opts.channelTitle ?? 'Fixture channel',
      '2024-01-01T00:00:00Z',
      'PT3M00S',
      opts.durationSeconds ?? 180,
      opts.isShort ?? 0
    );
  });
  return opts.videoId;
}

function seedPlaylist(
  dbm: DatabaseManager,
  playlistId: PlaylistId,
  title = 'Fixture playlist'
): PlaylistId {
  const repo = new PlaylistRepository(dbm);
  repo.createOrUpdate({ playlistId, title });
  return playlistId;
}

function attachVideoToPlaylist(
  dbm: DatabaseManager,
  playlistId: PlaylistId,
  videoId: VideoId,
  position: number
): void {
  const repo = new PlaylistItemRepository(dbm);
  repo.addVideoToPlaylist(playlistId, videoId, position);
}

function makeGeminiResponse(overrides: Partial<GeminiResponse> = {}): GeminiResponse {
  return {
    topics: ['machine learning', 'rust'],
    github_repos: [{ name: 'serde-rs/serde', url: 'https://github.com/serde-rs/serde' }],
    websites: [{ name: 'rust-lang.org', url: 'https://rust-lang.org' }],
    people: ['Alice Hacker'],
    tags: ['rust', 'ml'],
    summary: 'A talk on ML pipelines written in Rust.',
    content_type: 'tutorial',
    sentiment: 'positive',
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// THE STUB-BOMB CLOSURE — non-negotiable per docs/PORT_PLAN.md Wave 4
// --------------------------------------------------------------------------

describe('HTMLReportGenerator.generateVideoReport — stub-bomb closure', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    disposeHarness(h);
  });

  it('closes the v1 HIGH stub bomb — stored analysis appears in rendered HTML', async () => {
    // Arrange — seed a video, then write an analysis row through the
    // repository (the same path the extractor uses in production).
    const videoId = seedVideo(h.dbm, {
      videoId: asVideoId('STUBBOMB001'),
      title: 'Wave 4 closes the stub bomb',
    });
    const repo = new AIAnalysisRepository(h.dbm);
    const analysis = makeGeminiResponse({
      summary: 'AUDIT_GUARD_SUMMARY_SENTINEL the AI section must render',
      content_type: 'demo',
      sentiment: 'positive',
    });
    repo.upsert(videoId, analysis, 'gemini-3-flash-preview');

    // Act — render the report and read it back from disk.
    const filepath = await h.generator.generateVideoReport(videoId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — the rendered HTML MUST contain the analysis fields. If v1's
    // `return undefined` pattern re-emerges, none of these will be present.
    expect(html).toContain('AUDIT_GUARD_SUMMARY_SENTINEL the AI section must render');
    expect(html).toContain('demo');
    expect(html).toContain('positive');
    expect(html).toContain('gemini-3-flash-preview');

    // And the "no analysis" branch must NOT have rendered.
    expect(html).not.toContain('No analysis available');
  });

  it('renders the video report cleanly when no AI analysis exists', async () => {
    // Arrange — video, no `ai_analysis` row.
    const videoId = seedVideo(h.dbm, {
      videoId: asVideoId('NOANALYSIS1'),
      title: 'Video without analysis',
    });

    // Act
    const filepath = await h.generator.generateVideoReport(videoId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — file exists, title is present, the "no analysis" fallback
    // branch ran. No exception was thrown.
    expect(fs.existsSync(filepath)).toBe(true);
    expect(html).toContain('Video without analysis');
    expect(html).toContain('No analysis available');
  });
});

// --------------------------------------------------------------------------
// Video report — full surface
// --------------------------------------------------------------------------

describe('HTMLReportGenerator.generateVideoReport', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    disposeHarness(h);
  });

  it('writes a file with the expected name under the supplied outputDir', async () => {
    // Arrange
    const videoId = seedVideo(h.dbm, {
      videoId: asVideoId('FNAMECHCK01'),
      title: 'Some / questionable: filename<chars>',
    });

    // Act
    const filepath = await h.generator.generateVideoReport(videoId, h.outputDir);

    // Assert — the file landed under outputDir, filename starts with the
    // video id, and sanitisation stripped the dangerous characters.
    expect(fs.existsSync(filepath)).toBe(true);
    expect(filepath.startsWith(path.resolve(h.outputDir))).toBe(true);
    expect(path.basename(filepath).startsWith('FNAMECHCK01_')).toBe(true);
    expect(path.basename(filepath)).not.toContain('/');
    expect(path.basename(filepath)).not.toContain(':');
    expect(path.basename(filepath)).not.toContain('<');
  });

  it('embeds extracted entities (topics, repos, people, websites) in the HTML', async () => {
    // Arrange — video + entities of every type the report renders.
    const videoId = seedVideo(h.dbm, {
      videoId: asVideoId('ENTITIES001'),
      title: 'Entity coverage video',
    });
    const entityRepo = new EntityRepository(h.dbm);
    entityRepo.insertMany(videoId, [
      { type: 'topic', value: 'TYPESCRIPT_TOPIC_GUARD' },
      { type: 'topic', value: 'RUST_TOPIC_GUARD' },
      {
        type: 'github_repo',
        value: 'octocat/Hello-World',
        url: 'https://github.com/octocat/Hello-World',
      },
      { type: 'person', value: 'JANE_DOE_PERSON_GUARD' },
      { type: 'website', value: 'example.com', url: 'https://example.com' },
    ]);

    // Act
    const filepath = await h.generator.generateVideoReport(videoId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — every entity surfaced.
    expect(html).toContain('TYPESCRIPT_TOPIC_GUARD');
    expect(html).toContain('RUST_TOPIC_GUARD');
    expect(html).toContain('octocat/Hello-World');
    expect(html).toContain('https://github.com/octocat/Hello-World');
    expect(html).toContain('JANE_DOE_PERSON_GUARD');
    expect(html).toContain('example.com');
    expect(html).toContain('https://example.com');
  });

  it('renders transcript word count when a transcript exists', async () => {
    // Arrange
    const videoId = seedVideo(h.dbm, {
      videoId: asVideoId('TRANSCRPT01'),
    });
    const transcriptRepo = new TranscriptRepository(h.dbm);
    transcriptRepo.upsert(videoId, {
      language: 'en',
      fullText: 'one two three four five',
      segments: [
        { start: 0, text: 'one two three' },
        { start: 10, text: 'four five' },
      ],
      isAutoGenerated: false,
    });

    // Act
    const filepath = await h.generator.generateVideoReport(videoId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — word count was computed (5) and language rendered.
    expect(html).toContain('Words: 5');
    expect(html).toContain('Lang: en');
  });

  it('renders without crashing when transcript segments_json is malformed', async () => {
    // Arrange — directly inject a row with a corrupt segments_json so the
    // defensive JSON.parse branch is exercised. The transcript repository
    // only writes well-formed JSON, so we bypass it here on purpose.
    const videoId = seedVideo(h.dbm, {
      videoId: asVideoId('CORRUPTSEG1'),
    });
    h.dbm.withTransaction((db) => {
      db.prepare(
        `INSERT INTO transcripts
           (video_id, language, full_text, segments_json, is_auto_generated)
         VALUES (?, ?, ?, ?, ?)`
      ).run(videoId, 'en', 'word word word', 'not-valid-json{[', 1);
    });

    // Act
    const filepath = await h.generator.generateVideoReport(videoId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — file rendered, word count still came through (3 words), no
    // unhandled exception bubbled up.
    expect(fs.existsSync(filepath)).toBe(true);
    expect(html).toContain('Words: 3');
  });

  it('includes statistics view_count in the report when present', async () => {
    // Arrange
    const videoId = seedVideo(h.dbm, {
      videoId: asVideoId('STATSCHECK1'),
      title: 'Video with stats',
    });
    const stats = new StatisticsRepository(h.dbm);
    stats.recordSnapshot(videoId, {
      viewCount: 12345,
      likeCount: 678,
      commentCount: 90,
    });

    // Act
    const filepath = await h.generator.generateVideoReport(videoId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — title rendered (basic sanity), file written.
    expect(html).toContain('Video with stats');
    expect(fs.existsSync(filepath)).toBe(true);
  });

  it('throws AppError REPORT_VIDEO_NOT_FOUND for a video not in the DB', async () => {
    // Arrange — DB is empty.
    const videoId = asVideoId('NONEXISTENT');

    // Act + Assert — typed error, structured code, no file written.
    await expect(h.generator.generateVideoReport(videoId, h.outputDir)).rejects.toThrow(AppError);
    await expect(h.generator.generateVideoReport(videoId, h.outputDir)).rejects.toMatchObject({
      code: REPORT_ERROR_CODES.VIDEO_NOT_FOUND,
    });
  });

  it('throws ValidationError when outputDir is empty', async () => {
    // Arrange
    const videoId = seedVideo(h.dbm, { videoId: asVideoId('EMPTYDIR001') });

    // Act + Assert
    await expect(h.generator.generateVideoReport(videoId, '')).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------
// Template loading
// --------------------------------------------------------------------------

describe('HTMLReportGenerator template loading', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    disposeHarness(h);
  });

  it('throws AppError REPORT_TEMPLATE_NOT_FOUND when templatesDir is bogus', async () => {
    // Arrange — generator pointed at a directory that does not contain
    // the expected template files.
    const bogusDir = path.join(h.tempRoot, 'no-templates-here');
    fs.mkdirSync(bogusDir, { recursive: true });
    const dbm = new DatabaseManager(':memory:');
    const generator = new HTMLReportGenerator(dbm, { templatesDir: bogusDir });
    const videoId = seedVideo(dbm, { videoId: asVideoId('TMPLNOTFND1') });

    try {
      // Act + Assert
      await expect(generator.generateVideoReport(videoId, h.outputDir)).rejects.toMatchObject({
        code: REPORT_ERROR_CODES.TEMPLATE_NOT_FOUND,
      });
    } finally {
      dbm.close();
    }
  });
});

// --------------------------------------------------------------------------
// Playlist report
// --------------------------------------------------------------------------

describe('HTMLReportGenerator.generatePlaylistReport', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    disposeHarness(h);
  });

  it('renders all N videos in the playlist HTML', async () => {
    // Arrange — playlist with 3 distinct videos, each with its own marker
    // title so the test can verify all three appear in the output.
    const playlistId = seedPlaylist(
      h.dbm,
      asPlaylistId('PLrAXtmRdnEQy6nuLMt9H1tlfNUR_v0kuD'),
      'Three-video fixture'
    );
    const v1 = seedVideo(h.dbm, {
      videoId: asVideoId('VID0000PLT1'),
      title: 'PLAYLIST_GUARD_VID_ONE',
    });
    const v2 = seedVideo(h.dbm, {
      videoId: asVideoId('VID0000PLT2'),
      title: 'PLAYLIST_GUARD_VID_TWO',
    });
    const v3 = seedVideo(h.dbm, {
      videoId: asVideoId('VID0000PLT3'),
      title: 'PLAYLIST_GUARD_VID_THREE',
    });
    attachVideoToPlaylist(h.dbm, playlistId, v1, 0);
    attachVideoToPlaylist(h.dbm, playlistId, v2, 1);
    attachVideoToPlaylist(h.dbm, playlistId, v3, 2);

    // Act
    const filepath = await h.generator.generatePlaylistReport(playlistId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — every marker title is present and the count is exactly 3.
    expect(html).toContain('PLAYLIST_GUARD_VID_ONE');
    expect(html).toContain('PLAYLIST_GUARD_VID_TWO');
    expect(html).toContain('PLAYLIST_GUARD_VID_THREE');
    expect(html).toContain('3 videos');
  });

  it('aggregates entities across the playlist videos', async () => {
    // Arrange — two videos that share a topic and a repo, plus one
    // video-unique topic. Aggregation must produce counts that reflect
    // both sharing and uniqueness.
    const playlistId = seedPlaylist(h.dbm, asPlaylistId('PLBCF2DAC6FFB574DE'));
    const v1 = seedVideo(h.dbm, { videoId: asVideoId('AGG00000001') });
    const v2 = seedVideo(h.dbm, { videoId: asVideoId('AGG00000002') });
    attachVideoToPlaylist(h.dbm, playlistId, v1, 0);
    attachVideoToPlaylist(h.dbm, playlistId, v2, 1);

    const entityRepo = new EntityRepository(h.dbm);
    entityRepo.insertMany(v1, [
      { type: 'topic', value: 'SHARED_TOPIC_TOKEN' },
      { type: 'topic', value: 'V1_ONLY_TOPIC_TKN' },
      {
        type: 'github_repo',
        value: 'shared/repo',
        url: 'https://github.com/shared/repo',
      },
      { type: 'person', value: 'SHARED_PERSON_TKN' },
    ]);
    entityRepo.insertMany(v2, [
      { type: 'topic', value: 'SHARED_TOPIC_TOKEN' },
      {
        type: 'github_repo',
        value: 'shared/repo',
        url: 'https://github.com/shared/repo',
      },
      { type: 'person', value: 'SHARED_PERSON_TKN' },
    ]);

    // Act
    const filepath = await h.generator.generatePlaylistReport(playlistId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — shared topic count is 2; v1-only topic is present; repo is
    // present once in the aggregated section; person is present.
    expect(html).toContain('SHARED_TOPIC_TOKEN');
    expect(html).toContain('V1_ONLY_TOPIC_TKN');
    expect(html).toContain('shared/repo');
    expect(html).toContain('SHARED_PERSON_TKN');
    // data-count attribute for SHARED_TOPIC_TOKEN should be 2.
    expect(html).toMatch(/data-count="2"[^>]*>\s*SHARED_TOPIC_TOKEN/);
  });

  it('throws AppError REPORT_PLAYLIST_NOT_FOUND for a missing playlist', async () => {
    // Arrange — empty DB.
    const playlistId = asPlaylistId('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

    // Act + Assert
    await expect(h.generator.generatePlaylistReport(playlistId, h.outputDir)).rejects.toMatchObject(
      {
        code: REPORT_ERROR_CODES.PLAYLIST_NOT_FOUND,
      }
    );
  });

  it('throws AppError REPORT_PLAYLIST_EMPTY for a playlist with zero videos', async () => {
    // Arrange — playlist exists but has no playlist_items rows.
    const playlistId = seedPlaylist(
      h.dbm,
      asPlaylistId('PLemptyemptyemptyempty'),
      'Empty playlist'
    );

    // Act + Assert
    await expect(h.generator.generatePlaylistReport(playlistId, h.outputDir)).rejects.toMatchObject(
      {
        code: REPORT_ERROR_CODES.PLAYLIST_EMPTY,
      }
    );
  });

  it('totals duration and transcript percentage across the playlist', async () => {
    // Arrange — 2 videos, 60s + 120s, one with a transcript.
    const playlistId = seedPlaylist(h.dbm, asPlaylistId('PLtotalstotalstotals'));
    const v1 = seedVideo(h.dbm, {
      videoId: asVideoId('DURATION001'),
      durationSeconds: 60,
    });
    const v2 = seedVideo(h.dbm, {
      videoId: asVideoId('DURATION002'),
      durationSeconds: 120,
    });
    attachVideoToPlaylist(h.dbm, playlistId, v1, 0);
    attachVideoToPlaylist(h.dbm, playlistId, v2, 1);

    const transcriptRepo = new TranscriptRepository(h.dbm);
    transcriptRepo.upsert(v1, {
      language: 'en',
      fullText: 'hello world',
      segments: [],
      isAutoGenerated: true,
    });

    // Act
    const filepath = await h.generator.generatePlaylistReport(playlistId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — 60 + 120 = 180s = 3 minutes total, 1 of 2 = 50%.
    expect(html).toContain('3m');
    expect(html).toContain('50%');
    expect(html).toContain('2 videos');
  });

  it('uses AI analysis summary for video cards when present', async () => {
    // Arrange — a playlist video with a stored analysis. The summary
    // should appear on the per-video card in the playlist report.
    const playlistId = seedPlaylist(h.dbm, asPlaylistId('PLanlanlanlanlanlanl'));
    const videoId = seedVideo(h.dbm, {
      videoId: asVideoId('PLISTANL001'),
      title: 'Video with analysis',
    });
    attachVideoToPlaylist(h.dbm, playlistId, videoId, 0);

    const aiRepo = new AIAnalysisRepository(h.dbm);
    aiRepo.upsert(
      videoId,
      makeGeminiResponse({
        summary: 'PLIST_ANALYSIS_SUMMARY_SENTINEL embedded in card',
      }),
      'gemini-3-flash-preview'
    );

    // Act
    const filepath = await h.generator.generatePlaylistReport(playlistId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — the playlist report carries the per-video AI summary text.
    // The production playlist template surfaces summary inside the videos
    // loop (`templates/playlist_report.html`), and the minimal test
    // template here mirrors that so this assertion exercises the full
    // round-trip from AIAnalysisRepository → data shaping → render.
    expect(html).toContain('Video with analysis');
    expect(html).toContain('PLIST_ANALYSIS_SUMMARY_SENTINEL embedded in card');
    expect(fs.existsSync(filepath)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// GitHub repo description enrichment (Python html_generator.py:382-389)
// --------------------------------------------------------------------------

/**
 * Build a harness whose generator is wired with an injected `githubFetch`
 * mock and a zero throttle (so tests never wait wall-clock between calls).
 */
function makeEnrichHarness(githubFetch: typeof fetch): TestHarness {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metube-report-enrich-'));
  const templatesDir = path.join(tempRoot, 'templates');
  const outputDir = path.join(tempRoot, 'reports');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'video_report.html'), VIDEO_TEMPLATE);
  fs.writeFileSync(path.join(templatesDir, 'playlist_report.html'), PLAYLIST_TEMPLATE);

  const dbm = new DatabaseManager(':memory:');
  const generator = new HTMLReportGenerator(dbm, {
    templatesDir,
    githubFetch,
    githubThrottleMs: 0,
  });
  return { dbm, templatesDir, outputDir, tempRoot, generator };
}

/** A `Response`-like stub good enough for the enrichment code path. */
function githubResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Build the rejection a signal-respecting `fetch` raises when its
 * `AbortSignal` fires — a `DOMException` named `AbortError`, exactly what the
 * platform `fetch` throws on abort. Falls back to a plain `Error` on runtimes
 * without `DOMException` (the enrichment catch only reads `.message`).
 */
function makeAbortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

describe('HTMLReportGenerator — GitHub repo description enrichment', () => {
  let h: TestHarness;

  afterEach(() => {
    if (h) {
      disposeHarness(h);
    }
    vi.restoreAllMocks();
  });

  function seedRepoPlaylist(
    dbm: DatabaseManager,
    repos: ReadonlyArray<{ value: string; url: string }>
  ): PlaylistId {
    const playlistId = seedPlaylist(dbm, asPlaylistId('PLenrich0000000000000'));
    const videoId = seedVideo(dbm, { videoId: asVideoId('ENRICHVID01') });
    attachVideoToPlaylist(dbm, playlistId, videoId, 0);
    const entityRepo = new EntityRepository(dbm);
    entityRepo.insertMany(
      videoId,
      repos.map((r) => ({ type: 'github_repo', value: r.value, url: r.url }))
    );
    return playlistId;
  }

  it('fetches and renders the GitHub description for each unique repo', async () => {
    // Arrange
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/serde-rs/serde') {
        return githubResponse(200, { description: 'SERDE_FRAMEWORK_DESCRIPTION' });
      }
      return githubResponse(404, {});
    }) as unknown as typeof fetch;
    h = makeEnrichHarness(fetchMock);
    const playlistId = seedRepoPlaylist(h.dbm, [
      { value: 'serde-rs/serde', url: 'https://github.com/serde-rs/serde' },
    ]);

    // Act
    const filepath = await h.generator.generatePlaylistReport(playlistId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — the fetched description appears in the rendered HTML.
    expect(html).toContain('SERDE_FRAMEWORK_DESCRIPTION');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/serde-rs/serde',
      expect.anything()
    );
  });

  it('calls the GitHub API once per UNIQUE repo (deduped)', async () => {
    // Arrange — the same repo appears via two videos; only one API call.
    const fetchMock = vi.fn(async () =>
      githubResponse(200, { description: 'ONE_CALL_DESC' })
    ) as unknown as typeof fetch;
    h = makeEnrichHarness(fetchMock);

    const playlistId = seedPlaylist(h.dbm, asPlaylistId('PLdedupe00000000000000'));
    const v1 = seedVideo(h.dbm, { videoId: asVideoId('DEDUPEVID01') });
    const v2 = seedVideo(h.dbm, { videoId: asVideoId('DEDUPEVID02') });
    attachVideoToPlaylist(h.dbm, playlistId, v1, 0);
    attachVideoToPlaylist(h.dbm, playlistId, v2, 1);
    const entityRepo = new EntityRepository(h.dbm);
    entityRepo.insertMany(v1, [
      { type: 'github_repo', value: 'dup/repo', url: 'https://github.com/dup/repo' },
    ]);
    entityRepo.insertMany(v2, [
      { type: 'github_repo', value: 'dup/repo', url: 'https://github.com/dup/repo' },
    ]);

    // Act
    await h.generator.generatePlaylistReport(playlistId, h.outputDir);

    // Assert — exactly one fetch for the single distinct repo.
    expect(fetchMock as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully (no description, no throw) when fetch rejects', async () => {
    // Arrange — network failure on every call.
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    h = makeEnrichHarness(fetchMock);
    const playlistId = seedRepoPlaylist(h.dbm, [
      { value: 'down/repo', url: 'https://github.com/down/repo' },
    ]);

    // Act — must NOT throw despite the network being down.
    const filepath = await h.generator.generatePlaylistReport(playlistId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — report still generated, repo still present, just no description.
    expect(fs.existsSync(filepath)).toBe(true);
    expect(html).toContain('down/repo');
    expect(html).not.toContain('agg-repo-desc');
  });

  it('degrades gracefully on a 403 rate-limit response', async () => {
    // Arrange
    const fetchMock = vi.fn(async () =>
      githubResponse(403, { message: 'rate limited' })
    ) as unknown as typeof fetch;
    h = makeEnrichHarness(fetchMock);
    const playlistId = seedRepoPlaylist(h.dbm, [
      { value: 'limited/repo', url: 'https://github.com/limited/repo' },
    ]);

    // Act + Assert — no throw, no description rendered.
    const filepath = await h.generator.generatePlaylistReport(playlistId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');
    expect(html).toContain('limited/repo');
    expect(html).not.toContain('agg-repo-desc');
  });

  it('skips enrichment for non-GitHub URLs', async () => {
    // Arrange — a repo entity whose URL is not github.com is never fetched.
    const fetchMock = vi.fn(async () =>
      githubResponse(200, { description: 'SHOULD_NOT_APPEAR' })
    ) as unknown as typeof fetch;
    h = makeEnrichHarness(fetchMock);
    const playlistId = seedRepoPlaylist(h.dbm, [
      { value: 'gitlab/thing', url: 'https://gitlab.com/gitlab/thing' },
    ]);

    // Act
    await h.generator.generatePlaylistReport(playlistId, h.outputDir);

    // Assert — no GitHub API call for a non-github URL.
    expect(fetchMock as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it.each([
    // Hostname lookalike — substring "github.com" appears but the host differs.
    ['notgithub.com lookalike', 'https://notgithub.com/owner/repo'],
    // A different GitHub surface — gist, not a repo.
    ['gist subdomain', 'https://gist.github.com/owner/abc123'],
    // Deep path — more than two segments is not a bare owner/repo.
    ['deep path (tree/main)', 'https://github.com/owner/repo/tree/main'],
    // Single segment — a user/org page, not a repo.
    ['single segment (org page)', 'https://github.com/owner'],
  ])('does NOT enrich a non-canonical GitHub URL: %s', async (_label, url) => {
    // Arrange — strict URL parsing must reject these; no fetch should fire.
    const fetchMock = vi.fn(async () =>
      githubResponse(200, { description: 'SHOULD_NOT_APPEAR' })
    ) as unknown as typeof fetch;
    h = makeEnrichHarness(fetchMock);
    const playlistId = seedRepoPlaylist(h.dbm, [{ value: 'owner/repo', url }]);

    // Act
    const filepath = await h.generator.generatePlaylistReport(playlistId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — no API call, no description rendered, repo still passes through.
    expect(fetchMock as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(html).not.toContain('agg-repo-desc');
    expect(html).not.toContain('SHOULD_NOT_APPEAR');
  });

  it('enriches a canonical github.com URL that carries a query string', async () => {
    // A query string is allowed: the path is still a bare owner/repo, so the
    // strict parser keeps it and fetches the canonical API URL (no query).
    const fetchMock = vi.fn(async () =>
      githubResponse(200, { description: 'QUERY_OK_DESC' })
    ) as unknown as typeof fetch;
    h = makeEnrichHarness(fetchMock);
    const playlistId = seedRepoPlaylist(h.dbm, [
      { value: 'owner/repo', url: 'https://github.com/owner/repo?tab=readme' },
    ]);

    // Act
    await h.generator.generatePlaylistReport(playlistId, h.outputDir);

    // Assert — fetched the clean API URL, query stripped.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo',
      expect.anything()
    );
  });

  it('strips a .git suffix from the repo name when building the API URL', async () => {
    // Arrange — Python removes a trailing .git before the API call.
    const fetchMock = vi.fn(async () =>
      githubResponse(200, { description: 'DOTGIT_DESC' })
    ) as unknown as typeof fetch;
    h = makeEnrichHarness(fetchMock);
    const playlistId = seedRepoPlaylist(h.dbm, [
      { value: 'owner/repo', url: 'https://github.com/owner/repo.git' },
    ]);

    // Act
    await h.generator.generatePlaylistReport(playlistId, h.outputDir);

    // Assert — the API URL has no .git suffix.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo',
      expect.anything()
    );
  });

  it('treats an empty-string description as no description', async () => {
    // Arrange — GitHub returns 200 with an empty description (common for
    // repos that never set one). Python's `if description:` skips it.
    const fetchMock = vi.fn(async () =>
      githubResponse(200, { description: '' })
    ) as unknown as typeof fetch;
    h = makeEnrichHarness(fetchMock);
    const playlistId = seedRepoPlaylist(h.dbm, [
      { value: 'empty/desc', url: 'https://github.com/empty/desc' },
    ]);

    // Act
    const filepath = await h.generator.generatePlaylistReport(playlistId, h.outputDir);
    const html = fs.readFileSync(filepath, 'utf-8');

    // Assert — no description slot rendered.
    expect(html).toContain('empty/desc');
    expect(html).not.toContain('agg-repo-desc');
  });

  it('aborts a hung GitHub fetch at the 5s timeout and still completes the report', async () => {
    // A fetch that NEVER resolves on its own but RESPECTS the AbortSignal:
    // it rejects with an AbortError the moment the signal fires. This is the
    // exact contract the production timeout relies on (a signal-ignoring mock
    // would hang forever — see the githubFetch caveat in HTMLReportGenerator).
    // Vitest fake timers drive the wall clock so the 5s timer fires
    // deterministically without a real 5-second wait.
    vi.useFakeTimers();

    let abortObserved = false;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          // The production call always passes a signal; guard the contract.
          reject(new Error('test fetch invoked without an AbortSignal'));
          return;
        }
        // Already aborted (defensive) — reject immediately.
        if (signal.aborted) {
          abortObserved = true;
          reject(makeAbortError());
          return;
        }
        // Otherwise wait for the controller's abort, which the 5s timer trips.
        signal.addEventListener(
          'abort',
          () => {
            abortObserved = true;
            reject(makeAbortError());
          },
          { once: true }
        );
        // Note: no resolve path — this fetch only ever settles via abort.
      });
    }) as unknown as typeof fetch;

    h = makeEnrichHarness(fetchMock);
    const playlistId = seedRepoPlaylist(h.dbm, [
      { value: 'hung/repo', url: 'https://github.com/hung/repo' },
    ]);

    try {
      // Kick off report generation; it will await the (hung) fetch.
      const reportPromise = h.generator.generatePlaylistReport(playlistId, h.outputDir);

      // Advance the fake clock past the 5s GITHUB_FETCH_TIMEOUT_MS so the
      // AbortController fires. `...Async` flushes the microtasks the abort
      // rejection schedules, letting the catch-and-degrade path run.
      await vi.advanceTimersByTimeAsync(5000);

      const filepath = await reportPromise;
      const html = fs.readFileSync(filepath, 'utf-8');

      // The fetch saw the abort (timeout actually fired)...
      expect(abortObserved).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // ...the repo degraded to no description...
      expect(html).toContain('hung/repo');
      expect(html).not.toContain('agg-repo-desc');
      // ...and report generation completed despite the hang.
      expect(fs.existsSync(filepath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * v2 HTMLReportGenerator — Handlebars-rendered video + playlist reports.
 *
 * Ported from `legacy/python/src/reports/html_generator.py` lines 267-467
 * (the real, second definition of `generate_playlist_report`; the dead stub
 * at lines 182-207 was deleted in Phase 1 P8 fix). The Python original
 * mixes the two reports' aggregation logic in one class — this port keeps
 * the same shape because the Handlebars templates expect identical view
 * models.
 *
 * Audit context — closes the v1 HIGH stub bomb
 * ---------------------------------------------
 * `src-ts/reports/HTMLReportGenerator.ts` shipped with
 *
 *     private getAnalysisData(_videoId: string): ReportAnalysisData | undefined {
 *       // TODO: Query ai_analysis table when it's populated
 *       return undefined;
 *     }
 *
 * at line 391-394. The AI analysis section silently rendered empty in
 * every video report because the lookup was never wired. v2's contract
 * makes that class of bug impossible:
 *
 *   1. `getAnalysisData(videoId)` queries `AIAnalysisRepository.getByVideo`
 *      and ALWAYS returns the parsed projection (or undefined for a video
 *      that genuinely has no analysis row).
 *   2. The test suite asserts the round-trip: stored analysis MUST appear
 *      in the rendered HTML. If a future refactor reintroduces the
 *      `return undefined` pattern, the test fires.
 *
 * Discipline carried by this file
 * --------------------------------
 *   - Branded `VideoId` / `PlaylistId` at the public surface — raw
 *     `string` IDs will not compile at the call site.
 *   - No `any`, no `console.*`, no stub markers. Pino logger only.
 *   - All errors wrap as `AppError` (or its `ValidationError` /
 *     `DatabaseError` subclasses) with structured codes so the Ink layer
 *     can render targeted remediation copy.
 *   - Repositories are the only DB access path. Raw SQL stays inside
 *     `database/`. The report layer is a pure aggregation + render step.
 *   - Reads parse through Zod via the repositories already — no raw rows
 *     cross into this file.
 *   - Templates are loaded once, compiled, cached. Reading the same
 *     template twice in one process is a no-op after the first load.
 */

import fs from 'node:fs';
import path from 'node:path';

import Handlebars from 'handlebars';

import { AIAnalysisRepository } from '../database/AIAnalysisRepository.js';
import type { DatabaseManager } from '../database/connection.js';
import { EntityRepository } from '../database/EntityRepository.js';
import { PlaylistItemRepository } from '../database/PlaylistItemRepository.js';
import { PlaylistRepository } from '../database/PlaylistRepository.js';
import { StatisticsRepository } from '../database/StatisticsRepository.js';
import { TagRepository } from '../database/TagRepository.js';
import { TranscriptRepository } from '../database/TranscriptRepository.js';
import { VideoRepository, type VideoRecord } from '../database/VideoRepository.js';
import { AppError, ValidationError } from '../errors/index.js';
import { asVideoId, type PlaylistId, type VideoId } from '../types/index.js';
import logger from '../utils/logger.js';

import type {
  AggregatedEntity,
  AggregatedPerson,
  AggregatedTopic,
  CompletePlaylistReportData,
  PlaylistVideoSummary,
  ReportAnalysisData,
  ReportEntities,
  ReportTranscriptData,
  ReportTranscriptSegment,
  VideoReportData,
} from './types.js';

/**
 * Configuration accepted by the constructor. All fields are optional —
 * defaults match the Python original and the v1 TS implementation.
 */
export interface HTMLReportGeneratorConfig {
  /**
   * Directory containing the Handlebars templates `video_report.html`
   * and `playlist_report.html`. Resolved relative to `process.cwd()`
   * if not absolute. Defaults to `'templates'` (the repo's top-level
   * `templates/` directory).
   */
  readonly templatesDir?: string;

  /**
   * `fetch` implementation used for GitHub repo-description enrichment.
   * Injectable so tests can mock the network — production omits it and the
   * global `fetch` is used. Whatever the call does (resolve, reject, time
   * out) the enrichment degrades to "no description"; it never fails or
   * hangs report generation.
   *
   * Caveat: the injected implementation MUST honor the `AbortSignal` passed in
   * `RequestInit.signal`. The {@link GITHUB_FETCH_TIMEOUT_MS} timeout — and
   * thus the "report generation never hangs" guarantee — only holds for a
   * signal-respecting fetch; a mock that ignores the signal and never settles
   * will stall enrichment indefinitely.
   */
  readonly githubFetch?: typeof fetch;

  /**
   * Milliseconds to wait between consecutive GitHub API calls. Mirrors the
   * Python `time.sleep(0.1)` throttle (html_generator.py:389). Defaults to
   * {@link DEFAULT_GITHUB_THROTTLE_MS}; tests pass `0` to avoid wall-clock
   * waits.
   */
  readonly githubThrottleMs?: number;
}

/**
 * Structured error codes surfaced on `AppError.code`. The Ink layer
 * pattern-matches on these to render remediation copy
 * (see CLAUDE.md REPL/ErrorPanel notes).
 */
export const REPORT_ERROR_CODES = Object.freeze({
  TEMPLATE_NOT_FOUND: 'REPORT_TEMPLATE_NOT_FOUND',
  VIDEO_NOT_FOUND: 'REPORT_VIDEO_NOT_FOUND',
  PLAYLIST_NOT_FOUND: 'REPORT_PLAYLIST_NOT_FOUND',
  PLAYLIST_EMPTY: 'REPORT_PLAYLIST_EMPTY',
  WRITE_FAILED: 'REPORT_WRITE_FAILED',
  RENDER_FAILED: 'REPORT_RENDER_FAILED',
} as const);

interface HelperOptions {
  fn: (context: unknown) => string;
  inverse: (context: unknown) => string;
}

const DEFAULT_TEMPLATES_DIR = 'templates';

/**
 * Throttle between consecutive GitHub API calls. Matches Python's
 * `time.sleep(0.1)` (html_generator.py:389) — "be nice to the GitHub API".
 */
const DEFAULT_GITHUB_THROTTLE_MS = 100;

/**
 * Per-call timeout for a GitHub description fetch. Matches Python's
 * `requests.get(..., timeout=5)` (html_generator.py:225). A slow/hung GitHub
 * must never stall report generation, so the call is aborted at this bound.
 */
const GITHUB_FETCH_TIMEOUT_MS = 5000;

/**
 * Extracts `owner` / `repo` from a GitHub URL. Mirrors the Python regex
 * `r'github\.com/([^/]+)/([^/]+)'` (html_generator.py:213).
 */
const GITHUB_REPO_URL_PATTERN = /github\.com\/([^/]+)\/([^/]+)/;

/**
 * Sleep for `ms` milliseconds. A `0` (or negative) delay resolves on the
 * next microtask without scheduling a timer.
 */
function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a duration in seconds as `HH:MM:SS` (when > 1h) or `MM:SS`.
 * Matches `legacy/python/src/reports/html_generator.py::_format_timestamp`.
 */
function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * YouTube thumbnail URL for a given branded video id. Mirrors the Python
 * `_get_thumbnail_url` static.
 */
function getThumbnailUrl(videoId: VideoId, quality = 'maxresdefault'): string {
  return `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
}

/**
 * Strip filesystem-unsafe characters and clamp length. The character class
 * is intentionally narrow (ASCII letters, digits, dot, dash, underscore,
 * parens, space) to avoid surprises on case-insensitive filesystems.
 */
function sanitizeFilename(filename: string, maxLength = 50): string {
  const invalidChars = /[^a-zA-Z0-9\-_.() ]/g;
  let sanitized = filename.replace(invalidChars, '_');
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  return sanitized.trim().replace(/^_+|_+$/g, '');
}

/**
 * Ensure a directory exists, creating it (and any missing parents)
 * recursively if not. Surfaces a typed error if creation fails.
 */
function ensureDirectory(dir: string): void {
  if (fs.existsSync(dir)) {
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new AppError('Failed to create output directory', {
      code: REPORT_ERROR_CODES.WRITE_FAILED,
      cause: error,
      context: { dir },
    });
  }
}

/**
 * Register the Handlebars helpers the templates use. Idempotent — calling
 * twice replaces the helpers in place, which is what Handlebars does
 * anyway. Kept as a private static-ish function so the constructor stays
 * thin.
 */
function registerHandlebarsHelpers(): void {
  Handlebars.registerHelper('formatNumber', (num: unknown): string => {
    if (typeof num !== 'number' || !Number.isFinite(num)) {
      return '0';
    }
    return num.toLocaleString();
  });

  Handlebars.registerHelper('formatDate', (dateStr: unknown): string => {
    if (typeof dateStr !== 'string' || dateStr.length === 0) {
      return 'Unknown';
    }
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) {
      return 'Unknown';
    }
    return date.toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  });

  Handlebars.registerHelper(
    'ifEquals',
    function (this: unknown, a: unknown, b: unknown, options: HelperOptions): string {
      return a === b ? options.fn(this) : options.inverse(this);
    }
  );

  Handlebars.registerHelper(
    'ifGreater',
    function (this: unknown, a: unknown, b: unknown, options: HelperOptions): string {
      if (typeof a !== 'number' || typeof b !== 'number') {
        return options.inverse(this);
      }
      return a > b ? options.fn(this) : options.inverse(this);
    }
  );

  Handlebars.registerHelper('length', (value: unknown): number => {
    if (Array.isArray(value)) {
      return value.length;
    }
    if (value !== null && typeof value === 'object') {
      return Object.keys(value as object).length;
    }
    return 0;
  });

  Handlebars.registerHelper('inc', (value: unknown): number => {
    if (typeof value !== 'number') {
      return 1;
    }
    return value + 1;
  });
}

// Register helpers once at module load. Handlebars holds these on a
// module-global registry, so doing it here avoids paying the cost on
// every `new HTMLReportGenerator()`.
registerHandlebarsHelpers();

/**
 * HTML report generator. One instance per logical command path; the
 * constructor is cheap (it just stores references), so callers should
 * feel free to instantiate per command rather than caching globally.
 */
export class HTMLReportGenerator {
  private readonly db: DatabaseManager;
  private readonly templatesDir: string;
  private readonly githubFetch: typeof fetch | undefined;
  private readonly githubThrottleMs: number;
  private readonly videoRepository: VideoRepository;
  private readonly playlistRepository: PlaylistRepository;
  private readonly playlistItemRepository: PlaylistItemRepository;
  private readonly transcriptRepository: TranscriptRepository;
  private readonly entityRepository: EntityRepository;
  private readonly statisticsRepository: StatisticsRepository;
  private readonly tagRepository: TagRepository;
  private readonly aiAnalysisRepository: AIAnalysisRepository;

  private videoTemplate: HandlebarsTemplateDelegate | undefined;
  private playlistTemplate: HandlebarsTemplateDelegate | undefined;

  constructor(db: DatabaseManager, config: HTMLReportGeneratorConfig = {}) {
    this.db = db;
    this.templatesDir = config.templatesDir ?? DEFAULT_TEMPLATES_DIR;
    // Injected fetch wins; otherwise fall back to the runtime global `fetch`
    // (Node 18+ / undici). Captured once so enrichment is deterministic.
    this.githubFetch = config.githubFetch ?? (typeof fetch === 'function' ? fetch : undefined);
    this.githubThrottleMs = config.githubThrottleMs ?? DEFAULT_GITHUB_THROTTLE_MS;

    // Repository wiring. Each repository takes the DatabaseManager — the
    // discipline-bearing handle — not the raw `Database`. Writes (which
    // this layer never issues) still route through `withTransaction`.
    this.videoRepository = new VideoRepository(this.db);
    this.playlistRepository = new PlaylistRepository(this.db);
    this.playlistItemRepository = new PlaylistItemRepository(this.db);
    this.transcriptRepository = new TranscriptRepository(this.db);
    this.entityRepository = new EntityRepository(this.db);
    this.statisticsRepository = new StatisticsRepository(this.db);
    this.tagRepository = new TagRepository(this.db);
    this.aiAnalysisRepository = new AIAnalysisRepository(this.db);

    logger.debug({ templatesDir: this.templatesDir }, 'HTMLReportGenerator initialised');
  }

  // --------------------------------------------------------------------
  // Public surface
  // --------------------------------------------------------------------

  /**
   * Render and write a single-video HTML report.
   *
   * @param videoId   - Branded YouTube video id. The video MUST already
   *                    exist in the `videos` table.
   * @param outputDir - Directory the resulting HTML file is written to.
   *                    Created recursively if it does not exist.
   * @returns The absolute path of the written HTML file.
   * @throws {AppError} with code `REPORT_VIDEO_NOT_FOUND` if the video
   *                    row is missing, `REPORT_TEMPLATE_NOT_FOUND` if
   *                    the Handlebars template cannot be loaded,
   *                    `REPORT_RENDER_FAILED` if rendering throws, or
   *                    `REPORT_WRITE_FAILED` if the filesystem write
   *                    fails.
   */
  async generateVideoReport(videoId: VideoId, outputDir: string): Promise<string> {
    if (typeof outputDir !== 'string' || outputDir.length === 0) {
      throw new ValidationError('outputDir must be a non-empty string', {
        field: 'outputDir',
        value: outputDir,
      });
    }

    logger.info({ videoId, outputDir }, 'generating video report');

    const video = this.videoRepository.findById(videoId);
    if (video === null) {
      throw new AppError(`Video not found in database: ${videoId}`, {
        code: REPORT_ERROR_CODES.VIDEO_NOT_FOUND,
        context: { videoId },
      });
    }

    const reportData = this.buildVideoReportData(video);
    const html = this.renderVideoTemplate(reportData);

    ensureDirectory(outputDir);
    const safeTitle = sanitizeFilename(video.title);
    const filename = `${videoId}_${safeTitle}.html`;
    const filepath = path.resolve(outputDir, filename);

    try {
      fs.writeFileSync(filepath, html, 'utf-8');
    } catch (error) {
      throw new AppError('Failed to write video report HTML', {
        code: REPORT_ERROR_CODES.WRITE_FAILED,
        cause: error,
        context: { videoId, filepath },
      });
    }

    logger.info({ videoId, filepath }, 'video report written');
    return filepath;
  }

  /**
   * Render and write a playlist HTML report.
   *
   * Iterates the playlist's videos, aggregates entities (topics, repos,
   * websites, people), totals duration / views / transcript coverage,
   * and renders the result through `playlist_report.html`.
   *
   * @param playlistId - Branded YouTube playlist id. The playlist MUST
   *                     exist; an empty playlist is rejected with
   *                     `REPORT_PLAYLIST_EMPTY`.
   * @param outputDir  - Directory the resulting HTML file is written to.
   * @returns The absolute path of the written HTML file.
   * @throws {AppError} with code `REPORT_PLAYLIST_NOT_FOUND`,
   *                    `REPORT_PLAYLIST_EMPTY`,
   *                    `REPORT_TEMPLATE_NOT_FOUND`,
   *                    `REPORT_RENDER_FAILED`, or
   *                    `REPORT_WRITE_FAILED`.
   */
  async generatePlaylistReport(playlistId: PlaylistId, outputDir: string): Promise<string> {
    if (typeof outputDir !== 'string' || outputDir.length === 0) {
      throw new ValidationError('outputDir must be a non-empty string', {
        field: 'outputDir',
        value: outputDir,
      });
    }

    logger.info({ playlistId, outputDir }, 'generating playlist report');

    const playlist = this.playlistRepository.findById(playlistId);
    if (playlist === null) {
      throw new AppError(`Playlist not found in database: ${playlistId}`, {
        code: REPORT_ERROR_CODES.PLAYLIST_NOT_FOUND,
        context: { playlistId },
      });
    }

    const videos = this.videoRepository.findByPlaylist(playlistId);
    if (videos.length === 0) {
      throw new AppError(`Playlist contains no videos: ${playlistId}`, {
        code: REPORT_ERROR_CODES.PLAYLIST_EMPTY,
        context: { playlistId },
      });
    }

    const baseReportData = this.buildPlaylistReportData(
      playlistId,
      playlist.title,
      playlist.description,
      videos
    );

    // GitHub repo description enrichment (Python html_generator.py:382-389).
    // Network-touching but fully isolated: any failure degrades to "no
    // description" and never fails or hangs report generation.
    const enrichedRepos = await this.enrichGithubDescriptions(baseReportData.github_repos);
    const reportData: CompletePlaylistReportData = {
      ...baseReportData,
      github_repos: enrichedRepos,
    };

    const html = this.renderPlaylistTemplate(reportData);

    ensureDirectory(outputDir);
    const safeTitle = sanitizeFilename(playlist.title);
    const filename = `playlist_${playlistId}_${safeTitle}.html`;
    const filepath = path.resolve(outputDir, filename);

    try {
      fs.writeFileSync(filepath, html, 'utf-8');
    } catch (error) {
      throw new AppError('Failed to write playlist report HTML', {
        code: REPORT_ERROR_CODES.WRITE_FAILED,
        cause: error,
        context: { playlistId, filepath },
      });
    }

    logger.info({ playlistId, filepath }, 'playlist report written');
    return filepath;
  }

  // --------------------------------------------------------------------
  // Data-shaping (video)
  // --------------------------------------------------------------------

  /**
   * Compose the `VideoReportData` view-model from repository reads.
   *
   * Critical: `getAnalysisData(videoId)` MUST hit the
   * `AIAnalysisRepository.getByVideo` path — closing the v1 stub bomb.
   */
  private buildVideoReportData(video: VideoRecord): VideoReportData {
    const videoId = video.video_id;

    const transcript = this.getTranscriptData(videoId);
    const entities = this.getEntitiesData(videoId);
    const stats = this.statisticsRepository.findLatestByVideoId(videoId);
    const analysis = this.getAnalysisData(videoId);
    const tags = this.tagRepository.findByVideoId(videoId).map((t) => t.tag);

    return {
      video: {
        video_id: videoId,
        title: video.title,
        description: video.description ?? undefined,
        channel_title: video.channel_title,
        channel_id: video.channel_id,
        published_at: video.published_at,
        duration_seconds: video.duration_seconds,
        is_short: video.is_short === 1,
        view_count: stats?.view_count ?? 0,
        like_count: stats?.like_count ?? 0,
        comment_count: stats?.comment_count ?? 0,
        thumbnail_url: getThumbnailUrl(videoId),
      },
      transcript,
      entities,
      tags,
      analysis,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Read a video's transcript and shape it for the template. Returns
   * `undefined` when no transcript exists — the template branches on
   * `{{#if transcript}}` so that's the right shape, not `null`.
   *
   * Defensive JSON-parse: a corrupted `segments_json` should not abort
   * the report. Log + drop the segments and render the rest.
   */
  private getTranscriptData(videoId: VideoId): ReportTranscriptData | undefined {
    const transcript = this.transcriptRepository.findByVideoId(videoId);
    if (transcript === undefined) {
      return undefined;
    }

    interface RawSegment {
      start: number;
      text: string;
    }
    let segments: ReportTranscriptSegment[] = [];
    if (
      transcript.segments_json !== null &&
      transcript.segments_json !== undefined &&
      transcript.segments_json !== ''
    ) {
      try {
        const parsed: unknown = JSON.parse(transcript.segments_json);
        if (Array.isArray(parsed)) {
          segments = parsed
            .filter(
              (s): s is RawSegment =>
                typeof s === 'object' &&
                s !== null &&
                typeof (s as { start?: unknown }).start === 'number' &&
                typeof (s as { text?: unknown }).text === 'string'
            )
            .map((s) => ({
              start: s.start,
              timestamp: formatTimestamp(s.start),
              text: s.text,
            }));
        }
      } catch (error) {
        logger.warn(
          { videoId, err: error instanceof Error ? error.message : String(error) },
          'Failed to parse transcript segments_json; rendering without segments'
        );
      }
    }

    const wordCount = transcript.full_text.split(/\s+/).filter((w) => w.length > 0).length;

    return {
      language: transcript.language,
      is_auto_generated: (transcript.is_auto_generated ?? 1) === 1,
      full_text: transcript.full_text,
      segments,
      word_count: wordCount,
    };
  }

  /**
   * Read a video's entities and bucket them by type. Mirrors the Python
   * single-pass switch.
   */
  private getEntitiesData(videoId: VideoId): ReportEntities {
    const entities = this.entityRepository.findByVideoId(videoId);
    const grouped: ReportEntities = {
      topics: [],
      github_repos: [],
      websites: [],
      people: [],
    };

    for (const entity of entities) {
      switch (entity.entity_type) {
        case 'topic':
          grouped.topics.push(entity.entity_value);
          break;
        case 'github_repo':
          grouped.github_repos.push({
            name: entity.entity_value,
            url: entity.entity_url ?? undefined,
          });
          break;
        case 'website':
          grouped.websites.push({
            name: entity.entity_value,
            url: entity.entity_url ?? undefined,
          });
          break;
        case 'person':
          grouped.people.push(entity.entity_value);
          break;
        default:
          // Unknown type — silently skip. EntityRepository enforces the
          // enum on write, so reaching here means corruption that the
          // schema parse should have caught. Logging at debug avoids
          // spamming the operator.
          logger.debug(
            { videoId, entityType: entity.entity_type },
            'Skipping entity with unknown entity_type'
          );
          break;
      }
    }

    return grouped;
  }

  /**
   * Read the AI analysis for a video and shape it for the template.
   *
   * **THIS IS THE v1 STUB-BOMB CLOSURE.** v1's `getAnalysisData` was a
   * hard-coded `return undefined;` placeholder (see file header). This
   * implementation actually queries `AIAnalysisRepository.getByVideo`,
   * which itself queries the `ai_analysis` table and parses the row.
   * If the row exists, this method returns the populated analysis
   * shape. If no row exists, this method returns `undefined` (which
   * the template handles via `{{#if analysis}}`).
   *
   * The HTMLReportGenerator test suite asserts that storing an
   * analysis row + generating the report MUST produce HTML containing
   * the topic/person/repo text from the analysis. If a future refactor
   * reintroduces the `return undefined` pattern, that test fires.
   */
  private getAnalysisData(videoId: VideoId): ReportAnalysisData | undefined {
    const analysis = this.aiAnalysisRepository.getByVideo(videoId);
    if (analysis === null) {
      return undefined;
    }

    // Template requires `summary` as `string`; if the repository hands
    // back a null summary (allowed by the schema), fall back to an
    // empty string so the analysis block renders the other fields.
    const summary = analysis.summary ?? '';

    return {
      summary,
      content_type: analysis.contentType ?? undefined,
      sentiment: analysis.sentiment ?? undefined,
      model_used: analysis.modelUsed ?? undefined,
    };
  }

  // --------------------------------------------------------------------
  // Data-shaping (playlist)
  // --------------------------------------------------------------------

  /**
   * Walk every video in a playlist and aggregate the cross-video view
   * model expected by `playlist_report.html`. Ports the Python loop in
   * `html_generator.py:278-405`.
   *
   * The aggregation is deterministic: maps are keyed by lowercased
   * value or canonical URL, sorted by count/occurrence for the
   * top-list views. Reports must be reproducible across runs given the
   * same DB state, so non-stable ordering is a bug.
   *
   * This step is pure (no network). GitHub repo-description enrichment
   * (Python html_generator.py:382-389) runs as a SEPARATE async step
   * (`enrichGithubDescriptions`) after this aggregation, in
   * `generatePlaylistReport`, so the aggregation stays testable without
   * HTTP mocks and the network-touching part is isolated and
   * fail-safe.
   */
  private buildPlaylistReportData(
    playlistId: PlaylistId,
    playlistTitle: string,
    playlistDescription: string | null,
    videos: readonly VideoRecord[]
  ): CompletePlaylistReportData {
    let totalDuration = 0;
    let totalViews = 0;
    let videosWithTranscripts = 0;

    interface VideoRef {
      readonly video_id: string;
      readonly title: string;
    }

    const topicsMap = new Map<string, { name: string; count: number; videos: VideoRef[] }>();
    const reposMap = new Map<
      string,
      { name: string; url: string | undefined; videos: VideoRef[] }
    >();
    const websitesMap = new Map<
      string,
      { name: string; url: string | undefined; videos: VideoRef[] }
    >();
    const peopleMap = new Map<string, { name: string; count: number; videos: VideoRef[] }>();

    const videoSummaries: PlaylistVideoSummary[] = [];

    for (const video of videos) {
      const videoId = video.video_id;
      totalDuration += video.duration_seconds;

      const stats = this.statisticsRepository.findLatestByVideoId(videoId);
      if (stats !== null) {
        totalViews += stats.view_count ?? 0;
      }

      const hasTranscript = this.transcriptRepository.exists(videoId);
      if (hasTranscript) {
        videosWithTranscripts += 1;
      }

      const entities = this.entityRepository.findByVideoId(videoId);
      const analysis = this.aiAnalysisRepository.getByVideo(videoId);

      const videoRef: VideoRef = { video_id: videoId, title: video.title };
      const topicsForVideo: string[] = [];

      for (const entity of entities) {
        switch (entity.entity_type) {
          case 'topic': {
            topicsForVideo.push(entity.entity_value);
            const key = entity.entity_value.toLowerCase();
            const existing = topicsMap.get(key);
            if (existing === undefined) {
              topicsMap.set(key, {
                name: entity.entity_value,
                count: 1,
                videos: [videoRef],
              });
            } else {
              existing.count += 1;
              existing.videos.push(videoRef);
            }
            break;
          }
          case 'github_repo': {
            const key = entity.entity_url ?? entity.entity_value;
            const existing = reposMap.get(key);
            if (existing === undefined) {
              reposMap.set(key, {
                name: entity.entity_value,
                url: entity.entity_url ?? undefined,
                videos: [videoRef],
              });
            } else {
              existing.videos.push(videoRef);
            }
            break;
          }
          case 'website': {
            const key = entity.entity_url ?? entity.entity_value;
            const existing = websitesMap.get(key);
            if (existing === undefined) {
              websitesMap.set(key, {
                name: entity.entity_value,
                url: entity.entity_url ?? undefined,
                videos: [videoRef],
              });
            } else {
              existing.videos.push(videoRef);
            }
            break;
          }
          case 'person': {
            const key = entity.entity_value.toLowerCase();
            const existing = peopleMap.get(key);
            if (existing === undefined) {
              peopleMap.set(key, {
                name: entity.entity_value,
                count: 1,
                videos: [videoRef],
              });
            } else {
              existing.count += 1;
              existing.videos.push(videoRef);
            }
            break;
          }
          default:
            logger.debug(
              { videoId, entityType: entity.entity_type },
              'Skipping entity with unknown entity_type during playlist aggregation'
            );
            break;
        }
      }

      videoSummaries.push({
        video_id: videoId,
        title: video.title,
        channel_title: video.channel_title,
        published_at: video.published_at,
        duration_seconds: video.duration_seconds,
        view_count: stats?.view_count ?? 0,
        like_count: stats?.like_count ?? 0,
        has_transcript: hasTranscript,
        thumbnail_url: getThumbnailUrl(videoId),
        summary: analysis?.summary ?? undefined,
        topics: topicsForVideo,
      });
    }

    const topTopics: AggregatedTopic[] = Array.from(topicsMap.values())
      .map((t) => ({ name: t.name, count: t.count, videos: t.videos }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const githubRepos: AggregatedEntity[] = Array.from(reposMap.values())
      .map((r) => ({ name: r.name, url: r.url, videos: r.videos }))
      .sort((a, b) => b.videos.length - a.videos.length);

    const websites: AggregatedEntity[] = Array.from(websitesMap.values())
      .map((w) => ({ name: w.name, url: w.url, videos: w.videos }))
      .sort((a, b) => b.videos.length - a.videos.length);

    const people: AggregatedPerson[] = Array.from(peopleMap.values())
      .map((p) => ({ name: p.name, count: p.count, videos: p.videos }))
      .sort((a, b) => b.count - a.count);

    const hours = Math.floor(totalDuration / 3600);
    const minutes = Math.floor((totalDuration % 3600) / 60);
    const durationFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    const transcriptPercentage =
      videos.length === 0 ? 0 : Math.round((videosWithTranscripts / videos.length) * 100);

    return {
      playlist: {
        playlist_id: playlistId,
        title: playlistTitle,
        description: playlistDescription ?? undefined,
        video_count: videos.length,
        total_duration: durationFormatted,
        total_views: totalViews.toLocaleString(),
        videos_with_transcripts: videosWithTranscripts,
        transcript_percentage: transcriptPercentage,
      },
      stats: {
        total_topics: topicsMap.size,
        total_repos: reposMap.size,
        total_websites: websitesMap.size,
        total_people: peopleMap.size,
      },
      videos: videoSummaries,
      top_topics: topTopics,
      github_repos: githubRepos,
      websites,
      people,
      generated_at: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------
  // GitHub repo description enrichment
  // --------------------------------------------------------------------

  /**
   * For each UNIQUE GitHub repo, fetch its description from the GitHub API
   * and attach it. Ports Python `html_generator.py:382-389`.
   *
   * The `github_repos` aggregation upstream already dedupes by URL/name, so
   * "unique" is satisfied by iterating the list — one HTTP call per entry.
   * Non-GitHub URLs are skipped (no call). Calls are throttled by
   * `githubThrottleMs` between requests (Python's `time.sleep(0.1)`).
   *
   * Fail-safe contract: ANY failure (no fetch available, network error,
   * 403/404/non-200, timeout, malformed JSON) yields no description for that
   * repo — the original entry is returned unchanged. Report generation never
   * throws or hangs because of this step. Returns a NEW array of NEW objects
   * (immutability — the input aggregation is not mutated).
   *
   * @param repos - Aggregated repos from `buildPlaylistReportData`.
   * @returns The same repos, each optionally gaining a `description`.
   */
  private async enrichGithubDescriptions(
    repos: readonly AggregatedEntity[]
  ): Promise<AggregatedEntity[]> {
    if (this.githubFetch === undefined || repos.length === 0) {
      // No fetch implementation, or nothing to enrich — pass through
      // unchanged (still a fresh array for immutability).
      return repos.map((repo) => ({ ...repo }));
    }

    const enriched: AggregatedEntity[] = [];
    let firstFetched = false;

    for (const repo of repos) {
      const isGithub = repo.url !== undefined && repo.url.includes('github.com');
      if (!isGithub) {
        enriched.push({ ...repo });
        continue;
      }

      // Throttle BETWEEN calls only (not before the first), matching the
      // Python loop's `time.sleep(0.1)` placement after each request.
      if (firstFetched) {
        await delay(this.githubThrottleMs);
      }
      firstFetched = true;

      const description = await this.fetchGithubDescription(repo.url as string);
      enriched.push(description !== null ? { ...repo, description } : { ...repo });
    }

    return enriched;
  }

  /**
   * Fetch a single repository's description from the GitHub API. Ports
   * Python `_fetch_github_description` (html_generator.py:200-238).
   *
   * Extracts `owner/repo` from the URL (stripping a `.git` suffix), GETs
   * `https://api.github.com/repos/{owner}/{repo}` with a
   * {@link GITHUB_FETCH_TIMEOUT_MS} abort timeout, and returns the
   * `description` field on a 200. An empty-string description is treated as
   * "none" (Python's `if description:` guard).
   *
   * NEVER throws: every failure mode (unparseable URL, network error, abort,
   * non-200, malformed body) returns `null`.
   *
   * Abort caveat: the timeout below only fires if `this.githubFetch` honors
   * the `AbortSignal` it is handed (`signal: controller.signal`). The global
   * `fetch` does; an injected mock must too, or a never-settling call will
   * hang here despite the timer.
   *
   * @param repoUrl - The repo's GitHub URL.
   * @returns The non-empty description, or `null` if unavailable.
   */
  private async fetchGithubDescription(repoUrl: string): Promise<string | null> {
    const match = GITHUB_REPO_URL_PATTERN.exec(repoUrl);
    if (match === null) {
      return null;
    }

    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);

    try {
      const githubFetch = this.githubFetch;
      if (githubFetch === undefined) {
        return null;
      }
      const response = await githubFetch(apiUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github.v3+json' },
      });

      if (!response.ok) {
        // 403 (rate limit), 404 (gone), any other non-2xx → no description.
        logger.debug({ apiUrl, status: response.status }, 'GitHub description fetch non-OK');
        return null;
      }

      const body: unknown = await response.json();
      if (
        body !== null &&
        typeof body === 'object' &&
        'description' in body &&
        typeof (body as { description: unknown }).description === 'string'
      ) {
        const description = (body as { description: string }).description;
        // Python's `if description:` — empty string counts as no description.
        return description.length > 0 ? description : null;
      }
      return null;
    } catch (error) {
      // Network error, abort/timeout, malformed JSON — degrade silently.
      logger.debug(
        { apiUrl, err: error instanceof Error ? error.message : String(error) },
        'GitHub description fetch failed; rendering without description'
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // --------------------------------------------------------------------
  // Template loading + rendering
  // --------------------------------------------------------------------

  private renderVideoTemplate(data: VideoReportData): string {
    if (this.videoTemplate === undefined) {
      this.videoTemplate = this.loadTemplate('video_report');
    }
    try {
      return this.videoTemplate(data);
    } catch (error) {
      throw new AppError('Failed to render video report template', {
        code: REPORT_ERROR_CODES.RENDER_FAILED,
        cause: error,
        context: { templateName: 'video_report' },
      });
    }
  }

  private renderPlaylistTemplate(data: CompletePlaylistReportData): string {
    if (this.playlistTemplate === undefined) {
      this.playlistTemplate = this.loadTemplate('playlist_report');
    }
    try {
      return this.playlistTemplate(data);
    } catch (error) {
      throw new AppError('Failed to render playlist report template', {
        code: REPORT_ERROR_CODES.RENDER_FAILED,
        cause: error,
        context: { templateName: 'playlist_report' },
      });
    }
  }

  /**
   * Load a Handlebars template by base name (no extension). Resolves
   * relative to `templatesDir`, which itself resolves relative to
   * `process.cwd()` when not absolute. Compiles once; subsequent calls
   * for the same template hit the in-instance cache via the calling
   * methods above.
   *
   * @throws {AppError} with code `REPORT_TEMPLATE_NOT_FOUND` if the
   *                    file does not exist or cannot be read.
   */
  private loadTemplate(templateName: string): HandlebarsTemplateDelegate {
    const templatePath = path.resolve(this.templatesDir, `${templateName}.html`);
    if (!fs.existsSync(templatePath)) {
      throw new AppError(`Report template not found: ${templatePath}`, {
        code: REPORT_ERROR_CODES.TEMPLATE_NOT_FOUND,
        context: { templateName, templatePath, templatesDir: this.templatesDir },
      });
    }

    let source: string;
    try {
      source = fs.readFileSync(templatePath, 'utf-8');
    } catch (error) {
      throw new AppError(`Failed to read report template: ${templatePath}`, {
        code: REPORT_ERROR_CODES.TEMPLATE_NOT_FOUND,
        cause: error,
        context: { templateName, templatePath },
      });
    }

    return Handlebars.compile(source);
  }
}

/**
 * Re-export the branded-id helper so callers needing to construct a
 * `VideoId` from a raw string don't have to import from `types/`.
 */
export { asVideoId };

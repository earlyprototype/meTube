/**
 * VideoExtractor — Phase 2 Wave 3 integrator.
 *
 * The most important file in Wave 3: composes the YouTubeClient,
 * TranscriptExtractor, WhisperExtractor, GeminiParser, DescriptionParser,
 * and the nine Wave 2 repositories into a single `extractPlaylist`
 * pipeline. Ported from
 * `legacy/python/src/extractors/video_extractor.py:236-371` with the
 * P10 disposition redesigning the constructor from 8 primitive params
 * to a typed config object.
 *
 * Discipline carried by this file:
 *
 *   1. Constructor signature follows P10 disposition — three params:
 *      `(db, youtubeClient, config)`. Config is a Zod-validated object,
 *      not a bag of optional primitives.
 *   2. Branded `VideoId` / `PlaylistId` throughout. Raw strings won't
 *      type-check at any seam.
 *   3. ALL DB writes flow through the Wave 2 repositories — each
 *      repository wraps its own `withTransaction`. VideoExtractor
 *      composes their calls; it does not add a second outer
 *      transaction.
 *   4. Honest result counters: `processed + skipped + failed === total`.
 *      No "new" vs "processed" drift (v1 PostExtractionMenu label bug).
 *   5. onProgress events are a discriminated union (`kind: ...`) so
 *      callers can switch exhaustively.
 *   6. No `console.*`, no `any`, no stub markers. Errors wrapped as
 *      `AppError` with codes; underlying causes preserved.
 *   7. Sequential processing (matches Python — better-sqlite3 is
 *      synchronous, Whisper serializes naturally). No premature
 *      `Promise.all`.
 *
 * Sibling Wave 3 files are written in parallel; this file writes to
 * their expected API surfaces per PORT_PLAN.md. Sibling drift is a
 * downstream integration concern.
 */

import { z } from 'zod';

import { AppError } from '../errors/index.js';
import type { ParseTranscriptInput } from '../parsers/GeminiParser.js';
import { GeminiResponseSchema, type GeminiResponse } from '../schemas/gemini.js';
import { asVideoId, type PlaylistId, type VideoId } from '../types/index.js';
import logger from '../utils/logger.js';

import { AIAnalysisRepository } from '../database/AIAnalysisRepository.js';
import type { DatabaseManager } from '../database/connection.js';
import { EntityRepository, type EntityInput } from '../database/EntityRepository.js';
import {
  ExtractionJobRepository,
  type ExtractionJobId,
} from '../database/ExtractionJobRepository.js';
import { PlaylistItemRepository } from '../database/PlaylistItemRepository.js';
import { PlaylistRepository } from '../database/PlaylistRepository.js';
import { StatisticsRepository } from '../database/StatisticsRepository.js';
import { TagRepository } from '../database/TagRepository.js';
import { TranscriptRepository } from '../database/TranscriptRepository.js';
import { VideoRepository } from '../database/VideoRepository.js';

// --------------------------------------------------------------------------
// Sibling Wave 3 surfaces (expected API). Defined as TS `interface`s here so
// the VideoExtractor doesn't import the concrete classes — sibling agents
// can land their files independently. Production wiring (Wave 4) injects
// the real instances via the constructor's `deps` parameter.
// --------------------------------------------------------------------------

/**
 * Branded YouTube playlist info — what `YouTubeClient.getPlaylistInfo`
 * returns. Camel-cased domain shape (NOT the raw YouTube API
 * response — that lives in `schemas/youtube.ts`).
 */
export interface PlaylistInfo {
  readonly playlistId: PlaylistId;
  readonly title: string;
  readonly description: string;
  readonly videoCount: number;
}

/**
 * Branded YouTube playlist item — what `YouTubeClient.getPlaylistVideos`
 * yields per element. Position is the YouTube-supplied ordering.
 */
export interface PlaylistVideoItem {
  readonly videoId: VideoId;
  readonly title: string;
  readonly channelId: string;
  readonly channelTitle: string;
  readonly addedAt: string;
  readonly position: number;
}

/**
 * Branded YouTube video details — what `YouTubeClient.getVideoDetails`
 * returns for a single video. Mirrors the field set the v1 pipeline
 * reads (title, channel, duration, stats, etc.).
 */
export interface VideoDetails {
  readonly videoId: VideoId;
  readonly title: string;
  readonly description: string;
  readonly channelId: string;
  readonly channelTitle: string;
  readonly publishedAt: string;
  readonly duration: string;
  readonly durationSeconds: number;
  readonly isShort: boolean;
  readonly viewCount: number;
  readonly likeCount: number;
  readonly commentCount: number;
  readonly tags: readonly string[];
  readonly categoryId?: string;
  readonly definition?: string;
  readonly caption?: boolean;
  readonly licensedContent?: boolean;
}

/**
 * Pagination options for `getPlaylistVideos`. Optional cap; when absent
 * the client paginates to exhaustion (the v1 50-cap bug is fixed at the
 * client level, not here).
 */
export interface PlaylistVideoOptions {
  readonly maxResults?: number;
}

/**
 * Expected `YouTubeClient` surface. Sibling agent's concrete class
 * implements these methods; we depend on the shape, not the file.
 */
export interface YouTubeClientLike {
  getPlaylistInfo(playlistId: PlaylistId): Promise<PlaylistInfo | null>;
  getPlaylistVideos(
    playlistId: PlaylistId,
    opts?: PlaylistVideoOptions
  ): Promise<readonly PlaylistVideoItem[]>;
  getVideoDetails(videoId: VideoId): Promise<VideoDetails | null>;
}

/**
 * Shape of a transcript payload as it travels from extractor → repository.
 * Matches the lifted `TranscriptData` shape in
 * `src-ts-v2/extractors/TranscriptExtractor.ts` and
 * `src-ts-v2/extractors/WhisperExtractor.ts` — snake_case field names
 * preserved from the v1 lift so no transform is needed when wiring the
 * real extractors in production. The repository's `TranscriptInput`
 * shape uses camelCase; we translate at the persist boundary, not here.
 */
export interface TranscriptResult {
  readonly full_text: string;
  readonly segments: readonly unknown[];
  readonly language: string;
  readonly is_auto_generated: boolean;
  readonly from_whisper?: boolean;
}

/**
 * Expected `TranscriptExtractor` surface — async, returns null when no
 * caption track is available (caller falls back to Whisper). v2
 * declares the branded `VideoId` at the boundary (invariant #3); the
 * brand is structurally a string, so the sibling lifted extractor's
 * runtime impl satisfies this interface unchanged.
 */
export interface TranscriptExtractorLike {
  extract(videoId: VideoId): Promise<TranscriptResult | null>;
}

/**
 * Expected `WhisperExtractor` surface — same shape as TranscriptExtractor
 * but always sets `from_whisper: true` when it returns a result.
 */
export interface WhisperExtractorLike {
  extract(videoId: VideoId): Promise<TranscriptResult | null>;
  isAvailable(): boolean;
}

/**
 * GitHub repo mention shape used by the lifted DescriptionParser.
 */
export interface GitHubRepoMention {
  readonly url: string;
  readonly owner: string;
  readonly name: string;
  readonly full_name: string;
}

/**
 * What `DescriptionParser.parse` returns. Matches the v1 KEEP-AS-IS lift
 * (`src-ts/parsers/DescriptionParser.ts`).
 */
export interface ParsedDescription {
  readonly github_repos: readonly GitHubRepoMention[];
  readonly websites: readonly string[];
  readonly topics: readonly string[];
  readonly people: readonly string[];
  readonly key_concepts: readonly string[];
  readonly summary: string | null;
}

/**
 * What `DescriptionParser.extractEntitiesForDatabase` returns — the
 * entity shape repositories accept.
 */
export interface DatabaseEntity {
  readonly type: string;
  readonly value: string;
  readonly url: string | null;
  readonly confidence: number;
}

/**
 * Expected `DescriptionParser` surface — regex-only, deterministic, sync.
 */
export interface DescriptionParserLike {
  parse(title: string, description: string): ParsedDescription;
  extractEntitiesForDatabase(parsed: ParsedDescription): readonly DatabaseEntity[];
  getTags(parsed: ParsedDescription): string[];
}

/**
 * Expected `GeminiParser` surface — async LLM call, returns a parsed and
 * Zod-validated `GeminiResponse`. Returns null when the model is
 * unavailable or returns invalid JSON (the v1 `_empty_result` fallback
 * is the parser's responsibility, not ours).
 *
 * The input is the single typed object the real
 * `GeminiParser.parseTranscript` accepts (`{ transcript, videoTitle }`),
 * imported as `ParseTranscriptInput` so this seam can never drift from
 * the concrete parser's contract again.
 */
export interface GeminiParserLike {
  parseTranscript(input: ParseTranscriptInput): Promise<GeminiResponse | null>;
  getTags(parsedResult: GeminiResponse): string[];
  readonly modelName: string;
}

// --------------------------------------------------------------------------
// VideoExtractorConfig — Zod schema + inferred type (P10 disposition)
// --------------------------------------------------------------------------

/**
 * Constructor-time configuration for the VideoExtractor. Mirrors the
 * P10 disposition: single typed config object replaces the 8 primitive
 * parameters of the Python `__init__`.
 *
 * Every field is optional with a defined default — passing `{}` yields
 * a fully-defaulted config. Validation happens once in the constructor;
 * downstream code reads from the parsed value, not the raw input.
 */
export const VideoExtractorConfigSchema = z.object({
  /** Gemini API key. Optional — if absent, LLM parsing is disabled. */
  geminiApiKey: z.string().optional(),
  /** Gemini model name. Defaults to `gemini-3-flash-preview`. */
  geminiModel: z.string().default('gemini-3-flash-preview'),
  /** Whisper model size. Defaults to `base`. */
  whisperModel: z.string().default('base'),
  /** Preferred transcript language. Defaults to `en`. */
  transcriptLanguage: z.string().default('en'),
  /** Preferred transcript languages (priority order). */
  transcriptLanguages: z.array(z.string()).default(['en', 'en-GB', 'en-US']),
  /** Whether to attempt transcript extraction at all. */
  autoTranscript: z.boolean().default(true),
  /** Whether to run the LLM analysis stage when a transcript is available. */
  autoLlmParse: z.boolean().default(true),
  /** Whether the Whisper fallback is enabled. */
  enableWhisper: z.boolean().default(false),
  /** Rate-limit delay between transcript requests, in milliseconds. */
  transcriptRateLimitMs: z.number().int().nonnegative().default(2000),
  /** Skip videos already in the database (idempotency knob). */
  skipExisting: z.boolean().default(true),
  /** Optional hard cap on videos processed per extractPlaylist call. */
  maxVideos: z.number().int().positive().optional(),
});

/** Inferred TS type — what the constructor accepts and what `this.config` holds. */
export type VideoExtractorConfig = z.infer<typeof VideoExtractorConfigSchema>;

// --------------------------------------------------------------------------
// onProgress event shape (discriminated union)
// --------------------------------------------------------------------------

/**
 * Discriminated union for progress events. Each event carries `kind` for
 * exhaustive switching plus event-specific payload. Callers (Ink layer)
 * subscribe to whichever events they care about.
 */
export type ExtractProgressEvent =
  | { kind: 'job_started'; jobId: ExtractionJobId; playlistId: PlaylistId; total: number }
  | { kind: 'fetch_meta'; videoId: VideoId; index: number; total: number }
  | { kind: 'transcribe'; videoId: VideoId; index: number; total: number }
  | { kind: 'whisper'; videoId: VideoId; index: number; total: number }
  | { kind: 'gemini'; videoId: VideoId; index: number; total: number }
  | { kind: 'persist'; videoId: VideoId; index: number; total: number }
  | { kind: 'video_done'; videoId: VideoId; index: number; total: number }
  | { kind: 'video_skipped'; videoId: VideoId; index: number; total: number; reason: string }
  | { kind: 'video_failed'; videoId: VideoId; index: number; total: number; error: string }
  | { kind: 'job_completed'; jobId: ExtractionJobId; result: ExtractResult };

/**
 * Function signature for progress callbacks. Sync — fire-and-forget; the
 * extractor doesn't await.
 */
export type ExtractProgressCallback = (event: ExtractProgressEvent) => void;

// --------------------------------------------------------------------------
// ExtractResult — what extractPlaylist returns
// --------------------------------------------------------------------------

/**
 * Honest counters returned by `extractPlaylist`. The invariant the v1
 * pipeline lost: `processed + skipped + failed === total`. No "new"
 * field — "new" was the source of the PostExtractionMenu label drift
 * bug (see `_archivedkanban.md` REVIEW section). A video is either
 * successfully processed (counts in `processed`), skipped because it
 * was already there (counts in `skipped`), or it threw (counts in
 * `failed`). No overlap, no double-count.
 */
export interface ExtractResult {
  readonly playlistId: PlaylistId;
  readonly total: number;
  readonly processed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly jobId: ExtractionJobId;
  readonly success: boolean;
}

// --------------------------------------------------------------------------
// Injected dependencies (deps) — the testability seam
// --------------------------------------------------------------------------

/**
 * Optional dependency overrides supplied at construction time. Production
 * code passes nothing here (or a partial subset for staged rollout);
 * tests pass mock implementations of every sibling.
 *
 * Repositories are also overridable — the integration tests under
 * `src-ts-v2/__tests__/VideoExtractor.test.ts` exercise the real
 * `:memory:` DB path, but a unit test that wants to isolate a single
 * pipeline stage can swap a repository for a spy here.
 */
export interface VideoExtractorDeps {
  readonly transcriptExtractor?: TranscriptExtractorLike;
  readonly whisperExtractor?: WhisperExtractorLike;
  readonly descriptionParser?: DescriptionParserLike;
  readonly geminiParser?: GeminiParserLike | null;
  readonly videoRepository?: VideoRepository;
  readonly playlistRepository?: PlaylistRepository;
  readonly playlistItemRepository?: PlaylistItemRepository;
  readonly statisticsRepository?: StatisticsRepository;
  readonly entityRepository?: EntityRepository;
  readonly aiAnalysisRepository?: AIAnalysisRepository;
  readonly extractionJobRepository?: ExtractionJobRepository;
  readonly transcriptRepository?: TranscriptRepository;
  readonly tagRepository?: TagRepository;
}

// --------------------------------------------------------------------------
// VideoExtractor
// --------------------------------------------------------------------------

/**
 * Main extraction pipeline. Composes the sibling Wave 3 services and
 * the Wave 2 repositories to drive `extractPlaylist` end-to-end.
 *
 * Construction is sync — Whisper / Gemini availability checks are
 * lazy. Failure to provide a Gemini key when `autoLlmParse: true` is
 * not a constructor error; it merely disables LLM parsing for this
 * instance, logged at debug level.
 */
export class VideoExtractor {
  private readonly db: DatabaseManager;
  private readonly youtubeClient: YouTubeClientLike;
  private readonly config: VideoExtractorConfig;

  // Resolved sibling dependencies (either injected or constructed-from-config).
  private readonly transcriptExtractor: TranscriptExtractorLike | null;
  private readonly whisperExtractor: WhisperExtractorLike | null;
  private readonly descriptionParser: DescriptionParserLike;
  private readonly geminiParser: GeminiParserLike | null;

  // Repositories (one instance per logical context; not shared globally).
  private readonly videoRepository: VideoRepository;
  private readonly playlistRepository: PlaylistRepository;
  private readonly playlistItemRepository: PlaylistItemRepository;
  private readonly statisticsRepository: StatisticsRepository;
  private readonly entityRepository: EntityRepository;
  private readonly aiAnalysisRepository: AIAnalysisRepository;
  private readonly extractionJobRepository: ExtractionJobRepository;
  private readonly transcriptRepository: TranscriptRepository;
  private readonly tagRepository: TagRepository;

  /**
   * Construct a VideoExtractor.
   *
   * @param db - Wave 1 `DatabaseManager`. Owns the SQLite connection.
   * @param youtubeClient - Sibling Wave 3 `YouTubeClient` instance (or
   *                        anything satisfying `YouTubeClientLike`).
   * @param config - Typed config (P10 disposition). Parsed through
   *                 `VideoExtractorConfigSchema` — bad input throws
   *                 from the constructor.
   * @param deps - Optional dependency overrides. Production code may
   *               omit this entirely; tests pass mocks here.
   * @throws {AppError} If `config` fails Zod parse.
   */
  constructor(
    db: DatabaseManager,
    youtubeClient: YouTubeClientLike,
    config: Partial<VideoExtractorConfig> = {},
    deps: VideoExtractorDeps = {}
  ) {
    this.db = db;
    this.youtubeClient = youtubeClient;

    // Parse-then-store. The parse populates defaults and validates types;
    // downstream code reads `this.config.*` without re-checking.
    const parseResult = VideoExtractorConfigSchema.safeParse(config);
    if (!parseResult.success) {
      throw new AppError('VideoExtractorConfig failed validation', {
        code: 'VIDEO_EXTRACTOR_CONFIG_INVALID',
        cause: parseResult.error,
        context: { zodIssues: parseResult.error.issues },
      });
    }
    this.config = parseResult.data;

    // Repositories: use injected if present, otherwise build from `db`.
    this.videoRepository = deps.videoRepository ?? new VideoRepository(db);
    this.playlistRepository = deps.playlistRepository ?? new PlaylistRepository(db);
    this.playlistItemRepository = deps.playlistItemRepository ?? new PlaylistItemRepository(db);
    this.statisticsRepository = deps.statisticsRepository ?? new StatisticsRepository(db);
    this.entityRepository = deps.entityRepository ?? new EntityRepository(db);
    this.aiAnalysisRepository = deps.aiAnalysisRepository ?? new AIAnalysisRepository(db);
    this.extractionJobRepository = deps.extractionJobRepository ?? new ExtractionJobRepository(db);
    this.transcriptRepository = deps.transcriptRepository ?? new TranscriptRepository(db);
    this.tagRepository = deps.tagRepository ?? new TagRepository(db);

    // Siblings: injected siblings win. When not injected we leave them
    // null and require the test (or production wiring) to have passed
    // them. We do NOT construct concrete sibling classes here, to keep
    // VideoExtractor decoupled from their concrete shape during Wave 3.
    this.transcriptExtractor = deps.transcriptExtractor ?? null;
    this.whisperExtractor = deps.whisperExtractor ?? null;
    if (!deps.descriptionParser) {
      throw new AppError('descriptionParser dependency is required', {
        code: 'VIDEO_EXTRACTOR_DEP_MISSING',
        context: { missing: 'descriptionParser' },
      });
    }
    this.descriptionParser = deps.descriptionParser;
    this.geminiParser = deps.geminiParser ?? null;

    logger.info(
      {
        autoTranscript: this.config.autoTranscript,
        autoLlmParse: this.config.autoLlmParse && this.geminiParser !== null,
        enableWhisper: this.config.enableWhisper && this.whisperExtractor !== null,
        geminiModel: this.config.geminiModel,
        whisperModel: this.config.whisperModel,
      },
      'VideoExtractor initialized'
    );
  }

  /**
   * Extract every video in a playlist. End-to-end pipeline:
   *
   *   1. Fetch playlist info (YouTubeClient).
   *   2. Upsert the playlist row + create an extraction-job row.
   *   3. Page through playlist items via YouTubeClient.
   *   4. For each video: fetch details → persist video + stats + join row
   *      → fetch transcript (with Whisper fallback) → persist transcript
   *      → parse description → parse with Gemini (if enabled) → persist
   *      entities + AI analysis.
   *   5. Update job status to `completed` (or `failed` on uncaught error).
   *
   * Counter discipline: every video lands in exactly one of `processed`,
   * `skipped`, `failed`. The sum equals `total`. No "new" field —
   * "new" was the v1 PostExtractionMenu source of confusion.
   *
   * @param playlistId - Branded YouTube playlist ID.
   * @param opts - Optional callbacks. `onProgress` is invoked on every
   *               pipeline transition; exceptions inside the callback
   *               are caught and logged so a flaky observer does not
   *               kill the extraction.
   * @returns Honest counters + the job ID + success flag.
   * @throws {AppError} If the playlist cannot be fetched at all. Per-
   *                    video failures are captured in `result.failed`,
   *                    not raised.
   */
  async extractPlaylist(
    playlistId: PlaylistId,
    opts: { onProgress?: ExtractProgressCallback } = {}
  ): Promise<ExtractResult> {
    const onProgress = this.wrapProgress(opts.onProgress);
    logger.info({ playlistId }, 'Starting playlist extraction');

    // Step 1: fetch playlist info. Hard failure if we can't see the
    // playlist at all — there's nothing to extract.
    const playlistInfo = await this.youtubeClient.getPlaylistInfo(playlistId);
    if (playlistInfo === null) {
      throw new AppError('Playlist not found', {
        code: 'PLAYLIST_NOT_FOUND',
        context: { playlistId },
      });
    }

    // Step 2: upsert playlist row.
    this.playlistRepository.createOrUpdate({
      playlistId,
      title: playlistInfo.title,
      description: playlistInfo.description ?? null,
      videoCount: playlistInfo.videoCount,
    });

    // Step 3: list all videos in the playlist. The YouTubeClient is
    // expected to paginate internally and respect `maxResults` (no v1
    // 50-cap bug at this layer).
    const playlistVideos = await this.youtubeClient.getPlaylistVideos(playlistId, {
      maxResults: this.config.maxVideos,
    });
    const total = playlistVideos.length;

    // Step 4: create the extraction-job audit row. Fire `job_started`
    // progress event so observers can lock in the total up-front.
    const job = this.extractionJobRepository.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'running',
      videos_found: total,
    });
    const jobId: ExtractionJobId = job.id ?? 0;
    onProgress({ kind: 'job_started', jobId, playlistId, total });

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    // Step 5: iterate. Each video gets its own try-block — a failure
    // increments `failed`, logs the cause, and the loop continues.
    // Failure isolation is the discipline: one bad video does not kill
    // the run.
    try {
      for (let i = 0; i < playlistVideos.length; i++) {
        const item = playlistVideos[i];
        const videoId = item.videoId;
        const index = i + 1;

        try {
          const outcome = await this.processVideo({
            playlistId,
            item,
            index,
            total,
            onProgress,
          });

          if (outcome === 'processed') {
            processed += 1;
            onProgress({ kind: 'video_done', videoId, index, total });
          } else {
            skipped += 1;
            onProgress({
              kind: 'video_skipped',
              videoId,
              index,
              total,
              reason: 'video already in database',
            });
          }
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ videoId, err: message }, 'Video processing failed');
          onProgress({
            kind: 'video_failed',
            videoId,
            index,
            total,
            error: message,
          });
        }
      }

      // Step 6: mark job completed. Counters land in the audit row so
      // future "what happened in this run?" queries can answer without
      // re-running.
      this.extractionJobRepository.updateStatus(jobId, 'completed', {
        videos_found: total,
        videos_processed: processed,
        new_videos: processed,
      });

      const result: ExtractResult = {
        playlistId,
        total,
        processed,
        skipped,
        failed,
        jobId,
        success: failed === 0,
      };

      // Defence-in-depth invariant check. If counters drift we want to
      // know loudly; the v1 PostExtractionMenu silently displayed
      // wrong values for months.
      if (processed + skipped + failed !== total) {
        logger.error(
          { processed, skipped, failed, total, playlistId },
          'Counter invariant violation: processed+skipped+failed !== total'
        );
      }

      logger.info(result, 'Playlist extraction complete');
      onProgress({ kind: 'job_completed', jobId, result });
      return result;
    } catch (error) {
      // Whole-loop failure (not a per-video issue). Mark the job failed
      // and rethrow so callers see the real cause.
      const message = error instanceof Error ? error.message : String(error);
      this.extractionJobRepository.updateStatus(jobId, 'failed', {
        videos_found: total,
        videos_processed: processed,
        new_videos: processed,
        error_message: message,
      });
      logger.error({ playlistId, err: message }, 'Playlist extraction failed (uncaught)');
      throw error instanceof AppError
        ? error
        : new AppError('Playlist extraction failed', {
            code: 'PLAYLIST_EXTRACTION_FAILED',
            cause: error,
            context: { playlistId },
          });
    }
  }

  /**
   * Process a single video. Returns `'processed'` if the full pipeline
   * ran, `'skipped'` if the video was already in the DB and
   * `skipExisting: true`. Throws on hard failure (caller catches and
   * counts as `failed`).
   */
  private async processVideo(args: {
    readonly playlistId: PlaylistId;
    readonly item: PlaylistVideoItem;
    readonly index: number;
    readonly total: number;
    readonly onProgress: ExtractProgressCallback;
  }): Promise<'processed' | 'skipped'> {
    const { playlistId, item, index, total, onProgress } = args;
    const videoId = item.videoId;

    // Idempotency check. If `skipExisting` is on and the video is
    // already persisted, we STILL add the join-table row (so a
    // re-extract picks up newly-discovered playlist memberships) but
    // skip the rest of the pipeline.
    if (this.config.skipExisting && this.videoRepository.exists(videoId)) {
      this.playlistItemRepository.addVideoToPlaylist(
        playlistId,
        videoId,
        item.position,
        item.addedAt
      );
      return 'skipped';
    }

    // Step 1: fetch video details.
    onProgress({ kind: 'fetch_meta', videoId, index, total });
    const details = await this.youtubeClient.getVideoDetails(videoId);
    if (details === null) {
      throw new AppError('Video metadata not available', {
        code: 'VIDEO_NOT_FOUND',
        context: { videoId },
      });
    }

    // Step 2: persist video + statistics (each repo wraps its own
    // transaction — no outer wrapper here).
    onProgress({ kind: 'persist', videoId, index, total });
    this.videoRepository.createOrUpdate({
      video_id: videoId,
      title: details.title,
      description: details.description,
      channel_id: details.channelId,
      channel_title: details.channelTitle,
      published_at: details.publishedAt,
      duration: details.duration,
      duration_seconds: details.durationSeconds,
      is_short: details.isShort,
      category_id: details.categoryId ?? null,
      definition: details.definition ?? null,
      caption: details.caption ?? null,
      licensed_content: details.licensedContent ?? null,
    });

    this.statisticsRepository.recordSnapshot(videoId, {
      viewCount: details.viewCount,
      likeCount: details.likeCount,
      commentCount: details.commentCount,
    });

    // Step 2a: persist YouTube snippet tags. Matches Python behavior at
    // `legacy/python/src/extractors/video_extractor.py:149-150` where
    // `TagRepository.add_tags_to_video` is called immediately after the
    // video row is written.
    if (details.tags.length > 0) {
      this.tagRepository.attachManyToVideo(videoId, details.tags);
    }

    // Step 3: playlist-items join row. Closes the v1 PlaylistAddMine /
    // PlaylistSync stub-bomb — the row is now actually inserted, and
    // the repository's regression test asserts row count increased.
    this.playlistItemRepository.addVideoToPlaylist(
      playlistId,
      videoId,
      item.position,
      item.addedAt
    );

    // Step 4: transcript extraction (with Whisper fallback). Optional
    // — skipped entirely if `autoTranscript: false` or the extractor
    // was never injected.
    const transcript = await this.fetchTranscript({
      videoId,
      index,
      total,
      onProgress,
    });

    // Step 4a: persist transcript if one was obtained. Matches Python
    // behavior at `legacy/python/src/extractors/video_extractor.py:187`
    // where `TranscriptRepository.create` is called immediately after
    // extraction succeeds.
    if (transcript !== null) {
      this.transcriptRepository.upsert(videoId, {
        fullText: transcript.full_text,
        segments: transcript.segments as ReadonlyArray<unknown>,
        language: transcript.language,
        isAutoGenerated: transcript.is_auto_generated,
      });
    }

    // Step 5: description parsing (regex-only, always runs). Persisted
    // entities from the description path are independent of the LLM
    // path; LLM augments, doesn't replace.
    const description = this.descriptionParser.parse(details.title, details.description);
    const descriptionEntities = this.descriptionParser.extractEntitiesForDatabase(description);

    // Step 5a: persist description-derived tags. Matches Python behavior at
    // `legacy/python/src/extractors/video_extractor.py:170-172` where
    // `TagRepository.add_tags_to_video` is called after description parsing.
    const descriptionTags = this.descriptionParser.getTags(description);
    if (descriptionTags.length > 0) {
      this.tagRepository.attachManyToVideo(videoId, descriptionTags);
    }

    // Step 6: Gemini LLM analysis (optional). Requires a transcript +
    // an enabled parser.
    let geminiResult: GeminiResponse | null = null;
    if (
      this.config.autoLlmParse &&
      this.geminiParser !== null &&
      transcript !== null &&
      transcript.full_text.length > 0
    ) {
      onProgress({ kind: 'gemini', videoId, index, total });
      try {
        const raw = await this.geminiParser.parseTranscript({
          transcript: transcript.full_text,
          videoTitle: details.title,
        });
        if (raw !== null) {
          // Defence-in-depth: re-validate at the boundary. If the
          // sibling parser already validated, this is a no-op; if it
          // didn't, we catch a bad shape before it touches the DB.
          const parsed = GeminiResponseSchema.safeParse(raw);
          if (parsed.success) {
            geminiResult = parsed.data;
          } else {
            // A26: promoted warn -> error so the schema-parse breadcrumb
            // is visible at the default Pino level. The video itself is
            // NOT failed (description-path entities still land); only
            // visibility changes.
            logger.error(
              { videoId, issues: parsed.error.issues },
              'Gemini response failed schema parse; skipping LLM persistence'
            );
          }
        }
      } catch (error) {
        // Gemini failure must NOT fail the whole video — it's a soft
        // augmentation. Log and continue with description-only entities.
        // A26: promoted warn -> error so this soft-failure is visible at
        // the default Pino level. The video still counts as `processed`
        // (description-path entities still persist); only visibility
        // changes. This is the load-bearing site that hides A15 when
        // the GeminiParser arg-shape drift bites.
        logger.error(
          { videoId, err: error instanceof Error ? error.message : String(error) },
          'Gemini parseTranscript threw; continuing without LLM entities'
        );
      }
    }

    // Step 7: persist entities (description + LLM combined). When
    // reprocessing (`skipExisting: false`), clear prior entities to avoid
    // duplication. Matches Python behavior at
    // `legacy/python/src/extractors/video_extractor.py:208-209` where
    // `EntityRepository.delete_by_video` is called before inserting.
    if (!this.config.skipExisting) {
      this.entityRepository.deleteByVideoId(videoId);
    }
    const entities = this.buildEntityBatch(descriptionEntities, geminiResult);
    if (entities.length > 0) {
      this.entityRepository.insertMany(videoId, entities);
    }

    // Step 8: persist LLM-derived tags. Matches Python behavior at
    // `legacy/python/src/extractors/video_extractor.py:216-218` where
    // `TagRepository.add_tags_to_video` is called with `llm_parser.get_tags`.
    if (geminiResult !== null && this.geminiParser !== null) {
      const geminiTags = this.geminiParser.getTags(geminiResult);
      if (geminiTags.length > 0) {
        this.tagRepository.attachManyToVideo(videoId, geminiTags);
      }
    }

    // Step 9: persist AI analysis (closes the v1 stub-bomb at
    // HTMLReportGenerator.ts:391-394 that always returned undefined).
    if (geminiResult !== null) {
      this.aiAnalysisRepository.upsert(
        videoId,
        geminiResult,
        this.geminiParser?.modelName ?? this.config.geminiModel
      );
    }

    return 'processed';
  }

  /**
   * Run the transcript stage with optional Whisper fallback. Returns
   * null when no transcript can be obtained (or when transcript
   * extraction is disabled in config). Never throws — transcript
   * failure is normal and shouldn't kill the video.
   */
  private async fetchTranscript(args: {
    readonly videoId: VideoId;
    readonly index: number;
    readonly total: number;
    readonly onProgress: ExtractProgressCallback;
  }): Promise<TranscriptResult | null> {
    const { videoId, index, total, onProgress } = args;

    if (!this.config.autoTranscript || this.transcriptExtractor === null) {
      return null;
    }

    onProgress({ kind: 'transcribe', videoId, index, total });
    let transcript: TranscriptResult | null = null;
    try {
      transcript = await this.transcriptExtractor.extract(videoId);
    } catch (error) {
      // A26: promoted debug -> error. This is a FAILURE path (catch
      // block), not a success-path breadcrumb. At the default Pino
      // level (`error`) this would otherwise be invisible — and silent
      // YouTube-extraction throws are exactly what masks A18/A14's
      // dual-transcript-inert symptom. The video still continues
      // (Whisper fallback if configured); only visibility changes.
      logger.error(
        { videoId, err: error instanceof Error ? error.message : String(error) },
        'YouTube transcript extraction threw; will try Whisper fallback if enabled'
      );
      transcript = null;
    }

    // Whisper fallback — only runs when YouTube transcripts came back
    // null AND Whisper is enabled AND the extractor was injected AND
    // it reports available.
    if (
      transcript === null &&
      this.config.enableWhisper &&
      this.whisperExtractor !== null &&
      this.whisperExtractor.isAvailable()
    ) {
      onProgress({ kind: 'whisper', videoId, index, total });
      try {
        transcript = await this.whisperExtractor.extract(videoId);
      } catch (error) {
        // A26: promoted debug -> error. Same rationale as the YouTube
        // catch above: this is a FAILURE path that silently masks the
        // marquee dual-transcript pipeline going inert. The video still
        // continues (no transcript downstream); only visibility changes.
        logger.error(
          { videoId, err: error instanceof Error ? error.message : String(error) },
          'Whisper extraction threw; continuing without transcript'
        );
        transcript = null;
      }
    }

    return transcript;
  }

  /**
   * Build the combined entity batch (description regex + Gemini LLM).
   * Description entities use confidence 100 (deterministic regex match);
   * LLM entities follow Python's confidence levels (topic=90, repo=95,
   * site=90, person=85) to match `legacy/python/src/parsers/llm_parser.py:182-215`.
   *
   * De-duplication is intentionally NOT done here. The repository's
   * `insertMany` is a straight INSERT; if a topic appears in both
   * description and transcript, it's two rows. v1 behaviour, kept.
   */
  private buildEntityBatch(
    descriptionEntities: readonly DatabaseEntity[],
    gemini: GeminiResponse | null
  ): EntityInput[] {
    const batch: EntityInput[] = [];

    // Description-derived entities (regex-only). These come in with
    // type strings already normalized by the description parser.
    for (const entity of descriptionEntities) {
      batch.push({
        type: entity.type,
        value: entity.value,
        url: entity.url ?? null,
        confidence: entity.confidence,
      });
    }

    if (gemini === null) {
      return batch;
    }

    // LLM-derived entities. We accept Gemini's typed shape directly
    // (it was already Zod-validated upstream).
    for (const topic of gemini.topics) {
      batch.push({ type: 'topic', value: topic, url: null, confidence: 90 });
    }
    for (const repo of gemini.github_repos) {
      batch.push({
        type: 'github_repo',
        value: repo.name,
        url: repo.url ?? null,
        confidence: 95,
      });
    }
    for (const site of gemini.websites) {
      batch.push({
        type: 'website',
        value: site.name,
        url: site.url ?? null,
        confidence: 90,
      });
    }
    for (const person of gemini.people) {
      batch.push({ type: 'person', value: person, url: null, confidence: 85 });
    }

    return batch;
  }

  /**
   * Wrap a user-supplied progress callback in a try-catch so a faulty
   * observer does not abort the extraction. `undefined` → no-op.
   */
  private wrapProgress(raw: ExtractProgressCallback | undefined): ExtractProgressCallback {
    if (raw === undefined) {
      return () => {
        // no-op
      };
    }
    return (event: ExtractProgressEvent): void => {
      try {
        raw(event);
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), kind: event.kind },
          'onProgress callback threw; swallowing to keep extraction alive'
        );
      }
    };
  }
}

// --------------------------------------------------------------------------
// Re-exports for ergonomic consumer use
// --------------------------------------------------------------------------

export { asVideoId };
export type { GeminiResponse };

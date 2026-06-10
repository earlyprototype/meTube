import React, { useEffect, useRef, useState } from 'react';
import { useApp } from 'ink';
import { YouTubeAuth } from '../../src-ts-v2/auth/YouTubeAuth.js';
import { YouTubeClient } from '../../src-ts-v2/api/YouTubeClient.js';
import type { SkippedPageItem } from '../../src-ts-v2/api/types.js';
import { AppError } from '../../src-ts-v2/errors/AppError.js';
import {
  VideoExtractor,
  type ExtractProgressEvent,
  type YouTubeClientLike,
  type PlaylistInfo,
  type VideoDetails,
  type PlaylistVideoItem,
  type PlaylistVideoOptions,
  type VideoExtractorConfig,
  type VideoExtractorDeps,
  type GeminiParserLike,
} from '../../src-ts-v2/extractors/VideoExtractor.js';
import { DescriptionParser } from '../../src-ts-v2/parsers/DescriptionParser.js';
import { TranscriptExtractor } from '../../src-ts-v2/extractors/TranscriptExtractor.js';
import { WhisperExtractor } from '../../src-ts-v2/extractors/WhisperExtractor.js';
import { GeminiParser } from '../../src-ts-v2/parsers/GeminiParser.js';
import { DatabaseManager } from '../../src-ts-v2/database/connection.js';
import { PlaylistRepository } from '../../src-ts-v2/database/PlaylistRepository.js';
import { ProgressDisplay } from '../components/ProgressDisplay.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';
import { PostExtractionMenu } from '../components/PostExtractionMenu.js';
import { buildErrorInfo, type ErrorInfo } from '../utils/errorInfo.js';
import { loadAppPaths } from '../utils/appConfig.js';
import {
  formatMetaLine,
  formatTranscriptLine,
  formatEntitiesLine,
} from '../utils/progressLines.js';
import { resolvePlaylistIdentifier } from '../../src-ts-v2/utils/playlistResolver.js';
import { safeTitle } from '../utils/terminal.js';
import logger from '../../src-ts-v2/utils/logger.js';
import type { VideoId, PlaylistId } from '../../src-ts-v2/types/branded.js';
import { PlaylistVideos, PlaylistDiscover } from './PlaylistCommands.js';

interface ExtractCommandProps {
  type: string;
  id?: string;
  flags: {
    reprocess?: boolean;
    maxVideos?: number;
    all?: boolean;
  };
  onComplete?: () => void;
  /**
   * REPL-only: component-swap navigation. When the post-extraction menu's
   * navigation options fire (view playlist info / extract another), the
   * command replaces itself inline by calling onNavigate with the next
   * component. Undefined in direct-CLI mode — handlers fall back to
   * exiting via `useApp().exit()`.
   */
  onNavigate?: (next: React.ReactElement | null) => void;
}

export function ExtractCommand({ type, id, flags, onComplete, onNavigate }: ExtractCommandProps) {
  // Ink's exit handle for direct-CLI mode. In REPL mode the renderer is
  // a single long-lived Ink instance so exit() is never called there; we
  // gate on the presence of onNavigate to choose the right behaviour.
  const { exit } = useApp();
  const [status, setStatus] = useState<'initializing' | 'extracting' | 'done' | 'menu' | 'error'>(
    'initializing'
  );
  const [progress, setProgress] = useState<ProgressState>({
    current: 0,
    total: 0,
    currentVideo: '',
    status: 'downloading',
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
    stepLines: [],
    whisperProgress: undefined,
  });
  const [startTime] = useState(new Date());
  const [error, setError] = useState<string | null>(null);
  // Compact, legible rendering of an AppError's code + context, surfaced
  // to the user via ErrorDisplay's details block. Null for non-AppError
  // failures (which carry their message only).
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  // The AppError's machine code + structured context, threaded to
  // ErrorDisplay so it can render the numbered remediation steps Python
  // printed (e.g. CONFIG_ERROR -> "check config/config.yaml: <cause>").
  // Null for non-AppError failures.
  const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);
  // Truthful end-of-run summary counters. `unavailable` and
  // `shapeMismatch` are tallied from the tolerant-page-fetch skip
  // callback; the verified* fields are DB truth read back from the
  // ExtractResult after the run.
  const [runSummary, setRunSummary] = useState<{
    unavailableCount: number;
    shapeMismatchCount: number;
    distinctProcessed?: number;
    verifiedVideoRows?: number;
    verifiedTranscriptRows?: number;
  }>({ unavailableCount: 0, shapeMismatchCount: 0 });
  const [playlistTitle, setPlaylistTitle] = useState<string>('');
  // Stored as a string brand — the PostExtractionMenu accepts a raw
  // string. We brand at the boundary when calling v2 repository methods.
  const [extractedPlaylistId, setExtractedPlaylistId] = useState<string>('');

  // One-shot guard: extract() must fire exactly once per mount. The
  // shipped v1.0.0 effect listed `[type, id, flags, onComplete]` as deps,
  // which meant any parent re-render that passed a fresh `onComplete`
  // closure (e.g. the inline arrow in cli.tsx REPL wiring) would re-fire
  // extraction of the same playlist. The ref short-circuits the second
  // invocation deterministically without depending on dep-array hygiene.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    async function extract() {
      // Declared before the try so the finally can close it on EVERY path
      // (success, early return, or throw). REPL mode re-runs extraction on
      // repeated commands; a leaked SQLite handle there can lock the DB.
      let db: DatabaseManager | undefined;
      try {
        // Handle --all flag for batch extraction
        if (flags.all || type === 'all') {
          await extractAllPlaylists();
          return;
        }

        if (type !== 'playlist') {
          // Point the user at the correct grammar with a copy-pasteable
          // suggestion. Prefer a concrete identifier when we have one:
          //   `extract FabLab`     -> type='FabLab', id=undefined -> use type
          //   `extract video abc`  -> type='video',  id='abc'     -> use id
          // Fall back to the `<id>` placeholder when only a bare keyword
          // (e.g. `video`, `all`) was given with no identifier to echo.
          const KNOWN_SUBCOMMANDS = ['video', 'all'];
          const concreteTarget =
            id ?? (type && !KNOWN_SUBCOMMANDS.includes(type) ? type : undefined);
          const target = concreteTarget ?? '<id>';
          setError(
            `Only playlist extraction is supported. Did you mean: extract playlist ${target}`
          );
          setStatus('error');
          return;
        }

        if (!id) {
          setError('No playlist ID provided');
          setStatus('error');
          return;
        }

        // Initialize services up-front; v2 resolver needs a DB handle for
        // the database-fallback step. DB path comes from config (task 8); a
        // broken config throws ConfigError, caught below.
        const { dbPath } = loadAppPaths();
        db = new DatabaseManager(dbPath);

        // Resolve playlist identifier (number, title, URL, or ID) — v2
        // resolver returns branded PlaylistId.
        const resolved = await resolvePlaylistIdentifier(id, { db });
        if (!resolved) {
          setError(
            `Playlist not found: ${id}. Try 'metube playlist list' to see tracked playlists.`
          );
          setStatus('error');
          return;
        }

        const actualPlaylistId = resolved.id;

        // v2 YouTubeClient takes the OAuth2Client returned by authenticate.
        const auth = new YouTubeAuth();
        const oauthClient = await auth.authenticate();
        const youTubeClient = new YouTubeClient(oauthClient);

        // Get playlist — v2 findById, returns null on miss.
        const repo = new PlaylistRepository(db);
        const playlist = repo.findById(actualPlaylistId);

        if (!playlist) {
          setError(`Playlist not found: ${resolved.title || actualPlaylistId}`);
          setStatus('error');
          return;
        }

        setPlaylistTitle(playlist.title);
        setExtractedPlaylistId(actualPlaylistId);
        setStatus('extracting');

        // Collect items the API listed but the tolerant page-fetch dropped
        // (private/deleted, or shape-mismatched). Surfaced in the
        // end-of-run summary so the counts add up for the user.
        const skipped: SkippedPageItem[] = [];

        // v2 VideoExtractor expects a YouTubeClientLike shape with methods
        // (getPlaylistInfo, getPlaylistVideos, getVideoDetails) that differ
        // from the actual YouTubeClient (getPlaylistById, getPlaylistItems,
        // getVideoById). Adapter bridges the names + result shapes, and
        // forwards the skip callback.
        const ytAdapter: YouTubeClientLike = makeYouTubeClientAdapter(youTubeClient, {
          onSkipped: (s) => skipped.push(s),
        });

        // Wire the full dual-transcript + LLM pipeline. Without the
        // TranscriptExtractor / WhisperExtractor / GeminiParser injected
        // here, VideoExtractor short-circuits transcript and Gemini work
        // even though the config asks for them — the bug this fixes.
        const extractor = new VideoExtractor(
          db,
          ytAdapter,
          buildVideoExtractorConfig(flags),
          buildVideoExtractorDeps()
        );

        // v2 extractPlaylist signature: (playlistId, { onProgress }).
        // Progress events are a discriminated union — map onto the
        // existing ProgressDisplay state.
        const result = await extractor.extractPlaylist(actualPlaylistId, {
          onProgress: (event: ExtractProgressEvent) => {
            mapEventToProgress(event, setProgress);
          },
        });

        setProgress({
          current: result.processed,
          total: result.total,
          currentVideo: 'Complete',
          status: 'completed',
          successCount: result.processed,
          failureCount: result.failed,
          skippedCount: result.skipped,
          stepLines: [],
          whisperProgress: undefined,
        });

        // Derive the truthful summary: partition the collected skips by
        // reason, and read back the post-run DB truth from the result.
        const unavailableCount = skipped.filter((s) => s.reason === 'unavailable').length;
        const shapeMismatchCount = skipped.filter((s) => s.reason === 'shape_mismatch').length;
        setRunSummary({
          unavailableCount,
          shapeMismatchCount,
          distinctProcessed: result.distinctProcessed,
          verifiedVideoRows: result.verifiedVideoRows,
          verifiedTranscriptRows: result.verifiedTranscriptRows,
        });

        setStatus('menu');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        if (err instanceof AppError) {
          setErrorDetails(formatAppErrorDetails(err));
        }
        setErrorInfo(buildErrorInfo(err));
        setStatus('error');
      } finally {
        // Close exactly once on every path. Idempotent: undefined when
        // we bailed before opening the handle.
        db?.close();
      }
    }

    async function extractAllPlaylists() {
      // Declared before the try so the finally closes it on EVERY path;
      // see extract() for the REPL handle-leak rationale.
      let db: DatabaseManager | undefined;
      try {
        // Get all enabled playlists — v2 findAll default is enabledOnly:
        // true, which is what we want here. DB path from config (task 8).
        const { dbPath } = loadAppPaths();
        db = new DatabaseManager(dbPath);
        const playlistRepo = new PlaylistRepository(db);
        const enabledPlaylists = playlistRepo.findAll({ enabledOnly: true });

        if (enabledPlaylists.length === 0) {
          setError(
            'No enabled playlists found. Use "metube playlist list" to see tracked playlists.'
          );
          setStatus('error');
          return;
        }

        // Initialize extractor — v2 YouTubeClient takes OAuth2Client; the
        // VideoExtractor takes (db, youtubeClient, config, deps) with the
        // adapter for the differing client surface and an injected
        // descriptionParser.
        const auth = new YouTubeAuth();
        const oauthClient = await auth.authenticate();
        const youTubeClient = new YouTubeClient(oauthClient);
        // Aggregate skips across every playlist in the batch — same
        // tolerant-page-fetch callback as the single-playlist path.
        const skipped: SkippedPageItem[] = [];
        const ytAdapter: YouTubeClientLike = makeYouTubeClientAdapter(youTubeClient, {
          onSkipped: (s) => skipped.push(s),
        });
        const extractor = new VideoExtractor(
          db,
          ytAdapter,
          buildVideoExtractorConfig(flags),
          buildVideoExtractorDeps()
        );

        let totalProcessed = 0;
        let totalDistinctProcessed = 0;
        let totalFailed = 0;
        let totalSkipped = 0;
        // Batch verified-row totals propagate "unavailable" honestly: once
        // ANY playlist's DB verification fails (result field `undefined`),
        // the batch total goes `undefined` too — never NaN, and never a
        // misleadingly-low number. `addVerified` below short-circuits to
        // undefined the moment either operand is undefined.
        let totalVerifiedVideoRows: number | undefined = 0;
        let totalVerifiedTranscriptRows: number | undefined = 0;
        let playlistsFailed = 0;

        setStatus('extracting');

        // Process each playlist sequentially — v2 playlistId is branded.
        for (let i = 0; i < enabledPlaylists.length; i++) {
          const playlist = enabledPlaylists[i];

          setPlaylistTitle(`[${i + 1}/${enabledPlaylists.length}] ${playlist.title}`);
          setExtractedPlaylistId(playlist.playlistId);

          try {
            // Forward per-video progress so --all gets the SAME FULL
            // Python-style per-video display as the single-playlist path —
            // Python's --all loops extract_playlist, which prints the granular
            // per-video lines for every video (cli.py:916-921 +
            // video_extractor.py:108-228). The playlist-level context lives in
            // the header (setPlaylistTitle `[i/N] title`); the in-run bar tracks
            // videos within the current playlist.
            const result = await extractor.extractPlaylist(playlist.playlistId, {
              onProgress: (event: ExtractProgressEvent) => {
                mapEventToProgress(event, setProgress);
              },
            });

            totalProcessed += result.processed;
            totalDistinctProcessed += result.distinctProcessed;
            totalFailed += result.failed;
            totalSkipped += result.skipped;
            totalVerifiedVideoRows = addVerified(totalVerifiedVideoRows, result.verifiedVideoRows);
            totalVerifiedTranscriptRows = addVerified(
              totalVerifiedTranscriptRows,
              result.verifiedTranscriptRows
            );
          } catch (err) {
            playlistsFailed++;
            totalFailed++;
          }
        }

        // Final summary
        setProgress({
          current: enabledPlaylists.length,
          total: enabledPlaylists.length,
          currentVideo: 'All playlists processed',
          status: 'completed',
          successCount: totalProcessed,
          failureCount: totalFailed,
          skippedCount: totalSkipped,
          stepLines: [],
          whisperProgress: undefined,
        });

        // Truthful end-of-run summary aggregated across the whole batch.
        const unavailableCount = skipped.filter((s) => s.reason === 'unavailable').length;
        const shapeMismatchCount = skipped.filter((s) => s.reason === 'shape_mismatch').length;
        setRunSummary({
          unavailableCount,
          shapeMismatchCount,
          distinctProcessed: totalDistinctProcessed,
          verifiedVideoRows: totalVerifiedVideoRows,
          verifiedTranscriptRows: totalVerifiedTranscriptRows,
        });

        setStatus('done');

        if (onComplete) {
          setTimeout(() => onComplete(), 3000);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        if (err instanceof AppError) {
          setErrorDetails(formatAppErrorDetails(err));
        }
        setErrorInfo(buildErrorInfo(err));
        setStatus('error');
      } finally {
        // Close exactly once on every path. Idempotent: undefined when
        // we bailed before opening the handle.
        db?.close();
      }
    }

    extract();
  }, [type, id, flags, onComplete]);

  if (status === 'error') {
    return (
      <ErrorDisplay
        message={error || 'Extraction failed'}
        details={errorDetails ?? undefined}
        code={errorInfo?.code}
        remediationContext={errorInfo?.remediationContext}
      />
    );
  }

  if (status === 'menu') {
    return (
      <PostExtractionMenu
        playlistId={extractedPlaylistId}
        playlistTitle={playlistTitle}
        successCount={progress.successCount}
        distinctProcessed={runSummary.distinctProcessed}
        failureCount={progress.failureCount}
        skippedCount={progress.skippedCount}
        totalVideos={progress.total}
        unavailableCount={runSummary.unavailableCount}
        shapeMismatchCount={runSummary.shapeMismatchCount}
        verifiedVideoRows={runSummary.verifiedVideoRows}
        verifiedTranscriptRows={runSummary.verifiedTranscriptRows}
        onViewPlaylistInfo={() => {
          // REPL mode: swap this ExtractCommand for the just-extracted
          // playlist's PlaylistVideos view. Direct mode: nothing left to
          // navigate to — exit cleanly.
          if (onNavigate) {
            onNavigate(<PlaylistVideos playlistId={extractedPlaylistId} onComplete={onComplete} />);
          } else {
            exit();
          }
        }}
        onExtractMore={() => {
          // REPL mode: swap for the PlaylistDiscover picker so the user
          // can choose a different playlist. Direct mode: exit cleanly —
          // there's no host to navigate within.
          if (onNavigate) {
            onNavigate(
              <PlaylistDiscover key={Date.now()} onComplete={onComplete} onNavigate={onNavigate} />
            );
          } else {
            exit();
          }
        }}
        onMainMenu={() => {
          // REPL mode: clear the inline component so the user lands back
          // at the bare REPL prompt to type the next command. Direct mode:
          // exit the Ink instance.
          if (onNavigate) {
            onNavigate(null);
          } else {
            exit();
          }
        }}
      />
    );
  }

  return (
    <ProgressDisplay
      current={progress.current}
      total={progress.total}
      currentVideo={progress.currentVideo}
      status={progress.status}
      successCount={progress.successCount}
      failureCount={progress.failureCount}
      startTime={startTime}
      stepLines={progress.stepLines}
      whisperProgress={progress.whisperProgress}
    />
  );
}

/**
 * Gemini model used for production playlist extraction. Matches the
 * `VideoExtractorConfigSchema` default so `config.geminiModel` and the
 * adapter's `modelName` (written into the `ai_analysis` row) agree.
 */
const GEMINI_MODEL = 'gemini-3-flash-preview';

/**
 * Build the production VideoExtractor config. Enables the dual-transcript
 * path (`autoTranscript` + `enableWhisper`) and LLM analysis
 * (`autoLlmParse`). Preserves the user-facing flags: `reprocess` maps to
 * `skipExisting` (inverted) and `maxVideos` passes straight through.
 */
export function buildVideoExtractorConfig(flags: {
  reprocess?: boolean;
  maxVideos?: number;
}): Partial<VideoExtractorConfig> {
  return {
    autoTranscript: true,
    autoLlmParse: true,
    enableWhisper: true,
    geminiModel: GEMINI_MODEL,
    skipExisting: !flags.reprocess,
    maxVideos: flags.maxVideos,
  };
}

/**
 * Build the production dependency set injected into VideoExtractor. The
 * dual-transcript pipeline needs the real TranscriptExtractor (YouTube
 * captions) and WhisperExtractor (audio fallback); description parsing is
 * always on; Gemini is optional and degrades to null when no API key is
 * configured (see `buildGeminiAdapter`).
 */
export function buildVideoExtractorDeps(): VideoExtractorDeps {
  return {
    transcriptExtractor: new TranscriptExtractor(),
    whisperExtractor: new WhisperExtractor(),
    descriptionParser: new DescriptionParser(),
    geminiParser: buildGeminiAdapter(),
  };
}

/**
 * Build a `GeminiParserLike` adapter over the concrete v2 `GeminiParser`.
 * The `parseTranscript` signatures now match — both take a single
 * `ParseTranscriptInput` object — so the adapter delegates straight
 * through. Its remaining purpose is twofold:
 *
 *   1. Expose a public `modelName` (the concrete parser keeps it private,
 *      but VideoExtractor writes it into the `ai_analysis` row).
 *   2. Preserve graceful no-key behaviour: the `GeminiParser` constructor
 *      throws `ValidationError` without a key, and VideoExtractor treats a
 *      null parser as "LLM analysis disabled" rather than fatal. So missing
 *      credentials disable Gemini without breaking playlist extraction.
 */
export function buildGeminiAdapter(
  apiKey: string | undefined = process.env.GEMINI_API_KEY,
  model: string = GEMINI_MODEL
): GeminiParserLike | null {
  if (!apiKey) {
    logger.debug('GEMINI_API_KEY not set; Gemini LLM analysis disabled for extraction');
    return null;
  }

  try {
    const parser = new GeminiParser(apiKey, model);
    return {
      modelName: model,
      parseTranscript: (input) => parser.parseTranscript(input),
      getTags: (parsedResult) => parser.getTags(parsedResult),
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'GeminiParser construction failed; continuing without LLM analysis'
    );
    return null;
  }
}

/**
 * Render an AppError's `code` + `context` into a compact one-line detail
 * string for ErrorDisplay's details block. The Wave 1 parseResponse
 * enrichment already folds field paths into `error.message`; this is
 * belt-and-braces so the user also sees the machine-readable code and any
 * structured context the error carried. Returns null when there is nothing
 * useful to add (no context and a generic code).
 */
export function formatAppErrorDetails(err: AppError): string | null {
  const parts: string[] = [];
  if (err.code && err.code !== 'APP_ERROR') {
    parts.push(err.code);
  }
  if (err.context && Object.keys(err.context).length > 0) {
    const ctx = Object.entries(err.context)
      .map(([key, value]) => `${key}: ${formatContextValue(value)}`)
      .join(', ');
    parts.push(ctx);
  }
  return parts.length > 0 ? parts.join(' — ') : null;
}

/**
 * Sum two best-effort verified-row counts for the --all batch totals.
 * Verification is best-effort per playlist: a `undefined` operand means
 * that playlist's DB verification was unavailable (it threw and was
 * logged in VideoExtractor). Once any playlist is unavailable the batch
 * total is no longer trustworthy, so this returns `undefined` — never
 * `NaN` (which `number + undefined` would produce) and never a
 * silently-low partial sum. `undefined` flows to PostExtractionMenu,
 * which then suppresses the "Saved to DB" line rather than lying.
 */
function addVerified(running: number | undefined, next: number | undefined): number | undefined {
  if (running === undefined || next === undefined) return undefined;
  return running + next;
}

/**
 * Compact a single context value for inline display. Objects/arrays are
 * JSON-stringified; primitives are rendered directly. Keeps the details
 * line legible rather than dumping a multi-line blob.
 */
function formatContextValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  return String(value);
}

/**
 * Adapter: bridges v2 YouTubeClient (getPlaylistById / getPlaylistItems /
 * getVideoById) into the shape v2 VideoExtractor expects
 * (getPlaylistInfo / getPlaylistVideos / getVideoDetails). This is a
 * Wave 3 sibling-drift papered over at the Ink boundary; the proper fix
 * is to reconcile names inside src-ts-v2/ in a follow-up.
 */
export function makeYouTubeClientAdapter(
  client: YouTubeClient,
  adapterOpts?: { onSkipped?: (s: SkippedPageItem) => void }
): YouTubeClientLike {
  return {
    async getPlaylistInfo(playlistId: PlaylistId): Promise<PlaylistInfo | null> {
      const pl = await client.getPlaylistById(playlistId);
      if (pl === null) return null;
      return {
        playlistId: pl.playlistId,
        title: pl.title,
        description: pl.description,
        videoCount: pl.itemCount,
      };
    },
    async getPlaylistVideos(
      playlistId: PlaylistId,
      opts: PlaylistVideoOptions = {}
    ): Promise<readonly PlaylistVideoItem[]> {
      // Forward the tolerant-page-fetch skip callback so degenerate
      // (private/deleted) or shape-mismatched items surface to the caller
      // instead of vanishing silently at the page boundary. Forward
      // maxResults too so the client stops paginating once the cap is hit
      // (real quota saving) rather than fetching the whole playlist first.
      const items = await client.getPlaylistItems(playlistId, {
        onSkipped: adapterOpts?.onSkipped,
        maxResults: opts.maxResults,
      });
      // Belt-and-braces: the client already returns at most maxResults; this
      // slice is a harmless defensive guard at the adapter boundary.
      const capped = opts.maxResults !== undefined ? items.slice(0, opts.maxResults) : items;
      return capped.map((it) => ({
        videoId: it.videoId,
        title: it.title ?? '',
        channelId: it.channelId ?? '',
        channelTitle: it.channelTitle ?? '',
        addedAt: it.addedAt ?? '',
        position: it.position,
      }));
    },
    async getVideoDetails(videoId: VideoId): Promise<VideoDetails | null> {
      const v = await client.getVideoById(videoId);
      if (v === null) return null;
      return {
        videoId: v.videoId,
        title: v.title,
        description: v.description,
        channelId: v.channelId,
        channelTitle: v.channelTitle,
        publishedAt: v.publishedAt,
        duration: v.duration,
        durationSeconds: v.durationSeconds,
        isShort: v.isShort,
        viewCount: v.viewCount ?? 0,
        likeCount: v.likeCount ?? 0,
        commentCount: v.commentCount ?? 0,
        tags: v.tags ?? [],
        categoryId: v.categoryId,
        // Map definition ('hd'/'sd') through so the DB write persists it.
        // Wave 1 made toVideo() copy contentDetails.definition onto
        // YouTubeVideo; without this the adapter dropped it and the column
        // stored NULL despite the full schema/column/write plumbing existing
        // (PARITY.md section D, task 7).
        definition: v.definition,
        caption: v.caption,
        licensedContent: v.licensedContent,
      };
    },
  };
}

/**
 * Map v2's discriminated-union ExtractProgressEvent into the ProgressDisplay
 * state shape. The parity-close cycle enriched this from a coarse status enum
 * to the FULL Python-style in-run display: `currentVideo` is set from each
 * event's `title`, `stepLines` accumulates the granular per-video result lines,
 * and `whisperProgress` drives the live Whisper bar.
 */
export type ProgressState = {
  current: number;
  total: number;
  currentVideo: string;
  status:
    | 'downloading'
    | 'downloading_audio'
    | 'whisper_transcribing'
    | 'transcribing'
    | 'parsing'
    | 'saving'
    | 'completed';
  successCount: number;
  failureCount: number;
  skippedCount: number;
  /**
   * Per-video step-result lines for the CURRENT video. Reset on each new
   * video's first event (`fetch_meta`); appended on the per-step RESULT events.
   */
  stepLines: readonly string[];
  whisperProgress?: {
    stage: 'downloading' | 'transcribing' | 'complete';
    percentage?: number;
    message?: string;
  };
};

export function mapEventToProgress(
  event: ExtractProgressEvent,
  setProgress: React.Dispatch<React.SetStateAction<ProgressState>>
): void {
  switch (event.kind) {
    case 'job_started':
      setProgress((prev) => ({ ...prev, total: event.total, current: 0 }));
      return;
    case 'fetch_meta':
      // First event for each video — reset the per-video accumulators so the
      // step lines and Whisper bar belong to THIS video, not the previous one.
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        status: 'downloading',
        stepLines: [],
        whisperProgress: undefined,
      }));
      return;
    case 'persist':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        status: 'downloading',
      }));
      return;
    case 'transcribe':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        status: 'transcribing',
      }));
      return;
    case 'whisper':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        status: 'whisper_transcribing',
      }));
      return;
    case 'gemini':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        status: 'parsing',
      }));
      return;
    case 'meta_result':
      // Channel · duration line.
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        stepLines: [...prev.stepLines, formatMetaLine(event.channel, event.durationSeconds)],
      }));
      return;
    case 'transcript_result': {
      // Transcript source + char count; a 'whisper'/'none' result also means
      // the Whisper bar is done, so clear it.
      const line = formatTranscriptLine(event.source, event.charCount);
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        stepLines: [...prev.stepLines, line],
        whisperProgress: undefined,
      }));
      return;
    }
    case 'entities_result': {
      // Combined (description + Gemini) entity counts. Suppress the line when
      // everything is zero — Python only printed counts when it found something.
      const line = formatEntitiesLine(
        event.githubRepos,
        event.websites,
        event.topics,
        event.people
      );
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        stepLines: line ? [...prev.stepLines, line] : prev.stepLines,
      }));
      return;
    }
    case 'whisper_progress':
      // Live Whisper percentage. Clear the bar once the stage reports complete.
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        status: 'whisper_transcribing',
        whisperProgress:
          event.stage === 'complete'
            ? undefined
            : { stage: event.stage, percentage: event.percent },
      }));
      return;
    case 'video_done':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        successCount: prev.successCount + 1,
      }));
      return;
    case 'video_skipped':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        skippedCount: prev.skippedCount + 1,
        // Clear the per-video accumulators so a skipped video's stale step
        // lines / Whisper bar don't linger until the next fetch_meta resets
        // them (symmetric with fetch_meta).
        stepLines: [],
        whisperProgress: undefined,
      }));
      return;
    case 'video_failed':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        currentVideo: event.title,
        failureCount: prev.failureCount + 1,
        // Clear the per-video accumulators so a failed video's stale step
        // lines / Whisper bar don't linger until the next fetch_meta resets
        // them (symmetric with fetch_meta).
        stepLines: [],
        whisperProgress: undefined,
      }));
      return;
    case 'job_completed':
      setProgress((prev) => ({
        ...prev,
        status: 'completed',
        successCount: event.result.processed,
        failureCount: event.result.failed,
        skippedCount: event.result.skipped,
      }));
      return;
  }
}

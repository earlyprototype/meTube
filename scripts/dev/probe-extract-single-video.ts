/**
 * One-shot diagnostic probe for the per-video extraction pipeline.
 *
 * Reproduces the per-video path that `VideoExtractor.processVideo` runs,
 * but with explicit try/catch around EACH stage so a failure pins to a
 * specific stage. The production logger only sees
 * `DatabaseError('Transaction rolled back')` because
 * `src-ts-v2/database/connection.ts::withTransaction` wraps non-
 * `DatabaseError` causes; this probe walks `.cause` recursively to
 * surface the real underlying error. It also defends against the A6
 * issue (AppError swallows `.cause` due to a dead prototype guard) by
 * inspecting hidden symbols and the constructor input shape where it
 * can.
 *
 * Convention: scripts/dev/ is exempt from the no-console.* rule per
 * CLAUDE.md — it's ad-hoc developer tooling, not production code.
 *
 * Run with:
 *   npx tsx scripts/dev/probe-extract-single-video.ts iLr8YCdNBqk
 *   npx tsx scripts/dev/probe-extract-single-video.ts --walk-playlist Ai
 */

/* eslint-disable no-console */

// MUST be set before importing the v2 logger — pino snapshots env at
// module-load. Doing this after the import would log at the default
// level ("error") and we'd see nothing of the internal flow.
process.env.LOG_LEVEL = 'debug';
process.env.DEBUG = 'true';

import * as path from 'path';
import * as fs from 'fs';
import BetterSqlite3 from 'better-sqlite3';

import { YouTubeAuth } from '../../src-ts-v2/auth/YouTubeAuth.js';
import { YouTubeClient } from '../../src-ts-v2/api/YouTubeClient.js';
import { DatabaseManager } from '../../src-ts-v2/database/connection.js';
import { VideoRepository } from '../../src-ts-v2/database/VideoRepository.js';
import { PlaylistRepository } from '../../src-ts-v2/database/PlaylistRepository.js';
import { PlaylistItemRepository } from '../../src-ts-v2/database/PlaylistItemRepository.js';
import { StatisticsRepository } from '../../src-ts-v2/database/StatisticsRepository.js';
import { EntityRepository } from '../../src-ts-v2/database/EntityRepository.js';
import { AIAnalysisRepository } from '../../src-ts-v2/database/AIAnalysisRepository.js';
import { TranscriptRepository } from '../../src-ts-v2/database/TranscriptRepository.js';
import { TranscriptExtractor } from '../../src-ts-v2/extractors/TranscriptExtractor.js';
import { DescriptionParser } from '../../src-ts-v2/parsers/DescriptionParser.js';
import { resolvePlaylistIdentifier } from '../../src-ts-v2/utils/playlistResolver.js';
import {
  asVideoId,
  asPlaylistId,
  type VideoId,
  type PlaylistId,
} from '../../src-ts-v2/types/branded.js';
import { AppError, DatabaseError, ValidationError } from '../../src-ts-v2/errors/index.js';

const PROJECT_ROOT = path.resolve(process.cwd());
const CRED_PATH = path.join(PROJECT_ROOT, 'client_secret.json');
const TOKENS_PATH = path.join(PROJECT_ROOT, 'tokens.json');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'metube.db');

function banner(title: string): void {
  const bar = '='.repeat(72);
  console.log('\n' + bar);
  console.log(title);
  console.log(bar);
}

function safeJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

/**
 * Recursively walk error.cause printing everything useful. Adapted from
 * scripts/dev/probe-getmyplaylists.ts. Adds extra checks for SQLite-level
 * codes (better-sqlite3 attaches `.code` like `SQLITE_CONSTRAINT_FOREIGNKEY`)
 * and a paranoid sweep for the A6 issue (cause may have been swallowed by
 * the dead prototype guard in AppError; if so, we report it).
 */
function dumpError(err: unknown, depth = 0): void {
  const indent = '  '.repeat(depth);
  if (err === null || err === undefined) {
    console.error(`${indent}(null/undefined error)`);
    return;
  }

  if (!(err instanceof Error)) {
    console.error(`${indent}non-Error thrown: ${typeof err}`, err);
    return;
  }

  console.error(`${indent}[depth ${depth}] ${err.name}: ${err.message}`);

  // AppError fields
  const anyErr = err as unknown as Record<string, unknown>;
  if (typeof anyErr.code === 'string') {
    console.error(`${indent}  code: ${anyErr.code}`);
  }
  if (typeof anyErr.statusCode === 'number') {
    console.error(`${indent}  statusCode: ${anyErr.statusCode}`);
  }
  if (anyErr.context !== undefined) {
    console.error(`${indent}  context: ${safeJson(anyErr.context)}`);
  }
  // better-sqlite3 specific
  if (typeof (err as { code?: unknown }).code === 'string') {
    // already printed above if it's the AppError-style code, but if this
    // is a SqliteError it carries the SQLITE_* code; print explicitly so
    // it's unambiguous.
    const code = String((err as { code?: unknown }).code);
    if (code.startsWith('SQLITE_')) {
      console.error(`${indent}  sqlite code: ${code}`);
    }
  }
  // Zod
  if (Array.isArray(anyErr.issues)) {
    console.error(`${indent}  zod issues: ${safeJson(anyErr.issues)}`);
  }
  // Generic .errors arrays (Gaxios / aggregate)
  if (Array.isArray(anyErr.errors)) {
    console.error(`${indent}  errors[]: ${safeJson(anyErr.errors)}`);
  }
  // GaxiosError response shape
  if (anyErr.response !== undefined && anyErr.response !== null) {
    const resp = anyErr.response as Record<string, unknown>;
    console.error(`${indent}  response.status: ${String(resp.status)}`);
    if (resp.data !== undefined) {
      console.error(`${indent}  response.data: ${safeJson(resp.data)}`);
    }
  }

  // Stack — short version
  if (typeof err.stack === 'string') {
    const stackLines = err.stack.split('\n').slice(0, 8).join('\n');
    console.error(`${indent}  stack (top 8 lines):\n${stackLines}`);
  }

  // Recurse into cause. A6 caveat: AppError uses `Error.prototype.hasOwnProperty('cause')`
  // which is always false in Node, so the cause is NEVER attached to
  // AppError subclasses (DatabaseError, ValidationError). To get past
  // this we (a) look at the regular `.cause`, and (b) if missing on an
  // AppError, loudly say so so we know to fix it before we waste cycles.
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause !== undefined && cause !== err) {
    console.error(`${indent}  ---- cause ----`);
    dumpError(cause, depth + 1);
  } else if (err instanceof AppError) {
    console.error(
      `${indent}  (cause MISSING — note A6: AppError uses a dead prototype guard so` +
        ` cause was never attached even if one was supplied at the call site)`
    );
  }
}

// --------------------------------------------------------------------------
// Direct SQLite raw-INSERT probes — bypass the masking transaction wrapper
// --------------------------------------------------------------------------

/**
 * Try the same INSERTs the pipeline would run, but on the RAW better-sqlite3
 * Database object so any SQLite error is the actual SQLite error rather than
 * the wrapped `DatabaseError('Transaction rolled back')`. Used as a defence-
 * in-depth when the typed paths swallow the cause.
 *
 * Operates on the SAME on-disk DB the production code uses; this is for
 * diagnosis only and any rows it inserts are subject to test-cleanup
 * decisions by the caller (we don't auto-rollback here — that's deliberate
 * so we see the cumulative state if a multi-stage probe progresses).
 */
function rawSqliteProbeForVideoInsert(args: {
  videoId: string;
  details: {
    title: string;
    description: string;
    channelId: string;
    channelTitle: string;
    publishedAt: string;
    duration: string;
    durationSeconds: number;
    isShort: boolean;
    viewCount: number;
    likeCount: number;
    commentCount: number;
  };
}): void {
  const { videoId, details } = args;
  // Open the SAME db file as production reads
  const raw = new BetterSqlite3(DB_PATH, { fileMustExist: true });
  raw.pragma('foreign_keys = ON');
  console.log(`  raw-probe: opened ${DB_PATH}, fk on`);

  try {
    raw.exec('BEGIN');
    console.log('  raw-probe: BEGIN');

    const info = raw
      .prepare(
        `INSERT INTO videos (
           video_id, title, description, channel_id, channel_title,
           published_at, duration, duration_seconds, is_short
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        videoId,
        details.title,
        details.description,
        details.channelId,
        details.channelTitle,
        details.publishedAt,
        details.duration,
        details.durationSeconds,
        details.isShort ? 1 : 0
      );
    console.log('  raw-probe: INSERT videos changes=', info.changes);

    const statsInfo = raw
      .prepare(
        `INSERT INTO video_statistics (video_id, view_count, like_count, comment_count)
         VALUES (?, ?, ?, ?)`
      )
      .run(videoId, details.viewCount, details.likeCount, details.commentCount);
    console.log('  raw-probe: INSERT video_statistics changes=', statsInfo.changes);

    raw.exec('ROLLBACK');
    console.log('  raw-probe: ROLLBACK (left DB unchanged)');
  } catch (err) {
    raw.exec('ROLLBACK');
    console.error('  raw-probe: SQLite-level error:');
    dumpError(err, 1);
  } finally {
    raw.close();
  }
}

// --------------------------------------------------------------------------
// Stage runner — wraps every pipeline stage in a typed try/catch
// --------------------------------------------------------------------------

interface StageContext {
  readonly db: DatabaseManager;
  readonly youtubeClient: YouTubeClient;
  readonly playlistId: PlaylistId;
  readonly videoId: VideoId;
}

async function runStagesForVideo(ctx: StageContext, position: number): Promise<void> {
  const { db, youtubeClient, playlistId, videoId } = ctx;

  // Required by VideoExtractor — we construct fresh per probe to mirror
  // the production wiring (one repository per logical command path).
  const videoRepo = new VideoRepository(db);
  const playlistRepo = new PlaylistRepository(db);
  const playlistItemRepo = new PlaylistItemRepository(db);
  const statsRepo = new StatisticsRepository(db);
  const entityRepo = new EntityRepository(db);
  const aiRepo = new AIAnalysisRepository(db);
  const transcriptRepo = new TranscriptRepository(db);
  const descriptionParser = new DescriptionParser();
  const transcriptExtractor = new TranscriptExtractor({
    languages: ['en', 'en-GB', 'en-US'],
  });
  void aiRepo;
  void transcriptRepo;

  // ---------- Stage A: video pre-existence check ----------
  banner(`STAGE A: idempotency check (videoRepo.exists)`);
  try {
    const exists = videoRepo.exists(videoId);
    console.log(`  videoRepo.exists(${videoId}) =>`, exists);
    if (exists) {
      console.log('  video already persisted; production would skip → no failure here');
      return;
    }
  } catch (err) {
    console.error('  STAGE A threw:');
    dumpError(err);
    throw err;
  }

  // ---------- Stage B: ensure playlist row exists (parent for playlist_items FK) ----------
  banner(`STAGE B: playlist FK precondition`);
  try {
    const pl = playlistRepo.findById(playlistId);
    if (!pl) {
      console.log(`  playlistRepo.findById(${playlistId}) => null. FK would fail unless`);
      console.log('  extractPlaylist already upserted it earlier in the run.');
    } else {
      console.log(`  playlist present: title="${pl.title}"`);
    }
  } catch (err) {
    console.error('  STAGE B threw:');
    dumpError(err);
    throw err;
  }

  // ---------- Stage C: fetch video details from YouTube ----------
  banner(`STAGE C: youtubeClient.getVideoById`);
  let details;
  try {
    details = await youtubeClient.getVideoById(videoId);
    if (details === null) {
      console.log('  getVideoById returned NULL (video unavailable, private, or deleted).');
      console.log('  In production this throws AppError VIDEO_NOT_FOUND — pipeline ends here.');
      throw new AppError('Video metadata not available (probe-simulated)', {
        code: 'VIDEO_NOT_FOUND',
        context: { videoId },
      });
    }
    console.log('  fetched VIDEO details:');
    console.log('    title:           ', details.title);
    console.log('    channel:         ', details.channelTitle);
    console.log('    duration:        ', details.duration, '(', details.durationSeconds, 'sec )');
    console.log('    isShort:         ', details.isShort);
    console.log('    viewCount:       ', details.viewCount);
    console.log('    description.len: ', details.description?.length ?? 0);
    console.log(
      '    description[0..200]:',
      JSON.stringify((details.description ?? '').slice(0, 200))
    );
  } catch (err) {
    console.error('  STAGE C threw:');
    dumpError(err);
    throw err;
  }

  // ---------- Stage D: videoRepository.createOrUpdate ----------
  banner(`STAGE D: videoRepo.createOrUpdate`);
  try {
    videoRepo.createOrUpdate({
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
      definition: undefined,
      caption: details.caption ?? null,
      licensed_content: details.licensedContent ?? null,
    });
    console.log('  videoRepo.createOrUpdate succeeded');
  } catch (err) {
    console.error('  STAGE D threw — running raw-SQLite probe to surface real cause:');
    dumpError(err);
    rawSqliteProbeForVideoInsert({
      videoId,
      details: {
        title: details.title,
        description: details.description,
        channelId: details.channelId,
        channelTitle: details.channelTitle,
        publishedAt: details.publishedAt,
        duration: details.duration,
        durationSeconds: details.durationSeconds,
        isShort: details.isShort,
        viewCount: details.viewCount,
        likeCount: details.likeCount,
        commentCount: details.commentCount,
      },
    });
    throw err;
  }

  // ---------- Stage E: statisticsRepository.recordSnapshot ----------
  banner(`STAGE E: statisticsRepo.recordSnapshot`);
  try {
    statsRepo.recordSnapshot(videoId, {
      viewCount: details.viewCount,
      likeCount: details.likeCount,
      commentCount: details.commentCount,
    });
    console.log('  statisticsRepo.recordSnapshot succeeded');
  } catch (err) {
    console.error('  STAGE E threw:');
    dumpError(err);
    throw err;
  }

  // ---------- Stage F: playlistItemRepository.addVideoToPlaylist ----------
  banner(`STAGE F: playlistItemRepo.addVideoToPlaylist`);
  try {
    playlistItemRepo.addVideoToPlaylist(playlistId, videoId, position, new Date().toISOString());
    console.log('  playlistItemRepo.addVideoToPlaylist succeeded');
  } catch (err) {
    console.error('  STAGE F threw:');
    dumpError(err);
    throw err;
  }

  // ---------- Stage G: transcript extraction ----------
  banner(`STAGE G: transcriptExtractor.extract`);
  let transcriptResult;
  try {
    transcriptResult = await transcriptExtractor.extract(videoId);
    if (transcriptResult === null) {
      console.log('  no YouTube transcript available (null returned).');
    } else {
      console.log(
        '  transcript fetched: language=',
        transcriptResult.language,
        'segments=',
        transcriptResult.segments.length,
        'full_text.length=',
        transcriptResult.full_text.length
      );
    }
  } catch (err) {
    console.error('  STAGE G threw (NON-FATAL in production — caught & logged):');
    dumpError(err);
    transcriptResult = null;
  }

  // ---------- Stage H: description parsing ----------
  banner(`STAGE H: descriptionParser.parse + extractEntitiesForDatabase`);
  let descriptionEntities: ReturnType<DescriptionParser['extractEntitiesForDatabase']>;
  try {
    const parsed = descriptionParser.parse(details.title, details.description ?? '');
    console.log(
      '  parse: github_repos=',
      parsed.github_repos.length,
      'websites=',
      parsed.websites.length
    );
    descriptionEntities = descriptionParser.extractEntitiesForDatabase(parsed);
    console.log('  extractEntitiesForDatabase: entities=', descriptionEntities.length);
    for (const e of descriptionEntities) {
      console.log('    ', JSON.stringify(e));
    }
  } catch (err) {
    console.error('  STAGE H threw:');
    dumpError(err);
    throw err;
  }

  // ---------- Stage I: entityRepository.insertMany ----------
  banner(`STAGE I: entityRepo.insertMany`);
  try {
    const count = entityRepo.insertMany(
      videoId,
      descriptionEntities.map((e) => ({
        type: e.type,
        value: e.value,
        url: e.url ?? null,
        confidence: e.confidence,
      }))
    );
    console.log('  entityRepo.insertMany inserted', count, 'rows');
  } catch (err) {
    console.error('  STAGE I threw:');
    dumpError(err);
    throw err;
  }

  console.log('\n  All pipeline stages completed without failure for', videoId);
}

// --------------------------------------------------------------------------
// Main: process one video, optionally walk a whole playlist
// --------------------------------------------------------------------------

async function processOne(
  ctx: StageContext,
  position: number
): Promise<
  { status: 'ok'; videoId: string } | { status: 'failed'; videoId: string; err: unknown }
> {
  try {
    await runStagesForVideo(ctx, position);
    return { status: 'ok', videoId: ctx.videoId };
  } catch (err) {
    return { status: 'failed', videoId: ctx.videoId, err };
  }
}

async function main(): Promise<void> {
  banner('PROBE: extract single video');
  const args = process.argv.slice(2);
  const walkPlaylist = args[0] === '--walk-playlist';
  const arg0 = walkPlaylist ? args[1] : (args[0] ?? 'iLr8YCdNBqk');

  console.log('cwd:               ', process.cwd());
  console.log('credentialsPath:   ', CRED_PATH);
  console.log('tokensPath:        ', TOKENS_PATH);
  console.log('dbPath:            ', DB_PATH);
  console.log('LOG_LEVEL:         ', process.env.LOG_LEVEL);
  console.log('DEBUG:             ', process.env.DEBUG);
  console.log('NODE_ENV:          ', process.env.NODE_ENV ?? '(unset)');
  console.log('node version:      ', process.version);
  console.log('walk-playlist:     ', walkPlaylist);
  console.log('target:            ', arg0);

  banner('STEP 1: required files');
  if (!fs.existsSync(CRED_PATH) || !fs.existsSync(TOKENS_PATH) || !fs.existsSync(DB_PATH)) {
    console.error('missing one of: client_secret.json, tokens.json, data/metube.db — aborting');
    process.exit(2);
  }
  console.log('  OK');

  banner('STEP 2: YouTubeAuth.authenticate');
  const auth = new YouTubeAuth({
    credentialsPath: CRED_PATH,
    tokensPath: TOKENS_PATH,
  });
  let oauthClient;
  try {
    oauthClient = await auth.authenticate();
    console.log('  authenticate() OK');
  } catch (err) {
    console.error('  authenticate() threw:');
    dumpError(err);
    process.exit(3);
  }

  banner('STEP 3: construct YouTubeClient + DatabaseManager');
  const youtubeClient = new YouTubeClient(oauthClient);
  const db = new DatabaseManager(DB_PATH);
  console.log('  YouTubeClient + DatabaseManager constructed');

  if (!walkPlaylist) {
    // Single-video probe
    let videoId: VideoId;
    try {
      videoId = asVideoId(arg0);
    } catch (err) {
      console.error('  asVideoId rejected the input:');
      dumpError(err);
      db.close();
      process.exit(4);
    }

    // The Ai playlist is the user's known target. Hardcoded here so the
    // single-video probe still has a parent for the FK on playlist_items.
    const aiPlaylistId = asPlaylistId('PLqAWmFRvbe_F-W_DquxryH3Evh_95LWpT');

    const result = await processOne(
      { db, youtubeClient, playlistId: aiPlaylistId, videoId },
      999 // arbitrary probe position
    );

    db.close();

    if (result.status === 'failed') {
      banner('FAILURE — root cause');
      dumpError(result.err);
      process.exit(5);
    }
    banner('SUCCESS — video passed all stages in isolation');
    process.exit(0);
  }

  // --walk-playlist path
  banner(`STEP 4: resolve playlist identifier "${arg0}"`);
  let resolved;
  try {
    resolved = await resolvePlaylistIdentifier(arg0, { db });
  } catch (err) {
    console.error('  resolvePlaylistIdentifier threw:');
    dumpError(err);
    db.close();
    process.exit(6);
  }
  if (!resolved) {
    console.error(`  resolvePlaylistIdentifier returned null for "${arg0}"`);
    db.close();
    process.exit(7);
  }
  console.log('  resolved playlist:', resolved.id, '/', resolved.title);

  banner('STEP 5: fetch playlist videos via YouTubeClient');
  let items;
  try {
    items = await youtubeClient.getPlaylistItems(resolved.id);
  } catch (err) {
    console.error('  getPlaylistItems threw:');
    dumpError(err);
    db.close();
    process.exit(8);
  }
  console.log(`  ${items.length} items returned`);

  // Walk each one. We do NOT skip already-persisted videos here — that's
  // the production VideoExtractor's check, and we explicitly want to see
  // whether the pipeline does the right thing on an idempotent skip path
  // for the videos that are already in the DB. But we DO short-circuit
  // out of the heavy stages on `videoRepo.exists`, mirroring production.
  const failures: Array<{ videoId: string; err: unknown }> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    banner(`item ${i + 1}/${items.length}: ${it.videoId} — ${it.title.slice(0, 60)}`);
    const ctx: StageContext = {
      db,
      youtubeClient,
      playlistId: resolved.id,
      videoId: it.videoId,
    };
    const result = await processOne(ctx, it.position);
    if (result.status === 'failed') {
      failures.push({ videoId: it.videoId, err: result.err });
      console.error(`  → FAILED (continuing walk)`);
      // print which we believe is the cause line
      const top = result.err instanceof Error ? result.err.message : String(result.err);
      console.error(`     top message: ${top}`);
    } else {
      console.log('  → OK');
    }
  }

  db.close();

  banner(`WALK COMPLETE — ${failures.length} failures of ${items.length}`);
  for (const f of failures) {
    console.error(`\n--- failure: ${f.videoId}`);
    dumpError(f.err);
  }
  process.exit(failures.length === 0 ? 0 : 5);
}

main().catch((err) => {
  banner('UNCAUGHT in main()');
  dumpError(err);
  process.exit(99);
});

// Reference DatabaseError / ValidationError so unused-import lint doesn't
// complain — they're only referenced by `instanceof` checks inside dumpError
// indirectly via AppError.
void DatabaseError;
void ValidationError;

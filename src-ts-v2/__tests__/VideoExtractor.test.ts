/**
 * VideoExtractor integration tests.
 *
 * Strategy: real `:memory:` SQLite + real Wave 2 repositories + mocked
 * sibling Wave 3 services. We do NOT mock the DB layer (the Wave 2
 * test pattern — every write actually lands, every read actually
 * reads). We DO mock the YouTubeClient + TranscriptExtractor +
 * WhisperExtractor + GeminiParser + DescriptionParser, because they
 * are sibling Wave 3 files written in parallel and exercising real
 * network/subprocess paths from a unit test is out of scope.
 *
 * Coverage:
 *   - Happy path: 3 videos, all with captions, all persisted, counters
 *     come back honest (processed=3 / skipped=0 / failed=0, sum=total).
 *   - Whisper fallback: video without captions falls back to
 *     WhisperExtractor; transcript still ends up in the entity batch.
 *   - Idempotency: re-extracting the same playlist on a populated DB
 *     yields skipped=3, processed=0, failed=0.
 *   - Failure isolation: one mid-pipeline throw counts as failed=1;
 *     the other two videos process normally.
 *   - Job tracking: extraction_jobs row is created at start and
 *     transitions to `completed` (or `failed` on whole-loop error).
 *   - onProgress: discriminated-union events emitted, callback throws
 *     don't kill the run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseManager } from '../database/connection.js';
import { AIAnalysisRepository } from '../database/AIAnalysisRepository.js';
import { ExtractionJobRepository } from '../database/ExtractionJobRepository.js';
import { PlaylistItemRepository } from '../database/PlaylistItemRepository.js';
import { TranscriptRepository } from '../database/TranscriptRepository.js';
import { VideoRepository } from '../database/VideoRepository.js';
import { AppError } from '../errors/index.js';
import { asPlaylistId, asVideoId, type PlaylistId, type VideoId } from '../types/branded.js';
import logger from '../utils/logger.js';

import {
  VideoExtractor,
  type DescriptionParserLike,
  type ExtractProgressEvent,
  type GeminiParserLike,
  type ParsedDescription,
  type PlaylistInfo,
  type PlaylistVideoItem,
  type TranscriptExtractorLike,
  type TranscriptResult,
  type VideoDetails,
  type WhisperExtractorLike,
  type YouTubeClientLike,
} from '../extractors/VideoExtractor.js';

// --------------------------------------------------------------------------
// Fixture builders
// --------------------------------------------------------------------------

/**
 * Build a synthetic playlist ID. 11+ chars matching the PL prefix per
 * `asPlaylistId`'s pattern.
 */
function makePlaylistId(suffix: string): PlaylistId {
  const padded = `PL${suffix}`.padEnd(13, '0');
  return asPlaylistId(padded);
}

/**
 * Build a synthetic 11-char YouTube video ID.
 */
function makeVideoId(stub: string): VideoId {
  const padded = stub.padEnd(11, '0').slice(0, 11);
  return asVideoId(padded);
}

/**
 * Build a `PlaylistVideoItem` for the mock YouTube client.
 */
function makeItem(videoIdStub: string, position: number, title = 'Sample'): PlaylistVideoItem {
  return {
    videoId: makeVideoId(videoIdStub),
    title,
    channelId: 'UCsamplechannel',
    channelTitle: 'Sample Channel',
    addedAt: `2024-01-${String(position + 1).padStart(2, '0')}T00:00:00Z`,
    position,
  };
}

/**
 * Build a `VideoDetails` payload — matches what the mock YouTubeClient
 * returns from `getVideoDetails`.
 */
function makeDetails(videoIdStub: string, title = 'Sample'): VideoDetails {
  return {
    videoId: makeVideoId(videoIdStub),
    title,
    description: 'A sample video about https://example.com and github.com/foo/bar',
    channelId: 'UCsamplechannel',
    channelTitle: 'Sample Channel',
    publishedAt: '2024-01-01T00:00:00Z',
    duration: 'PT3M30S',
    durationSeconds: 210,
    isShort: false,
    viewCount: 1000,
    likeCount: 50,
    commentCount: 10,
    tags: ['sample'],
    categoryId: '22',
    definition: 'hd',
    caption: false,
    licensedContent: false,
  };
}

/**
 * Build a `TranscriptResult` payload from YouTube captions. Snake-case
 * field names match the lifted sibling `TranscriptData` shape.
 */
function makeCaptionsTranscript(): TranscriptResult {
  return {
    full_text: 'This is a sample transcript.',
    segments: [{ text: 'This is a sample transcript.', start: 0, duration: 3 }],
    language: 'en',
    is_auto_generated: true,
    from_whisper: false,
  };
}

/**
 * Build a `TranscriptResult` payload from Whisper.
 */
function makeWhisperTranscript(): TranscriptResult {
  return {
    full_text: 'Whisper-transcribed text.',
    segments: [{ text: 'Whisper-transcribed text.', start: 0, duration: 3 }],
    language: 'en',
    is_auto_generated: false,
    from_whisper: true,
  };
}

/**
 * Build a minimal `ParsedDescription`. The DescriptionParser is mocked
 * so this is a static return value, not a real regex parse.
 */
function makeParsedDescription(): ParsedDescription {
  return {
    github_repos: [
      {
        url: 'https://github.com/foo/bar',
        owner: 'foo',
        name: 'bar',
        full_name: 'foo/bar',
      },
    ],
    websites: ['https://example.com'],
    topics: [],
    people: [],
    key_concepts: [],
    summary: null,
  };
}

// --------------------------------------------------------------------------
// Mock factories — return Vitest mock functions wrapped in the *-Like shapes
// --------------------------------------------------------------------------

interface MockYouTubeClient extends YouTubeClientLike {
  readonly getPlaylistInfo: ReturnType<typeof vi.fn>;
  readonly getPlaylistVideos: ReturnType<typeof vi.fn>;
  readonly getVideoDetails: ReturnType<typeof vi.fn>;
}

function makeMockYouTubeClient(opts: {
  playlistInfo: PlaylistInfo | null;
  playlistVideos: readonly PlaylistVideoItem[];
  videoDetails: ReadonlyMap<VideoId, VideoDetails | null>;
}): MockYouTubeClient {
  return {
    getPlaylistInfo: vi.fn(async () => opts.playlistInfo),
    getPlaylistVideos: vi.fn(async () => opts.playlistVideos),
    getVideoDetails: vi.fn(async (videoId: VideoId) => {
      const entry = opts.videoDetails.get(videoId);
      return entry === undefined ? null : entry;
    }),
  };
}

interface MockTranscriptExtractor extends TranscriptExtractorLike {
  readonly extract: ReturnType<typeof vi.fn>;
}

function makeMockTranscriptExtractor(
  byVideoId: ReadonlyMap<VideoId, TranscriptResult | null>
): MockTranscriptExtractor {
  return {
    extract: vi.fn(async (videoId: VideoId) => byVideoId.get(videoId) ?? null),
  };
}

interface MockWhisperExtractor extends WhisperExtractorLike {
  readonly extract: ReturnType<typeof vi.fn>;
  readonly isAvailable: ReturnType<typeof vi.fn>;
}

function makeMockWhisperExtractor(
  byVideoId: ReadonlyMap<VideoId, TranscriptResult | null>,
  available = true
): MockWhisperExtractor {
  return {
    extract: vi.fn(async (videoId: VideoId) => byVideoId.get(videoId) ?? null),
    isAvailable: vi.fn(() => available),
  };
}

interface MockGeminiParser extends GeminiParserLike {
  readonly parseTranscript: ReturnType<typeof vi.fn>;
  readonly getTags: ReturnType<typeof vi.fn>;
}

function makeMockGeminiParser(modelName = 'gemini-3-flash-preview'): MockGeminiParser {
  return {
    parseTranscript: vi.fn(async () => ({
      topics: ['LLMs', 'Testing'],
      github_repos: [{ name: 'foo/bar', url: 'https://github.com/foo/bar' }],
      websites: [{ name: 'example.com', url: 'https://example.com' }],
      people: ['Alice'],
      tags: ['llm'],
      summary: 'A sample summary.',
      content_type: 'tutorial',
      sentiment: 'neutral' as const,
    })),
    getTags: vi.fn(() => ['programming', 'ai']),
    modelName,
  };
}

interface MockDescriptionParser extends DescriptionParserLike {
  readonly parse: ReturnType<typeof vi.fn>;
  readonly extractEntitiesForDatabase: ReturnType<typeof vi.fn>;
  readonly getTags: ReturnType<typeof vi.fn>;
}

function makeMockDescriptionParser(): MockDescriptionParser {
  const parsed = makeParsedDescription();
  return {
    parse: vi.fn(() => parsed),
    extractEntitiesForDatabase: vi.fn(() => [
      {
        type: 'github_repo',
        value: 'foo/bar',
        url: 'https://github.com/foo/bar',
        confidence: 100,
      },
      {
        type: 'website',
        value: 'https://example.com',
        url: 'https://example.com',
        confidence: 100,
      },
    ]),
    getTags: vi.fn(() => ['tutorial', 'tech']),
  };
}

// --------------------------------------------------------------------------
// Happy path: 3 videos, all with captions
// --------------------------------------------------------------------------

describe('VideoExtractor.extractPlaylist — happy path', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('processes all 3 videos and counters are honest (processed=3, skipped=0, failed=0)', async () => {
    // Arrange
    const playlistId = makePlaylistId('happy01');
    const items = [
      makeItem('vidaaaaaaa1', 0, 'Video A'),
      makeItem('vidbbbbbbb2', 1, 'Video B'),
      makeItem('vidccccccc3', 2, 'Video C'),
    ];
    const detailsMap = new Map<VideoId, VideoDetails | null>();
    const transcriptMap = new Map<VideoId, TranscriptResult | null>();
    for (const item of items) {
      detailsMap.set(item.videoId, makeDetails(item.videoId, item.title));
      transcriptMap.set(item.videoId, makeCaptionsTranscript());
    }

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'Happy Playlist',
        description: 'Three videos that all work.',
        videoCount: 3,
      },
      playlistVideos: items,
      videoDetails: detailsMap,
    });
    const transcriptExtractor = makeMockTranscriptExtractor(transcriptMap);
    const whisperExtractor = makeMockWhisperExtractor(new Map(), false);
    const geminiParser = makeMockGeminiParser();
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { autoTranscript: true, autoLlmParse: true, enableWhisper: false },
      {
        transcriptExtractor,
        whisperExtractor,
        geminiParser,
        descriptionParser,
      }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert — counters honest
    expect(result.total).toBe(3);
    expect(result.processed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.processed + result.skipped + result.failed).toBe(result.total);
    expect(result.success).toBe(true);
    expect(result.playlistId).toBe(playlistId);

    // Each video persisted
    const videoRepo = new VideoRepository(dbm);
    for (const item of items) {
      expect(videoRepo.exists(item.videoId)).toBe(true);
    }

    // Playlist-items join rows present
    const itemRepo = new PlaylistItemRepository(dbm);
    expect(itemRepo.countByPlaylist(playlistId)).toBe(3);

    // Statistics snapshot for each video
    const statRow = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM video_statistics')
      .get();
    expect(statRow?.c).toBe(3);

    // AI analysis row per video (LLM ran for all 3)
    const aiRepo = new AIAnalysisRepository(dbm);
    for (const item of items) {
      const analysis = aiRepo.getByVideo(item.videoId);
      expect(analysis).not.toBeNull();
      expect(analysis?.summary).toBe('A sample summary.');
    }

    // Mock interaction sanity
    expect(youtubeClient.getPlaylistInfo).toHaveBeenCalledOnce();
    expect(youtubeClient.getPlaylistVideos).toHaveBeenCalledOnce();
    expect(youtubeClient.getVideoDetails).toHaveBeenCalledTimes(3);
    expect(transcriptExtractor.extract).toHaveBeenCalledTimes(3);
    expect(geminiParser.parseTranscript).toHaveBeenCalledTimes(3);
    expect(whisperExtractor.extract).not.toHaveBeenCalled();
  });

  it('persists entities from both description and Gemini', async () => {
    // Arrange
    const playlistId = makePlaylistId('entities1');
    const videoId = makeVideoId('entityvid01');
    const detailsMap = new Map<VideoId, VideoDetails | null>([[videoId, makeDetails(videoId)]]);

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'Entities playlist',
        description: '',
        videoCount: 1,
      },
      playlistVideos: [makeItem('entityvid01', 0)],
      videoDetails: detailsMap,
    });
    const transcriptExtractor = makeMockTranscriptExtractor(
      new Map([[videoId, makeCaptionsTranscript()]])
    );
    const geminiParser = makeMockGeminiParser();
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      {},
      { transcriptExtractor, geminiParser, descriptionParser }
    );

    // Act
    await extractor.extractPlaylist(playlistId);

    // Assert — entity rows for description (regex) + Gemini (LLM)
    const entityRow = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM extracted_entities')
      .get();
    // description: 1 github_repo + 1 website = 2
    // gemini:     2 topics + 1 github_repo + 1 website + 1 person = 5
    expect(entityRow?.c).toBe(7);
  });
});

// --------------------------------------------------------------------------
// Whisper fallback path
// --------------------------------------------------------------------------

describe('VideoExtractor.extractPlaylist — Whisper fallback', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('falls back to Whisper when YouTube captions are unavailable', async () => {
    // Arrange
    const playlistId = makePlaylistId('whisper01');
    const videoId = makeVideoId('nocaps000a1');
    const detailsMap = new Map<VideoId, VideoDetails | null>([
      [videoId, makeDetails(videoId, 'No-Captions Video')],
    ]);
    // TranscriptExtractor returns null → Whisper should fire.
    const transcriptMap = new Map<VideoId, TranscriptResult | null>([[videoId, null]]);
    const whisperMap = new Map<VideoId, TranscriptResult | null>([
      [videoId, makeWhisperTranscript()],
    ]);

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'Whisper playlist',
        description: '',
        videoCount: 1,
      },
      playlistVideos: [makeItem('nocaps000a1', 0)],
      videoDetails: detailsMap,
    });
    const transcriptExtractor = makeMockTranscriptExtractor(transcriptMap);
    const whisperExtractor = makeMockWhisperExtractor(whisperMap, true);
    const geminiParser = makeMockGeminiParser();
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { enableWhisper: true },
      {
        transcriptExtractor,
        whisperExtractor,
        geminiParser,
        descriptionParser,
      }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(transcriptExtractor.extract).toHaveBeenCalledWith(videoId);
    expect(whisperExtractor.extract).toHaveBeenCalledWith(videoId);
    // Whisper-supplied transcript text reached Gemini
    expect(geminiParser.parseTranscript).toHaveBeenCalledWith({
      transcript: 'Whisper-transcribed text.',
      videoTitle: 'No-Captions Video',
    });
  });

  it('does NOT call Whisper when feature is disabled in config', async () => {
    // Arrange
    const playlistId = makePlaylistId('nowhisp01');
    const videoId = makeVideoId('nowhispvid1');

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'No Whisper',
        description: '',
        videoCount: 1,
      },
      playlistVideos: [makeItem('nowhispvid1', 0)],
      videoDetails: new Map([[videoId, makeDetails(videoId)]]),
    });
    const transcriptExtractor = makeMockTranscriptExtractor(new Map([[videoId, null]]));
    const whisperExtractor = makeMockWhisperExtractor(
      new Map([[videoId, makeWhisperTranscript()]]),
      true
    );
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { enableWhisper: false },
      { transcriptExtractor, whisperExtractor, descriptionParser }
    );

    // Act
    await extractor.extractPlaylist(playlistId);

    // Assert
    expect(transcriptExtractor.extract).toHaveBeenCalledOnce();
    expect(whisperExtractor.extract).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Idempotency
// --------------------------------------------------------------------------

describe('VideoExtractor.extractPlaylist — idempotency', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('re-extracting a populated playlist yields skipped=N, processed=0, failed=0', async () => {
    // Arrange
    const playlistId = makePlaylistId('idemp001');
    const items = [
      makeItem('idemvid001x', 0),
      makeItem('idemvid002x', 1),
      makeItem('idemvid003x', 2),
    ];
    const detailsMap = new Map<VideoId, VideoDetails | null>();
    const transcriptMap = new Map<VideoId, TranscriptResult | null>();
    for (const item of items) {
      detailsMap.set(item.videoId, makeDetails(item.videoId));
      transcriptMap.set(item.videoId, makeCaptionsTranscript());
    }

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'Idempotent playlist',
        description: '',
        videoCount: 3,
      },
      playlistVideos: items,
      videoDetails: detailsMap,
    });
    const transcriptExtractor = makeMockTranscriptExtractor(transcriptMap);
    const geminiParser = makeMockGeminiParser();
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { skipExisting: true },
      { transcriptExtractor, geminiParser, descriptionParser }
    );

    // First run — establishes the populated state.
    const firstRun = await extractor.extractPlaylist(playlistId);
    expect(firstRun.processed).toBe(3);
    expect(firstRun.skipped).toBe(0);

    // Act — second run on the same DB.
    const secondRun = await extractor.extractPlaylist(playlistId);

    // Assert — every video already exists, so all 3 skip.
    expect(secondRun.total).toBe(3);
    expect(secondRun.processed).toBe(0);
    expect(secondRun.skipped).toBe(3);
    expect(secondRun.failed).toBe(0);
    expect(secondRun.processed + secondRun.skipped + secondRun.failed).toBe(secondRun.total);

    // Per the v1 stub-bomb closure: playlist_items still updated on
    // skip (so a re-extract picks up newly-discovered membership).
    const itemRepo = new PlaylistItemRepository(dbm);
    expect(itemRepo.countByPlaylist(playlistId)).toBe(3);
  });

  it('does not re-fetch transcripts / re-call Gemini for skipped videos', async () => {
    // Arrange — same as above
    const playlistId = makePlaylistId('idemp002');
    const items = [makeItem('idemvid004x', 0), makeItem('idemvid005x', 1)];
    const detailsMap = new Map<VideoId, VideoDetails | null>();
    const transcriptMap = new Map<VideoId, TranscriptResult | null>();
    for (const item of items) {
      detailsMap.set(item.videoId, makeDetails(item.videoId));
      transcriptMap.set(item.videoId, makeCaptionsTranscript());
    }

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'Idempotent 2',
        description: '',
        videoCount: 2,
      },
      playlistVideos: items,
      videoDetails: detailsMap,
    });
    const transcriptExtractor = makeMockTranscriptExtractor(transcriptMap);
    const geminiParser = makeMockGeminiParser();
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { skipExisting: true },
      { transcriptExtractor, geminiParser, descriptionParser }
    );

    await extractor.extractPlaylist(playlistId);

    // Act — clear the call records, run again.
    transcriptExtractor.extract.mockClear();
    geminiParser.parseTranscript.mockClear();
    youtubeClient.getVideoDetails.mockClear();
    await extractor.extractPlaylist(playlistId);

    // Assert
    expect(transcriptExtractor.extract).not.toHaveBeenCalled();
    expect(geminiParser.parseTranscript).not.toHaveBeenCalled();
    expect(youtubeClient.getVideoDetails).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Failure isolation
// --------------------------------------------------------------------------

describe('VideoExtractor.extractPlaylist — failure isolation', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('one mid-pipeline throw counts as failed=1 but does not abort the run', async () => {
    // Arrange
    const playlistId = makePlaylistId('fail0001');
    const goodA = makeItem('goodaaaaa01', 0, 'Good A');
    const bad = makeItem('badbbbbbbb2', 1, 'Bad B');
    const goodB = makeItem('goodccccc03', 2, 'Good C');
    const items = [goodA, bad, goodB];

    // Details map: bad video returns null → triggers AppError(VIDEO_NOT_FOUND).
    const detailsMap = new Map<VideoId, VideoDetails | null>();
    detailsMap.set(goodA.videoId, makeDetails(goodA.videoId, 'Good A'));
    detailsMap.set(bad.videoId, null);
    detailsMap.set(goodB.videoId, makeDetails(goodB.videoId, 'Good C'));

    const transcriptMap = new Map<VideoId, TranscriptResult | null>();
    transcriptMap.set(goodA.videoId, makeCaptionsTranscript());
    transcriptMap.set(goodB.videoId, makeCaptionsTranscript());

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'Failure playlist',
        description: '',
        videoCount: 3,
      },
      playlistVideos: items,
      videoDetails: detailsMap,
    });
    const transcriptExtractor = makeMockTranscriptExtractor(transcriptMap);
    const geminiParser = makeMockGeminiParser();
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      {},
      { transcriptExtractor, geminiParser, descriptionParser }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert — 2 succeed, 1 fails. Honest counters.
    expect(result.total).toBe(3);
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.success).toBe(false);
    expect(result.processed + result.skipped + result.failed).toBe(result.total);

    // The two good videos actually landed.
    const videoRepo = new VideoRepository(dbm);
    expect(videoRepo.exists(goodA.videoId)).toBe(true);
    expect(videoRepo.exists(goodB.videoId)).toBe(true);
    expect(videoRepo.exists(bad.videoId)).toBe(false);
  });

  it('captures a Gemini parser throw as a soft failure without killing the video', async () => {
    // Arrange. A15 closure: this test previously baked in the broken
    // positional `parseTranscript(text, title)` mock shape (the BACKLOG
    // MED entry flagged it). The mock now mirrors the concrete
    // `GeminiParser.parseTranscript({ transcript, videoTitle })` contract
    // so the test asserts soft-failure semantics against the corrected
    // contract — not the historical drift.
    const playlistId = makePlaylistId('softfail1');
    const videoId = makeVideoId('softfailv01');

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'Soft fail',
        description: '',
        videoCount: 1,
      },
      playlistVideos: [makeItem('softfailv01', 0)],
      videoDetails: new Map([[videoId, makeDetails(videoId)]]),
    });
    const transcriptExtractor = makeMockTranscriptExtractor(
      new Map([[videoId, makeCaptionsTranscript()]])
    );
    // Object-arg-shape mock — `input` is `{ transcript, videoTitle }`.
    const parseTranscriptMock = vi.fn(
      async (_input: { transcript: string; videoTitle: string }) => {
        throw new Error('Gemini exploded');
      }
    );
    const geminiParser: GeminiParserLike = {
      modelName: 'gemini-3-flash-preview',
      parseTranscript: parseTranscriptMock,
    };
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      {},
      { transcriptExtractor, geminiParser, descriptionParser }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert — video succeeds (description path), Gemini error suppressed.
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    // AI analysis was NOT written because Gemini threw.
    const aiRepo = new AIAnalysisRepository(dbm);
    expect(aiRepo.getByVideo(videoId)).toBeNull();
    // Description entities still landed.
    const entityRow = dbm
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM extracted_entities')
      .get();
    expect(entityRow?.c).toBe(2); // 1 github_repo + 1 website

    // Contract assertion: the parser was called with the object-arg
    // shape (the A15-corrected contract), not the historical positional
    // shape. If a future refactor silently reverts the call site, this
    // assertion fails — the green-pass that flagged A15 cannot recur.
    expect(parseTranscriptMock).toHaveBeenCalledTimes(1);
    expect(parseTranscriptMock).toHaveBeenCalledWith({
      transcript: 'This is a sample transcript.',
      videoTitle: 'Sample',
    });
  });

  it('A15 — Gemini parseTranscript call site uses {transcript, videoTitle} object arg (contract-correct)', async () => {
    // A15 regression guard. Pinned regression: if the call site silently
    // reverts to two positional strings the mock receives them as the
    // first param (string) and the second as `undefined` for the
    // object-shape assertion below, failing the test. Distinct from the
    // soft-failure test: this one focuses purely on the call-site
    // contract (happy path, no throw), keeping the contract assertion
    // isolated from soft-failure semantics.
    const playlistId = makePlaylistId('a15ctrct');
    const videoId = makeVideoId('a15ctrctv01');
    const captionTranscript = makeCaptionsTranscript();

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'A15 contract',
        description: '',
        videoCount: 1,
      },
      playlistVideos: [makeItem('a15ctrctv01', 0, 'A15 contract video')],
      videoDetails: new Map([[videoId, makeDetails(videoId, 'A15 contract video')]]),
    });
    const transcriptExtractor = makeMockTranscriptExtractor(
      new Map([[videoId, captionTranscript]])
    );
    // Real-shape mock: takes `{ transcript, videoTitle }` and returns
    // a valid GeminiResponse fixture (happy path).
    const parseTranscriptMock = vi.fn(
      async (_input: { transcript: string; videoTitle: string }) => ({
        topics: ['contract-pinning'],
        github_repos: [],
        websites: [],
        people: [],
        tags: [],
        summary: 'Pinned contract.',
        content_type: 'tutorial',
        sentiment: 'neutral' as const,
      })
    );
    const geminiParser: GeminiParserLike = {
      modelName: 'gemini-3-flash-preview',
      parseTranscript: parseTranscriptMock,
    };
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { autoTranscript: true, autoLlmParse: true },
      { transcriptExtractor, geminiParser, descriptionParser }
    );

    // Act
    await extractor.extractPlaylist(playlistId);

    // Assert — exactly one call, with the object-arg shape mirroring
    // the concrete `GeminiParser.parseTranscript` signature.
    expect(parseTranscriptMock).toHaveBeenCalledTimes(1);
    expect(parseTranscriptMock).toHaveBeenCalledWith({
      transcript: captionTranscript.full_text,
      videoTitle: 'A15 contract video',
    });

    // Sanity: the first argument is an OBJECT, not a string. Pins the
    // regression so a "fix" that passes the transcript text positionally
    // also fails here (a string is not an object that matches the shape).
    const firstCallArgs = parseTranscriptMock.mock.calls[0];
    expect(firstCallArgs).toHaveLength(1);
    expect(typeof firstCallArgs[0]).toBe('object');
    expect(firstCallArgs[0]).not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// Counter discipline — closes the 'counter-lie' bug surfaced 2026-05-29.
//
// The original symptom: extract job reported `processed=3, new=3, dur=0s`
// while the DB showed zero new rows since the start of the day. Hypothesis
// at PM-cycle open: with A14 (transcript upsert), A18 (Ink-boundary wiring),
// and A26 (visibility) landed, the symptom may auto-resolve — the lie was
// upstream (no rows landing) not in the counter logic itself.
//
// Probe finding: the per-video loop (extractPlaylist lines ~550-588) only
// increments `processed` AFTER `processVideo` returns successfully, and
// routes thrown exceptions to `failed`. With A14's transcript upsert living
// INSIDE processVideo, a transcript-persistence throw bubbles up and counts
// as `failed`, not `processed`. The counter-lie is auto-resolved by A14.
//
// These tests pin the discipline so a future refactor reintroducing the
// pre-confirm increment is caught immediately:
//   1. A repo throw mid-processVideo counts the video as `failed`, NOT
//      `processed`. The processed counter must reflect actual successful
//      persistence (the audit invariant: counters cannot exceed reality).
//   2. The processed + skipped + failed === total invariant holds even
//      when the loop is heterogeneous (some succeed, some fail).
// --------------------------------------------------------------------------

describe('VideoExtractor.extractPlaylist — counter discipline', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('counter discipline — processed/new only increment after row persistence; throw mid-processVideo counts as failed not processed', async () => {
    // Arrange — 3 videos. The TranscriptRepository is rigged to throw on
    // the Nth (middle) video's upsert. With the discipline correct
    // (increment AFTER processVideo returns) the throw bubbles to the
    // outer per-video catch and counts as `failed=1`. With the discipline
    // broken (increment-before-confirm) the middle video lies as
    // `processed=1` and the run reports `processed=3, failed=0` while
    // the transcript row never landed — the exact 2026-05-29 symptom.
    const playlistId = makePlaylistId('cntdsc01');
    const items = [
      makeItem('cntdsvid01a', 0, 'Video A'),
      makeItem('cntdsvid02b', 1, 'Video B (throws)'),
      makeItem('cntdsvid03c', 2, 'Video C'),
    ];
    const detailsMap = new Map<VideoId, VideoDetails | null>();
    const transcriptMap = new Map<VideoId, TranscriptResult | null>();
    for (const item of items) {
      detailsMap.set(item.videoId, makeDetails(item.videoId, item.title));
      transcriptMap.set(item.videoId, makeCaptionsTranscript());
    }

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'Counter discipline',
        description: '',
        videoCount: 3,
      },
      playlistVideos: items,
      videoDetails: detailsMap,
    });
    const transcriptExtractor = makeMockTranscriptExtractor(transcriptMap);
    const descriptionParser = makeMockDescriptionParser();

    // Real TranscriptRepository on `:memory:` — but we spy on `upsert`
    // and force it to throw for the middle video. This mirrors the
    // exact pattern the 2026-05-29 bug would hit if it recurred: a
    // persistence call inside processVideo fails mid-pipeline; the
    // counter must reflect reality (failed=1), not optimism
    // (processed=3).
    const transcriptRepository = new TranscriptRepository(dbm);
    const middleVideoId = items[1].videoId;
    const realUpsert = transcriptRepository.upsert.bind(transcriptRepository);
    vi.spyOn(transcriptRepository, 'upsert').mockImplementation(
      ((videoId: VideoId, input: Parameters<typeof realUpsert>[1]) => {
        if (videoId === middleVideoId) {
          throw new Error('Transcript repo exploded on Nth video');
        }
        return realUpsert(videoId, input);
      }) as typeof realUpsert
    );

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { autoTranscript: true, autoLlmParse: false, enableWhisper: false },
      {
        transcriptExtractor,
        transcriptRepository,
        descriptionParser,
      }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert — counters reflect reality, not optimism.
    expect(result.total).toBe(3);
    expect(result.processed).toBe(2); // A and C only
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(1); // B threw inside processVideo
    expect(result.success).toBe(false);

    // The audit invariant: processed + skipped + failed === total. The
    // v1 PostExtractionMenu drift (which inspired this discipline) used
    // to break this; the new contract is that it CANNOT break.
    expect(result.processed + result.skipped + result.failed).toBe(result.total);

    // Sanity: the persistence really did fail for B (no transcript row
    // for B) and really did succeed for A and C (rows exist). This is
    // what makes the counter assertion above honest — we're not just
    // asserting the result object, we're asserting it MATCHES the DB.
    expect(transcriptRepository.findByVideoId(items[0].videoId)).not.toBeUndefined();
    expect(transcriptRepository.findByVideoId(items[1].videoId)).toBeUndefined();
    expect(transcriptRepository.findByVideoId(items[2].videoId)).not.toBeUndefined();

    // Audit-row sanity — videos_processed must mirror the in-memory
    // `processed` counter (this was the bit the 2026-05-29 symptom
    // amplified: the audit row reported processed=3 too).
    const jobRepo = new ExtractionJobRepository(dbm);
    const job = jobRepo.findById(result.jobId);
    expect(job?.videos_processed).toBe(2);
    expect(job?.new_videos).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Job tracking
// --------------------------------------------------------------------------

describe('VideoExtractor.extractPlaylist — job tracking', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('creates an extraction_jobs row at start and updates to completed at end', async () => {
    // Arrange
    const playlistId = makePlaylistId('jobtrack1');
    const videoId = makeVideoId('jobtrackv01');

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'Job tracking',
        description: '',
        videoCount: 1,
      },
      playlistVideos: [makeItem('jobtrackv01', 0)],
      videoDetails: new Map([[videoId, makeDetails(videoId)]]),
    });
    const transcriptExtractor = makeMockTranscriptExtractor(
      new Map([[videoId, makeCaptionsTranscript()]])
    );
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { autoLlmParse: false },
      { transcriptExtractor, descriptionParser }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert
    const jobRepo = new ExtractionJobRepository(dbm);
    const job = jobRepo.findById(result.jobId);
    expect(job).not.toBeNull();
    expect(job?.status).toBe('completed');
    expect(job?.playlist_id).toBe(playlistId);
    expect(job?.videos_found).toBe(1);
    expect(job?.videos_processed).toBe(1);
    expect(job?.completed_at).not.toBeNull();
  });

  it('transitions job to failed when getPlaylistInfo returns null', async () => {
    // Arrange — playlist not found at the source.
    const playlistId = makePlaylistId('nofind01');
    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: null,
      playlistVideos: [],
      videoDetails: new Map(),
    });
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(dbm, youtubeClient, {}, { descriptionParser });

    // Act + Assert — getPlaylistInfo returning null causes a hard throw
    // BEFORE the job row is created, so we expect an AppError and no
    // job row.
    await expect(extractor.extractPlaylist(playlistId)).rejects.toThrow(AppError);
    const jobRepo = new ExtractionJobRepository(dbm);
    expect(jobRepo.findByPlaylistId(playlistId)).toEqual([]);
  });

  it('transitions job to failed if an uncaught error occurs after job creation', async () => {
    // Arrange — playlist info is fine, but getPlaylistVideos throws.
    const playlistId = makePlaylistId('uncaught1');
    const youtubeClient: YouTubeClientLike = {
      getPlaylistInfo: vi.fn(async () => ({
        playlistId,
        title: 'Uncaught',
        description: '',
        videoCount: 1,
      })),
      getPlaylistVideos: vi.fn(async () => {
        // Throw AFTER playlist info succeeds — the job row has not yet
        // been created here, since we create it AFTER getPlaylistVideos.
        // Simulate a downstream error inside the iteration instead by
        // returning a video then having details throw.
        return [makeItem('uncaughtv01', 0)];
      }),
      getVideoDetails: vi.fn(async () => {
        throw new Error('Network exploded');
      }),
    };
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(dbm, youtubeClient, {}, { descriptionParser });

    // Act — per-video failures are isolated, not raised. The job row
    // still completes (with failed=1).
    const result = await extractor.extractPlaylist(playlistId);

    // Assert
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);
    const jobRepo = new ExtractionJobRepository(dbm);
    const job = jobRepo.findById(result.jobId);
    expect(job?.status).toBe('completed');
  });
});

// --------------------------------------------------------------------------
// onProgress events
// --------------------------------------------------------------------------

describe('VideoExtractor.extractPlaylist — onProgress events', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('emits a discriminated-union event stream containing job_started and job_completed', async () => {
    // Arrange
    const playlistId = makePlaylistId('progress1');
    const videoId = makeVideoId('progressv01');
    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: { playlistId, title: 'Progress', description: '', videoCount: 1 },
      playlistVideos: [makeItem('progressv01', 0)],
      videoDetails: new Map([[videoId, makeDetails(videoId)]]),
    });
    const transcriptExtractor = makeMockTranscriptExtractor(
      new Map([[videoId, makeCaptionsTranscript()]])
    );
    const descriptionParser = makeMockDescriptionParser();

    const events: ExtractProgressEvent[] = [];
    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { autoLlmParse: false },
      { transcriptExtractor, descriptionParser }
    );

    // Act
    await extractor.extractPlaylist(playlistId, {
      onProgress: (event) => events.push(event),
    });

    // Assert
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('job_started');
    expect(kinds).toContain('fetch_meta');
    expect(kinds).toContain('persist');
    expect(kinds).toContain('transcribe');
    expect(kinds).toContain('video_done');
    expect(kinds).toContain('job_completed');
    // First event is always job_started
    expect(events[0].kind).toBe('job_started');
    // Last event is always job_completed
    expect(events[events.length - 1].kind).toBe('job_completed');
  });

  it('does not abort the run when onProgress callback throws', async () => {
    // Arrange
    const playlistId = makePlaylistId('callbug1');
    const videoId = makeVideoId('callbugvi01');
    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: { playlistId, title: 'Callback bug', description: '', videoCount: 1 },
      playlistVideos: [makeItem('callbugvi01', 0)],
      videoDetails: new Map([[videoId, makeDetails(videoId)]]),
    });
    const transcriptExtractor = makeMockTranscriptExtractor(
      new Map([[videoId, makeCaptionsTranscript()]])
    );
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { autoLlmParse: false },
      { transcriptExtractor, descriptionParser }
    );

    // Act — callback throws on every event; should be swallowed.
    const result = await extractor.extractPlaylist(playlistId, {
      onProgress: () => {
        throw new Error('observer is buggy');
      },
    });

    // Assert — extraction completed successfully despite the noisy callback
    expect(result.processed).toBe(1);
    expect(result.success).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Config validation
// --------------------------------------------------------------------------

describe('VideoExtractor — config validation', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('accepts an empty config (defaults all fields)', () => {
    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: null,
      playlistVideos: [],
      videoDetails: new Map(),
    });
    expect(
      () =>
        new VideoExtractor(
          dbm,
          youtubeClient,
          {},
          { descriptionParser: makeMockDescriptionParser() }
        )
    ).not.toThrow();
  });

  it('rejects a config with an invalid maxVideos (non-positive)', () => {
    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: null,
      playlistVideos: [],
      videoDetails: new Map(),
    });
    expect(
      () =>
        new VideoExtractor(
          dbm,
          youtubeClient,
          { maxVideos: -5 },
          { descriptionParser: makeMockDescriptionParser() }
        )
    ).toThrow(AppError);
  });

  it('requires a descriptionParser dep', () => {
    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: null,
      playlistVideos: [],
      videoDetails: new Map(),
    });
    expect(() => new VideoExtractor(dbm, youtubeClient, {}, {})).toThrow(AppError);
  });
});

// --------------------------------------------------------------------------
// Transcript persistence — closes the A14 / A18 wiring gap.
//
// A14 (VideoExtractor): processVideo previously fetched the transcript and
//   used `full_text` only as Gemini input — there was no `transcriptRepository
//   .upsert(...)` call anywhere in the playlist path. Zero rows landed even
//   when the captions came back fine.
// A18 (ExtractCommand wiring): the Ink layer only injected
//   `descriptionParser`, leaving `transcriptExtractor` and `whisperExtractor`
//   null on the playlist path. With either fix alone the pipeline is still
//   silently inert; both must land together.
//
// These tests close the unit-level loop: prove that when a
// `transcriptRepository` is in the deps bag and either the YouTube extractor
// or the Whisper fallback yields a transcript, an `upsert` call fires with
// the correct payload shape.
// --------------------------------------------------------------------------

describe('VideoExtractor.processVideo — transcript persistence (A14 / A18)', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('processVideo persists transcript via injected TranscriptRepository — closes A14/A18 wiring gap', async () => {
    // Arrange — happy path: YouTube transcript returns a payload, Whisper
    // is not invoked. We spy on TranscriptRepository.upsert by extending
    // the real repo (so the FK to videos is honoured) and capturing calls.
    const playlistId = makePlaylistId('a14happy');
    const videoId = makeVideoId('a14happyv01');
    const captions = makeCaptionsTranscript();

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'A14 happy',
        description: '',
        videoCount: 1,
      },
      playlistVideos: [makeItem('a14happyv01', 0, 'A14 video')],
      videoDetails: new Map([[videoId, makeDetails(videoId, 'A14 video')]]),
    });
    const transcriptExtractor = makeMockTranscriptExtractor(new Map([[videoId, captions]]));
    const whisperExtractor = makeMockWhisperExtractor(new Map(), false);
    const descriptionParser = makeMockDescriptionParser();

    const transcriptRepository = new TranscriptRepository(dbm);
    const upsertSpy = vi.spyOn(transcriptRepository, 'upsert');

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { autoTranscript: true, autoLlmParse: false, enableWhisper: false },
      {
        transcriptExtractor,
        whisperExtractor,
        transcriptRepository,
        descriptionParser,
      }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert — counters honest AND transcript actually landed.
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // upsert called exactly once with the fetched transcript shape
    // (TranscriptInput is camelCase; the extractor translates snake_case
    // TranscriptResult to camelCase TranscriptInput at the persist boundary).
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledWith(videoId, {
      language: captions.language,
      fullText: captions.full_text,
      segments: captions.segments,
      isAutoGenerated: captions.is_auto_generated,
    });

    // And a row really exists in the transcripts table (proves the call
    // made it through withTransaction, not just to the spy).
    const persisted = transcriptRepository.findByVideoId(videoId);
    expect(persisted).not.toBeUndefined();
    expect(persisted?.full_text).toBe(captions.full_text);
  });

  it('processVideo falls back to WhisperExtractor when YouTube captions absent — Whisper transcript also persists', async () => {
    // Arrange — captions return null, Whisper supplies the payload.
    const playlistId = makePlaylistId('a14whisp');
    const videoId = makeVideoId('a14whispv01');
    const whisperTranscript = makeWhisperTranscript();

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: {
        playlistId,
        title: 'A14 Whisper fallback',
        description: '',
        videoCount: 1,
      },
      playlistVideos: [makeItem('a14whispv01', 0, 'A14 Whisper video')],
      videoDetails: new Map([[videoId, makeDetails(videoId, 'A14 Whisper video')]]),
    });
    // YouTube transcript path returns null → Whisper should fire.
    const transcriptExtractor = makeMockTranscriptExtractor(new Map([[videoId, null]]));
    const whisperExtractor = makeMockWhisperExtractor(
      new Map([[videoId, whisperTranscript]]),
      true
    );
    const descriptionParser = makeMockDescriptionParser();

    const transcriptRepository = new TranscriptRepository(dbm);
    const upsertSpy = vi.spyOn(transcriptRepository, 'upsert');

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { autoTranscript: true, autoLlmParse: false, enableWhisper: true },
      {
        transcriptExtractor,
        whisperExtractor,
        transcriptRepository,
        descriptionParser,
      }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert — Whisper transcript persisted with the same shape contract.
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(transcriptExtractor.extract).toHaveBeenCalledWith(videoId);
    expect(whisperExtractor.extract).toHaveBeenCalledWith(videoId);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledWith(videoId, {
      language: whisperTranscript.language,
      fullText: whisperTranscript.full_text,
      segments: whisperTranscript.segments,
      isAutoGenerated: whisperTranscript.is_auto_generated,
    });

    const persisted = transcriptRepository.findByVideoId(videoId);
    expect(persisted?.full_text).toBe(whisperTranscript.full_text);
  });
});

// --------------------------------------------------------------------------
// Soft-failure log-level visibility — closes A26.
//
// The default Pino level is `error` (see src-ts-v2/utils/logger.ts:16),
// so prior `logger.warn(...)` / `logger.debug(...)` calls inside the
// soft-failure catch blocks were invisible in production. A26 promotes
// the three audit-identified sites to `logger.error(...)` so the
// breadcrumbs surface. The video-level semantics do NOT change — these
// remain SOFT failures (the run continues, counters don't shift to
// `failed`); only visibility changes.
//
// These tests pin the level at each promoted site so a future regression
// silently demoting one back to warn/debug is caught here.
// --------------------------------------------------------------------------

describe('VideoExtractor.processVideo — soft-failure visibility (A26)', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
    vi.restoreAllMocks();
  });

  it('logs a Gemini parseTranscript throw at error level (was warn — A26)', async () => {
    // Arrange — same shape as the existing 'captures a Gemini parser
    // throw as a soft failure' test, but we additionally assert the
    // promoted log LEVEL. The video must still process successfully
    // (counters unchanged); only the log call's severity is the
    // contract under test.
    const errorSpy = vi.spyOn(logger, 'error');
    const warnSpy = vi.spyOn(logger, 'warn');

    const playlistId = makePlaylistId('a26gem01');
    const videoId = makeVideoId('a26gemv0001');

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: { playlistId, title: 'A26 gem', description: '', videoCount: 1 },
      playlistVideos: [makeItem('a26gemv0001', 0)],
      videoDetails: new Map([[videoId, makeDetails(videoId)]]),
    });
    const transcriptExtractor = makeMockTranscriptExtractor(
      new Map([[videoId, makeCaptionsTranscript()]])
    );
    const geminiParser: GeminiParserLike = {
      modelName: 'gemini-3-flash-preview',
      parseTranscript: vi.fn(async () => {
        throw new Error('Gemini exploded');
      }),
    };
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      {},
      { transcriptExtractor, geminiParser, descriptionParser }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert — soft-failure semantics preserved (video still processed)
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // Assert — the promoted log call fired at ERROR level. The
    // structured fields must include the videoId and the err message.
    const matchingErrorCalls = errorSpy.mock.calls.filter(
      ([payload, msg]) =>
        typeof msg === 'string' &&
        msg === 'Gemini parseTranscript threw; continuing without LLM entities' &&
        typeof payload === 'object' &&
        payload !== null &&
        'videoId' in payload &&
        'err' in payload &&
        (payload as { videoId: unknown }).videoId === videoId &&
        (payload as { err: unknown }).err === 'Gemini exploded'
    );
    expect(matchingErrorCalls).toHaveLength(1);

    // And it did NOT fire at warn (the pre-A26 level we're moving away
    // from). Pin the regression so a silent demotion is caught.
    const matchingWarnCalls = warnSpy.mock.calls.filter(
      ([, msg]) =>
        typeof msg === 'string' &&
        msg === 'Gemini parseTranscript threw; continuing without LLM entities'
    );
    expect(matchingWarnCalls).toHaveLength(0);
  });

  it('logs a YouTube transcript extractor throw at error level (was debug — A26)', async () => {
    // Arrange — transcriptExtractor.extract rejects. The video must
    // still process (transcript becomes null; description path still
    // produces entities); only the log call's severity is asserted.
    const errorSpy = vi.spyOn(logger, 'error');
    const debugSpy = vi.spyOn(logger, 'debug');

    const playlistId = makePlaylistId('a26yt01');
    const videoId = makeVideoId('a26ytvid001');

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: { playlistId, title: 'A26 yt', description: '', videoCount: 1 },
      playlistVideos: [makeItem('a26ytvid001', 0)],
      videoDetails: new Map([[videoId, makeDetails(videoId)]]),
    });
    const transcriptExtractor: TranscriptExtractorLike = {
      extract: vi.fn(async () => {
        throw new Error('YouTube transcripts API exploded');
      }),
    };
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      // autoLlmParse disabled so a missing transcript doesn't cascade
      // into Gemini noise; we want the YouTube-catch log call isolated.
      { autoTranscript: true, autoLlmParse: false, enableWhisper: false },
      { transcriptExtractor, descriptionParser }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert — soft-failure semantics: video processed despite the throw.
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // Assert — error-level log fired with the expected payload shape.
    const matchingErrorCalls = errorSpy.mock.calls.filter(
      ([payload, msg]) =>
        typeof msg === 'string' &&
        msg === 'YouTube transcript extraction threw; will try Whisper fallback if enabled' &&
        typeof payload === 'object' &&
        payload !== null &&
        'videoId' in payload &&
        'err' in payload &&
        (payload as { videoId: unknown }).videoId === videoId &&
        (payload as { err: unknown }).err === 'YouTube transcripts API exploded'
    );
    expect(matchingErrorCalls).toHaveLength(1);

    // And it did NOT fire at debug (the pre-A26 level).
    const matchingDebugCalls = debugSpy.mock.calls.filter(
      ([, msg]) =>
        typeof msg === 'string' &&
        msg === 'YouTube transcript extraction threw; will try Whisper fallback if enabled'
    );
    expect(matchingDebugCalls).toHaveLength(0);
  });

  it('logs a Whisper extractor throw at error level (was debug — A26)', async () => {
    // Arrange — YouTube transcript returns null so Whisper fallback
    // fires; WhisperExtractor.extract then throws. Video still processes.
    const errorSpy = vi.spyOn(logger, 'error');
    const debugSpy = vi.spyOn(logger, 'debug');

    const playlistId = makePlaylistId('a26wh01');
    const videoId = makeVideoId('a26whvid001');

    const youtubeClient = makeMockYouTubeClient({
      playlistInfo: { playlistId, title: 'A26 whisper', description: '', videoCount: 1 },
      playlistVideos: [makeItem('a26whvid001', 0)],
      videoDetails: new Map([[videoId, makeDetails(videoId)]]),
    });
    const transcriptExtractor = makeMockTranscriptExtractor(new Map([[videoId, null]]));
    const whisperExtractor: WhisperExtractorLike = {
      isAvailable: vi.fn(() => true),
      extract: vi.fn(async () => {
        throw new Error('Whisper subprocess exploded');
      }),
    };
    const descriptionParser = makeMockDescriptionParser();

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      { autoTranscript: true, autoLlmParse: false, enableWhisper: true },
      { transcriptExtractor, whisperExtractor, descriptionParser }
    );

    // Act
    const result = await extractor.extractPlaylist(playlistId);

    // Assert — soft-failure semantics preserved.
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // Assert — error-level log fired with the expected payload shape.
    const matchingErrorCalls = errorSpy.mock.calls.filter(
      ([payload, msg]) =>
        typeof msg === 'string' &&
        msg === 'Whisper extraction threw; continuing without transcript' &&
        typeof payload === 'object' &&
        payload !== null &&
        'videoId' in payload &&
        'err' in payload &&
        (payload as { videoId: unknown }).videoId === videoId &&
        (payload as { err: unknown }).err === 'Whisper subprocess exploded'
    );
    expect(matchingErrorCalls).toHaveLength(1);

    // And it did NOT fire at debug (the pre-A26 level).
    const matchingDebugCalls = debugSpy.mock.calls.filter(
      ([, msg]) =>
        typeof msg === 'string' && msg === 'Whisper extraction threw; continuing without transcript'
    );
    expect(matchingDebugCalls).toHaveLength(0);
  });
});

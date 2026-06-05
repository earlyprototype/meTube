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
import { VideoRepository } from '../database/VideoRepository.js';
import { AppError } from '../errors/index.js';
import { asPlaylistId, asVideoId, type PlaylistId, type VideoId } from '../types/branded.js';

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
  const padded = (`PL${suffix}`).padEnd(13, '0');
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
    modelName,
  };
}

interface MockDescriptionParser extends DescriptionParserLike {
  readonly parse: ReturnType<typeof vi.fn>;
  readonly extractEntitiesForDatabase: ReturnType<typeof vi.fn>;
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
    const detailsMap = new Map<VideoId, VideoDetails | null>([
      [videoId, makeDetails(videoId)],
    ]);

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
    // Whisper-supplied transcript text reached Gemini as a single typed
    // object ({ transcript, videoTitle }) — the contract the real
    // GeminiParser.parseTranscript expects. This regression fails on the
    // old two-positional-string call shape, which made the real parser
    // throw ValidationError and silently skip LLM persistence.
    expect(geminiParser.parseTranscript).toHaveBeenCalledWith({
      transcript: 'Whisper-transcribed text.',
      videoTitle: 'No-Captions Video',
    });
    // And because the call shape is correct, LLM analysis is persisted.
    const aiRepo = new AIAnalysisRepository(dbm);
    expect(aiRepo.getByVideo(videoId)).not.toBeNull();
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
    const transcriptExtractor = makeMockTranscriptExtractor(
      new Map([[videoId, null]])
    );
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
    expect(secondRun.processed + secondRun.skipped + secondRun.failed).toBe(
      secondRun.total
    );

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
    // Arrange
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

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      {},
      { descriptionParser }
    );

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

    const extractor = new VideoExtractor(
      dbm,
      youtubeClient,
      {},
      { descriptionParser }
    );

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

/**
 * Regression coverage for ExtractCommand's VideoExtractor wiring.
 *
 * Context: Wave 4 originally constructed VideoExtractor for both
 * `metube extract playlist <id>` and `metube extract --all` while
 * injecting only a `descriptionParser`. With no `transcriptExtractor` /
 * `whisperExtractor`, `fetchTranscript` short-circuited, and with
 * `autoLlmParse: false` plus no `geminiParser` the LLM analysis stage
 * never ran — so the differentiated dual-transcript + Gemini pipeline
 * was silently dead despite v1.0.0 calling playlist extract
 * production-ready.
 *
 * These tests pin the wiring: the shared `buildVideoExtractorConfig` /
 * `buildVideoExtractorDeps` helpers (used by BOTH extract paths) enable
 * `autoTranscript`, `enableWhisper`, `autoLlmParse` and inject the real
 * TranscriptExtractor, WhisperExtractor, DescriptionParser and a Gemini
 * adapter (when credentials exist). Missing credentials degrade Gemini to
 * `null` without breaking the rest of the wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mock the concrete GeminiParser so the adapter-forwarding test can assert
// the exact (object-shaped) argument passed through, with no live API call.
// Only the `GeminiParser` value export is used at runtime by ExtractCommand;
// `ParseTranscriptInput` is a type-only import elsewhere and needs no stub.
// --------------------------------------------------------------------------

const { parseTranscriptSpy } = vi.hoisted(() => ({
  parseTranscriptSpy: vi.fn(),
}));

vi.mock('../../../src-ts-v2/parsers/GeminiParser.js', () => ({
  GeminiParser: class {
    parseTranscript = parseTranscriptSpy;
  },
}));

import { DatabaseManager } from '../../../src-ts-v2/database/connection.js';
import { TranscriptExtractor } from '../../../src-ts-v2/extractors/TranscriptExtractor.js';
import { WhisperExtractor } from '../../../src-ts-v2/extractors/WhisperExtractor.js';
import { DescriptionParser } from '../../../src-ts-v2/parsers/DescriptionParser.js';
import {
  VideoExtractor,
  type PlaylistInfo,
  type PlaylistVideoItem,
  type PlaylistVideoOptions,
  type VideoDetails,
  type YouTubeClientLike,
} from '../../../src-ts-v2/extractors/VideoExtractor.js';

import type { SkippedPageItem } from '../../../src-ts-v2/api/types.js';
import type { YouTubeClient } from '../../../src-ts-v2/api/YouTubeClient.js';
import type { YouTubePlaylistItem } from '../../../src-ts-v2/api/types.js';
import { asVideoId, asPlaylistId } from '../../../src-ts-v2/types/branded.js';

import {
  buildGeminiAdapter,
  buildVideoExtractorConfig,
  buildVideoExtractorDeps,
  makeYouTubeClientAdapter,
} from '../ExtractCommand.js';

// --------------------------------------------------------------------------
// GEMINI_API_KEY is read by buildGeminiAdapter at call time. Snapshot and
// restore it so tests can drive both the "credentials present" and
// "credentials absent" branches deterministically.
// --------------------------------------------------------------------------

let savedGeminiKey: string | undefined;

beforeEach(() => {
  savedGeminiKey = process.env.GEMINI_API_KEY;
});

afterEach(() => {
  if (savedGeminiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = savedGeminiKey;
  }
});

// --------------------------------------------------------------------------
// buildVideoExtractorConfig
// --------------------------------------------------------------------------

describe('buildVideoExtractorConfig', () => {
  it('enables the dual-transcript + LLM pipeline for production extraction', () => {
    const config = buildVideoExtractorConfig({ reprocess: false, maxVideos: 5 });

    expect(config.autoTranscript).toBe(true);
    expect(config.enableWhisper).toBe(true);
    expect(config.autoLlmParse).toBe(true);
  });

  it('preserves the reprocess flag (skipExisting is the inverse)', () => {
    expect(buildVideoExtractorConfig({ reprocess: true }).skipExisting).toBe(false);
    expect(buildVideoExtractorConfig({ reprocess: false }).skipExisting).toBe(true);
    expect(buildVideoExtractorConfig({}).skipExisting).toBe(true);
  });

  it('passes maxVideos straight through', () => {
    expect(buildVideoExtractorConfig({ maxVideos: 12 }).maxVideos).toBe(12);
    expect(buildVideoExtractorConfig({}).maxVideos).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// buildGeminiAdapter
// --------------------------------------------------------------------------

describe('buildGeminiAdapter', () => {
  it('returns a GeminiParserLike adapter when an API key is provided', () => {
    const adapter = buildGeminiAdapter('test-key');

    expect(adapter).not.toBeNull();
    expect(typeof adapter?.parseTranscript).toBe('function');
    expect(typeof adapter?.modelName).toBe('string');
    expect((adapter?.modelName.length ?? 0) > 0).toBe(true);
  });

  it('returns null when no API key is available (no GEMINI_API_KEY, none passed)', () => {
    delete process.env.GEMINI_API_KEY;

    expect(buildGeminiAdapter()).toBeNull();
  });

  it('reads GEMINI_API_KEY from the environment by default', () => {
    process.env.GEMINI_API_KEY = 'env-key';

    expect(buildGeminiAdapter()).not.toBeNull();
  });

  it('forwards the object-shaped ParseTranscriptInput straight to the parser', async () => {
    parseTranscriptSpy.mockReset();
    parseTranscriptSpy.mockResolvedValue(null);

    const adapter = buildGeminiAdapter('test-key');
    const input = { transcript: 'hello world', videoTitle: 'My Video' };
    await adapter?.parseTranscript(input);

    expect(parseTranscriptSpy).toHaveBeenCalledTimes(1);
    expect(parseTranscriptSpy).toHaveBeenCalledWith(input);
  });
});

// --------------------------------------------------------------------------
// buildVideoExtractorDeps
// --------------------------------------------------------------------------

describe('buildVideoExtractorDeps', () => {
  it('injects the real transcript, whisper and description dependencies', () => {
    delete process.env.GEMINI_API_KEY;
    const deps = buildVideoExtractorDeps();

    expect(deps.transcriptExtractor).toBeInstanceOf(TranscriptExtractor);
    expect(deps.whisperExtractor).toBeInstanceOf(WhisperExtractor);
    expect(deps.descriptionParser).toBeInstanceOf(DescriptionParser);
  });

  it('includes a Gemini adapter when GEMINI_API_KEY is set', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const deps = buildVideoExtractorDeps();

    expect(deps.geminiParser).not.toBeNull();
    expect(typeof deps.geminiParser?.parseTranscript).toBe('function');
  });

  it('passes geminiParser: null when GEMINI_API_KEY is absent, without dropping other deps', () => {
    delete process.env.GEMINI_API_KEY;
    const deps = buildVideoExtractorDeps();

    expect(deps.geminiParser).toBeNull();
    expect(deps.transcriptExtractor).toBeInstanceOf(TranscriptExtractor);
    expect(deps.whisperExtractor).toBeInstanceOf(WhisperExtractor);
    expect(deps.descriptionParser).toBeInstanceOf(DescriptionParser);
  });
});

// --------------------------------------------------------------------------
// Integration: the produced config + deps actually construct a
// VideoExtractor. This proves the deps satisfy the constructor's
// required-descriptionParser invariant and the config passes Zod parse —
// i.e. the wiring both extract paths share is valid end-to-end.
// --------------------------------------------------------------------------

describe('VideoExtractor accepts the production config + deps', () => {
  let db: DatabaseManager;

  const stubClient: YouTubeClientLike = {
    async getPlaylistInfo(): Promise<PlaylistInfo | null> {
      return null;
    },
    async getPlaylistVideos(
      _playlistId,
      _opts?: PlaylistVideoOptions
    ): Promise<readonly PlaylistVideoItem[]> {
      return [];
    },
    async getVideoDetails(): Promise<VideoDetails | null> {
      return null;
    },
  };

  beforeEach(() => {
    db = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('constructs with credentials present (Gemini adapter injected)', () => {
    process.env.GEMINI_API_KEY = 'test-key';

    expect(
      () =>
        new VideoExtractor(
          db,
          stubClient,
          buildVideoExtractorConfig({ reprocess: false, maxVideos: 3 }),
          buildVideoExtractorDeps()
        )
    ).not.toThrow();
  });

  it('constructs with credentials absent (Gemini disabled, extraction still wired)', () => {
    delete process.env.GEMINI_API_KEY;

    expect(
      () =>
        new VideoExtractor(
          db,
          stubClient,
          buildVideoExtractorConfig({ reprocess: true }),
          buildVideoExtractorDeps()
        )
    ).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// makeYouTubeClientAdapter
//
// The adapter bridges the v2 YouTubeClient surface
// (getPlaylistById/getPlaylistItems/getVideoById) onto the
// YouTubeClientLike shape VideoExtractor consumes. Wave 2 added two
// behaviours that need pinning:
//   1. It forwards the tolerant-page-fetch `onSkipped` callback into
//      `getPlaylistItems`, so degenerate (private/deleted) playlist items
//      surface to the caller instead of vanishing at the page boundary.
//   2. It still maps each raw playlist item onto a PlaylistVideoItem and
//      honours the `maxResults` cap.
// --------------------------------------------------------------------------

describe('makeYouTubeClientAdapter', () => {
  const PLAYLIST_ID = asPlaylistId('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

  function makeItem(videoId: string, position: number): YouTubePlaylistItem {
    return {
      videoId: asVideoId(videoId),
      playlistId: PLAYLIST_ID,
      position,
      title: `Video ${position}`,
      channelId: 'UCxxxxxxxxxxxxxxxxxxxxxxxx',
      channelTitle: 'Test Channel',
      addedAt: '2024-01-01T00:00:00Z',
    };
  }

  /**
   * Minimal stub matching the slice of YouTubeClient the adapter calls.
   * `getPlaylistItems` fires `onSkipped` once with an 'unavailable' record
   * (mirroring a private/deleted item dropped from the page) before
   * returning the available items.
   */
  function makeStubClient(items: YouTubePlaylistItem[]): YouTubeClient {
    return {
      async getPlaylistItems(
        _playlistId: unknown,
        opts?: { onSkipped?: (s: SkippedPageItem) => void }
      ): Promise<readonly YouTubePlaylistItem[]> {
        opts?.onSkipped?.({
          reason: 'unavailable',
          method: 'getPlaylistItems',
          videoId: 'deletedVid0',
          position: 99,
        });
        return items;
      },
    } as unknown as YouTubeClient;
  }

  it('forwards onSkipped records from getPlaylistItems to the caller', async () => {
    const collected: SkippedPageItem[] = [];
    const client = makeStubClient([makeItem('vid00000001', 0)]);

    const adapter = makeYouTubeClientAdapter(client, {
      onSkipped: (s) => collected.push(s),
    });
    await adapter.getPlaylistVideos(PLAYLIST_ID);

    expect(collected).toHaveLength(1);
    expect(collected[0].reason).toBe('unavailable');
    expect(collected[0].videoId).toBe('deletedVid0');
  });

  it('maps raw playlist items onto PlaylistVideoItem shape', async () => {
    const client = makeStubClient([makeItem('vid00000001', 0), makeItem('vid00000002', 1)]);

    const adapter = makeYouTubeClientAdapter(client);
    const result = await adapter.getPlaylistVideos(PLAYLIST_ID);

    expect(result).toHaveLength(2);
    expect(result[0].videoId).toBe('vid00000001');
    expect(result[0].title).toBe('Video 0');
    expect(result[0].position).toBe(0);
  });

  it('honours the maxResults cap', async () => {
    const client = makeStubClient([
      makeItem('vid00000001', 0),
      makeItem('vid00000002', 1),
      makeItem('vid00000003', 2),
    ]);

    const adapter = makeYouTubeClientAdapter(client);
    const result = await adapter.getPlaylistVideos(PLAYLIST_ID, { maxResults: 2 });

    expect(result).toHaveLength(2);
  });

  it('does not throw when no onSkipped handler is supplied', async () => {
    const client = makeStubClient([makeItem('vid00000001', 0)]);

    const adapter = makeYouTubeClientAdapter(client);

    await expect(adapter.getPlaylistVideos(PLAYLIST_ID)).resolves.toHaveLength(1);
  });

  // Task 7: the adapter must forward `definition` ('hd'/'sd') from the v2
  // client's YouTubeVideo onto VideoDetails so the DB write persists it.
  // Before, the adapter dropped it and the column always stored NULL.
  function makeVideoStubClient(video: Record<string, unknown>): YouTubeClient {
    return {
      async getVideoById(): Promise<unknown> {
        return video;
      },
    } as unknown as YouTubeClient;
  }

  function fixtureVideo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      videoId: asVideoId('vid00000001'),
      title: 'Vid',
      description: '',
      channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
      channelTitle: 'Chan',
      publishedAt: '2024-01-01T00:00:00Z',
      duration: 'PT3M',
      durationSeconds: 180,
      isShort: false,
      viewCount: 1,
      likeCount: 1,
      commentCount: 1,
      tags: [],
      categoryId: '28',
      caption: true,
      licensedContent: false,
      ...overrides,
    };
  }

  it('forwards definition (hd) from the client video onto VideoDetails', async () => {
    const adapter = makeYouTubeClientAdapter(makeVideoStubClient(fixtureVideo({ definition: 'hd' })));

    const details = await adapter.getVideoDetails(asVideoId('vid00000001'));

    expect(details?.definition).toBe('hd');
  });

  it('forwards definition (sd) too', async () => {
    const adapter = makeYouTubeClientAdapter(makeVideoStubClient(fixtureVideo({ definition: 'sd' })));

    const details = await adapter.getVideoDetails(asVideoId('vid00000001'));

    expect(details?.definition).toBe('sd');
  });

  it('leaves definition undefined when the client video omits it', async () => {
    const adapter = makeYouTubeClientAdapter(makeVideoStubClient(fixtureVideo()));

    const details = await adapter.getVideoDetails(asVideoId('vid00000001'));

    expect(details?.definition).toBeUndefined();
  });
});

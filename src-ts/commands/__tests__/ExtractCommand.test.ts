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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

import {
  buildGeminiAdapter,
  buildVideoExtractorConfig,
  buildVideoExtractorDeps,
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

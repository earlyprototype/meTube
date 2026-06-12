/**
 * Coverage for the single-video step output (PARITY.md section A, task 2).
 *
 * `video add` previously showed only a coarse spinner status. It now surfaces
 * the same FULL Python-style per-video lines the playlist path shows: the
 * metadata line (Channel · duration), the transcript source + char count, and
 * the entity counts (Python video_extractor.py:118-120,160-161,184,202-205).
 *
 * The v2 services the manual pipeline touches are stubbed at the module
 * boundary so the render is hermetic (no native sqlite, no auth, no network).
 * Assertions read the full `frames` history because the component flips to the
 * terminal 'done' view once extraction finishes; the step lines render in the
 * intermediate 'extracting' frames.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const upsertSpy = vi.fn();
const insertManySpy = vi.fn();

// Pin the config-derived paths so the suite never touches the real
// config/config.yaml on disk (a broken file would fail this unrelated suite).
vi.mock('../../utils/appConfig.js', () => ({
  loadAppPaths: () => ({ dbPath: 'data/metube.db', reportsDir: 'reports' }),
}));

vi.mock('../../../src-ts-v2/database/connection.js', () => ({
  DatabaseManager: class {
    constructor(_path: string) {}
    close() {}
  },
}));

vi.mock('../../../src-ts-v2/auth/YouTubeAuth.js', () => ({
  YouTubeAuth: class {
    async authenticate() {
      return {};
    }
  },
}));

// YouTubeClient.getVideoById returns the fixture video details.
vi.mock('../../../src-ts-v2/api/YouTubeClient.js', () => ({
  YouTubeClient: class {
    async getVideoById() {
      return {
        videoId: 'vid00000001',
        title: 'My Single Video',
        description: 'See https://github.com/owner/repo and https://example.com',
        channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
        channelTitle: 'Fireship',
        publishedAt: '2024-01-01T00:00:00Z',
        duration: 'PT12M34S',
        durationSeconds: 754,
        isShort: false,
        viewCount: 1,
        likeCount: 1,
        commentCount: 1,
        tags: [],
        categoryId: '28',
        caption: true,
        licensedContent: false,
      };
    }
  },
}));

vi.mock('../../../src-ts-v2/database/VideoRepository.js', () => ({
  VideoRepository: class {
    createOrUpdate() {}
  },
}));

vi.mock('../../../src-ts-v2/database/StatisticsRepository.js', () => ({
  StatisticsRepository: class {
    recordSnapshot() {}
  },
}));

vi.mock('../../../src-ts-v2/database/TranscriptRepository.js', () => ({
  TranscriptRepository: class {
    upsert(...args: unknown[]) {
      upsertSpy(...args);
    }
  },
}));

vi.mock('../../../src-ts-v2/database/EntityRepository.js', () => ({
  EntityRepository: class {
    insertMany(...args: unknown[]) {
      insertManySpy(...args);
    }
  },
}));

// YouTube captions found — a YouTube-sourced transcript with a known length.
vi.mock('../../../src-ts-v2/extractors/TranscriptExtractor.js', () => ({
  TranscriptExtractor: class {
    async extract() {
      return {
        full_text: 'x'.repeat(12345),
        segments: [],
        language: 'en',
        is_auto_generated: true,
        from_whisper: false,
      };
    }
  },
}));

vi.mock('../../../src-ts-v2/extractors/WhisperExtractor.js', () => ({
  WhisperExtractor: class {
    constructor(_config?: unknown) {}
  },
}));

// Real DescriptionParser is fine — it's pure (regex over the description). The
// fixture description carries one GitHub repo + one website.

import { VideoCommands } from '../VideoCommands.js';

/** Let the async pipeline settle and React commit each intermediate state. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  upsertSpy.mockReset();
  insertManySpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('video add — per-video step output', () => {
  it('renders title, metadata, transcript source, and entity lines', async () => {
    const { frames } = render(
      <VideoCommands subcommand="add" args={['vid00000001']} flags={{}} onComplete={() => {}} />
    );
    await settle();

    const all = frames.join('\n');

    // Title surfaced.
    expect(all).toContain('My Single Video');
    // Metadata line: Channel · 12:34 (754s).
    expect(all).toContain('Fireship · 12:34');
    // Transcript source + char count.
    expect(all).toContain('YouTube captions (12,345 chars)');
    // Entity counts from the description (1 repo, 1 website; no topics/people).
    expect(all).toContain('Found 1 repo · 1 website · 0 topics · 0 people');
  });

  it('still persists the transcript and entities through the pipeline', async () => {
    render(
      <VideoCommands subcommand="add" args={['vid00000001']} flags={{}} onComplete={() => {}} />
    );
    await settle();

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(insertManySpy).toHaveBeenCalledTimes(1);
  });
});

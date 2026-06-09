/**
 * Coverage for the A9 fix in PlaylistVideos.
 *
 * Before: PlaylistVideos fetched rows via `findByPlaylist` and hardcoded
 * `has_transcript: undefined` for every row, so the Transcript column
 * rendered "No" for every video regardless of whether a transcript
 * existed.
 *
 * After: it fetches via `findByPlaylistWithTranscriptFlag` (which resolves
 * the flag in-query via an EXISTS sub-select) and passes the real
 * `has_transcript` through to the column, so the column reflects DB truth.
 *
 * Mock style mirrors ExtractCommand.refire.test.tsx: the v2 services
 * PlaylistVideos touches are stubbed at the module boundary so the test is
 * hermetic (no better-sqlite3 native bindings, no filesystem cache writes,
 * no auth).
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Module mocks. The flagged-row fetch is the unit under test; everything
// else is stubbed to keep the render hermetic.
// --------------------------------------------------------------------------

const findByPlaylistWithTranscriptFlagSpy = vi.fn();
const findByPlaylistSpy = vi.fn();
const saveVideoCacheSpy = vi.fn();

vi.mock('../../../src-ts-v2/database/connection.js', () => ({
  DatabaseManager: class {
    constructor(_path: string) {}
    close() {}
  },
}));

vi.mock('../../../src-ts-v2/database/PlaylistRepository.js', () => ({
  PlaylistRepository: class {
    findById() {
      return { playlistId: 'PLtest', title: 'My Playlist' };
    }
  },
}));

vi.mock('../../../src-ts-v2/database/VideoRepository.js', () => ({
  VideoRepository: class {
    findByPlaylistWithTranscriptFlag(...args: unknown[]) {
      return findByPlaylistWithTranscriptFlagSpy(...args);
    }
    findByPlaylist(...args: unknown[]) {
      return findByPlaylistSpy(...args);
    }
  },
}));

vi.mock('../../../src-ts-v2/auth/YouTubeAuth.js', () => ({
  YouTubeAuth: class {
    async authenticate() {
      return {};
    }
  },
}));

vi.mock('../../../src-ts-v2/api/YouTubeClient.js', () => ({
  YouTubeClient: class {},
}));

vi.mock('../../../src-ts-v2/utils/playlistResolver.js', () => ({
  resolvePlaylistIdentifier: vi.fn().mockResolvedValue({ id: 'PLtest', title: 'My Playlist' }),
}));

// Avoid touching the real on-disk video cache during the render.
vi.mock('../../../src-ts-v2/utils/cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src-ts-v2/utils/cache.js')>();
  return {
    ...actual,
    saveVideoCache: (...args: unknown[]) => saveVideoCacheSpy(...args),
  };
});

import { PlaylistVideos } from '../PlaylistCommands.js';

/**
 * Two-stage flush: lets the async fetchVideos effect settle and React
 * commit the resulting state before assertions read the frame.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setImmediate(resolve));
}

function videoRow(videoId: string, title: string, hasTranscript: boolean, durationSeconds = 180) {
  return {
    video_id: videoId,
    title,
    channel_id: 'UCxxxx',
    channel_title: 'Chan',
    published_at: '2024-01-01T00:00:00Z',
    duration: 'PT3M',
    duration_seconds: durationSeconds,
    is_short: 0,
    has_transcript: hasTranscript,
  };
}

beforeEach(() => {
  findByPlaylistWithTranscriptFlagSpy.mockReset();
  findByPlaylistSpy.mockReset();
  saveVideoCacheSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlaylistVideos — A9 transcript column reflects DB truth', () => {
  it('renders Yes for a video with a transcript and No for one without', async () => {
    findByPlaylistWithTranscriptFlagSpy.mockReturnValue([
      videoRow('vidHasTrans', 'Has Transcript Video', true),
      videoRow('vidNoTrans', 'No Transcript Video', false),
    ]);

    const { lastFrame } = render(<PlaylistVideos playlistId="PLtest" onComplete={() => {}} />);
    await settle();

    const frame = lastFrame() ?? '';

    // Both rows present.
    expect(frame).toContain('Has Transcript Video');
    expect(frame).toContain('No Transcript Video');

    // The flagged fetch was used — not the flat findByPlaylist.
    expect(findByPlaylistWithTranscriptFlagSpy).toHaveBeenCalledTimes(1);
    expect(findByPlaylistSpy).not.toHaveBeenCalled();

    // Both column states are represented (the true row → "Yes", the false
    // row → "No"). Pre-fix every row was "No", so a "Yes" anywhere proves
    // the real flag now flows through.
    expect(frame).toContain('Yes');
    expect(frame).toContain('No');
  });

  it('caches the rows with their real has_transcript flag', async () => {
    findByPlaylistWithTranscriptFlagSpy.mockReturnValue([
      videoRow('vidHasTrans', 'Has Transcript Video', true),
      videoRow('vidNoTrans', 'No Transcript Video', false),
    ]);

    render(<PlaylistVideos playlistId="PLtest" onComplete={() => {}} />);
    await settle();

    expect(saveVideoCacheSpy).toHaveBeenCalledTimes(1);
    const cachedVideos = saveVideoCacheSpy.mock.calls[0][1] as Array<{ has_transcript?: boolean }>;
    expect(cachedVideos).toHaveLength(2);
    expect(cachedVideos[0].has_transcript).toBe(true);
    expect(cachedVideos[1].has_transcript).toBe(false);
  });
});

describe('PlaylistVideos — zero-second duration renders 0:00, not N/A', () => {
  it('renders a 0-second video as 0:00 in the Duration column', async () => {
    // A live 0-second video (duration_seconds: 0) is a valid value, not a
    // missing one. The mapping must not drop it via a truthiness check —
    // the column should read "0:00", never the missing-value placeholder.
    findByPlaylistWithTranscriptFlagSpy.mockReturnValue([
      videoRow('vidZeroDur', 'Zero Duration Video', true, 0),
    ]);

    const { lastFrame } = render(<PlaylistVideos playlistId="PLtest" onComplete={() => {}} />);
    await settle();

    const frame = lastFrame() ?? '';

    expect(frame).toContain('Zero Duration Video');
    expect(frame).toContain('0:00');

    // The row is present and its duration cell is NOT the N/A placeholder.
    expect(saveVideoCacheSpy).toHaveBeenCalledTimes(1);
    const cachedVideos = saveVideoCacheSpy.mock.calls[0][1] as Array<{ duration?: string }>;
    expect(cachedVideos).toHaveLength(1);
    expect(cachedVideos[0].duration).toBe('0:00');
  });
});

/**
 * Regression coverage for the Cursor Bugbot fix on commit cfcc206:
 * "Thread onNavigate through PlaylistDiscover and ExtractPrompt for
 * REPL navigation".
 *
 * The user-visible bug: from the post-extraction menu, picking "Extract
 * Another Playlist" rendered <PlaylistDiscover> WITHOUT forwarding
 * onNavigate. The nested discovery flow then created a fresh
 * <ExtractCommand> via <ExtractPrompt>; that nested command had no
 * onNavigate either, so its own post-extraction menu fell through to
 * exit() and bailed out of the REPL. Bugbot's fix added the prop
 * forwarding at ExtractCommand.tsx:335 (and the matching prop wiring on
 * PlaylistDiscover + ExtractPrompt).
 *
 * This test pins the load-bearing call site: when the menu's
 * "Extract Another Playlist" handler fires, the React element passed to
 * onNavigate must carry the SAME onNavigate reference (by ===) as the
 * one ExtractCommand received. That guards against:
 *
 *  - Removing the `onNavigate={onNavigate}` line on the PlaylistDiscover
 *    render (the literal Bugbot fix).
 *  - Wrapping it in an arrow like `(next) => onNavigate(next)` — same
 *    behaviour at runtime but new reference, which breaks
 *    reference-stability assumptions downstream.
 *
 * PlaylistVideos forwarding is intentionally NOT tested. Bugbot
 * deliberately did not add onNavigate to PlaylistVideos — it's a leaf,
 * and YAGNI applies.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock v2 services so ExtractCommand reaches the post-extraction menu state
// without touching the real DB / OAuth / extractor pipeline. The mocks
// trace the actual extract() control flow for type='playlist':
//
//   DatabaseManager construct -> resolvePlaylistIdentifier returns hit ->
//   YouTubeAuth.authenticate -> YouTubeClient construct -> PlaylistRepository
//   .findById returns playlist -> VideoExtractor.extractPlaylist resolves
//   immediately -> setStatus('menu').
//
// The PostExtractionMenu then renders the three options; pressing Enter
// while still on the default-selected first option fires onViewPlaylistInfo,
// not onExtractMore. We need to navigate down once and then press Enter.
// ---------------------------------------------------------------------------

vi.mock('../../../src-ts-v2/database/connection.js', () => ({
  DatabaseManager: class {
    close() {
      // no-op for hermetic tests
    }
  },
}));

vi.mock('../../../src-ts-v2/database/PlaylistRepository.js', () => ({
  PlaylistRepository: class {
    findById() {
      return {
        playlistId: 'PLtest123',
        title: 'Test Playlist',
        description: '',
        videoCount: 1,
        enabled: true,
      };
    }
    findAll() {
      return [];
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
  resolvePlaylistIdentifier: vi.fn().mockResolvedValue({ id: 'PLtest123', title: 'Test Playlist' }),
}));

// VideoExtractor.extractPlaylist must resolve without doing real work.
// Returning a stub ExtractResult is enough — ExtractCommand only reads
// processed / failed / skipped / total from it.
vi.mock('../../../src-ts-v2/extractors/VideoExtractor.js', () => ({
  VideoExtractor: class {
    async extractPlaylist() {
      return {
        processed: 1,
        distinctProcessed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
      };
    }
  },
}));

// The remaining v2 deps are only constructed (not called) inside
// buildVideoExtractorDeps(); stubbing them out keeps module loading hermetic
// on machines without better-sqlite3 / python whisper / etc.
vi.mock('../../../src-ts-v2/extractors/TranscriptExtractor.js', () => ({
  TranscriptExtractor: class {},
}));

vi.mock('../../../src-ts-v2/extractors/WhisperExtractor.js', () => ({
  WhisperExtractor: class {},
}));

vi.mock('../../../src-ts-v2/parsers/DescriptionParser.js', () => ({
  DescriptionParser: class {},
}));

vi.mock('../../../src-ts-v2/parsers/GeminiParser.js', () => ({
  GeminiParser: class {
    constructor() {
      throw new Error('disabled in tests');
    }
  },
}));

import { ExtractCommand } from '../ExtractCommand.js';

// ink-testing-library batches synchronous stdin writes — we yield between
// each keystroke so Ink's useInput handler processes them as separate events
// and React commits the resulting selectedIndex update before the next write.
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setImmediate(resolve));
}

const ENTER = '\r';
// Vim-style 'j' is treated identically to key.downArrow by PostExtractionMenu
// and avoids cross-platform terminal escape-sequence flakiness.
const DOWN = 'j';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExtractCommand — onNavigate threaded into nested PlaylistDiscover', () => {
  it('forwards the same onNavigate reference to <PlaylistDiscover> when "Extract Another Playlist" fires', async () => {
    const onNavigate = vi.fn();
    const onComplete = vi.fn();

    const { stdin, unmount } = render(
      <ExtractCommand
        type="playlist"
        id="PLtest123"
        flags={{}}
        onComplete={onComplete}
        onNavigate={onNavigate}
      />
    );

    // Wait for extract() to walk the mocked pipeline and land on status='menu'.
    // Three macrotask ticks cover: (1) DB+resolver, (2) auth + repo lookup +
    // extractor.extractPlaylist, (3) the final setStatus('menu') commit.
    await tick();
    await tick();
    await tick();

    // Sanity check: extract() did not blow up into the error branch. If we
    // assert directly on stdin keystrokes without confirming menu state,
    // a future regression that errors out before the menu would produce a
    // confusing "navigate spy never called" failure instead of a clear
    // "we never reached the menu" failure.
    expect(onNavigate).not.toHaveBeenCalled();

    // Navigate to the second menu option ("Extract Another Playlist") and
    // press Enter. The default selection is index 0
    // ("View Playlist Video Information"), so one Down moves us to index 1.
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(onNavigate).toHaveBeenCalledTimes(1);

    // The handler must hand back a React element — onNavigate(null) is the
    // "clear inline component" signal used by the Main Menu option, not by
    // Extract Another Playlist.
    const passedElement = onNavigate.mock.calls[0]?.[0];
    expect(React.isValidElement(passedElement)).toBe(true);

    // The load-bearing assertion: the rendered PlaylistDiscover must carry
    // THIS test's onNavigate reference, not an arrow wrapper or undefined.
    // Reverting Bugbot's `onNavigate={onNavigate}` on PlaylistDiscover
    // would leave props.onNavigate undefined here and fail this check.
    expect((passedElement as React.ReactElement).props.onNavigate).toBe(onNavigate);

    // And onComplete must still be forwarded (Bugbot's fix did not regress
    // the pre-existing onComplete threading).
    expect((passedElement as React.ReactElement).props.onComplete).toBe(onComplete);

    unmount();
  });
});

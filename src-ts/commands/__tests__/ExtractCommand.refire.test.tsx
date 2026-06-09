/**
 * Regression coverage for the v1.0.0 "Extract Another Playlist re-fires
 * the same playlist" bug.
 *
 * Root cause: ExtractCommand's extract-side-effect useEffect listed
 * `[type, id, flags, onComplete]` in its deps. The cli.tsx REPL wiring
 * passes a fresh `onComplete` arrow on every render of the REPL host
 * (it's an inline arrow inside `onCommand`). Once the post-extraction
 * menu rendered and the REPL host re-rendered for any reason, the
 * effect saw a new `onComplete` reference, re-ran, and re-extracted the
 * same playlist.
 *
 * The fix is a `useRef` one-shot guard inside the effect. These tests
 * pin that guard: extract() must invoke its first observable side
 * effect (constructing `DatabaseManager`) exactly once across multiple
 * re-renders, regardless of which props change.
 *
 * The PostExtractionMenu navigation contract (the "what each menu
 * option calls" half of the fix) is covered in
 * `PostExtractionMenu.test.tsx`.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mock the v2 services ExtractCommand touches before the playlist-type
// branch in extract(). The test forces an early exit by passing
// `type: 'video'` so extract() returns at the `type !== 'playlist'` guard
// before any DB / auth work — keeping the test hermetic. The mocks are
// here purely so module loading does not blow up on platforms missing
// better-sqlite3 native bindings in CI-style environments.
// --------------------------------------------------------------------------

const databaseManagerSpy = vi.fn();

vi.mock('../../../src-ts-v2/database/connection.js', () => ({
  DatabaseManager: class {
    constructor(path: string) {
      databaseManagerSpy(path);
    }
    close() {
      // no-op for hermetic tests
    }
  },
}));

vi.mock('../../../src-ts-v2/database/PlaylistRepository.js', () => ({
  PlaylistRepository: class {
    findById() {
      return null;
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
  resolvePlaylistIdentifier: vi.fn().mockResolvedValue(null),
}));

import { ExtractCommand } from '../ExtractCommand.js';

beforeEach(() => {
  databaseManagerSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExtractCommand — extract() one-shot ref guard', () => {
  it('does NOT re-fire extract() when onComplete reference changes across re-renders', async () => {
    // Use --all path so extract() always reaches DatabaseManager
    // construction (the first observable side effect). The mocked
    // PlaylistRepository returns no enabled playlists, so the effect
    // exits cleanly via the "No enabled playlists" error branch — no
    // network / auth / extractor activity.
    const firstOnComplete = vi.fn();
    const { rerender, unmount } = render(
      <ExtractCommand type="all" flags={{ all: true }} onComplete={firstOnComplete} />
    );

    // Wait a microtask tick so the async extract() runs through its
    // first DB construction. The "No enabled playlists" branch settles
    // synchronously after the constructor.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const callsAfterFirstRender = databaseManagerSpy.mock.calls.length;
    expect(callsAfterFirstRender).toBeGreaterThanOrEqual(1);

    // Re-render with a *different* onComplete reference. Pre-fix, this
    // re-fires the effect (and thus the extraction). Post-fix, the
    // startedRef guard short-circuits.
    const secondOnComplete = vi.fn();
    rerender(<ExtractCommand type="all" flags={{ all: true }} onComplete={secondOnComplete} />);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(databaseManagerSpy.mock.calls.length).toBe(callsAfterFirstRender);

    // Third re-render — still no re-fire.
    rerender(
      <ExtractCommand type="all" flags={{ all: true }} onComplete={vi.fn()} onNavigate={vi.fn()} />
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(databaseManagerSpy.mock.calls.length).toBe(callsAfterFirstRender);

    unmount();
  });
});

/**
 * Behavioural coverage for the v1.0.0 PostExtractionMenu navigation
 * contract: each menu option must invoke the corresponding callback
 * prop on Enter.
 *
 * Shipped v1.0.0 wired the menu correctly to its three callbacks but
 * the *consumer* (ExtractCommand) routed all three to a no-op
 * `onComplete()`. The component-level contract was always sound — but
 * since the consumer was broken and the user-reported regression is at
 * the menu interaction, these tests defensively pin the contract so
 * any future regression at this layer is caught.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { PostExtractionMenu } from '../PostExtractionMenu.js';

/**
 * ink-testing-library's stdin batches multiple synchronous writes into
 * a single keypress event. To register separate keystrokes (e.g. two
 * down-arrows then Enter), each write must be on its own microtask
 * tick — yielding lets Ink's useInput handler process each keypress
 * independently.
 */
async function tick(): Promise<void> {
  // Two-stage flush: first macrotask lets ink-testing-library push the
  // keystroke into Ink's input stream, second lets React commit the
  // resulting state update so the next useInput handler closes over the
  // new selectedIndex.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setImmediate(resolve));
}

// PostExtractionMenu's useInput treats vim-style 'j' identically to
// key.downArrow (and 'k' identically to key.upArrow). We use the vim
// characters because ink-testing-library forwards raw bytes — terminal
// escape-sequence parsing for arrow keys is unreliable across platforms.
const ENTER = '\r';
const DOWN = 'j';

interface RenderArgs {
  onViewPlaylistInfo?: () => void;
  onExtractMore?: () => void;
  onMainMenu?: () => void;
}

function renderMenu(args: RenderArgs = {}) {
  return render(
    <PostExtractionMenu
      playlistId="PLtest"
      playlistTitle="Test Playlist"
      successCount={2}
      failureCount={0}
      skippedCount={0}
      totalVideos={2}
      onViewPlaylistInfo={args.onViewPlaylistInfo}
      onExtractMore={args.onExtractMore}
      onMainMenu={args.onMainMenu}
    />
  );
}

describe('PostExtractionMenu — navigation contract', () => {
  it('renders the three menu options and the completion summary', () => {
    const { lastFrame } = renderMenu();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Extraction Complete');
    expect(frame).toContain('Test Playlist');
    expect(frame).toContain('View Playlist Video Information');
    expect(frame).toContain('Extract Another Playlist');
    expect(frame).toContain('Return to Main Menu');
  });

  it('fires onViewPlaylistInfo when Enter is pressed on the first option (default selection)', () => {
    const onViewPlaylistInfo = vi.fn();
    const onExtractMore = vi.fn();
    const onMainMenu = vi.fn();

    const { stdin } = renderMenu({ onViewPlaylistInfo, onExtractMore, onMainMenu });
    stdin.write(ENTER);

    expect(onViewPlaylistInfo).toHaveBeenCalledTimes(1);
    expect(onExtractMore).not.toHaveBeenCalled();
    expect(onMainMenu).not.toHaveBeenCalled();
  });

  it('fires onExtractMore when Enter is pressed on the second option', async () => {
    const onViewPlaylistInfo = vi.fn();
    const onExtractMore = vi.fn();
    const onMainMenu = vi.fn();

    const { stdin } = renderMenu({ onViewPlaylistInfo, onExtractMore, onMainMenu });
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(onExtractMore).toHaveBeenCalledTimes(1);
    expect(onViewPlaylistInfo).not.toHaveBeenCalled();
    expect(onMainMenu).not.toHaveBeenCalled();
  });

  it('fires onMainMenu when Enter is pressed on the third option', async () => {
    const onViewPlaylistInfo = vi.fn();
    const onExtractMore = vi.fn();
    const onMainMenu = vi.fn();

    const { stdin } = renderMenu({ onViewPlaylistInfo, onExtractMore, onMainMenu });
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(onMainMenu).toHaveBeenCalledTimes(1);
    expect(onViewPlaylistInfo).not.toHaveBeenCalled();
    expect(onExtractMore).not.toHaveBeenCalled();
  });

  it('does not throw when a callback prop is omitted', () => {
    // Component must tolerate missing handlers (the menuItem.action
    // guard in PostExtractionMenu). This pins the resilience contract.
    const { stdin } = renderMenu({});

    expect(() => stdin.write(ENTER)).not.toThrow();
  });
});

describe('PostExtractionMenu — truthful end-of-run summary', () => {
  it('omits all new summary lines when the new props are absent (baseline shape unchanged)', () => {
    const { lastFrame } = renderMenu();
    const frame = lastFrame() ?? '';

    expect(frame).not.toContain('Unavailable in playlist');
    expect(frame).not.toContain('Skipped (malformed API data)');
    expect(frame).not.toContain('Saved to DB');
    expect(frame).not.toContain('Warning: claimed');
  });

  it('shows the unavailable line when unavailableCount > 0', () => {
    const { lastFrame } = render(
      <PostExtractionMenu
        playlistId="PLtest"
        successCount={2}
        failureCount={0}
        totalVideos={5}
        unavailableCount={3}
      />
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Unavailable in playlist (private/deleted): 3');
  });

  it('hides the unavailable line when unavailableCount is 0', () => {
    const { lastFrame } = render(
      <PostExtractionMenu
        playlistId="PLtest"
        successCount={2}
        failureCount={0}
        totalVideos={5}
        unavailableCount={0}
      />
    );

    expect(lastFrame() ?? '').not.toContain('Unavailable in playlist');
  });

  it('shows the malformed-skipped line when shapeMismatchCount > 0', () => {
    const { lastFrame } = render(
      <PostExtractionMenu
        playlistId="PLtest"
        successCount={1}
        failureCount={0}
        totalVideos={5}
        shapeMismatchCount={2}
      />
    );

    expect(lastFrame() ?? '').toContain('Skipped (malformed API data): 2');
  });

  it('shows the saved-to-DB line when verified counts are provided', () => {
    const { lastFrame } = render(
      <PostExtractionMenu
        playlistId="PLtest"
        successCount={4}
        failureCount={0}
        totalVideos={4}
        verifiedVideoRows={4}
        verifiedTranscriptRows={3}
      />
    );

    expect(lastFrame() ?? '').toContain('Saved to DB: 4 videos, 3 transcripts');
  });

  it('renders a red mismatch warning when verifiedVideoRows is below the extracted count', () => {
    const { lastFrame } = render(
      <PostExtractionMenu
        playlistId="PLtest"
        successCount={5}
        failureCount={0}
        totalVideos={5}
        verifiedVideoRows={2}
        verifiedTranscriptRows={2}
      />
    );

    expect(lastFrame() ?? '').toContain(
      'Warning: claimed 5 extracted but only 2 video rows found in DB'
    );
  });

  it('does not warn when verifiedVideoRows matches the extracted count', () => {
    const { lastFrame } = render(
      <PostExtractionMenu
        playlistId="PLtest"
        successCount={5}
        failureCount={0}
        totalVideos={5}
        verifiedVideoRows={5}
        verifiedTranscriptRows={5}
      />
    );

    expect(lastFrame() ?? '').not.toContain('Warning: claimed');
  });
});

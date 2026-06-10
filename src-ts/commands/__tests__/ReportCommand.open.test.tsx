/**
 * Coverage for report browser-open honesty (PARITY.md section B, task 3).
 *
 * Before: ReportCommand printed "Opening in browser..." but no open() call
 * existed — the copy lied. Now it actually opens the generated report for the
 * single-report modes (single video, single consolidated playlist), matching
 * Python which calls webbrowser.open for those modes only
 * (cli.py:982-985, 1022-1025, 1054-1058) and NOT for --all (no open there).
 * `--no-open` suppresses both the open call and the copy.
 *
 * The `open` package is mocked at the module boundary; the v2 services are
 * stubbed so the render is hermetic.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openSpy = vi.fn().mockResolvedValue(undefined);

// The command opens via a dynamic `import('open')` (same pattern as
// OAuthServer.openBrowser). Mock the default export.
vi.mock('open', () => ({
  default: (...args: unknown[]) => openSpy(...args),
}));

vi.mock('../../../src-ts-v2/database/connection.js', () => ({
  DatabaseManager: class {
    constructor(_path: string) {}
    close() {}
  },
}));

const generateVideoReportSpy = vi.fn().mockResolvedValue('reports/video-vid00000001.html');
const generatePlaylistReportSpy = vi.fn().mockResolvedValue('reports/playlist-PLtest.html');

vi.mock('../../../src-ts-v2/reports/HTMLReportGenerator.js', () => ({
  HTMLReportGenerator: class {
    constructor(_db: unknown, _cfg: unknown) {}
    generateVideoReport(...args: unknown[]) {
      return generateVideoReportSpy(...args);
    }
    generatePlaylistReport(...args: unknown[]) {
      return generatePlaylistReportSpy(...args);
    }
  },
}));

vi.mock('../../../src-ts-v2/database/VideoRepository.js', () => ({
  VideoRepository: class {
    findAll() {
      return [{ video_id: 'vid00000001' }, { video_id: 'vid00000002' }];
    }
  },
}));

vi.mock('../../../src-ts-v2/utils/playlistResolver.js', () => ({
  resolvePlaylistIdentifier: vi.fn().mockResolvedValue({ id: 'PLtest', title: 'My Playlist' }),
}));

import { ReportCommand } from '../ReportCommand.js';

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  openSpy.mockClear();
  generateVideoReportSpy.mockClear();
  generatePlaylistReportSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('report open behaviour', () => {
  it('opens the report for a single video and shows the copy', async () => {
    const { frames } = render(
      <ReportCommand type="video" id="vid00000001" flags={{}} onComplete={() => {}} />
    );
    await settle();

    expect(openSpy).toHaveBeenCalledTimes(1);
    // The opened argument names the generated report file.
    expect(String(openSpy.mock.calls[0][0])).toContain('video-vid00000001.html');
    expect(frames.join('\n')).toContain('Opening in browser');
  });

  it('opens the consolidated playlist report', async () => {
    render(<ReportCommand type="playlist" id="PLtest" flags={{}} onComplete={() => {}} />);
    await settle();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(String(openSpy.mock.calls[0][0])).toContain('playlist-PLtest.html');
  });

  it('does NOT open when --no-open is set, and hides the copy', async () => {
    const { frames } = render(
      <ReportCommand type="video" id="vid00000001" flags={{ noOpen: true }} onComplete={() => {}} />
    );
    await settle();

    expect(openSpy).not.toHaveBeenCalled();
    expect(frames.join('\n')).not.toContain('Opening in browser');
  });

  it('does NOT open for --all batch mode (matches Python)', async () => {
    render(<ReportCommand type="video" flags={{ all: true }} onComplete={() => {}} />);
    await settle();

    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not crash when open() rejects (warns, completes)', async () => {
    openSpy.mockRejectedValueOnce(new Error('no browser'));

    const { frames } = render(
      <ReportCommand type="video" id="vid00000001" flags={{}} onComplete={() => {}} />
    );
    await settle();

    // Still reaches the done view despite the open failure.
    expect(frames.join('\n')).toContain('Report Generated');
  });
});

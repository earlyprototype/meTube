import { stripVTControlCharacters } from 'node:util';
import React from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { ReplMode } from '../ReplMode.js';

vi.mock('../../../src-ts-v2/auth/YouTubeAuth.js', () => ({
  YouTubeAuth: class {
    loadTokens() {}
  },
}));
vi.mock('../../utils/appConfig.js', () => ({
  loadAppPaths: () => ({ dbPath: ':memory:' }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('preserves every logo column in the persistent REPL header', async () => {
  const expectedRows = [
    '███╗   ███╗███████╗████████╗██╗   ██╗██████╗ ███████╗',
    '████╗ ████║██╔════╝╚══██╔══╝██║   ██║██╔══██╗██╔════╝',
    '██╔████╔██║█████╗     ██║   ██║   ██║██████╔╝█████╗  ',
    '██║╚██╔╝██║██╔══╝     ██║   ██║   ██║██╔══██╗██╔══╝  ',
    '██║ ╚═╝ ██║███████╗   ██║   ╚██████╔╝██████╔╝███████╗',
    '╚═╝     ╚═╝╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚══════╝',
  ];
  vi.useFakeTimers();
  const { lastFrame } = render(<ReplMode onCommand={vi.fn()} onExit={vi.fn()} />);
  await vi.advanceTimersByTimeAsync(1500);
  await vi.waitFor(() => expect(lastFrame()).toContain('YouTube Video Extraction & Analysis CLI'));

  const lines = stripVTControlCharacters(lastFrame() ?? '').split('\n');
  const firstRow = lines.findIndex((line) => line.includes('█'));
  expect(firstRow).toBeGreaterThanOrEqual(0);
  const left = lines[firstRow].indexOf('█');
  const logo = lines
    .slice(firstRow, firstRow + expectedRows.length)
    .map((line) => line.slice(left, left + expectedRows[0].length));
  expect(logo).toEqual(expectedRows);
});

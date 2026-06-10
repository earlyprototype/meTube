/**
 * Coverage for the "Filtered to N {privacy}" feedback on add-mine (PARITY.md
 * section C, task 6). Python prints the filter result (cli.py:752); the TS path
 * filtered silently. The line now renders in the selection view when a
 * --privacy filter is applied, and is absent otherwise.
 *
 * v2 services are stubbed at the module boundary so the render is hermetic.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getMyPlaylistsSpy = vi.fn();

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

vi.mock('../../../src-ts-v2/api/YouTubeClient.js', () => ({
  YouTubeClient: class {
    async getMyPlaylists() {
      return getMyPlaylistsSpy();
    }
  },
}));

vi.mock('../../../src-ts-v2/database/PlaylistRepository.js', () => ({
  PlaylistRepository: class {
    findAll() {
      return [];
    }
    createOrUpdate() {}
  },
}));

import { PlaylistCommands } from '../PlaylistCommands.js';

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function playlist(id: string, title: string, privacyStatus: string) {
  return {
    playlistId: id,
    title,
    description: '',
    itemCount: 3,
    privacyStatus,
  };
}

beforeEach(() => {
  getMyPlaylistsSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('add-mine — privacy filter feedback', () => {
  it('renders "Filtered to N private playlists" when --privacy private is set', async () => {
    getMyPlaylistsSpy.mockResolvedValue([
      playlist('PL1', 'Public One', 'public'),
      playlist('PL2', 'Private One', 'private'),
      playlist('PL3', 'Private Two', 'private'),
    ]);

    const { frames } = render(
      <PlaylistCommands subcommand="add-mine" args={[]} flags={{ privacy: 'private' }} />
    );
    await settle();

    expect(frames.join('\n')).toContain('Filtered to 2 private playlists');
  });

  it('does NOT render the filter line when no privacy filter is applied', async () => {
    getMyPlaylistsSpy.mockResolvedValue([
      playlist('PL1', 'Public One', 'public'),
      playlist('PL2', 'Private One', 'private'),
    ]);

    const { frames } = render(<PlaylistCommands subcommand="add-mine" args={[]} flags={{}} />);
    await settle();

    expect(frames.join('\n')).not.toContain('Filtered to');
  });

  it('does NOT render the filter line for --privacy all', async () => {
    getMyPlaylistsSpy.mockResolvedValue([playlist('PL1', 'Public One', 'public')]);

    const { frames } = render(
      <PlaylistCommands subcommand="add-mine" args={[]} flags={{ privacy: 'all' }} />
    );
    await settle();

    expect(frames.join('\n')).not.toContain('Filtered to');
  });
});

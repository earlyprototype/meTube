/**
 * Wave 3 cache.ts tests.
 *
 * The behavioural promise of `cache.ts` after the Wave-1 Zod-on-load fix is:
 *
 *   - Well-formed cache file → caller receives the parsed entry.
 *   - Malformed cache file (bad JSON, drifted shape, partial write) →
 *     caller receives the cache-miss sentinel (`null` / `[]`), never an
 *     exception, never a half-shaped object.
 *   - Read+write round-trip preserves shape end-to-end.
 *
 * The tests run against a per-test `tmpdir` so they never touch the real
 * `data/` directory. Each test changes the process cwd into that tmpdir,
 * lets the cache module use its relative `data/` path normally, then
 * restores the cwd in `afterEach`.
 *
 * AAA throughout. No mocks.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAllCaches,
  getPlaylistByNumber,
  getVideoByNumber,
  loadPlaylistCache,
  loadVideoCache,
  savePlaylistCache,
  saveVideoCache,
  searchPlaylistsByTitle,
  type CachedPlaylist,
  type CachedVideo,
} from '../utils/cache.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

interface Workspace {
  dir: string;
  videoFile: string;
  playlistFile: string;
  originalCwd: string;
}

function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metube-cache-test-'));
  const originalCwd = process.cwd();
  process.chdir(dir);

  // The module uses `data/` relative to cwd; we don't pre-create it so we
  // can test the "directory doesn't exist yet" path on first save.
  return {
    dir,
    videoFile: path.join(dir, 'data', 'video_cache.json'),
    playlistFile: path.join(dir, 'data', 'playlist_cache.json'),
    originalCwd,
  };
}

function cleanupWorkspace(ws: Workspace): void {
  process.chdir(ws.originalCwd);
  fs.rmSync(ws.dir, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// Video cache — load
// --------------------------------------------------------------------------

describe('cache — loadVideoCache', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('returns null when no cache file exists', () => {
    // Arrange — no file written

    // Act
    const result = loadVideoCache('PLanything');

    // Assert
    expect(result).toBeNull();
  });

  it('returns the parsed array for a well-formed cache file', () => {
    // Arrange
    const videos: CachedVideo[] = [
      { num: 1, video_id: 'dQw4w9WgXcQ', title: 'Vid one' },
      {
        num: 2,
        video_id: 'jNQXAC9IVRw',
        title: 'Vid two',
        duration: 'PT5M',
        has_transcript: true,
      },
    ];
    saveVideoCache('PLgood', videos);

    // Act
    const loaded = loadVideoCache('PLgood');

    // Assert
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(2);
    expect(loaded?.[0].video_id).toBe('dQw4w9WgXcQ');
    expect(loaded?.[1].has_transcript).toBe(true);
  });

  it('returns null when the cache file is not valid JSON', () => {
    // Arrange — write garbage to the cache file directly
    fs.mkdirSync(path.dirname(ws.videoFile), { recursive: true });
    fs.writeFileSync(ws.videoFile, 'this is not json {{');

    // Act
    const result = loadVideoCache('PLanything');

    // Assert — Zod parse must not be reached because JSON.parse fails
    expect(result).toBeNull();
  });

  it('returns null when the cache shape has drifted (Zod parse fails)', () => {
    // Arrange — valid JSON but wrong shape: video num is a string
    fs.mkdirSync(path.dirname(ws.videoFile), { recursive: true });
    const drifted = {
      PLshape: [{ num: 'one', video_id: 'dQw4w9WgXcQ', title: 't' }],
    };
    fs.writeFileSync(ws.videoFile, JSON.stringify(drifted));

    // Act
    const result = loadVideoCache('PLshape');

    // Assert
    expect(result).toBeNull();
  });

  it('returns null when the requested playlist is not in the cache', () => {
    // Arrange — populate with one playlist
    saveVideoCache('PLpresent', [{ num: 1, video_id: 'aaaaaaaaaaa', title: 'one' }]);

    // Act
    const result = loadVideoCache('PLabsent');

    // Assert
    expect(result).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Video cache — save (round-trip)
// --------------------------------------------------------------------------

describe('cache — saveVideoCache + loadVideoCache round-trip', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('round-trips a single playlist through write -> read', () => {
    // Arrange
    const videos: CachedVideo[] = [
      { num: 1, video_id: 'aaaaaaaaaaa', title: 'A' },
      { num: 2, video_id: 'bbbbbbbbbbb', title: 'B' },
    ];

    // Act
    saveVideoCache('PLroundtrip', videos);
    const loaded = loadVideoCache('PLroundtrip');

    // Assert
    expect(loaded).toEqual(videos);
  });

  it('preserves other playlists when overwriting one', () => {
    // Arrange
    saveVideoCache('PLfirst', [{ num: 1, video_id: 'aaaaaaaaaaa', title: 'A' }]);
    saveVideoCache('PLsecond', [{ num: 1, video_id: 'bbbbbbbbbbb', title: 'B' }]);

    // Act — overwrite first
    saveVideoCache('PLfirst', [{ num: 1, video_id: 'ccccccccccc', title: 'C' }]);

    // Assert — second is untouched
    expect(loadVideoCache('PLfirst')?.[0].video_id).toBe('ccccccccccc');
    expect(loadVideoCache('PLsecond')?.[0].video_id).toBe('bbbbbbbbbbb');
  });

  it('treats a drifted on-disk shape as empty during save (does not throw)', () => {
    // Arrange — drifted file already in place
    fs.mkdirSync(path.dirname(ws.videoFile), { recursive: true });
    fs.writeFileSync(ws.videoFile, JSON.stringify({ PLold: [{ num: 'x' }] }));

    // Act — new save must not throw, must overwrite without inheriting drift
    expect(() =>
      saveVideoCache('PLnew', [{ num: 1, video_id: 'aaaaaaaaaaa', title: 'A' }])
    ).not.toThrow();

    // Assert
    const loaded = loadVideoCache('PLnew');
    expect(loaded).toHaveLength(1);
    // The previously-drifted entry was discarded; its slot is not present.
    expect(loadVideoCache('PLold')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// getVideoByNumber
// --------------------------------------------------------------------------

describe('cache — getVideoByNumber', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('returns the video at the requested position', () => {
    // Arrange
    saveVideoCache('PLnum', [
      { num: 1, video_id: 'aaaaaaaaaaa', title: 'A' },
      { num: 2, video_id: 'bbbbbbbbbbb', title: 'B' },
      { num: 3, video_id: 'ccccccccccc', title: 'C' },
    ]);

    // Act
    const v = getVideoByNumber('PLnum', 2);

    // Assert
    expect(v?.video_id).toBe('bbbbbbbbbbb');
  });

  it('returns null when the position is not present', () => {
    // Arrange
    saveVideoCache('PLnum', [{ num: 1, video_id: 'aaaaaaaaaaa', title: 'A' }]);

    // Act + Assert
    expect(getVideoByNumber('PLnum', 99)).toBeNull();
  });

  it('returns null when the playlist is not cached at all', () => {
    // Arrange — no cache populated

    // Act + Assert
    expect(getVideoByNumber('PLmissing', 1)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Playlist cache — load
// --------------------------------------------------------------------------

describe('cache — loadPlaylistCache', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('returns an empty array when no cache file exists', () => {
    // Arrange — none

    // Act + Assert
    expect(loadPlaylistCache()).toEqual([]);
  });

  it('returns the parsed array for a well-formed cache file', () => {
    // Arrange
    const playlists: CachedPlaylist[] = [
      { num: 1, id: 'PLgood1', title: 'first', video_count: 5 },
      { num: 2, id: 'PLgood2', title: 'second' },
    ];
    savePlaylistCache(playlists);

    // Act
    const loaded = loadPlaylistCache();

    // Assert
    expect(loaded).toEqual(playlists);
  });

  it('returns an empty array when the playlist cache file is malformed JSON', () => {
    // Arrange
    fs.mkdirSync(path.dirname(ws.playlistFile), { recursive: true });
    fs.writeFileSync(ws.playlistFile, '!!! not json !!!');

    // Act + Assert
    expect(loadPlaylistCache()).toEqual([]);
  });

  it('returns an empty array when the shape has drifted (Zod fails)', () => {
    // Arrange — `num` is a string, `id` is missing
    fs.mkdirSync(path.dirname(ws.playlistFile), { recursive: true });
    fs.writeFileSync(ws.playlistFile, JSON.stringify([{ num: 'one', title: 'drifted' }]));

    // Act + Assert
    expect(loadPlaylistCache()).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Playlist cache — save (round-trip)
// --------------------------------------------------------------------------

describe('cache — savePlaylistCache + loadPlaylistCache round-trip', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('round-trips a list of playlists', () => {
    // Arrange
    const playlists: CachedPlaylist[] = [
      { num: 1, id: 'PLone', title: 'one' },
      { num: 2, id: 'PLtwo', title: 'two', video_count: 10 },
    ];

    // Act
    savePlaylistCache(playlists);
    const loaded = loadPlaylistCache();

    // Assert
    expect(loaded).toEqual(playlists);
  });

  it('getPlaylistByNumber finds a playlist by 1-indexed position', () => {
    // Arrange
    savePlaylistCache([
      { num: 1, id: 'PLone', title: 'one' },
      { num: 2, id: 'PLtwo', title: 'two' },
      { num: 3, id: 'PLthree', title: 'three' },
    ]);

    // Act + Assert
    expect(getPlaylistByNumber(2)?.id).toBe('PLtwo');
    expect(getPlaylistByNumber(99)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// searchPlaylistsByTitle
// --------------------------------------------------------------------------

describe('cache — searchPlaylistsByTitle', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('matches case-insensitively on partial title', () => {
    // Arrange
    savePlaylistCache([
      { num: 1, id: 'PLa', title: 'Machine Learning' },
      { num: 2, id: 'PLb', title: 'Cooking Class' },
      { num: 3, id: 'PLc', title: 'Advanced Machine Topics' },
    ]);

    // Act
    const hits = searchPlaylistsByTitle('machine');

    // Assert
    expect(hits.map((h) => h.id)).toEqual(['PLa', 'PLc']);
  });

  it('returns an empty array when nothing matches', () => {
    // Arrange
    savePlaylistCache([{ num: 1, id: 'PLa', title: 'whatever' }]);

    // Act + Assert
    expect(searchPlaylistsByTitle('nope')).toEqual([]);
  });

  it('returns an empty array when no playlists are cached', () => {
    // Arrange — no playlist cache file

    // Act + Assert
    expect(searchPlaylistsByTitle('anything')).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// clearAllCaches
// --------------------------------------------------------------------------

describe('cache — clearAllCaches', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('removes both cache files and is idempotent on second call', () => {
    // Arrange
    saveVideoCache('PLone', [{ num: 1, video_id: 'aaaaaaaaaaa', title: 'A' }]);
    savePlaylistCache([{ num: 1, id: 'PLone', title: 'A' }]);
    expect(fs.existsSync(ws.videoFile)).toBe(true);
    expect(fs.existsSync(ws.playlistFile)).toBe(true);

    // Act
    clearAllCaches();

    // Assert
    expect(fs.existsSync(ws.videoFile)).toBe(false);
    expect(fs.existsSync(ws.playlistFile)).toBe(false);

    // Act again — must not throw
    expect(() => clearAllCaches()).not.toThrow();
  });
});

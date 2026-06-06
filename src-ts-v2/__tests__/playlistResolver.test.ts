/**
 * Wave 3 playlistResolver tests.
 *
 * Exercises every resolution source and the prefix-validation discipline:
 *
 *   1. Number → cache lookup
 *   2. YouTube URL → branded ID extraction (+ rejection of malformed URLs)
 *   3. Partial title → cache search (+ MultipleMatchesError)
 *   4. Direct ID → branded validation accepts all 5 prefixes
 *      (PL, UU, LL, FL, RD); rejects OL and other shapes that v1
 *      mistakenly accepted
 *   5. Database fallback → real `:memory:` DatabaseManager + real
 *      PlaylistRepository, no mocks
 *   6. resolvePlaylistOrThrow surface
 *   7. resolveMultiplePlaylists batch behaviour
 *
 * AAA pattern throughout.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { savePlaylistCache } from '../utils/cache.js';
import {
  MultipleMatchesError,
  resolveMultiplePlaylists,
  resolvePlaylistIdentifier,
  resolvePlaylistOrThrow,
} from '../utils/playlistResolver.js';

import { DatabaseManager } from '../database/connection.js';
import { PlaylistRepository } from '../database/PlaylistRepository.js';
import { asPlaylistId } from '../types/branded.js';
import { ValidationError } from '../errors/index.js';

// --------------------------------------------------------------------------
// Workspace helpers
// --------------------------------------------------------------------------

interface Workspace {
  dir: string;
  originalCwd: string;
}

function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metube-resolver-test-'));
  const originalCwd = process.cwd();
  process.chdir(dir);
  return { dir, originalCwd };
}

function cleanupWorkspace(ws: Workspace): void {
  process.chdir(ws.originalCwd);
  fs.rmSync(ws.dir, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// 1. Number source — cache lookup
// --------------------------------------------------------------------------

describe('resolvePlaylistIdentifier — number source', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('resolves a numeric input via the cache (1-indexed)', async () => {
    // Arrange
    savePlaylistCache([
      { num: 1, id: 'PLfirst123', title: 'First' },
      { num: 2, id: 'PLsecond12', title: 'Second' },
    ]);

    // Act
    const result = await resolvePlaylistIdentifier('2');

    // Assert
    expect(result?.id).toBe('PLsecond12');
    expect(result?.title).toBe('Second');
    expect(result?.source).toBe('number');
  });

  it('returns null when the number is not in the cache', async () => {
    // Arrange — cache exists but doesn't include 99
    savePlaylistCache([{ num: 1, id: 'PLone', title: 'One' }]);

    // Act
    const result = await resolvePlaylistIdentifier('99');

    // Assert
    expect(result).toBeNull();
  });
});

// --------------------------------------------------------------------------
// 2. YouTube URL source
// --------------------------------------------------------------------------

describe('resolvePlaylistIdentifier — URL source', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('extracts the list= parameter as a branded playlist ID', async () => {
    // Arrange — no cache, no DB, just URL parsing
    const url =
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L';

    // Act
    const result = await resolvePlaylistIdentifier(url);

    // Assert
    expect(result?.source).toBe('url');
    expect(result?.id).toBe('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');
  });

  it('throws ValidationError when the URL contains an invalid playlist ID', async () => {
    // Arrange — `list=` exists but the value has no canonical prefix
    const url = 'https://www.youtube.com/watch?list=ZZbadprefix1234';

    // Act + Assert
    await expect(resolvePlaylistIdentifier(url)).rejects.toThrow(ValidationError);
  });
});

// --------------------------------------------------------------------------
// 3. Partial title source — cache
// --------------------------------------------------------------------------

describe('resolvePlaylistIdentifier — title source', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('resolves a unique partial-title match from the cache', async () => {
    // Arrange
    savePlaylistCache([
      { num: 1, id: 'PLcooking', title: 'Cooking 101' },
      { num: 2, id: 'PLcoding', title: 'Coding Daily' },
    ]);

    // Act
    const result = await resolvePlaylistIdentifier('cooking');

    // Assert
    expect(result?.source).toBe('title');
    expect(result?.id).toBe('PLcooking');
  });

  it('throws MultipleMatchesError on ambiguous partial titles', async () => {
    // Arrange
    savePlaylistCache([
      { num: 1, id: 'PLpython1', title: 'Python Basics' },
      { num: 2, id: 'PLpython2', title: 'Advanced Python' },
    ]);

    // Act + Assert
    await expect(resolvePlaylistIdentifier('python')).rejects.toThrow(MultipleMatchesError);
  });
});

// --------------------------------------------------------------------------
// 4. Direct ID source — prefix validation
// --------------------------------------------------------------------------

describe('resolvePlaylistIdentifier — direct ID source (5 prefixes)', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it.each([
    ['PL', 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L'],
    ['UU', 'UUuAXFkgsw1L7xaCfnd5JJOw'],
    ['LL', 'LLuAXFkgsw1L7xaCfnd5JJOw'],
    ['FL', 'FLuAXFkgsw1L7xaCfnd5JJOw'],
    ['RD', 'RDMM9bZkp7q19f0'],
  ])('accepts a direct ID with the %s prefix', async (_prefix, candidate) => {
    // Arrange — no cache, no DB, so resolver must fall through to
    // direct-ID path and return a successful resolution.
    // Act
    const result = await resolvePlaylistIdentifier(candidate);

    // Assert
    expect(result?.source).toBe('direct');
    expect(result?.id).toBe(candidate);
  });

  it('rejects the OL prefix that v1 mistakenly accepted', async () => {
    // Arrange
    const candidate = 'OLBCF2DAC6FFB574DE';

    // Act — OL doesn't match the prefix regex, doesn't match a URL, isn't
    // numeric. With no cache or DB it falls through to a null resolution.
    const result = await resolvePlaylistIdentifier(candidate);

    // Assert
    expect(result).toBeNull();
  });

  it('rejects a totally malformed candidate', async () => {
    // Arrange
    // Act
    const result = await resolvePlaylistIdentifier('garbage-input!');
    // Assert
    expect(result).toBeNull();
  });

  it('returns null for empty / whitespace input', async () => {
    // Arrange + Act + Assert
    expect(await resolvePlaylistIdentifier('')).toBeNull();
    expect(await resolvePlaylistIdentifier('   ')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// 5. Database fallback source
// --------------------------------------------------------------------------

describe('resolvePlaylistIdentifier — database source', () => {
  let ws: Workspace;
  let dbm: DatabaseManager;

  beforeEach(() => {
    ws = makeWorkspace();
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
    cleanupWorkspace(ws);
  });

  it('resolves a partial title via the DB when not in the cache', async () => {
    // Arrange — no cache, but a playlist in the DB
    const repo = new PlaylistRepository(dbm);
    repo.createOrUpdate({
      playlistId: asPlaylistId('PLdbonly1234'),
      title: 'DB-only Topic',
    });

    // Act — input is not numeric, not a URL, not ID-shaped → falls
    // through cache (empty), title-search (empty), direct-ID
    // (regex miss) into DB fallback.
    const result = await resolvePlaylistIdentifier('db-only', { db: dbm });

    // Assert
    expect(result?.source).toBe('database');
    expect(result?.id).toBe('PLdbonly1234');
    expect(result?.title).toBe('DB-only Topic');
  });

  it('skips the DB fallback when no DB is passed', async () => {
    // Arrange — playlist exists in a separate DB we never pass in
    const repo = new PlaylistRepository(dbm);
    repo.createOrUpdate({
      playlistId: asPlaylistId('PLdbonly1234'),
      title: 'DB-only Topic',
    });

    // Act — no db in context
    const result = await resolvePlaylistIdentifier('db-only');

    // Assert
    expect(result).toBeNull();
  });

  it('throws MultipleMatchesError on ambiguous DB results', async () => {
    // Arrange — two DB playlists that both match
    const repo = new PlaylistRepository(dbm);
    repo.createOrUpdate({
      playlistId: asPlaylistId('PLdbjava1234'),
      title: 'Java Basics',
    });
    repo.createOrUpdate({
      playlistId: asPlaylistId('PLdbjava5678'),
      title: 'Advanced Java',
    });

    // Act + Assert
    await expect(resolvePlaylistIdentifier('java', { db: dbm })).rejects.toThrow(
      MultipleMatchesError
    );
  });

  it('returns null when nothing matches in DB either', async () => {
    // Arrange — empty DB

    // Act
    const result = await resolvePlaylistIdentifier('not-found', { db: dbm });

    // Assert
    expect(result).toBeNull();
  });
});

// --------------------------------------------------------------------------
// 6. resolvePlaylistOrThrow
// --------------------------------------------------------------------------

describe('resolvePlaylistOrThrow', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('returns the resolution when one is found', async () => {
    // Arrange
    savePlaylistCache([{ num: 1, id: 'PLfound1234', title: 'Found' }]);

    // Act
    const result = await resolvePlaylistOrThrow('1');

    // Assert
    expect(result.id).toBe('PLfound1234');
  });

  it('throws a helpful error when nothing resolves', async () => {
    // Arrange + Act + Assert
    await expect(resolvePlaylistOrThrow('whatever')).rejects.toThrow(/Playlist not found/);
  });
});

// --------------------------------------------------------------------------
// 7. resolveMultiplePlaylists
// --------------------------------------------------------------------------

describe('resolveMultiplePlaylists', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
  });

  it('resolves a mix of resolvable and unresolvable inputs', async () => {
    // Arrange
    savePlaylistCache([{ num: 1, id: 'PLone12345', title: 'One' }]);

    // Act
    const results = await resolveMultiplePlaylists(['1', 'no-such-thing']);

    // Assert
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('PLone12345');
    expect(results[1]).toBeNull();
  });
});

// --------------------------------------------------------------------------
// MultipleMatchesError message
// --------------------------------------------------------------------------

describe('MultipleMatchesError', () => {
  it('formats up to 5 matches with an overflow notice', () => {
    // Arrange
    const matches = Array.from({ length: 7 }, (_, i) => ({
      num: i + 1,
      id: `PLmatch${i + 1}`,
      title: `match ${i + 1}`,
    }));

    // Act
    const err = new MultipleMatchesError('match', matches);

    // Assert
    expect(err.message).toContain('Multiple playlists match "match"');
    expect(err.message).toContain('  1. match 1 (PLmatch1)');
    expect(err.message).toContain('  5. match 5 (PLmatch5)');
    expect(err.message).toContain('... and 2 more');
  });
});

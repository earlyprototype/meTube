/**
 * Wave 2 PlaylistRepository tests.
 *
 * Exercises the public surface against `:memory:` SQLite — no mocking,
 * real DDL, real transactions, real branded IDs. AAA pattern throughout.
 *
 * Coverage:
 *   1. createOrUpdate — insert path
 *   2. createOrUpdate — update path (partial fields preserved)
 *   3. createOrUpdate — boolean -> 0/1 mapping for `enabled`
 *   4. createOrUpdate — throws ValidationError on missing title for insert
 *   5. findById — returns null on miss
 *   6. findById — returns the domain shape (branded id, real boolean)
 *   7. findAll — filters by enabled by default
 *   8. findAll — { enabledOnly: false } returns disabled rows too
 *   9. delete — removes the row (idempotent on a missing row)
 *  10. exists — true / false
 *  11. Rollback discipline — throw inside a caller's withTransaction wrapper
 *      rolls back this repository's write
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../database/connection.js';
import { PlaylistRepository } from '../database/PlaylistRepository.js';
import { ValidationError, DatabaseError } from '../errors/index.js';
import { asPlaylistId } from '../types/branded.js';

const PL_A = 'PLrAXtmRdnEQy6nuLMt9H1tlfNUR_v0kuD';
const PL_B = 'PLBCF2DAC6FFB574DE';
const PL_C = 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

describe('PlaylistRepository — createOrUpdate (insert)', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('inserts a new playlist row and returns the domain shape', () => {
    // Arrange
    const playlistId = asPlaylistId(PL_A);

    // Act
    const created = repo.createOrUpdate({
      playlistId,
      title: 'Test playlist',
      description: 'a description',
    });

    // Assert
    expect(created.playlistId).toBe(playlistId);
    expect(created.title).toBe('Test playlist');
    expect(created.description).toBe('a description');
    expect(created.enabled).toBe(true); // schema default
    expect(created.videoCount).toBe(0); // schema default
    expect(created.id).toBeGreaterThan(0);
  });

  it('persists nullable fields as null and defaults missing ones', () => {
    // Arrange + Act
    const created = repo.createOrUpdate({
      playlistId: asPlaylistId(PL_A),
      title: 'minimal',
    });

    // Assert — description / last_checked default to null; enabled / count to defaults
    expect(created.description).toBe(null);
    expect(created.lastChecked).toBe(null);
    expect(created.enabled).toBe(true);
    expect(created.videoCount).toBe(0);
  });

  it('throws ValidationError when title is missing on a fresh insert', () => {
    // Arrange + Act + Assert
    expect(() =>
      repo.createOrUpdate({ playlistId: asPlaylistId(PL_A) })
    ).toThrow(ValidationError);
  });
});

describe('PlaylistRepository — createOrUpdate (update)', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('updates only supplied fields and preserves the rest', () => {
    // Arrange — insert with title + description
    const playlistId = asPlaylistId(PL_A);
    repo.createOrUpdate({
      playlistId,
      title: 'original',
      description: 'keep me',
      videoCount: 10,
    });

    // Act — update title only
    const updated = repo.createOrUpdate({
      playlistId,
      title: 'changed',
    });

    // Assert — title updated, description + count preserved
    expect(updated.title).toBe('changed');
    expect(updated.description).toBe('keep me');
    expect(updated.videoCount).toBe(10);
  });

  it('maps boolean enabled -> 0/1 at write and back to boolean at read', () => {
    // Arrange — insert enabled (default), then flip to disabled
    const playlistId = asPlaylistId(PL_A);
    repo.createOrUpdate({ playlistId, title: 'flip me' });

    // Act
    const disabled = repo.createOrUpdate({
      playlistId,
      enabled: false,
    });

    // Assert
    expect(disabled.enabled).toBe(false);

    // And re-enable
    const reEnabled = repo.createOrUpdate({ playlistId, enabled: true });
    expect(reEnabled.enabled).toBe(true);
  });

  it('returns the existing row unchanged when no updatable fields supplied', () => {
    // Arrange
    const playlistId = asPlaylistId(PL_A);
    repo.createOrUpdate({ playlistId, title: 'unchanged' });

    // Act
    const noop = repo.createOrUpdate({ playlistId });

    // Assert
    expect(noop.title).toBe('unchanged');
  });
});

describe('PlaylistRepository — findById', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns null when no row matches', () => {
    // Arrange
    const playlistId = asPlaylistId(PL_A);

    // Act
    const found = repo.findById(playlistId);

    // Assert
    expect(found).toBe(null);
  });

  it('returns the domain shape with a branded id when the row exists', () => {
    // Arrange
    const playlistId = asPlaylistId(PL_A);
    repo.createOrUpdate({ playlistId, title: 'persisted' });

    // Act
    const found = repo.findById(playlistId);

    // Assert
    expect(found).not.toBe(null);
    expect(found?.playlistId).toBe(playlistId);
    expect(found?.title).toBe('persisted');
    expect(found?.enabled).toBe(true);
  });
});

describe('PlaylistRepository — findAll', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistRepository(dbm);

    repo.createOrUpdate({
      playlistId: asPlaylistId(PL_A),
      title: 'enabled one',
    });
    repo.createOrUpdate({
      playlistId: asPlaylistId(PL_B),
      title: 'enabled two',
    });
    repo.createOrUpdate({
      playlistId: asPlaylistId(PL_C),
      title: 'disabled one',
      enabled: false,
    });
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns only enabled playlists by default', () => {
    // Act
    const rows = repo.findAll();

    // Assert
    expect(rows).toHaveLength(2);
    expect(rows.every((p) => p.enabled)).toBe(true);
  });

  it('returns all playlists when enabledOnly is false', () => {
    // Act
    const rows = repo.findAll({ enabledOnly: false });

    // Assert
    expect(rows).toHaveLength(3);
    expect(rows.some((p) => !p.enabled)).toBe(true);
  });
});

describe('PlaylistRepository — delete', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('removes the row matching the branded id', () => {
    // Arrange
    const playlistId = asPlaylistId(PL_A);
    repo.createOrUpdate({ playlistId, title: 'about to die' });
    expect(repo.findById(playlistId)).not.toBe(null);

    // Act
    repo.delete(playlistId);

    // Assert
    expect(repo.findById(playlistId)).toBe(null);
  });

  it('is a no-op when the row does not exist', () => {
    // Arrange
    const playlistId = asPlaylistId(PL_A);

    // Act + Assert — must not throw
    expect(() => repo.delete(playlistId)).not.toThrow();
  });
});

describe('PlaylistRepository — exists', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns false for a missing playlist', () => {
    // Arrange + Act + Assert
    expect(repo.exists(asPlaylistId(PL_A))).toBe(false);
  });

  it('returns true once the playlist has been inserted', () => {
    // Arrange
    const playlistId = asPlaylistId(PL_A);
    repo.createOrUpdate({ playlistId, title: 'I exist' });

    // Act + Assert
    expect(repo.exists(playlistId)).toBe(true);
  });
});

describe('PlaylistRepository — rollback discipline', () => {
  let dbm: DatabaseManager;
  let repo: PlaylistRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new PlaylistRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('rolls back the repository write when the surrounding caller throws', () => {
    // Arrange — caller wraps multiple repo writes in a transaction and then
    // throws. better-sqlite3 nests via SAVEPOINTs; the outer rollback must
    // undo the inner repo write.
    class CallerError extends Error {}
    const playlistId = asPlaylistId(PL_A);

    // Act + Assert — the throw must propagate
    expect(() =>
      dbm.withTransaction(() => {
        repo.createOrUpdate({ playlistId, title: 'will be rolled back' });
        throw new CallerError('boom');
      })
    ).toThrow();

    // And the inner write must not have committed
    expect(repo.findById(playlistId)).toBe(null);
    expect(repo.exists(playlistId)).toBe(false);
  });

  it('rolls back atomically when a write inside createOrUpdate fails', () => {
    // Arrange — pre-seed two rows
    repo.createOrUpdate({ playlistId: asPlaylistId(PL_A), title: 'one' });
    repo.createOrUpdate({ playlistId: asPlaylistId(PL_B), title: 'two' });

    // Act — corrupt the playlists table on a separate write inside a tx
    // and then throw to confirm the schema parse triggers DatabaseError.
    // We do this by inserting a row that violates the UNIQUE constraint
    // inside a manual withTransaction, simulating the repo throwing
    // partway through.
    expect(() =>
      dbm.withTransaction((db) => {
        db.prepare(
          `INSERT INTO playlists (playlist_id, title) VALUES (?, ?)`
        ).run(PL_A, 'duplicate'); // UNIQUE violation
      })
    ).toThrow(DatabaseError);

    // Assert — original two rows still present, no third row
    const rows = repo.findAll({ enabledOnly: false });
    expect(rows).toHaveLength(2);
  });
});

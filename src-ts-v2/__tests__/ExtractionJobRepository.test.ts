/**
 * Wave 2 — ExtractionJobRepository behavioural tests.
 *
 * Discipline: no mocks. Every test instantiates a fresh `:memory:` SQLite
 * via `DatabaseManager`, seeds a parent `playlists` row where the FK
 * matters, and exercises the repository against real DDL with real Zod
 * validation. AAA pattern throughout.
 *
 * Covers (at minimum, per task spec):
 *   - happy-path `create()` populates `started_at` and defaults
 *   - `updateStatus()` happy path + auto-stamp of `completed_at`
 *   - rollback discipline: a throw inside the transaction leaves no row
 *   - status-transition validity: random strings are rejected
 *   - branded `PlaylistId` round-trip on `findByPlaylistId()`
 *   - read-shape validation: Zod parses every returned row
 *   - close-after discipline (the repo respects an underlying closed DB)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../database/connection.js';
import {
  ExtractionJobRepository,
  type ExtractionJobInput,
} from '../database/ExtractionJobRepository.js';
import { DatabaseError, ValidationError } from '../errors/index.js';
import { ExtractionJobRowSchema } from '../schemas/db.js';
import { asPlaylistId, type PlaylistId } from '../types/index.js';

/**
 * Seed a parent playlist row so FK-constrained INSERTs into
 * `extraction_jobs` succeed. The repository itself does not write to
 * `playlists`; tests do this directly via the transactional handle so we
 * stay honest about which writes the SUT is responsible for.
 */
function seedPlaylist(dbm: DatabaseManager, playlistId: PlaylistId, title = 'Test playlist'): void {
  dbm.withTransaction((handle) => {
    handle
      .prepare(
        `INSERT INTO playlists (playlist_id, title, description, video_count, enabled)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(playlistId, title, null, 0, 1);
  });
}

describe('ExtractionJobRepository.create', () => {
  let dbm: DatabaseManager;
  let repo: ExtractionJobRepository;
  const playlistId = asPlaylistId('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');

  beforeEach(() => {
    // Arrange — fresh in-memory DB per test
    dbm = new DatabaseManager(':memory:');
    repo = new ExtractionJobRepository(dbm);
    seedPlaylist(dbm, playlistId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('inserts a job with defaulted counters and auto-populated started_at', () => {
    // Arrange
    const input: ExtractionJobInput = {
      playlist_id: playlistId,
      job_type: 'playlist',
    };

    // Act
    const row = repo.create(input);

    // Assert
    expect(row.id).toBeTypeOf('number');
    expect(row.playlist_id).toBe(playlistId);
    expect(row.job_type).toBe('playlist');
    expect(row.status).toBe('pending');
    expect(row.videos_found).toBe(0);
    expect(row.videos_processed).toBe(0);
    expect(row.new_videos).toBe(0);
    expect(typeof row.started_at).toBe('string');
    expect(row.started_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.completed_at).toBeNull();
    expect(row.error_message).toBeNull();
  });

  it('honours an explicit initial status when supplied', () => {
    // Arrange
    const input: ExtractionJobInput = {
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'running',
    };

    // Act
    const row = repo.create(input);

    // Assert
    expect(row.status).toBe('running');
  });

  it('accepts null playlist_id for video-typed jobs', () => {
    // Arrange — Python uses `playlist_id=None` for single-video extraction runs
    const input: ExtractionJobInput = {
      playlist_id: null,
      job_type: 'video',
    };

    // Act
    const row = repo.create(input);

    // Assert
    expect(row.playlist_id).toBeNull();
    expect(row.job_type).toBe('video');
  });

  it('rejects a status string outside the enum', () => {
    // Arrange — TS would block this at compile time, but call sites that
    // bypass via `as` should still throw at runtime.
    const input = {
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'in-progress' as never,
    } as unknown as ExtractionJobInput;

    // Act + Assert
    expect(() => repo.create(input)).toThrow(ValidationError);
  });

  it('persists the row such that a direct SQL read sees identical values', () => {
    // Arrange
    const input: ExtractionJobInput = {
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'pending',
      videos_found: 50,
      videos_processed: 0,
      new_videos: 0,
    };

    // Act
    const row = repo.create(input);
    const direct = dbm
      .prepare<readonly [number], unknown>('SELECT * FROM extraction_jobs WHERE id = ?')
      .get(row.id as number);

    // Assert
    expect(direct).toBeDefined();
    const parsed = ExtractionJobRowSchema.parse(direct);
    expect(parsed.videos_found).toBe(50);
  });
});

describe('ExtractionJobRepository.updateStatus', () => {
  let dbm: DatabaseManager;
  let repo: ExtractionJobRepository;
  const playlistId = asPlaylistId('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new ExtractionJobRepository(dbm);
    seedPlaylist(dbm, playlistId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('updates status, counters, and auto-stamps completed_at on completion', () => {
    // Arrange — a fresh running job
    const job = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'running',
    });

    // Act
    const updated = repo.updateStatus(job.id as number, 'completed', {
      videos_found: 50,
      videos_processed: 48,
      new_videos: 5,
    });

    // Assert
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('completed');
    expect(updated?.videos_found).toBe(50);
    expect(updated?.videos_processed).toBe(48);
    expect(updated?.new_videos).toBe(5);
    expect(updated?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('auto-stamps completed_at when transitioning to failed', () => {
    // Arrange
    const job = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'running',
    });

    // Act
    const updated = repo.updateStatus(job.id as number, 'failed', {
      error_message: 'YouTube API quota exhausted',
    });

    // Assert
    expect(updated?.status).toBe('failed');
    expect(updated?.error_message).toBe('YouTube API quota exhausted');
    expect(updated?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('does NOT auto-stamp completed_at when transitioning to running', () => {
    // Arrange — non-terminal transition should not touch completed_at
    const job = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'pending',
    });

    // Act
    const updated = repo.updateStatus(job.id as number, 'running');

    // Assert
    expect(updated?.status).toBe('running');
    expect(updated?.completed_at).toBeNull();
  });

  it('honours an explicit completed_at override', () => {
    // Arrange
    const job = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'running',
    });
    const explicit = '2026-01-01 00:00:00';

    // Act
    const updated = repo.updateStatus(job.id as number, 'completed', {
      completed_at: explicit,
    });

    // Assert
    expect(updated?.completed_at).toBe(explicit);
  });

  it('rejects random strings as status — status-transition validity', () => {
    // Arrange
    const job = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'running',
    });

    // Act + Assert
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      repo.updateStatus(job.id as number, 'finished' as never)
    ).toThrow(ValidationError);

    // And the row in the DB must be untouched by the rejected update.
    const after = repo.findById(job.id as number);
    expect(after?.status).toBe('running');
    expect(after?.completed_at).toBeNull();
  });

  it('returns null when the job ID does not exist', () => {
    // Arrange — no rows yet, so any id misses

    // Act
    const updated = repo.updateStatus(9999, 'completed');

    // Assert
    expect(updated).toBeNull();
  });

  it('sets error_message to null when explicitly passed null', () => {
    // Arrange — start with an error string, then clear it
    const job = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'running',
    });
    repo.updateStatus(job.id as number, 'failed', { error_message: 'transient' });

    // Act
    const cleared = repo.updateStatus(job.id as number, 'running', {
      error_message: null,
    });

    // Assert
    expect(cleared?.error_message).toBeNull();
  });
});

describe('ExtractionJobRepository — transaction rollback discipline', () => {
  let dbm: DatabaseManager;
  let repo: ExtractionJobRepository;
  const playlistId = asPlaylistId('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new ExtractionJobRepository(dbm);
    seedPlaylist(dbm, playlistId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('rolls back an outer transaction containing repo.create() when the outer throws', () => {
    // Arrange — caller composes a multi-step transaction; repo participates
    class TestRollbackError extends Error {}

    // Act + Assert
    expect(() =>
      dbm.withTransaction((_handle) => {
        repo.create({
          playlist_id: playlistId,
          job_type: 'playlist',
        });
        throw new TestRollbackError('boom');
      })
    ).toThrow();

    // Assert — no row landed
    const count = dbm
      .prepare<readonly [], { c: number }>('SELECT COUNT(*) AS c FROM extraction_jobs')
      .get();
    expect(count?.c).toBe(0);
  });

  it('rolls back updateStatus when the surrounding transaction throws', () => {
    // Arrange — landed job, then a wrapping transaction that fails mid-flight
    const job = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'running',
    });

    class TestRollbackError extends Error {}

    // Act + Assert
    expect(() =>
      dbm.withTransaction((_handle) => {
        repo.updateStatus(job.id as number, 'completed');
        throw new TestRollbackError('boom');
      })
    ).toThrow();

    // Assert — status reverted to running, completed_at still null
    const after = repo.findById(job.id as number);
    expect(after?.status).toBe('running');
    expect(after?.completed_at).toBeNull();
  });
});

describe('ExtractionJobRepository.findById', () => {
  let dbm: DatabaseManager;
  let repo: ExtractionJobRepository;
  const playlistId = asPlaylistId('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new ExtractionJobRepository(dbm);
    seedPlaylist(dbm, playlistId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns the inserted row', () => {
    // Arrange
    const job = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
    });

    // Act
    const found = repo.findById(job.id as number);

    // Assert
    expect(found).not.toBeNull();
    expect(found?.id).toBe(job.id);
    expect(found?.playlist_id).toBe(playlistId);
  });

  it('returns null for a missing ID', () => {
    // Arrange + Act + Assert
    expect(repo.findById(9999)).toBeNull();
  });
});

describe('ExtractionJobRepository.findByPlaylistId', () => {
  let dbm: DatabaseManager;
  let repo: ExtractionJobRepository;
  const playlistA = asPlaylistId('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');
  const playlistB = asPlaylistId('PLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new ExtractionJobRepository(dbm);
    seedPlaylist(dbm, playlistA, 'A');
    seedPlaylist(dbm, playlistB, 'B');
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns only rows for the requested playlist, newest first', () => {
    // Arrange — two jobs for A, one for B
    const first = repo.create({ playlist_id: playlistA, job_type: 'playlist' });
    const second = repo.create({ playlist_id: playlistA, job_type: 'update' });
    repo.create({ playlist_id: playlistB, job_type: 'playlist' });

    // Act
    const jobsForA = repo.findByPlaylistId(playlistA);

    // Assert — both A jobs, ordered most-recent (highest id) first
    expect(jobsForA).toHaveLength(2);
    expect(jobsForA[0]?.id).toBe(second.id);
    expect(jobsForA[1]?.id).toBe(first.id);
    expect(jobsForA.every((j) => j.playlist_id === playlistA)).toBe(true);
  });

  it('returns an empty array when no jobs exist for the playlist', () => {
    // Arrange — only B has a job
    repo.create({ playlist_id: playlistB, job_type: 'playlist' });

    // Act + Assert
    expect(repo.findByPlaylistId(playlistA)).toEqual([]);
  });

  it('round-trips branded PlaylistId without losing the brand at the wire', () => {
    // Arrange
    repo.create({ playlist_id: playlistA, job_type: 'playlist' });

    // Act
    const [row] = repo.findByPlaylistId(playlistA);

    // Assert — string value preserved; the brand is a compile-time property,
    // but the wire value must equal the input
    expect(row?.playlist_id).toBe(playlistA);
  });
});

describe('ExtractionJobRepository.findActive', () => {
  let dbm: DatabaseManager;
  let repo: ExtractionJobRepository;
  const playlistId = asPlaylistId('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new ExtractionJobRepository(dbm);
    seedPlaylist(dbm, playlistId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns pending and running jobs but not completed or failed', () => {
    // Arrange
    const pending = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'pending',
    });
    const running = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'running',
    });
    const completed = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'completed',
    });
    const failed = repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'failed',
    });

    // Act
    const active = repo.findActive();

    // Assert
    const activeIds = active.map((j) => j.id);
    expect(activeIds).toContain(pending.id);
    expect(activeIds).toContain(running.id);
    expect(activeIds).not.toContain(completed.id);
    expect(activeIds).not.toContain(failed.id);
  });

  it('returns empty when no active jobs exist', () => {
    // Arrange
    repo.create({
      playlist_id: playlistId,
      job_type: 'playlist',
      status: 'completed',
    });

    // Act + Assert
    expect(repo.findActive()).toEqual([]);
  });
});

describe('ExtractionJobRepository.findRecent', () => {
  let dbm: DatabaseManager;
  let repo: ExtractionJobRepository;
  const playlistId = asPlaylistId('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new ExtractionJobRepository(dbm);
    seedPlaylist(dbm, playlistId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns rows newest first, capped at the limit', () => {
    // Arrange — insert 5 jobs
    const ids: Array<number | bigint | undefined> = [];
    for (let i = 0; i < 5; i++) {
      const r = repo.create({ playlist_id: playlistId, job_type: 'playlist' });
      ids.push(r.id);
    }

    // Act
    const recent = repo.findRecent(3);

    // Assert
    expect(recent).toHaveLength(3);
    expect(recent[0]?.id).toBe(ids[4]);
    expect(recent[2]?.id).toBe(ids[2]);
  });

  it('defaults to a sane limit when none supplied', () => {
    // Arrange
    repo.create({ playlist_id: playlistId, job_type: 'playlist' });

    // Act
    const recent = repo.findRecent();

    // Assert — single row returned (we inserted one); default limit
    // doesn't trim it.
    expect(recent).toHaveLength(1);
  });

  it('rejects zero or negative limits', () => {
    // Arrange + Act + Assert
    expect(() => repo.findRecent(0)).toThrow(ValidationError);
    expect(() => repo.findRecent(-1)).toThrow(ValidationError);
    expect(() => repo.findRecent(1.5)).toThrow(ValidationError);
  });
});

describe('ExtractionJobRepository.countByStatus', () => {
  let dbm: DatabaseManager;
  let repo: ExtractionJobRepository;
  const playlistId = asPlaylistId('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new ExtractionJobRepository(dbm);
    seedPlaylist(dbm, playlistId);
  });

  afterEach(() => {
    dbm.close();
  });

  it('counts every known status, defaulting absent statuses to zero', () => {
    // Arrange — 2 running, 1 completed, 0 pending, 0 failed
    repo.create({ playlist_id: playlistId, job_type: 'playlist', status: 'running' });
    repo.create({ playlist_id: playlistId, job_type: 'playlist', status: 'running' });
    repo.create({ playlist_id: playlistId, job_type: 'playlist', status: 'completed' });

    // Act
    const counts = repo.countByStatus();

    // Assert
    expect(counts.pending).toBe(0);
    expect(counts.running).toBe(2);
    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(0);
  });

  it('returns all-zeros when the table is empty', () => {
    // Arrange + Act
    const counts = repo.countByStatus();

    // Assert
    expect(counts).toEqual({ pending: 0, running: 0, completed: 0, failed: 0 });
  });
});

describe('ExtractionJobRepository — closed DB discipline', () => {
  it('surfaces DatabaseError when the underlying DB is closed', () => {
    // Arrange
    const dbm = new DatabaseManager(':memory:');
    const repo = new ExtractionJobRepository(dbm);
    const playlistId = asPlaylistId('PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L');
    seedPlaylist(dbm, playlistId);
    dbm.close();

    // Act + Assert
    expect(() => repo.create({ playlist_id: playlistId, job_type: 'playlist' })).toThrow(
      DatabaseError
    );
  });
});

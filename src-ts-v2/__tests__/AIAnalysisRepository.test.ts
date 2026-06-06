/**
 * AIAnalysisRepository tests — Phase 2 Wave 2.
 *
 * Real `:memory:` SQLite, no mocks, AAA pattern throughout. Each test owns
 * its own `DatabaseManager` so state never leaks between cases.
 *
 * **Audit-critical test:** `closes the v1 stub-bomb` proves `getByVideo`
 * returns the actual stored analysis instead of `undefined`. v1 had a
 * `return undefined;` placeholder in `HTMLReportGenerator.getAnalysisData`
 * that silently produced empty AI sections in every report. If a future
 * refactor reintroduces that pattern in v2, this test fails immediately.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AIAnalysisRepository } from '../database/AIAnalysisRepository.js';
import { DatabaseManager } from '../database/connection.js';
import { DatabaseError } from '../errors/index.js';
import { asVideoId, type VideoId } from '../types/index.js';
import type { GeminiResponse } from '../schemas/gemini.js';

// --------------------------------------------------------------------------
// Test fixtures
// --------------------------------------------------------------------------

/**
 * Insert a stub `videos` row so the FK on `ai_analysis.video_id` can be
 * satisfied. Returns the same branded id so the test can chain on it.
 */
function seedVideo(dbm: DatabaseManager, videoId: VideoId): VideoId {
  dbm.withTransaction((conn) => {
    conn
      .prepare(
        `INSERT INTO videos
           (video_id, title, channel_id, channel_title, published_at, duration, duration_seconds, is_short)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        videoId,
        'fixture title',
        'UCfixturefixturefixture',
        'fixture channel',
        '2024-01-01T00:00:00Z',
        'PT3M00S',
        180,
        0
      );
  });
  return videoId;
}

/**
 * Realistic, valid Gemini response. Mirrors the prompt shape — every
 * required field present, sentiment is one of the three accepted enum
 * values, topics is non-empty so the key_points -> JSON round-trip has
 * data to assert against.
 */
function makeGeminiResponse(
  overrides: Partial<GeminiResponse> = {}
): GeminiResponse {
  return {
    topics: ['machine learning', 'rust', 'compilers'],
    github_repos: [{ name: 'serde-rs/serde', url: 'https://github.com/serde-rs/serde' }],
    websites: [{ name: 'rust-lang.org', url: 'https://rust-lang.org' }],
    people: ['Alice Hacker'],
    tags: ['rust', 'ml'],
    summary: 'A talk on ML pipelines written in Rust.',
    content_type: 'tutorial',
    sentiment: 'positive',
    ...overrides,
  };
}

const MODEL_USED = 'gemini-3-flash-preview';

// --------------------------------------------------------------------------
// Happy-path coverage
// --------------------------------------------------------------------------

describe('AIAnalysisRepository.upsert — insert path', () => {
  let dbm: DatabaseManager;
  let repo: AIAnalysisRepository;

  beforeEach(() => {
    // Arrange — fresh DB per test
    dbm = new DatabaseManager(':memory:');
    repo = new AIAnalysisRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('persists a Gemini analysis under the given video id', () => {
    // Arrange
    const videoId = seedVideo(dbm, asVideoId('dQw4w9WgXcQ'));
    const analysis = makeGeminiResponse();

    // Act
    const persisted = repo.upsert(videoId, analysis, MODEL_USED);

    // Assert — returned projection carries the persisted fields
    expect(persisted.videoId).toBe(videoId);
    expect(persisted.summary).toBe('A talk on ML pipelines written in Rust.');
    expect(persisted.contentType).toBe('tutorial');
    expect(persisted.sentiment).toBe('positive');
    expect(persisted.modelUsed).toBe(MODEL_USED);
    expect(persisted.analyzedAt).not.toBeNull();
  });

  it('stores topics into key_points as a JSON-encoded array', () => {
    // Arrange
    const videoId = seedVideo(dbm, asVideoId('abcdefghij1'));
    const analysis = makeGeminiResponse({
      topics: ['alpha', 'beta', 'gamma'],
    });

    // Act
    repo.upsert(videoId, analysis, MODEL_USED);
    const fetched = repo.getByVideo(videoId);

    // Assert — projection exposes parsed string[]
    expect(fetched).not.toBeNull();
    expect(fetched?.keyPoints).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('exactly one row exists in ai_analysis after an upsert', () => {
    // Arrange
    const videoId = seedVideo(dbm, asVideoId('rowcount111'));
    const analysis = makeGeminiResponse();

    // Act
    repo.upsert(videoId, analysis, MODEL_USED);

    // Assert
    expect(repo.count()).toBe(1);
  });
});

describe('AIAnalysisRepository.upsert — update path', () => {
  let dbm: DatabaseManager;
  let repo: AIAnalysisRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new AIAnalysisRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('overwrites an existing row when called twice for the same video', () => {
    // Arrange
    const videoId = seedVideo(dbm, asVideoId('updateXXXXX'));
    const first = makeGeminiResponse({
      summary: 'initial summary',
      sentiment: 'neutral',
      content_type: 'review',
    });
    const second = makeGeminiResponse({
      summary: 'revised summary',
      sentiment: 'negative',
      content_type: 'rant',
    });

    // Act
    repo.upsert(videoId, first, MODEL_USED);
    repo.upsert(videoId, second, 'gemini-2.5-pro');
    const fetched = repo.getByVideo(videoId);

    // Assert — the SECOND call's values win
    expect(fetched?.summary).toBe('revised summary');
    expect(fetched?.sentiment).toBe('negative');
    expect(fetched?.contentType).toBe('rant');
    expect(fetched?.modelUsed).toBe('gemini-2.5-pro');
    // And still only one row in the table — UNIQUE on video_id holds.
    expect(repo.count()).toBe(1);
  });
});

// --------------------------------------------------------------------------
// THE STUB-BOMB CLOSURE — explicit regression test
// --------------------------------------------------------------------------

describe('AIAnalysisRepository.getByVideo — v1 stub-bomb closure', () => {
  let dbm: DatabaseManager;
  let repo: AIAnalysisRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new AIAnalysisRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  /**
   * v1 had `getAnalysisData(_videoId) { return undefined; }` in
   * `src-ts/reports/HTMLReportGenerator.ts:391-394`. The AI analysis
   * section silently rendered empty in every video report because the
   * lookup was never actually wired to the table.
   *
   * v2's contract: a video with a stored analysis MUST get its real
   * projection back from `getByVideo`. If this assertion ever fails
   * because the method returns `null` for a video that DOES have stored
   * analysis, the v1 regression has re-emerged and the build must fail.
   */
  it('returns the actual analysis (not null/undefined) for a video with stored analysis', () => {
    // Arrange — store an analysis the report would expect to render
    const videoId = seedVideo(dbm, asVideoId('STUBBOMB001'));
    const analysis = makeGeminiResponse({
      summary: 'The session that proved the report path works.',
      content_type: 'demo',
      sentiment: 'positive',
    });
    repo.upsert(videoId, analysis, MODEL_USED);

    // Act
    const fetched = repo.getByVideo(videoId);

    // Assert — explicitly not undefined, explicitly not null, with real data
    expect(fetched).not.toBeUndefined();
    expect(fetched).not.toBeNull();
    expect(fetched?.summary).toBe(
      'The session that proved the report path works.'
    );
    expect(fetched?.contentType).toBe('demo');
    expect(fetched?.sentiment).toBe('positive');
    expect(fetched?.modelUsed).toBe(MODEL_USED);
  });

  it('returns null (not undefined) for a video with no analysis row', () => {
    // Arrange — video exists in the parent table, but no analysis written
    const videoId = seedVideo(dbm, asVideoId('NOANALYSIS1'));

    // Act
    const fetched = repo.getByVideo(videoId);

    // Assert — the "no row" sentinel is null, deliberately distinct from
    // the v1 "stubbed undefined" pattern.
    expect(fetched).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Wire-boundary validation
// --------------------------------------------------------------------------

describe('AIAnalysisRepository.upsert — input validation', () => {
  let dbm: DatabaseManager;
  let repo: AIAnalysisRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new AIAnalysisRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('throws DatabaseError when sentiment is outside the enum', () => {
    // Arrange — sentiment must be one of positive | negative | neutral
    const videoId = seedVideo(dbm, asVideoId('BADSENTIMNT'));
    const malformed = {
      ...makeGeminiResponse(),
      sentiment: 'extremely-enthusiastic',
    } as unknown as GeminiResponse;

    // Act + Assert
    expect(() => repo.upsert(videoId, malformed, MODEL_USED)).toThrow(
      DatabaseError
    );
    // Nothing got persisted — the parse fired before the SQL did.
    expect(repo.count()).toBe(0);
  });

  it('throws DatabaseError when topics is not an array', () => {
    // Arrange — topics must be string[]
    const videoId = seedVideo(dbm, asVideoId('BADTOPICS01'));
    const malformed = {
      ...makeGeminiResponse(),
      topics: 'one big string instead of an array',
    } as unknown as GeminiResponse;

    // Act + Assert
    expect(() => repo.upsert(videoId, malformed, MODEL_USED)).toThrow(
      DatabaseError
    );
    expect(repo.count()).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Transaction discipline
// --------------------------------------------------------------------------

describe('AIAnalysisRepository — transaction rollback', () => {
  let dbm: DatabaseManager;
  let repo: AIAnalysisRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new AIAnalysisRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('rolls back when an upsert is wrapped in an outer withTransaction that throws', () => {
    // Arrange
    const videoId = seedVideo(dbm, asVideoId('ROLLBACK001'));
    const analysis = makeGeminiResponse({ summary: 'should not persist' });

    class TestRollbackError extends Error {}

    // Act + Assert — outer transaction wraps the repo call, then throws.
    // better-sqlite3 nests via savepoints; the outer rollback discards
    // every write performed inside, including the repo's INSERT.
    expect(() =>
      dbm.withTransaction(() => {
        repo.upsert(videoId, analysis, MODEL_USED);
        throw new TestRollbackError('outer transaction aborted');
      })
    ).toThrow();

    // The analysis row must not have committed.
    expect(repo.count()).toBe(0);
    expect(repo.getByVideo(videoId)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// deleteByVideo + exists
// --------------------------------------------------------------------------

describe('AIAnalysisRepository.deleteByVideo', () => {
  let dbm: DatabaseManager;
  let repo: AIAnalysisRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new AIAnalysisRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns 1 and removes the row when an analysis exists', () => {
    // Arrange
    const videoId = seedVideo(dbm, asVideoId('DELETE00001'));
    repo.upsert(videoId, makeGeminiResponse(), MODEL_USED);
    expect(repo.exists(videoId)).toBe(true);

    // Act
    const removed = repo.deleteByVideo(videoId);

    // Assert
    expect(removed).toBe(1);
    expect(repo.exists(videoId)).toBe(false);
    expect(repo.getByVideo(videoId)).toBeNull();
  });

  it('returns 0 and is idempotent when no row exists', () => {
    // Arrange — a video, but no analysis row
    const videoId = seedVideo(dbm, asVideoId('DELETENOP01'));

    // Act
    const removed = repo.deleteByVideo(videoId);

    // Assert
    expect(removed).toBe(0);
  });
});

describe('AIAnalysisRepository.exists', () => {
  let dbm: DatabaseManager;
  let repo: AIAnalysisRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new AIAnalysisRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('reflects insert / delete state changes', () => {
    // Arrange
    const videoId = seedVideo(dbm, asVideoId('EXISTSTEST1'));
    expect(repo.exists(videoId)).toBe(false);

    // Act + Assert — insert flips it to true
    repo.upsert(videoId, makeGeminiResponse(), MODEL_USED);
    expect(repo.exists(videoId)).toBe(true);

    // Delete flips it back
    repo.deleteByVideo(videoId);
    expect(repo.exists(videoId)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Many-video isolation
// --------------------------------------------------------------------------

describe('AIAnalysisRepository — multi-video isolation', () => {
  let dbm: DatabaseManager;
  let repo: AIAnalysisRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new AIAnalysisRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('keeps analyses scoped to their own video_id', () => {
    // Arrange — three videos, each with a distinct analysis
    const a = seedVideo(dbm, asVideoId('MULTIVIDEO1'));
    const b = seedVideo(dbm, asVideoId('MULTIVIDEO2'));
    const c = seedVideo(dbm, asVideoId('MULTIVIDEO3'));
    repo.upsert(a, makeGeminiResponse({ summary: 'A' }), MODEL_USED);
    repo.upsert(b, makeGeminiResponse({ summary: 'B' }), MODEL_USED);
    repo.upsert(c, makeGeminiResponse({ summary: 'C' }), MODEL_USED);

    // Act + Assert
    expect(repo.getByVideo(a)?.summary).toBe('A');
    expect(repo.getByVideo(b)?.summary).toBe('B');
    expect(repo.getByVideo(c)?.summary).toBe('C');
    expect(repo.count()).toBe(3);

    // Deleting one leaves the others untouched
    repo.deleteByVideo(b);
    expect(repo.getByVideo(a)?.summary).toBe('A');
    expect(repo.getByVideo(b)).toBeNull();
    expect(repo.getByVideo(c)?.summary).toBe('C');
    expect(repo.count()).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Key-points parsing edge cases
// --------------------------------------------------------------------------

describe('AIAnalysisRepository — keyPoints parsing', () => {
  let dbm: DatabaseManager;
  let repo: AIAnalysisRepository;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
    repo = new AIAnalysisRepository(dbm);
  });

  afterEach(() => {
    dbm.close();
  });

  it('exposes keyPoints as an empty array when Gemini returned no topics', () => {
    // Arrange
    const videoId = seedVideo(dbm, asVideoId('EMPTYTOPIC1'));
    repo.upsert(videoId, makeGeminiResponse({ topics: [] }), MODEL_USED);

    // Act
    const fetched = repo.getByVideo(videoId);

    // Assert — empty array, not null, because '[]' JSON-parses to []
    expect(fetched?.keyPoints).toEqual([]);
  });

  it('falls back to null when key_points was hand-corrupted to non-JSON', () => {
    // Arrange — write a row directly with garbage in key_points to simulate
    // a corrupted historical row (e.g. SQLite imported from a bad dump).
    const videoId = seedVideo(dbm, asVideoId('CORRUPTKP01'));
    dbm.withTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO ai_analysis (video_id, summary, key_points, sentiment, content_type, model_used)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(videoId, 'sum', 'not-json{{{', 'neutral', 'tutorial', MODEL_USED);
    });

    // Act
    const fetched = repo.getByVideo(videoId);

    // Assert — the row still loads, summary is intact, keyPoints downgraded
    expect(fetched).not.toBeNull();
    expect(fetched?.summary).toBe('sum');
    expect(fetched?.keyPoints).toBeNull();
  });
});

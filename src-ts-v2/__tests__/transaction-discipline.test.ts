/**
 * Transaction-discipline enforcement tests for Phase 2 Wave 2.
 *
 * This is the test that would have caught v1's "transaction() exists but is
 * unused" pattern — where a `withTransaction` helper was defined on the
 * connection layer but repositories happily issued INSERT/UPDATE/DELETE
 * outside of it because there was nothing stopping them.
 *
 * Discipline guarantees enforced here:
 *
 *   1. `DatabaseManager` exposes NO public write path other than
 *      `withTransaction`. There is no `run`, `exec`, or public `db`
 *      accessor that would let a repository smuggle a write past the
 *      transaction boundary.
 *   2. `withTransaction(work)` actually commits writes performed inside
 *      its closure — the wrapper is real, not theatre.
 *   3. `withTransaction(work)` rolls back ALL writes performed in the
 *      same closure when the closure throws — partial commits are
 *      impossible.
 *   4. `manager.prepare(...)` returns a typed `PreparedRead` that does
 *      NOT expose `.run()`. Repositories cannot say "well, prepare()
 *      gave me a Statement, so I'll just call .run() on it" — the
 *      method literally is not on the object.
 *
 * Guarantees (1) and (4) are surface-shape assertions: they prove a
 * write CANNOT be issued, not just that one happens to not be issued.
 * Guarantees (2) and (3) are behavioural smokes against an in-memory
 * `:memory:` DB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseManager, type PreparedRead } from '../database/connection.js';
import { AppError, DatabaseError, ValidationError } from '../errors/index.js';

/** Sentinel error type so a rollback assertion can target this exact throw. */
class TransactionDisciplineTestError extends Error {}

/**
 * Shape of the only INSERT used in this suite. Keeping the tuple narrow
 * means the prepared-statement generic stays honest and we don't have to
 * sprinkle `as` casts to make the call sites compile.
 */
type TagInsertParams = readonly [tag: string];

describe('DatabaseManager — write-path surface (guarantee 1)', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    // Arrange — fresh in-memory DB per test so state never leaks
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('exposes withTransaction as the only write-shaped method on the public surface', () => {
    // Act — enumerate ONLY own + inherited enumerable string keys callers can reach.
    // Private TS fields (`db`, `closed`, `databasePath`) are not on the prototype
    // chain as accessors — TS marks them private at the type level, and at runtime
    // they exist as own properties on the instance. We assert separately on those.
    const proto = Object.getPrototypeOf(dbm) as object;
    const publicMethodNames = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== 'constructor'
    );

    // Assert — withTransaction must be present; no other write-shaped method may be.
    expect(publicMethodNames).toContain('withTransaction');
    expect(publicMethodNames).not.toContain('run');
    expect(publicMethodNames).not.toContain('exec');
    expect(publicMethodNames).not.toContain('runWrite');
    expect(publicMethodNames).not.toContain('insert');
    expect(publicMethodNames).not.toContain('update');
    expect(publicMethodNames).not.toContain('delete');
  });

  it('does not expose a `db` accessor on the public type surface', () => {
    // The `db` field is declared `private readonly` on DatabaseManager.
    // The TS-only assertion below proves a public reference to it is a
    // compile error. The runtime assertion proves no enumerable
    // `db`-shaped method or accessor escapes via the prototype.
    //
    // @ts-expect-error - `db` is private; the type system must forbid this access.
    const _privateProbe: unknown = dbm.db;
    void _privateProbe;

    const proto = Object.getPrototypeOf(dbm) as object;
    const inheritedNames = Object.getOwnPropertyNames(proto);
    expect(inheritedNames).not.toContain('db');
    expect(inheritedNames).not.toContain('getDb');
    expect(inheritedNames).not.toContain('getDatabase');
    expect(inheritedNames).not.toContain('raw');
    expect(inheritedNames).not.toContain('connection');
  });
});

describe('DatabaseManager.withTransaction — commits writes inside the closure (guarantee 2)', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('persists an INSERT issued inside the work closure', () => {
    // Arrange — single-row INSERT into the tags table (no FK dependencies, ideal smoke)
    dbm.withTransaction((db) => {
      db.prepare('INSERT INTO tags (tag) VALUES (?)').run('typescript');
    });

    // Act — read it back via the read-only prepared surface
    const row = dbm
      .prepare<TagInsertParams, { tag: string }>('SELECT tag FROM tags WHERE tag = ?')
      .get('typescript');

    // Assert — the row landed
    expect(row?.tag).toBe('typescript');
  });
});

describe('DatabaseManager.withTransaction — rolls back the entire closure on throw (guarantee 3)', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('reverts a prior INSERT in the same callback when a later statement throws', () => {
    // Arrange — count rows before; expect zero
    const countBefore = dbm.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tags').get();
    expect(countBefore?.c).toBe(0);

    // Act — issue an INSERT, then throw. The INSERT must NOT survive.
    expect(() =>
      dbm.withTransaction((db) => {
        db.prepare('INSERT INTO tags (tag) VALUES (?)').run('will-be-rolled-back');
        throw new TransactionDisciplineTestError('forced rollback for discipline test');
      })
    ).toThrow();

    // Assert — the tag table must be empty; the INSERT was rolled back atomically
    const countAfter = dbm.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tags').get();
    expect(countAfter?.c).toBe(0);

    const sneaked = dbm
      .prepare<TagInsertParams, { tag: string }>('SELECT tag FROM tags WHERE tag = ?')
      .get('will-be-rolled-back');
    expect(sneaked).toBeUndefined();
  });

  it('rolls back the FIRST insert when a SECOND insert in the same closure throws', () => {
    // Arrange + Act — two inserts; the second deliberately violates the UNIQUE
    // constraint on tags.tag so SQLite throws inside the closure.
    expect(() =>
      dbm.withTransaction((db) => {
        const insert = db.prepare('INSERT INTO tags (tag) VALUES (?)');
        insert.run('first-write');
        insert.run('first-write'); // UNIQUE violation — throws inside the closure
      })
    ).toThrow();

    // Assert — neither row survived. This is the bit that catches partial-commit bugs.
    const remaining = dbm
      .prepare<TagInsertParams, { tag: string }>('SELECT tag FROM tags WHERE tag = ?')
      .get('first-write');
    expect(remaining).toBeUndefined();
  });
});

describe('DatabaseManager.prepare — PreparedRead does not expose .run() (guarantee 4)', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('returns a PreparedRead whose type does not include .run', () => {
    // Arrange — prepare a SELECT against tags
    const handle: PreparedRead<TagInsertParams, { tag: string }> = dbm.prepare(
      'SELECT tag FROM tags WHERE tag = ?'
    );

    // TS-only assertion — accessing .run on PreparedRead must be a compile error.
    // This is the load-bearing check: even if a future commit accidentally adds
    // a `run` method to PreparedRead's interface, the @ts-expect-error will
    // start failing because the error it expects no longer exists.
    //
    // @ts-expect-error - PreparedRead deliberately omits .run(); writes go via withTransaction.
    const _runProbe = handle.run;
    void _runProbe;

    // Read methods that SHOULD exist remain callable — confirms the handle is wired up.
    expect(typeof handle.get).toBe('function');
    expect(typeof handle.all).toBe('function');
    expect(typeof handle.iterate).toBe('function');
  });

  it('runtime-asserts that .run is absent on the PreparedRead value', () => {
    // Arrange
    const handle: PreparedRead<TagInsertParams, { tag: string }> = dbm.prepare(
      'SELECT tag FROM tags WHERE tag = ?'
    );

    // Act + Assert — runtime probe for an absent method. We use a Record<string, unknown>
    // index rather than `as any` because `any` would defeat the point of the assertion:
    // we want a typed probe that says "if .run existed, it would be 'unknown' to us,
    // and we expect it to be undefined". This avoids the one-`any` exception entirely.
    const indexable = handle as unknown as Record<string, unknown>;
    expect(indexable.run).toBeUndefined();
    expect(indexable.exec).toBeUndefined();

    // Sanity — the read methods ARE present via the same indexed access path
    expect(indexable.get).toBeDefined();
    expect(indexable.all).toBeDefined();
  });
});

/**
 * Typed-error pass-through tests (guarantee 5).
 *
 * Bug regression: previously, `withTransaction` caught EVERY non-`DatabaseError`
 * throw from the work closure and rewrapped it as
 * `new DatabaseError('Transaction rolled back', { cause })`. This destroyed
 * typed errors thrown by repository code (e.g. `ValidationError`,
 * `ZodError`-via-`ValidationError`, custom `AppError` subclasses) so that
 * a Zod parse failure surfaced to the user as the opaque message
 * "Transaction rolled back" with no usable cause chain.
 *
 * The fix: re-throw any `AppError` subclass UNWRAPPED. Only wrap
 * genuinely-unknown errors (raw `Error`, `TypeError`, network errors, etc.).
 *
 * Sibling fix: `AppError`'s `cause` attach previously hid behind a
 * `Error.prototype.hasOwnProperty('cause')` guard that is ALWAYS false
 * (cause is per-instance, not on the prototype). The cause was never
 * attached even when callers passed one. The fix attaches unconditionally.
 */
describe('DatabaseManager.withTransaction — typed-error pass-through (guarantee 5)', () => {
  let dbm: DatabaseManager;

  beforeEach(() => {
    dbm = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    dbm.close();
  });

  it('throwing a ValidationError inside withTransaction surfaces as ValidationError to the caller', () => {
    // Arrange — a ValidationError carrying a recognisable message that must
    // survive the transaction boundary unmangled. This is the exact shape
    // a repository emits when a Zod parse fails at the wire boundary.
    const innerMessage = 'tag must be a non-empty string';

    // Act + Assert — caller sees the ValidationError untouched.
    let caught: unknown;
    try {
      dbm.withTransaction(() => {
        throw new ValidationError(innerMessage, { field: 'tag' });
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).not.toBeInstanceOf(DatabaseError);
    expect((caught as ValidationError).message).toBe(innerMessage);
    expect((caught as ValidationError).code).toBe('VALIDATION_ERROR');
  });

  it('throwing a DatabaseError inside withTransaction surfaces as DatabaseError to the caller (no double-wrap)', () => {
    // Arrange — DatabaseError with a recognisable context. If the catch
    // branch double-wraps, the outer DatabaseError will carry an INNER
    // DatabaseError as its cause and the original message will be lost.
    const innerMessage = 'unique constraint failed on tags.tag';
    const inner = new DatabaseError(innerMessage, { operation: 'TagRepository.insert' });

    // Act + Assert
    let caught: unknown;
    try {
      dbm.withTransaction(() => {
        throw inner;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DatabaseError);
    expect(caught).toBe(inner); // identity preserved — no rewrap
    expect((caught as DatabaseError).message).toBe(innerMessage);
    // Sanity — the cause chain wasn't inverted (the original error should
    // not have ITSELF as a cause via a double-wrap)
    expect((caught as DatabaseError & { cause?: unknown }).cause).toBeUndefined();
  });

  it('throwing a raw Error inside withTransaction surfaces as DatabaseError with cause set to the original', () => {
    // Arrange — a raw, untyped error that withTransaction SHOULD wrap. This
    // is the legitimate use of the wrap branch: network errors, TypeErrors,
    // anything that isn't part of the v2 typed-error tree.
    const rawMessage = 'unexpected runtime explosion';
    const raw = new Error(rawMessage);

    // Act + Assert
    let caught: unknown;
    try {
      dbm.withTransaction(() => {
        throw raw;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DatabaseError);
    expect((caught as DatabaseError).message).toBe('Transaction rolled back');
    // The cause chain MUST work — this is the second-half of the fix.
    // If `AppError`'s prototype guard regressed, this assertion would fail
    // even though the catch branch did the right thing.
    expect((caught as DatabaseError & { cause?: unknown }).cause).toBe(raw);
  });
});

/**
 * v2 DatabaseManager — discipline-first wrapper around better-sqlite3.
 *
 * Invariants enforced at the API surface:
 *
 *   1. `withTransaction<T>(work)` is the only public write path. There is no
 *      public `run` / `exec` / direct `db` accessor. A repository receiving a
 *      `DatabaseManager` cannot perform an INSERT/UPDATE/DELETE outside a
 *      transaction, by construction.
 *   2. Reads expose a typed `prepare<TParams, TRow>()` wrapper. Reads do not
 *      require transactional wrapping in better-sqlite3 (synchronous engine),
 *      and forcing it would only obscure intent.
 *   3. Schema is self-bootstrapping via `initSchema()` — no Python or external
 *      migration step. v1's "Please use Python version to initialize schema."
 *      error path does not exist here.
 *   4. No global singleton. The Ink layer instantiates one `DatabaseManager`
 *      at the command boundary; tests instantiate `:memory:` per test.
 *
 * Ported from `legacy/python/src/database/connection.py` (the
 * `@contextmanager get_session()` pattern). The TS equivalent of that
 * pattern is `withTransaction<T>()`.
 */

import BetterSqlite3, { type Database, type RunResult, type Statement } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { DatabaseError } from '../errors/index.js';
import logger from '../utils/logger.js';
import { initSchema } from './schema.js';

/**
 * Typed read-only view over a `better-sqlite3` `Statement`. Restricts the
 * surface to the three read-shaped methods (`get`, `all`, `iterate`) so a
 * caller cannot smuggle a write through a "prepared statement".
 *
 * Writes still happen via prepared statements internally — but only inside
 * `withTransaction<T>`, where the closure has the full `Database` handle.
 */
export interface PreparedRead<TParams extends readonly unknown[], TRow> {
  get(...params: TParams): TRow | undefined;
  all(...params: TParams): TRow[];
  iterate(...params: TParams): IterableIterator<TRow>;
}

/**
 * Function signature passed to `withTransaction`. The callback receives the
 * raw `Database` handle so it can run prepared statements, execute multiple
 * writes atomically, and read its own writes — all inside a single
 * BEGIN/COMMIT (or BEGIN/ROLLBACK on throw).
 */
export type TransactionWork<T> = (db: Database) => T;

/**
 * Manages a single SQLite connection. One instance per logical context;
 * not a singleton.
 */
export class DatabaseManager {
  private readonly db: Database;
  private readonly databasePath: string;
  private closed = false;

  constructor(databasePath: string) {
    this.databasePath = databasePath;

    this.ensureDirectoryExists(databasePath);

    try {
      this.db = new BetterSqlite3(databasePath, { fileMustExist: false });
    } catch (error) {
      throw new DatabaseError('Failed to open SQLite database', {
        operation: 'constructor',
        cause: error,
        context: { databasePath },
      });
    }

    this.configurePragmas();

    try {
      initSchema(this.db);
    } catch (error) {
      // Failure here leaves the DB in an indeterminate state; close it so the
      // caller does not get a half-bootstrapped handle back.
      this.db.close();
      throw new DatabaseError('Failed to bootstrap schema', {
        operation: 'initSchema',
        cause: error,
        context: { databasePath },
      });
    }

    logger.debug({ databasePath }, 'DatabaseManager opened');
  }

  /**
   * Close the underlying connection. Idempotent — safe to call multiple times.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.db.close();
      this.closed = true;
      logger.debug({ databasePath: this.databasePath }, 'DatabaseManager closed');
    } catch (error) {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          databasePath: this.databasePath,
        },
        'Failed to close DatabaseManager'
      );
    }
  }

  /**
   * Run `work` inside a transaction. better-sqlite3's `db.transaction(fn)`
   * wraps `fn` in `BEGIN; ... COMMIT;` and rolls back automatically on throw.
   * Nested calls use SAVEPOINTs; nested commits land iff the outermost
   * transaction also commits.
   *
   * This is the ONLY public write path on `DatabaseManager`. Repositories
   * receive a `DatabaseManager` and must call this to perform any write.
   *
   * @typeParam T - Return type of the work closure.
   * @param work - Synchronous closure that performs writes against the
   *               supplied `Database` handle. Any thrown error rolls the
   *               transaction back and is rethrown to the caller.
   * @returns The value returned by `work`.
   * @throws {DatabaseError} If the transaction cannot start, or if `work`
   *                        throws — the original cause is preserved.
   */
  withTransaction<T>(work: TransactionWork<T>): T {
    this.assertOpen();
    const wrapped = this.db.transaction(work);
    logger.debug({ databasePath: this.databasePath }, 'transaction begin');
    try {
      return wrapped(this.db);
    } catch (error) {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          databasePath: this.databasePath,
        },
        'transaction rollback'
      );
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Transaction rolled back', {
        operation: 'withTransaction',
        cause: error,
      });
    }
  }

  /**
   * Prepare a read-only-shaped statement. The returned object only exposes
   * `get` / `all` / `iterate` — there is no `run` here, so a caller cannot
   * use this method to perform writes.
   *
   * @typeParam TParams - Tuple type of the SQL bind parameters.
   * @typeParam TRow - Row shape the SELECT returns (caller-asserted; pair
   *                   with a Zod parse at the boundary for real safety).
   */
  prepare<TParams extends readonly unknown[], TRow>(
    sql: string
  ): PreparedRead<TParams, TRow> {
    this.assertOpen();
    try {
      const stmt: Statement = this.db.prepare(sql);
      return {
        get: (...params: TParams): TRow | undefined =>
          stmt.get(...(params as unknown as unknown[])) as TRow | undefined,
        all: (...params: TParams): TRow[] =>
          stmt.all(...(params as unknown as unknown[])) as TRow[],
        iterate: (...params: TParams): IterableIterator<TRow> =>
          stmt.iterate(...(params as unknown as unknown[])) as IterableIterator<TRow>,
      };
    } catch (error) {
      throw new DatabaseError('Failed to prepare statement', {
        operation: 'prepare',
        cause: error,
        context: { sql },
      });
    }
  }

  /**
   * Path the manager opened. Useful for logs and tests.
   */
  getPath(): string {
    return this.databasePath;
  }

  /**
   * Whether the underlying connection is still open. Reflects `close()`
   * having been called; does not detect external corruption.
   */
  isOpen(): boolean {
    return !this.closed && this.db.open;
  }

  private configurePragmas(): void {
    // Foreign keys MUST be enabled per-connection in SQLite — DDL alone is
    // not enough. Done here, not in schema.ts, because PRAGMA is a
    // connection-level concern.
    this.db.pragma('foreign_keys = ON');

    // WAL improves concurrency for the read-heavy report path. `:memory:`
    // databases ignore journal_mode but accept the pragma silently.
    this.db.pragma('journal_mode = WAL');
  }

  private ensureDirectoryExists(databasePath: string): void {
    if (databasePath === ':memory:' || databasePath === '') {
      return;
    }
    const dir = path.dirname(databasePath);
    if (dir === '' || dir === '.') {
      return;
    }
    if (fs.existsSync(dir)) {
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      logger.debug({ dir }, 'Created database directory');
    } catch (error) {
      throw new DatabaseError('Failed to create database directory', {
        operation: 'ensureDirectoryExists',
        cause: error,
        context: { databasePath, dir },
      });
    }
  }

  private assertOpen(): void {
    if (this.closed || !this.db.open) {
      throw new DatabaseError('DatabaseManager is closed', {
        operation: 'assertOpen',
        context: { databasePath: this.databasePath },
      });
    }
  }
}

/**
 * Convenience re-export so callers can refer to a `RunResult` without
 * importing from `better-sqlite3` directly.
 */
export type { RunResult };

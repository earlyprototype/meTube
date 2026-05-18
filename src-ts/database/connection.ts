/**
 * Database connection manager using better-sqlite3
 * Connects to existing metube.db database
 * Provides connection lifecycle management and proper cleanup
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DatabaseError } from '../errors/index.js';
import logger from '../utils/logger.js';

export class DatabaseManager {
  private db: Database.Database | null = null;
  private databasePath: string;

  constructor(databasePath?: string) {
    this.databasePath = databasePath || 'data/metube.db';

    try {
      // Ensure directory exists
      const dbDir = path.dirname(this.databasePath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.info({  dbDir  }, 'Created database directory');
      }
    } catch (error) {
      throw new DatabaseError('Failed to create database directory', {
        operation: 'constructor',
        cause: error,
        context: { databasePath: this.databasePath },
      });
    }
  }

  /**
   * Get or create database connection
   * Automatically enables foreign keys and WAL mode
   * @returns Active database connection
   * @throws {DatabaseError} If connection fails
   */
  getConnection(): Database.Database {
    if (!this.db) {
      try {
        this.db = new Database(this.databasePath, {
          verbose: undefined, // Can set to logger.debug for SQL debugging
          fileMustExist: false,
        });

        // Enable foreign keys
        this.db.pragma('foreign_keys = ON');

        // Set WAL mode for better concurrency
        this.db.pragma('journal_mode = WAL');

        logger.info({  path: this.databasePath  }, 'Database connection established');
      } catch (error) {
        throw new DatabaseError('Failed to establish database connection', {
          operation: 'getConnection',
          cause: error,
          context: { databasePath: this.databasePath },
        });
      }
    }

    return this.db;
  }

  /**
   * Close database connection
   * Safe to call multiple times
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
        this.db = null;
        logger.info({  path: this.databasePath  }, 'Database connection closed');
      } catch (error) {
        logger.error({ 
          error: error instanceof Error ? error.message : String(error),
          path: this.databasePath,
         }, 'Failed to close database connection');
        // Don't throw - we're cleaning up
      }
    }
  }

  /**
   * Check if database file exists
   * @returns True if database file exists
   */
  exists(): boolean {
    return fs.existsSync(this.databasePath);
  }

  /**
   * Get database path
   * @returns Absolute path to database file
   */
  getPath(): string {
    return this.databasePath;
  }

  /**
   * Execute a query and return all rows
   * @param sql - SQL query string
   * @param params - Optional query parameters
   * @returns Array of result rows
   * @throws {DatabaseError} If query execution fails
   */
  all<T>(sql: string, params?: unknown[]): T[] {
    try {
      const db = this.getConnection();
      const stmt = db.prepare(sql);
      return (params && params.length > 0 ? stmt.all(...params) : stmt.all()) as T[];
    } catch (error) {
      throw new DatabaseError('Query execution failed', {
        operation: 'all',
        cause: error,
        context: { sql, paramCount: params?.length },
      });
    }
  }

  /**
   * Execute a query and return first row
   * @param sql - SQL query string
   * @param params - Optional query parameters
   * @returns First result row or undefined if no results
   * @throws {DatabaseError} If query execution fails
   */
  get<T>(sql: string, params?: unknown[]): T | undefined {
    try {
      const db = this.getConnection();
      const stmt = db.prepare(sql);
      return (params && params.length > 0 ? stmt.get(...params) : stmt.get()) as T | undefined;
    } catch (error) {
      throw new DatabaseError('Query execution failed', {
        operation: 'get',
        cause: error,
        context: { sql, paramCount: params?.length },
      });
    }
  }

  /**
   * Execute a query without returning rows (INSERT, UPDATE, DELETE)
   * @param sql - SQL query string
   * @param params - Optional query parameters
   * @returns Query execution result
   * @throws {DatabaseError} If query execution fails
   */
  run(sql: string, params?: unknown[]): Database.RunResult {
    try {
      const db = this.getConnection();
      const stmt = db.prepare(sql);
      return params && params.length > 0 ? stmt.run(...params) : stmt.run();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('\n=== SQLITE ERROR ===');
      console.error('SQL:', sql);
      console.error('Params:', JSON.stringify(params, null, 2));
      console.error('Error:', errorMsg);
      console.error('===================\n');
      
      throw new DatabaseError(`Query execution failed: ${errorMsg}`, {
        operation: 'run',
        cause: error,
        context: { sql, paramCount: params?.length, params },
      });
    }
  }

  /**
   * Execute operations within a transaction
   * Automatically rolls back on error
   * @param fn - Function containing transaction operations
   * @returns Result from transaction function
   * @throws {DatabaseError} If transaction fails
   */
  transaction<T>(fn: (db: Database.Database) => T): T {
    try {
      const db = this.getConnection();
      const transactionFn = db.transaction(fn);
      return transactionFn(db);
    } catch (error) {
      throw new DatabaseError('Transaction failed', {
        operation: 'transaction',
        cause: error,
      });
    }
  }

  /**
   * Check if database connection is open
   * @returns True if connection is open
   */
  isOpen(): boolean {
    return this.db !== null && this.db.open;
  }
}

// Global database manager instance
let _dbManager: DatabaseManager | null = null;

/**
 * Get or create global database manager instance
 * @param databasePath - Optional custom database path
 * @returns Database manager instance
 */
export function getDbManager(databasePath?: string): DatabaseManager {
  if (!_dbManager) {
    _dbManager = new DatabaseManager(databasePath);
  }
  return _dbManager;
}

/**
 * Initialize database connection and verify schema
 * @param databasePath - Optional custom database path
 * @returns Initialized database manager
 * @throws {DatabaseError} If database cannot be initialized or has no tables
 */
export function initDatabase(databasePath?: string): DatabaseManager {
  try {
    const manager = getDbManager(databasePath);

    // Ensure connection works
    const db = manager.getConnection();

    // Verify database has tables
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    if (tables.length === 0) {
      throw new DatabaseError(
        'Database has no tables. Please use Python version to initialize schema.',
        {
          operation: 'initDatabase',
          context: { databasePath: manager.getPath() },
        }
      );
    }

    logger.info({ 
      path: manager.getPath(),
      tableCount: tables.length,
      tables: tables.map((t) => t.name),
     }, 'Database initialized successfully');

    return manager;
  } catch (error) {
    if (error instanceof DatabaseError) {
      throw error;
    }
    throw new DatabaseError('Failed to initialize database', {
      operation: 'initDatabase',
      cause: error,
      context: { databasePath },
    });
  }
}

/**
 * Close global database connection
 * Safe to call multiple times
 * Should be called on application shutdown
 */
export function closeDatabase(): void {
  if (_dbManager) {
    _dbManager.close();
    _dbManager = null;
    logger.info('Global database connection closed');
  }
}

/**
 * Graceful shutdown handler
 * Register this with process.on('SIGTERM') or similar
 */
export function setupGracefulShutdown(): void {
  const shutdown = () => {
    logger.info('Shutting down gracefully...');
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.error({ 
      error: error.message,
      stack: error.stack,
     }, 'Uncaught exception');
    closeDatabase();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ 
      reason: reason instanceof Error ? reason.message : String(reason),
     }, 'Unhandled rejection');
    closeDatabase();
    process.exit(1);
  });
}


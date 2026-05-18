/**
 * Tests for database connection manager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager, initDatabase, closeDatabase, getDbManager } from '../connection.js';
import { DatabaseError } from '../../errors/index.js';
import fs from 'fs';
import path from 'path';

const TEST_DB_PATH = path.join(process.cwd(), 'test-connection.db');

describe('DatabaseManager', () => {
  let dbManager: DatabaseManager;

  afterEach(() => {
    if (dbManager) {
      dbManager.close();
    }
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('constructor', () => {
    it('should create database manager with default path', () => {
      dbManager = new DatabaseManager();
      expect(dbManager.getPath()).toBe('data/metube.db');
    });

    it('should create database manager with custom path', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      expect(dbManager.getPath()).toBe(TEST_DB_PATH);
    });

    it('should create database directory if not exists', () => {
      const testPath = path.join(process.cwd(), 'test-dir-new', 'test.db');
      const testDir = path.dirname(testPath);

      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true });
      }

      dbManager = new DatabaseManager(testPath);

      expect(fs.existsSync(testDir)).toBe(true);

      // Cleanup
      dbManager.close();
      fs.rmSync(testDir, { recursive: true });
    });
  });

  describe('getConnection', () => {
    it('should establish database connection', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      const db = dbManager.getConnection();

      expect(db).toBeDefined();
      expect(dbManager.isOpen()).toBe(true);
    });

    it('should return same connection on multiple calls', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      const db1 = dbManager.getConnection();
      const db2 = dbManager.getConnection();

      expect(db1).toBe(db2);
    });

    it('should enable foreign keys', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      const db = dbManager.getConnection();

      const result = db.pragma('foreign_keys', { simple: true });
      expect(result).toBe(1);
    });
  });

  describe('close', () => {
    it('should close database connection', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.getConnection();

      dbManager.close();

      expect(dbManager.isOpen()).toBe(false);
    });

    it('should be safe to call close multiple times', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.getConnection();

      dbManager.close();
      dbManager.close(); // Should not throw

      expect(dbManager.isOpen()).toBe(false);
    });
  });

  describe('exists', () => {
    it('should return true if database file exists', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.getConnection(); // Creates file

      expect(dbManager.exists()).toBe(true);
    });

    it('should return false if database file does not exist', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);

      expect(dbManager.exists()).toBe(false);
    });
  });

  describe('all', () => {
    it('should execute query and return all rows', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.run('CREATE TABLE test (id INTEGER, name TEXT)');
      dbManager.run("INSERT INTO test VALUES (1, 'Alice')");
      dbManager.run("INSERT INTO test VALUES (2, 'Bob')");

      const results = dbManager.all<{ id: number; name: string }>('SELECT * FROM test');

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('Alice');
    });

    it('should return empty array if no results', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.run('CREATE TABLE test (id INTEGER)');

      const results = dbManager.all('SELECT * FROM test');

      expect(results).toEqual([]);
    });
  });

  describe('get', () => {
    it('should execute query and return first row', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.run('CREATE TABLE test (id INTEGER, name TEXT)');
      dbManager.run("INSERT INTO test VALUES (1, 'Alice')");

      const result = dbManager.get<{ id: number; name: string }>('SELECT * FROM test WHERE id = ?', [1]);

      expect(result).toBeDefined();
      expect(result?.name).toBe('Alice');
    });

    it('should return undefined if no results', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.run('CREATE TABLE test (id INTEGER)');

      const result = dbManager.get('SELECT * FROM test WHERE id = 999');

      expect(result).toBeUndefined();
    });
  });

  describe('run', () => {
    it('should execute query without returning rows', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);

      const result = dbManager.run('CREATE TABLE test (id INTEGER)');

      expect(result).toBeDefined();
      expect(result.changes).toBeDefined();
    });

    it('should return changes count', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.run('CREATE TABLE test (id INTEGER)');

      const result = dbManager.run('INSERT INTO test VALUES (1)');

      expect(result.changes).toBe(1);
    });
  });

  describe('transaction', () => {
    it('should execute operations within transaction', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.run('CREATE TABLE test (id INTEGER)');

      const result = dbManager.transaction((db) => {
        db.prepare('INSERT INTO test VALUES (1)').run();
        db.prepare('INSERT INTO test VALUES (2)').run();
        return 'success';
      });

      expect(result).toBe('success');

      const rows = dbManager.all('SELECT * FROM test');
      expect(rows).toHaveLength(2);
    });

    it('should rollback on error', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.run('CREATE TABLE test (id INTEGER PRIMARY KEY)');

      try {
        dbManager.transaction((db) => {
          db.prepare('INSERT INTO test VALUES (1)').run();
          db.prepare('INSERT INTO test VALUES (1)').run(); // Duplicate, should fail
        });
      } catch (error) {
        // Expected to throw
      }

      const rows = dbManager.all('SELECT * FROM test');
      expect(rows).toHaveLength(0); // Should be rolled back
    });
  });

  describe('isOpen', () => {
    it('should return false when connection not established', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);

      expect(dbManager.isOpen()).toBe(false);
    });

    it('should return true when connection established', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.getConnection();

      expect(dbManager.isOpen()).toBe(true);
    });

    it('should return false after closing', () => {
      dbManager = new DatabaseManager(TEST_DB_PATH);
      dbManager.getConnection();
      dbManager.close();

      expect(dbManager.isOpen()).toBe(false);
    });
  });
});

describe('Global database functions', () => {
  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('initDatabase', () => {
    it('should initialize database and verify tables', () => {
      const tempDb = new DatabaseManager(TEST_DB_PATH);
      tempDb.run('CREATE TABLE test (id INTEGER)');
      tempDb.close();

      const manager = initDatabase(TEST_DB_PATH);

      expect(manager).toBeDefined();
      expect(manager.isOpen()).toBe(true);
    });

    it('should throw if database has no tables', () => {
      // Create empty database
      const tempDb = new DatabaseManager(TEST_DB_PATH);
      tempDb.getConnection();
      tempDb.close();

      expect(() => {
        initDatabase(TEST_DB_PATH);
      }).toThrow(DatabaseError);
    });
  });

  describe('getDbManager', () => {
    it('should return singleton instance', () => {
      const manager1 = getDbManager(TEST_DB_PATH);
      const manager2 = getDbManager(TEST_DB_PATH);

      expect(manager1).toBe(manager2);
    });
  });

  describe('closeDatabase', () => {
    it('should close global database connection', () => {
      const manager = getDbManager(TEST_DB_PATH);
      manager.getConnection();

      closeDatabase();

      expect(manager.isOpen()).toBe(false);
    });

    it('should be safe to call multiple times', () => {
      getDbManager(TEST_DB_PATH);

      closeDatabase();
      closeDatabase(); // Should not throw
    });
  });
});

/**
 * Comprehensive tests for database repositories
 * Tests VideoRepository, PlaylistRepository, and TranscriptRepository
 * Target: 80%+ code coverage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../connection.js';
import {
  VideoRepository,
  PlaylistRepository,
  PlaylistItemRepository,
  TranscriptRepository,
  EntityRepository,
  StatisticsRepository,
} from '../repositories.js';
import { ValidationError, DatabaseError } from '../../errors/index.js';
import fs from 'fs';
import path from 'path';

// Use a temporary test database
const TEST_DB_PATH = path.join(process.cwd(), 'test-metube.db');

describe('VideoRepository', () => {
  let dbManager: DatabaseManager;
  let repository: VideoRepository;

  beforeEach(() => {
    // Create fresh database for each test
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    dbManager = new DatabaseManager(TEST_DB_PATH);
    repository = new VideoRepository(dbManager);

    // Create videos table
    dbManager.run(`
      CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT UNIQUE NOT NULL,
        title TEXT,
        description TEXT,
        channel_id TEXT,
        channel_name TEXT,
        published_at TEXT,
        duration_seconds INTEGER,
        view_count INTEGER,
        like_count INTEGER,
        is_short INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => {
    dbManager.close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('createOrUpdate', () => {
    it('should create a new video', () => {
      const videoData = {
        video_id: 'dQw4w9WgXcQ',
        title: 'Test Video',
        description: 'Test Description',
        channel_id: 'UC123456',
        channel_name: 'Test Channel',
      };

      const video = repository.createOrUpdate(videoData);

      expect(video).toBeDefined();
      expect(video.video_id).toBe('dQw4w9WgXcQ');
      expect(video.title).toBe('Test Video');
      expect(video.channel_id).toBe('UC123456');
    });

    it('should update an existing video', () => {
      const videoData = {
        video_id: 'dQw4w9WgXcQ',
        title: 'Original Title',
        channel_id: 'UC123456',
      };

      repository.createOrUpdate(videoData);

      const updated = repository.createOrUpdate({
        video_id: 'dQw4w9WgXcQ',
        title: 'Updated Title',
      });

      expect(updated.title).toBe('Updated Title');
      expect(updated.channel_id).toBe('UC123456');
    });

    it('should throw ValidationError if video_id is missing', () => {
      expect(() => {
        repository.createOrUpdate({ title: 'No ID' });
      }).toThrow(ValidationError);
    });

    it('should throw ValidationError if video_id is invalid format', () => {
      expect(() => {
        repository.createOrUpdate({ video_id: 'invalid', title: 'Test' });
      }).toThrow(ValidationError);
    });

    it('should return existing video if no fields to update', () => {
      const videoData = { video_id: 'dQw4w9WgXcQ', title: 'Test' };
      const created = repository.createOrUpdate(videoData);
      const updated = repository.createOrUpdate({ video_id: 'dQw4w9WgXcQ' });

      expect(updated.id).toBe(created.id);
      expect(updated.title).toBe('Test');
    });
  });

  describe('getByVideoId', () => {
    it('should return video by video_id', () => {
      repository.createOrUpdate({
        video_id: 'dQw4w9WgXcQ',
        title: 'Test Video',
      });

      const video = repository.getByVideoId('dQw4w9WgXcQ');

      expect(video).toBeDefined();
      expect(video?.video_id).toBe('dQw4w9WgXcQ');
    });

    it('should return undefined if video not found', () => {
      const video = repository.getByVideoId('nonexistent');
      expect(video).toBeUndefined();
    });

    it('should throw ValidationError for invalid video_id', () => {
      expect(() => {
        repository.getByVideoId('invalid');
      }).toThrow(ValidationError);
    });
  });

  describe('getAll', () => {
    it('should return all videos', () => {
      repository.createOrUpdate({ video_id: 'video00001a', title: 'Video 1' });
      repository.createOrUpdate({ video_id: 'video00002b', title: 'Video 2' });

      const videos = repository.getAll();

      expect(videos).toHaveLength(2);
    });

    it('should filter shorts when shortsOnly=true', () => {
      repository.createOrUpdate({ video_id: 'video00001a', title: 'Regular', is_short: 0 });
      repository.createOrUpdate({ video_id: 'video00002b', title: 'Short', is_short: 1 });

      const shorts = repository.getAll(true);

      expect(shorts).toHaveLength(1);
      expect(shorts[0].title).toBe('Short');
    });

    it('should return empty array if no videos', () => {
      const videos = repository.getAll();
      expect(videos).toEqual([]);
    });
  });

  describe('getByChannel', () => {
    it('should return videos from a channel', () => {
      repository.createOrUpdate({
        video_id: 'video00001a',
        channel_id: 'UC123',
        title: 'Video 1',
      });
      repository.createOrUpdate({
        video_id: 'video00002b',
        channel_id: 'UC123',
        title: 'Video 2',
      });
      repository.createOrUpdate({
        video_id: 'video00003c',
        channel_id: 'UC456',
        title: 'Video 3',
      });

      const videos = repository.getByChannel('UC123');

      expect(videos).toHaveLength(2);
      expect(videos.every((v) => v.channel_id === 'UC123')).toBe(true);
    });

    it('should throw ValidationError for empty channel_id', () => {
      expect(() => {
        repository.getByChannel('');
      }).toThrow(ValidationError);
    });
  });

  describe('search', () => {
    it('should search videos by title', () => {
      repository.createOrUpdate({ video_id: 'video00001a', title: 'JavaScript Tutorial' });
      repository.createOrUpdate({ video_id: 'video00002b', title: 'Python Guide' });

      const results = repository.search('JavaScript');

      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('JavaScript');
    });

    it('should search videos by description', () => {
      repository.createOrUpdate({
        video_id: 'video00001a',
        title: 'Video 1',
        description: 'Learn TypeScript',
      });

      const results = repository.search('TypeScript');

      expect(results).toHaveLength(1);
    });

    it('should be case-insensitive', () => {
      repository.createOrUpdate({ video_id: 'video00001a', title: 'JavaScript Tutorial' });

      const results = repository.search('javascript');

      expect(results).toHaveLength(1);
    });

    it('should throw ValidationError for empty query', () => {
      expect(() => {
        repository.search('');
      }).toThrow(ValidationError);
    });
  });

  describe('exists', () => {
    it('should return true if video exists', () => {
      repository.createOrUpdate({ video_id: 'dQw4w9WgXcQ', title: 'Test' });

      expect(repository.exists('dQw4w9WgXcQ')).toBe(true);
    });

    it('should return false if video does not exist', () => {
      expect(repository.exists('nonexistent')).toBe(false);
    });

    it('should throw ValidationError for invalid video_id', () => {
      expect(() => {
        repository.exists('invalid');
      }).toThrow(ValidationError);
    });
  });
});

describe('PlaylistRepository', () => {
  let dbManager: DatabaseManager;
  let repository: PlaylistRepository;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    dbManager = new DatabaseManager(TEST_DB_PATH);
    repository = new PlaylistRepository(dbManager);

    dbManager.run(`
      CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id TEXT UNIQUE NOT NULL,
        title TEXT,
        description TEXT,
        channel_id TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => {
    dbManager.close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('createOrUpdate', () => {
    it('should create a new playlist', () => {
      const playlistData = {
        playlist_id: 'PLtest123',
        title: 'Test Playlist',
        channel_id: 'UC123',
      };

      const playlist = repository.createOrUpdate(playlistData);

      expect(playlist).toBeDefined();
      expect(playlist.playlist_id).toBe('PLtest123');
      expect(playlist.title).toBe('Test Playlist');
    });

    it('should update an existing playlist', () => {
      repository.createOrUpdate({ playlist_id: 'PLtest123', title: 'Original' });

      const updated = repository.createOrUpdate({
        playlist_id: 'PLtest123',
        title: 'Updated',
      });

      expect(updated.title).toBe('Updated');
    });

    it('should throw ValidationError if playlist_id is missing', () => {
      expect(() => {
        repository.createOrUpdate({ title: 'No ID' });
      }).toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid playlist_id', () => {
      expect(() => {
        repository.createOrUpdate({ playlist_id: '', title: 'Test' });
      }).toThrow(ValidationError);
    });
  });

  describe('getById', () => {
    it('should return playlist by ID', () => {
      repository.createOrUpdate({ playlist_id: 'PLtest123', title: 'Test' });

      const playlist = repository.getById('PLtest123');

      expect(playlist).toBeDefined();
      expect(playlist?.title).toBe('Test');
    });

    it('should return undefined if not found', () => {
      const playlist = repository.getById('nonexistent');
      expect(playlist).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('should return only enabled playlists by default', () => {
      repository.createOrUpdate({ playlist_id: 'PLtest001', enabled: 1 });
      repository.createOrUpdate({ playlist_id: 'PLtest002', enabled: 0 });

      const playlists = repository.getAll();

      expect(playlists).toHaveLength(1);
    });

    it('should return all playlists when enabledOnly=false', () => {
      repository.createOrUpdate({ playlist_id: 'PLtest001', enabled: 1 });
      repository.createOrUpdate({ playlist_id: 'PLtest002', enabled: 0 });

      const playlists = repository.getAll(false);

      expect(playlists).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('should delete a playlist', () => {
      repository.createOrUpdate({ playlist_id: 'PLtest123', title: 'Test' });

      repository.delete('PLtest123');

      expect(repository.getById('PLtest123')).toBeUndefined();
    });

    it('should throw ValidationError for invalid playlist_id', () => {
      expect(() => {
        repository.delete('');
      }).toThrow(ValidationError);
    });
  });

  describe('exists', () => {
    it('should return true if playlist exists', () => {
      repository.createOrUpdate({ playlist_id: 'PLtest123', title: 'Test' });

      expect(repository.exists('PLtest123')).toBe(true);
    });

    it('should return false if playlist does not exist', () => {
      expect(repository.exists('nonexistent')).toBe(false);
    });
  });
});

describe('TranscriptRepository', () => {
  let dbManager: DatabaseManager;
  let repository: TranscriptRepository;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    dbManager = new DatabaseManager(TEST_DB_PATH);
    repository = new TranscriptRepository(dbManager);

    dbManager.run(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT UNIQUE NOT NULL,
        language TEXT DEFAULT 'en',
        full_text TEXT,
        segments_json TEXT,
        is_auto_generated INTEGER DEFAULT 0,
        extracted_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => {
    dbManager.close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('create', () => {
    it('should create a transcript', () => {
      const transcript = repository.create('dQw4w9WgXcQ', {
        language: 'en',
        full_text: 'Hello world',
        segments_json: '[]',
        is_auto_generated: false,
      });

      expect(transcript).toBeDefined();
      expect(transcript.video_id).toBe('dQw4w9WgXcQ');
      expect(transcript.full_text).toBe('Hello world');
    });

    it('should replace existing transcript', () => {
      repository.create('dQw4w9WgXcQ', { full_text: 'Original' });
      const updated = repository.create('dQw4w9WgXcQ', { full_text: 'Updated' });

      expect(updated.full_text).toBe('Updated');

      const all = dbManager.all('SELECT * FROM transcripts');
      expect(all).toHaveLength(1);
    });

    it('should use default values', () => {
      const transcript = repository.create('dQw4w9WgXcQ', {});

      expect(transcript.language).toBe('en');
      expect(transcript.full_text).toBe('');
      expect(transcript.segments_json).toBe('[]');
    });

    it('should throw ValidationError for invalid video_id', () => {
      expect(() => {
        repository.create('invalid', { full_text: 'Test' });
      }).toThrow(ValidationError);
    });
  });

  describe('getByVideoId', () => {
    it('should return transcript for video', () => {
      repository.create('dQw4w9WgXcQ', { full_text: 'Test' });

      const transcript = repository.getByVideoId('dQw4w9WgXcQ');

      expect(transcript).toBeDefined();
      expect(transcript?.full_text).toBe('Test');
    });

    it('should return undefined if not found', () => {
      const transcript = repository.getByVideoId('nonexistent');
      expect(transcript).toBeUndefined();
    });
  });

  describe('exists', () => {
    it('should return true if transcript exists', () => {
      repository.create('dQw4w9WgXcQ', { full_text: 'Test' });

      expect(repository.exists('dQw4w9WgXcQ')).toBe(true);
    });

    it('should return false if transcript does not exist', () => {
      expect(repository.exists('nonexistent')).toBe(false);
    });
  });
});

describe('PlaylistItemRepository', () => {
  let dbManager: DatabaseManager;
  let repository: PlaylistItemRepository;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    dbManager = new DatabaseManager(TEST_DB_PATH);
    repository = new PlaylistItemRepository(dbManager);

    dbManager.run(`
      CREATE TABLE IF NOT EXISTS playlist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        position INTEGER,
        added_at TEXT DEFAULT (datetime('now')),
        UNIQUE(playlist_id, video_id)
      )
    `);
  });

  afterEach(() => {
    dbManager.close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('addVideoToPlaylist', () => {
    it('should add video to playlist', () => {
      const item = repository.addVideoToPlaylist('PLtest123', 'dQw4w9WgXcQ', 1);

      expect(item).toBeDefined();
      expect(item.playlist_id).toBe('PLtest123');
      expect(item.video_id).toBe('dQw4w9WgXcQ');
      expect(item.position).toBe(1);
    });

    it('should return existing item if already added', () => {
      const first = repository.addVideoToPlaylist('PLtest123', 'dQw4w9WgXcQ');
      const second = repository.addVideoToPlaylist('PLtest123', 'dQw4w9WgXcQ');

      expect(first.id).toBe(second.id);
    });

    it('should throw ValidationError for invalid playlist_id', () => {
      expect(() => {
        repository.addVideoToPlaylist('', 'dQw4w9WgXcQ');
      }).toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid video_id', () => {
      expect(() => {
        repository.addVideoToPlaylist('PLtest123', 'invalid');
      }).toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid position', () => {
      expect(() => {
        repository.addVideoToPlaylist('PLtest123', 'dQw4w9WgXcQ', -1);
      }).toThrow(ValidationError);
    });
  });

  describe('getByPlaylist', () => {
    it('should return items in a playlist', () => {
      repository.addVideoToPlaylist('PLtest123', 'video00001a', 1);
      repository.addVideoToPlaylist('PLtest123', 'video00002b', 2);

      const items = repository.getByPlaylist('PLtest123');

      expect(items).toHaveLength(2);
    });

    it('should order by position', () => {
      repository.addVideoToPlaylist('PLtest123', 'video00002b', 2);
      repository.addVideoToPlaylist('PLtest123', 'video00001a', 1);

      const items = repository.getByPlaylist('PLtest123');

      expect(items[0].position).toBe(1);
      expect(items[1].position).toBe(2);
    });
  });

  describe('getByVideo', () => {
    it('should return playlists containing a video', () => {
      repository.addVideoToPlaylist('PLtest001', 'dQw4w9WgXcQ');
      repository.addVideoToPlaylist('PLtest002', 'dQw4w9WgXcQ');

      const items = repository.getByVideo('dQw4w9WgXcQ');

      expect(items).toHaveLength(2);
    });
  });
});

describe('EntityRepository', () => {
  let dbManager: DatabaseManager;
  let repository: EntityRepository;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    dbManager = new DatabaseManager(TEST_DB_PATH);
    repository = new EntityRepository(dbManager);

    dbManager.run(`
      CREATE TABLE IF NOT EXISTS extracted_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_value TEXT NOT NULL,
        entity_url TEXT,
        confidence INTEGER DEFAULT 100,
        extracted_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => {
    dbManager.close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('addEntities', () => {
    it('should add entities for a video', () => {
      const entities = [
        { type: 'person', value: 'John Doe' },
        { type: 'organization', value: 'Acme Corp', url: 'https://acme.com', confidence: 95 },
      ];

      repository.addEntities('dQw4w9WgXcQ', entities);

      const saved = repository.getByVideo('dQw4w9WgXcQ');
      expect(saved).toHaveLength(2);
      expect(saved[0].entity_type).toBe('person');
      expect(saved[1].confidence).toBe(95);
    });

    it('should throw ValidationError for invalid video_id', () => {
      expect(() => {
        repository.addEntities('invalid', [{ type: 'test', value: 'test' }]);
      }).toThrow(ValidationError);
    });

    it('should throw ValidationError for empty entities array', () => {
      expect(() => {
        repository.addEntities('dQw4w9WgXcQ', []);
      }).toThrow(ValidationError);
    });

    it('should throw ValidationError for entity missing type', () => {
      expect(() => {
        repository.addEntities('dQw4w9WgXcQ', [{ type: '', value: 'test' }]);
      }).toThrow(ValidationError);
    });
  });

  describe('getByVideo', () => {
    it('should return all entities for a video', () => {
      repository.addEntities('dQw4w9WgXcQ', [
        { type: 'person', value: 'John' },
        { type: 'location', value: 'London' },
      ]);

      const entities = repository.getByVideo('dQw4w9WgXcQ');

      expect(entities).toHaveLength(2);
    });

    it('should filter by entity type', () => {
      repository.addEntities('dQw4w9WgXcQ', [
        { type: 'person', value: 'John' },
        { type: 'location', value: 'London' },
      ]);

      const people = repository.getByVideo('dQw4w9WgXcQ', 'person');

      expect(people).toHaveLength(1);
      expect(people[0].entity_type).toBe('person');
    });
  });

  describe('getByType', () => {
    it('should return all entities of a specific type', () => {
      repository.addEntities('video00001a', [{ type: 'person', value: 'John' }]);
      repository.addEntities('video00002b', [{ type: 'person', value: 'Jane' }]);

      const people = repository.getByType('person');

      expect(people).toHaveLength(2);
    });
  });
});

describe('StatisticsRepository', () => {
  let dbManager: DatabaseManager;
  let repository: StatisticsRepository;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    dbManager = new DatabaseManager(TEST_DB_PATH);
    repository = new StatisticsRepository(dbManager);

    dbManager.run(`
      CREATE TABLE IF NOT EXISTS video_statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        view_count INTEGER DEFAULT 0,
        like_count INTEGER DEFAULT 0,
        comment_count INTEGER DEFAULT 0,
        recorded_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => {
    dbManager.close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('addSnapshot', () => {
    it('should add statistics snapshot', () => {
      const stats = repository.addSnapshot('dQw4w9WgXcQ', {
        view_count: 1000,
        like_count: 50,
        comment_count: 10,
      });

      expect(stats).toBeDefined();
      expect(stats.view_count).toBe(1000);
      expect(stats.like_count).toBe(50);
    });

    it('should use default values for missing counts', () => {
      const stats = repository.addSnapshot('dQw4w9WgXcQ', {});

      expect(stats.view_count).toBe(0);
      expect(stats.like_count).toBe(0);
      expect(stats.comment_count).toBe(0);
    });

    it('should throw ValidationError for negative view_count', () => {
      expect(() => {
        repository.addSnapshot('dQw4w9WgXcQ', { view_count: -1 });
      }).toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid video_id', () => {
      expect(() => {
        repository.addSnapshot('invalid', { view_count: 100 });
      }).toThrow(ValidationError);
    });
  });

  describe('getLatest', () => {
    it('should return latest statistics', () => {
      repository.addSnapshot('dQw4w9WgXcQ', { view_count: 100 });
      // Get latest after first snapshot
      const latest = repository.getLatest('dQw4w9WgXcQ');

      expect(latest).toBeDefined();
      expect(latest?.view_count).toBe(100);
    });

    it('should return undefined if no statistics', () => {
      const latest = repository.getLatest('nonexistent');
      expect(latest).toBeUndefined();
    });
  });

  describe('getHistory', () => {
    it('should return statistics history ordered by time', () => {
      repository.addSnapshot('dQw4w9WgXcQ', { view_count: 100 });
      repository.addSnapshot('dQw4w9WgXcQ', { view_count: 200 });
      repository.addSnapshot('dQw4w9WgXcQ', { view_count: 300 });

      const history = repository.getHistory('dQw4w9WgXcQ');

      expect(history).toHaveLength(3);
      expect(history[0].view_count).toBe(100);
      expect(history[2].view_count).toBe(300);
    });
  });
});

/**
 * Repository pattern for database operations
 * Provides clean interface for data access using better-sqlite3
 * All methods include error handling, input validation, and proper type safety
 */

import { DatabaseManager } from './connection.js';
import {
  Video,
  Playlist,
  PlaylistItem,
  Transcript,
  ExtractedEntity,
  VideoStatistic,
  Tag,
} from './models.js';
import { DatabaseError, ValidationError } from '../errors/index.js';
import {
  validateVideoId,
  validatePlaylistId,
  validateNonEmptyString,
  getErrorMessage,
} from '../utils/validation.js';
import logger from '../utils/logger.js';

export class VideoRepository {
  constructor(private db: DatabaseManager) {}

  /**
   * Create or update a video in the database
   * @param videoData - Partial video data (must include video_id)
   * @returns The created or updated video
   * @throws {ValidationError} If video_id is missing or invalid
   * @throws {DatabaseError} If database operation fails
   */
  createOrUpdate(videoData: Partial<Video>): Video {
    // Validate required field
    if (!videoData.video_id) {
      throw new ValidationError('video_id is required for createOrUpdate', {
        field: 'video_id',
      });
    }
    validateVideoId(videoData.video_id);

    try {
      const existing = this.getByVideoId(videoData.video_id);

      if (existing) {
        // Update existing video
        const updateFields: string[] = [];
        const updateValues: unknown[] = [];

        for (const [key, value] of Object.entries(videoData)) {
          if (key !== 'id' && key !== 'video_id') {
            updateFields.push(`${key} = ?`);
            // Convert booleans to 0/1 for SQLite
            if (typeof value === 'boolean') {
              updateValues.push(value ? 1 : 0);
            } else {
              updateValues.push(value);
            }
          }
        }

        if (updateFields.length === 0) {
          logger.debug({ videoId: videoData.video_id }, 'No fields to update for video');
          return existing;
        }

        updateValues.push(videoData.video_id);

        this.db.run(
          `UPDATE videos SET ${updateFields.join(', ')}, updated_at = datetime('now') 
           WHERE video_id = ?`,
          updateValues
        );

        const updated = this.getByVideoId(videoData.video_id);
        if (!updated) {
          throw new DatabaseError('Failed to retrieve updated video', {
            operation: 'createOrUpdate',
            table: 'videos',
            context: { videoId: videoData.video_id },
          });
        }

        logger.info({ videoId: videoData.video_id }, 'Video updated successfully');
        return updated;
      } else {
        // Insert new video
        const fields = Object.keys(videoData).filter((k) => k !== 'id');
        const placeholders = fields.map(() => '?').join(', ');
        const values = fields.map((k) => {
          const value = videoData[k as keyof Video];
          // Convert booleans to 0/1 for SQLite
          return typeof value === 'boolean' ? (value ? 1 : 0) : value;
        });

        this.db.run(`INSERT INTO videos (${fields.join(', ')}) VALUES (${placeholders})`, values);

        const created = this.getByVideoId(videoData.video_id);
        if (!created) {
          throw new DatabaseError('Failed to retrieve created video', {
            operation: 'createOrUpdate',
            table: 'videos',
            context: { videoId: videoData.video_id },
          });
        }

        logger.info({ videoId: videoData.video_id }, 'Video created successfully');
        return created;
      }
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Failed to create or update video', {
        operation: 'createOrUpdate',
        table: 'videos',
        cause: error,
        context: { videoId: videoData.video_id },
      });
    }
  }

  /**
   * Get video by video_id
   * @param videoId - YouTube video ID (11 characters)
   * @returns Video object or undefined if not found
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getByVideoId(videoId: string): Video | undefined {
    validateVideoId(videoId);

    try {
      return this.db.get<Video>('SELECT * FROM videos WHERE video_id = ?', [videoId]);
    } catch (error) {
      throw new DatabaseError('Failed to get video by ID', {
        operation: 'getByVideoId',
        table: 'videos',
        cause: error,
        context: { videoId },
      });
    }
  }

  /**
   * Get all videos, optionally filtering for shorts
   * @param shortsOnly - If true, only return YouTube Shorts
   * @returns Array of videos
   * @throws {DatabaseError} If database operation fails
   */
  getAll(shortsOnly: boolean = false): Video[] {
    try {
      if (shortsOnly) {
        return this.db.all<Video>('SELECT * FROM videos WHERE is_short = 1');
      }
      return this.db.all<Video>('SELECT * FROM videos');
    } catch (error) {
      throw new DatabaseError('Failed to get all videos', {
        operation: 'getAll',
        table: 'videos',
        cause: error,
        context: { shortsOnly },
      });
    }
  }

  /**
   * Get videos in a playlist
   * @param playlistId - YouTube playlist ID
   * @returns Array of videos in the playlist, ordered by position
   * @throws {ValidationError} If playlist_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getByPlaylist(playlistId: string): Video[] {
    validatePlaylistId(playlistId);

    try {
      return this.db.all<Video>(
        `SELECT v.* FROM videos v
         JOIN playlist_items pi ON v.video_id = pi.video_id
         WHERE pi.playlist_id = ?
         ORDER BY pi.position, pi.added_at`,
        [playlistId]
      );
    } catch (error) {
      throw new DatabaseError('Failed to get videos by playlist', {
        operation: 'getByPlaylist',
        table: 'videos',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Get videos by channel
   * @param channelId - YouTube channel ID
   * @returns Array of videos from the channel
   * @throws {ValidationError} If channel_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getByChannel(channelId: string): Video[] {
    validateNonEmptyString(channelId, 'channelId');

    try {
      return this.db.all<Video>('SELECT * FROM videos WHERE channel_id = ?', [channelId]);
    } catch (error) {
      throw new DatabaseError('Failed to get videos by channel', {
        operation: 'getByChannel',
        table: 'videos',
        cause: error,
        context: { channelId },
      });
    }
  }

  /**
   * Search videos by title or description
   * @param queryText - Search query
   * @returns Array of matching videos
   * @throws {ValidationError} If query is empty
   * @throws {DatabaseError} If database operation fails
   */
  search(queryText: string): Video[] {
    validateNonEmptyString(queryText, 'queryText');

    try {
      const pattern = `%${queryText}%`;
      return this.db.all<Video>('SELECT * FROM videos WHERE title LIKE ? OR description LIKE ?', [
        pattern,
        pattern,
      ]);
    } catch (error) {
      throw new DatabaseError('Failed to search videos', {
        operation: 'search',
        table: 'videos',
        cause: error,
        context: { queryText },
      });
    }
  }

  /**
   * Check if video exists in database
   * @param videoId - YouTube video ID
   * @returns True if video exists, false otherwise
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  exists(videoId: string): boolean {
    validateVideoId(videoId);

    try {
      const result = this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM videos WHERE video_id = ?',
        [videoId]
      );
      return (result?.count || 0) > 0;
    } catch (error) {
      throw new DatabaseError('Failed to check if video exists', {
        operation: 'exists',
        table: 'videos',
        cause: error,
        context: { videoId },
      });
    }
  }
}

export class PlaylistRepository {
  constructor(private db: DatabaseManager) {}

  /**
   * Create or update a playlist in the database
   * @param playlistData - Partial playlist data (must include playlist_id)
   * @returns The created or updated playlist
   * @throws {ValidationError} If playlist_id is missing or invalid
   * @throws {DatabaseError} If database operation fails
   */
  createOrUpdate(playlistData: Partial<Playlist>): Playlist {
    if (!playlistData.playlist_id) {
      throw new ValidationError('playlist_id is required for createOrUpdate', {
        field: 'playlist_id',
      });
    }
    validatePlaylistId(playlistData.playlist_id);

    try {
      const existing = this.getById(playlistData.playlist_id);

      if (existing) {
        // Update existing playlist
        const updateFields: string[] = [];
        const updateValues: unknown[] = [];

        for (const [key, value] of Object.entries(playlistData)) {
          if (key !== 'id' && key !== 'playlist_id') {
            updateFields.push(`${key} = ?`);
            // Convert booleans to 0/1 for SQLite
            if (typeof value === 'boolean') {
              updateValues.push(value ? 1 : 0);
            } else {
              updateValues.push(value);
            }
          }
        }

        if (updateFields.length === 0) {
          logger.debug(
            {
              playlistId: playlistData.playlist_id,
            },
            'No fields to update for playlist'
          );
          return existing;
        }

        updateValues.push(playlistData.playlist_id);

        this.db.run(
          `UPDATE playlists SET ${updateFields.join(', ')}, updated_at = datetime('now') 
           WHERE playlist_id = ?`,
          updateValues
        );

        const updated = this.getById(playlistData.playlist_id);
        if (!updated) {
          throw new DatabaseError('Failed to retrieve updated playlist', {
            operation: 'createOrUpdate',
            table: 'playlists',
            context: { playlistId: playlistData.playlist_id },
          });
        }

        logger.info({ playlistId: playlistData.playlist_id }, 'Playlist updated successfully');
        return updated;
      } else {
        // Insert new playlist
        const fields = Object.keys(playlistData).filter((k) => k !== 'id');
        const placeholders = fields.map(() => '?').join(', ');
        const values = fields.map((k) => {
          const value = playlistData[k as keyof Playlist];
          // Convert booleans to 0/1 for SQLite
          return typeof value === 'boolean' ? (value ? 1 : 0) : value;
        });

        this.db.run(
          `INSERT INTO playlists (${fields.join(', ')}) VALUES (${placeholders})`,
          values
        );

        const created = this.getById(playlistData.playlist_id);
        if (!created) {
          throw new DatabaseError('Failed to retrieve created playlist', {
            operation: 'createOrUpdate',
            table: 'playlists',
            context: { playlistId: playlistData.playlist_id },
          });
        }

        logger.info({ playlistId: playlistData.playlist_id }, 'Playlist created successfully');
        return created;
      }
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Failed to create or update playlist', {
        operation: 'createOrUpdate',
        table: 'playlists',
        cause: error,
        context: { playlistId: playlistData.playlist_id },
      });
    }
  }

  /**
   * Get playlist by ID
   * @param playlistId - YouTube playlist ID
   * @returns Playlist object or undefined if not found
   * @throws {ValidationError} If playlist_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getById(playlistId: string): Playlist | undefined {
    validatePlaylistId(playlistId);

    try {
      return this.db.get<Playlist>('SELECT * FROM playlists WHERE playlist_id = ?', [playlistId]);
    } catch (error) {
      throw new DatabaseError('Failed to get playlist by ID', {
        operation: 'getById',
        table: 'playlists',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Get all playlists
   * @param enabledOnly - If true, only return enabled playlists
   * @returns Array of playlists
   * @throws {DatabaseError} If database operation fails
   */
  getAll(enabledOnly: boolean = true): Playlist[] {
    try {
      if (enabledOnly) {
        return this.db.all<Playlist>('SELECT * FROM playlists WHERE enabled = 1');
      }
      return this.db.all<Playlist>('SELECT * FROM playlists');
    } catch (error) {
      throw new DatabaseError('Failed to get all playlists', {
        operation: 'getAll',
        table: 'playlists',
        cause: error,
        context: { enabledOnly },
      });
    }
  }

  /**
   * Delete a playlist from the database
   * @param playlistId - YouTube playlist ID
   * @throws {ValidationError} If playlist_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  delete(playlistId: string): void {
    validatePlaylistId(playlistId);

    try {
      this.db.run('DELETE FROM playlists WHERE playlist_id = ?', [playlistId]);
      logger.info({ playlistId }, 'Playlist deleted successfully');
    } catch (error) {
      throw new DatabaseError('Failed to delete playlist', {
        operation: 'delete',
        table: 'playlists',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Check if playlist exists in database
   * @param playlistId - YouTube playlist ID
   * @returns True if playlist exists, false otherwise
   * @throws {ValidationError} If playlist_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  exists(playlistId: string): boolean {
    validatePlaylistId(playlistId);

    try {
      const result = this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM playlists WHERE playlist_id = ?',
        [playlistId]
      );
      return (result?.count || 0) > 0;
    } catch (error) {
      throw new DatabaseError('Failed to check if playlist exists', {
        operation: 'exists',
        table: 'playlists',
        cause: error,
        context: { playlistId },
      });
    }
  }
}

export class PlaylistItemRepository {
  constructor(private db: DatabaseManager) {}

  /**
   * Add video to playlist
   * @param playlistId - YouTube playlist ID
   * @param videoId - YouTube video ID
   * @param position - Optional position in playlist
   * @param addedAt - Optional timestamp (ISO string)
   * @returns The playlist item (existing or newly created)
   * @throws {ValidationError} If IDs are invalid
   * @throws {DatabaseError} If database operation fails
   */
  addVideoToPlaylist(
    playlistId: string,
    videoId: string,
    position?: number,
    addedAt?: string
  ): PlaylistItem {
    validatePlaylistId(playlistId);
    validateVideoId(videoId);

    if (position !== undefined && (typeof position !== 'number' || position < 0)) {
      throw new ValidationError('position must be a non-negative number', {
        field: 'position',
        value: position,
      });
    }

    try {
      const added = addedAt || new Date().toISOString();

      // Check if already exists
      const existing = this.db.get<PlaylistItem>(
        'SELECT * FROM playlist_items WHERE playlist_id = ? AND video_id = ?',
        [playlistId, videoId]
      );

      if (existing) {
        logger.debug({ playlistId, videoId }, 'Video already in playlist');
        return existing;
      }

      this.db.run(
        'INSERT INTO playlist_items (playlist_id, video_id, position, added_at) VALUES (?, ?, ?, ?)',
        [playlistId, videoId, position ?? null, added]
      );

      const created = this.db.get<PlaylistItem>(
        'SELECT * FROM playlist_items WHERE playlist_id = ? AND video_id = ?',
        [playlistId, videoId]
      );

      if (!created) {
        throw new DatabaseError('Failed to retrieve created playlist item', {
          operation: 'addVideoToPlaylist',
          table: 'playlist_items',
          context: { playlistId, videoId },
        });
      }

      logger.info({ playlistId, videoId, position }, 'Video added to playlist');
      return created;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Failed to add video to playlist', {
        operation: 'addVideoToPlaylist',
        table: 'playlist_items',
        cause: error,
        context: { playlistId, videoId },
      });
    }
  }

  /**
   * Get all items in a playlist
   * @param playlistId - YouTube playlist ID
   * @returns Array of playlist items, ordered by position
   * @throws {ValidationError} If playlist_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getByPlaylist(playlistId: string): PlaylistItem[] {
    validatePlaylistId(playlistId);

    try {
      return this.db.all<PlaylistItem>(
        'SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position, added_at',
        [playlistId]
      );
    } catch (error) {
      throw new DatabaseError('Failed to get playlist items', {
        operation: 'getByPlaylist',
        table: 'playlist_items',
        cause: error,
        context: { playlistId },
      });
    }
  }

  /**
   * Get all playlists containing a video
   * @param videoId - YouTube video ID
   * @returns Array of playlist items
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getByVideo(videoId: string): PlaylistItem[] {
    validateVideoId(videoId);

    try {
      return this.db.all<PlaylistItem>('SELECT * FROM playlist_items WHERE video_id = ?', [
        videoId,
      ]);
    } catch (error) {
      throw new DatabaseError('Failed to get playlists by video', {
        operation: 'getByVideo',
        table: 'playlist_items',
        cause: error,
        context: { videoId },
      });
    }
  }
}

export class TranscriptRepository {
  constructor(private db: DatabaseManager) {}

  /**
   * Create or replace transcript for a video
   * @param videoId - YouTube video ID
   * @param transcriptData - Transcript data
   * @returns The created transcript
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  create(videoId: string, transcriptData: Partial<Transcript>): Transcript {
    validateVideoId(videoId);

    try {
      // Delete existing transcript
      this.db.run('DELETE FROM transcripts WHERE video_id = ?', [videoId]);

      // Insert new transcript
      this.db.run(
        `INSERT INTO transcripts (video_id, language, full_text, segments_json, is_auto_generated, extracted_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [
          videoId,
          transcriptData.language || 'en',
          transcriptData.full_text || '',
          transcriptData.segments_json || '[]',
          transcriptData.is_auto_generated ? 1 : 0,
        ]
      );

      const created = this.getByVideoId(videoId);
      if (!created) {
        throw new DatabaseError('Failed to retrieve created transcript', {
          operation: 'create',
          table: 'transcripts',
          context: { videoId },
        });
      }

      logger.info({ videoId }, 'Transcript created successfully');
      return created;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Failed to create transcript', {
        operation: 'create',
        table: 'transcripts',
        cause: error,
        context: { videoId },
      });
    }
  }

  /**
   * Get transcript for a video
   * @param videoId - YouTube video ID
   * @returns Transcript object or undefined if not found
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getByVideoId(videoId: string): Transcript | undefined {
    validateVideoId(videoId);

    try {
      return this.db.get<Transcript>('SELECT * FROM transcripts WHERE video_id = ?', [videoId]);
    } catch (error) {
      throw new DatabaseError('Failed to get transcript', {
        operation: 'getByVideoId',
        table: 'transcripts',
        cause: error,
        context: { videoId },
      });
    }
  }

  /**
   * Check if transcript exists for a video
   * @param videoId - YouTube video ID
   * @returns True if transcript exists, false otherwise
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  exists(videoId: string): boolean {
    validateVideoId(videoId);

    try {
      const result = this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM transcripts WHERE video_id = ?',
        [videoId]
      );
      return (result?.count || 0) > 0;
    } catch (error) {
      throw new DatabaseError('Failed to check if transcript exists', {
        operation: 'exists',
        table: 'transcripts',
        cause: error,
        context: { videoId },
      });
    }
  }
}

/**
 * Entity data for insertion
 */
interface EntityInput {
  type: string;
  value: string;
  url?: string;
  confidence?: number;
}

export class EntityRepository {
  constructor(private db: DatabaseManager) {}

  /**
   * Add entities for a video
   * @param videoId - YouTube video ID
   * @param entities - Array of entities to add
   * @throws {ValidationError} If video_id is invalid or entities array is invalid
   * @throws {DatabaseError} If database operation fails
   */
  addEntities(videoId: string, entities: EntityInput[]): void {
    validateVideoId(videoId);

    if (!Array.isArray(entities) || entities.length === 0) {
      throw new ValidationError('entities must be a non-empty array', {
        field: 'entities',
        value: entities,
      });
    }

    try {
      for (const entity of entities) {
        if (!entity.type || !entity.value) {
          throw new ValidationError('Each entity must have type and value', {
            field: 'entity',
            value: entity,
          });
        }

        this.db.run(
          `INSERT INTO extracted_entities (video_id, entity_type, entity_value, entity_url, confidence, extracted_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
          [videoId, entity.type, entity.value, entity.url ?? null, entity.confidence ?? 100]
        );
      }

      logger.info({ videoId, count: entities.length }, 'Entities added successfully');
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Failed to add entities', {
        operation: 'addEntities',
        table: 'extracted_entities',
        cause: error,
        context: { videoId, entityCount: entities.length },
      });
    }
  }

  /**
   * Delete all entities for a video
   * @param videoId - YouTube video ID
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  deleteByVideo(videoId: string): void {
    validateVideoId(videoId);

    try {
      this.db.run('DELETE FROM extracted_entities WHERE video_id = ?', [videoId]);
      logger.info({ videoId }, 'Entities deleted successfully');
    } catch (error) {
      throw new DatabaseError('Failed to delete entities', {
        operation: 'deleteByVideo',
        table: 'extracted_entities',
        cause: error,
        context: { videoId },
      });
    }
  }

  /**
   * Get entities for a video
   * @param videoId - YouTube video ID
   * @param entityType - Optional filter by entity type
   * @returns Array of extracted entities
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getByVideo(videoId: string, entityType?: string): ExtractedEntity[] {
    validateVideoId(videoId);

    if (entityType !== undefined) {
      validateNonEmptyString(entityType, 'entityType');
    }

    try {
      if (entityType) {
        return this.db.all<ExtractedEntity>(
          'SELECT * FROM extracted_entities WHERE video_id = ? AND entity_type = ?',
          [videoId, entityType]
        );
      }
      return this.db.all<ExtractedEntity>('SELECT * FROM extracted_entities WHERE video_id = ?', [
        videoId,
      ]);
    } catch (error) {
      throw new DatabaseError('Failed to get entities by video', {
        operation: 'getByVideo',
        table: 'extracted_entities',
        cause: error,
        context: { videoId, entityType },
      });
    }
  }

  /**
   * Get all entities of a specific type
   * @param entityType - Entity type to filter by
   * @returns Array of extracted entities
   * @throws {ValidationError} If entity_type is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getByType(entityType: string): ExtractedEntity[] {
    validateNonEmptyString(entityType, 'entityType');

    try {
      return this.db.all<ExtractedEntity>(
        'SELECT * FROM extracted_entities WHERE entity_type = ?',
        [entityType]
      );
    } catch (error) {
      throw new DatabaseError('Failed to get entities by type', {
        operation: 'getByType',
        table: 'extracted_entities',
        cause: error,
        context: { entityType },
      });
    }
  }
}

/**
 * Statistics snapshot data
 */
interface StatisticsInput {
  view_count?: number;
  like_count?: number;
  comment_count?: number;
}

export class StatisticsRepository {
  constructor(private db: DatabaseManager) {}

  /**
   * Add statistics snapshot for a video
   * @param videoId - YouTube video ID
   * @param stats - Statistics data
   * @returns The created statistics record
   * @throws {ValidationError} If video_id is invalid or stats are invalid
   * @throws {DatabaseError} If database operation fails
   */
  addSnapshot(videoId: string, stats: StatisticsInput): VideoStatistic {
    validateVideoId(videoId);

    // Validate counts are non-negative numbers
    if (
      stats.view_count !== undefined &&
      (typeof stats.view_count !== 'number' || stats.view_count < 0)
    ) {
      throw new ValidationError('view_count must be a non-negative number', {
        field: 'view_count',
        value: stats.view_count,
      });
    }
    if (
      stats.like_count !== undefined &&
      (typeof stats.like_count !== 'number' || stats.like_count < 0)
    ) {
      throw new ValidationError('like_count must be a non-negative number', {
        field: 'like_count',
        value: stats.like_count,
      });
    }
    if (
      stats.comment_count !== undefined &&
      (typeof stats.comment_count !== 'number' || stats.comment_count < 0)
    ) {
      throw new ValidationError('comment_count must be a non-negative number', {
        field: 'comment_count',
        value: stats.comment_count,
      });
    }

    try {
      this.db.run(
        `INSERT INTO video_statistics (video_id, view_count, like_count, comment_count, recorded_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        [videoId, stats.view_count ?? 0, stats.like_count ?? 0, stats.comment_count ?? 0]
      );

      const created = this.getLatest(videoId);
      if (!created) {
        throw new DatabaseError('Failed to retrieve created statistics', {
          operation: 'addSnapshot',
          table: 'video_statistics',
          context: { videoId },
        });
      }

      logger.info({ videoId, ...stats }, 'Statistics snapshot added');
      return created;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError('Failed to add statistics snapshot', {
        operation: 'addSnapshot',
        table: 'video_statistics',
        cause: error,
        context: { videoId },
      });
    }
  }

  /**
   * Get latest statistics for a video
   * @param videoId - YouTube video ID
   * @returns Latest statistics record or undefined if not found
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getLatest(videoId: string): VideoStatistic | undefined {
    validateVideoId(videoId);

    try {
      return this.db.get<VideoStatistic>(
        'SELECT * FROM video_statistics WHERE video_id = ? ORDER BY recorded_at DESC LIMIT 1',
        [videoId]
      );
    } catch (error) {
      throw new DatabaseError('Failed to get latest statistics', {
        operation: 'getLatest',
        table: 'video_statistics',
        cause: error,
        context: { videoId },
      });
    }
  }

  /**
   * Get statistics history for a video
   * @param videoId - YouTube video ID
   * @returns Array of statistics records ordered by time
   * @throws {ValidationError} If video_id is invalid
   * @throws {DatabaseError} If database operation fails
   */
  getHistory(videoId: string): VideoStatistic[] {
    validateVideoId(videoId);

    try {
      return this.db.all<VideoStatistic>(
        'SELECT * FROM video_statistics WHERE video_id = ? ORDER BY recorded_at',
        [videoId]
      );
    } catch (error) {
      throw new DatabaseError('Failed to get statistics history', {
        operation: 'getHistory',
        table: 'video_statistics',
        cause: error,
        context: { videoId },
      });
    }
  }
}

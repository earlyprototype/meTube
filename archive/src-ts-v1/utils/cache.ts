/**
 * Cache utilities for storing and retrieving playlist and video data
 * Used for numbered references in commands
 */

import * as fs from 'fs';
import * as path from 'path';
import logger from './logger.js';

/**
 * Cached video information
 */
export interface CachedVideo {
  num: number;
  video_id: string;
  title: string;
  duration?: string;
  has_transcript?: boolean;
}

/**
 * Cache structure for videos grouped by playlist
 */
export interface VideoCache {
  [playlistId: string]: CachedVideo[];
}

/**
 * Cached playlist information
 */
export interface CachedPlaylist {
  num: number;
  id: string;
  title: string;
  video_count?: number;
}

const CACHE_DIR = 'data';
const VIDEO_CACHE_FILE = path.join(CACHE_DIR, 'video_cache.json');
const PLAYLIST_CACHE_FILE = path.join(CACHE_DIR, 'playlist_cache.json');

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Save videos for a playlist to cache
 *
 * @param playlistId - Playlist ID
 * @param videos - Array of videos with metadata
 */
export function saveVideoCache(playlistId: string, videos: CachedVideo[]): void {
  try {
    ensureCacheDir();

    let cache: VideoCache = {};

    // Load existing cache
    if (fs.existsSync(VIDEO_CACHE_FILE)) {
      const data = fs.readFileSync(VIDEO_CACHE_FILE, 'utf-8');
      cache = JSON.parse(data);
    }

    // Update cache for this playlist
    cache[playlistId] = videos;

    // Write back to file
    fs.writeFileSync(VIDEO_CACHE_FILE, JSON.stringify(cache, null, 2));

    logger.info({ playlistId, count: videos.length }, 'Video cache saved');
  } catch (error) {
    logger.error({ error, playlistId }, 'Failed to save video cache');
    throw error;
  }
}

/**
 * Load cached videos for a playlist
 *
 * @param playlistId - Playlist ID
 * @returns Array of cached videos or null if not found
 */
export function loadVideoCache(playlistId: string): CachedVideo[] | null {
  try {
    if (!fs.existsSync(VIDEO_CACHE_FILE)) {
      return null;
    }

    const data = fs.readFileSync(VIDEO_CACHE_FILE, 'utf-8');
    const cache: VideoCache = JSON.parse(data);

    return cache[playlistId] || null;
  } catch (error) {
    logger.error({ error, playlistId }, 'Failed to load video cache');
    return null;
  }
}

/**
 * Get video by position number from cache
 *
 * @param playlistId - Playlist ID
 * @param videoNum - Video position number (1-indexed)
 * @returns Cached video or null if not found
 */
export function getVideoByNumber(playlistId: string, videoNum: number): CachedVideo | null {
  const videos = loadVideoCache(playlistId);
  if (!videos) {
    return null;
  }

  return videos.find((v) => v.num === videoNum) || null;
}

/**
 * Save playlists to cache with numbered references
 *
 * @param playlists - Array of playlists
 */
export function savePlaylistCache(playlists: CachedPlaylist[]): void {
  try {
    ensureCacheDir();
    fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(playlists, null, 2));
    logger.info({ count: playlists.length }, 'Playlist cache saved');
  } catch (error) {
    logger.error({ error }, 'Failed to save playlist cache');
    throw error;
  }
}

/**
 * Load cached playlists
 *
 * @returns Array of cached playlists or empty array if not found
 */
export function loadPlaylistCache(): CachedPlaylist[] {
  try {
    if (!fs.existsSync(PLAYLIST_CACHE_FILE)) {
      return [];
    }

    const data = fs.readFileSync(PLAYLIST_CACHE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    logger.error({ error }, 'Failed to load playlist cache');
    return [];
  }
}

/**
 * Get playlist by number from cache
 *
 * @param playlistNum - Playlist position number (1-indexed)
 * @returns Cached playlist or null if not found
 */
export function getPlaylistByNumber(playlistNum: number): CachedPlaylist | null {
  const playlists = loadPlaylistCache();
  return playlists.find((p) => p.num === playlistNum) || null;
}

/**
 * Search playlists by partial title match
 *
 * @param query - Search query
 * @returns Array of matching playlists
 */
export function searchPlaylistsByTitle(query: string): CachedPlaylist[] {
  const playlists = loadPlaylistCache();
  const lowerQuery = query.toLowerCase();
  return playlists.filter((p) => p.title.toLowerCase().includes(lowerQuery));
}

/**
 * Clear all caches
 */
export function clearAllCaches(): void {
  try {
    if (fs.existsSync(VIDEO_CACHE_FILE)) {
      fs.unlinkSync(VIDEO_CACHE_FILE);
    }
    if (fs.existsSync(PLAYLIST_CACHE_FILE)) {
      fs.unlinkSync(PLAYLIST_CACHE_FILE);
    }
    logger.info('All caches cleared');
  } catch (error) {
    logger.error({ error }, 'Failed to clear caches');
    throw error;
  }
}

/**
 * Cache utilities for storing and retrieving playlist and video data.
 *
 * Lifted from `src-ts/utils/cache.ts` (v1) per PORT_PLAN Wave 3. The only
 * functional change vs. v1 is Wave 1's invariant landing here at last: every
 * load goes through a Zod parse. A cache file whose shape has drifted (manual
 * edit, partial write, schema upgrade in flight) is treated as a cache miss —
 * never thrown, never silently coerced. The cache is a convenience surface,
 * not a source of truth: when it is wrong, we refetch.
 *
 * The previous v1 behaviour (`JSON.parse(...) as VideoCache`) was the exact
 * pattern P5 in PORT_PLAN's Python-issue map flagged as MED severity. That
 * issue is foreclosed here by parsing through `VideoCacheSchema` /
 * `PlaylistCacheSchema` at the I/O boundary.
 */

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import logger from './logger.js';

// --------------------------------------------------------------------------
// Schemas — shape-discipline at the cache boundary
// --------------------------------------------------------------------------

/**
 * Single cached video entry. Mirrors the v1 `CachedVideo` interface but as a
 * Zod schema so the loader can verify shape on read.
 */
export const CachedVideoSchema = z.object({
  num: z.number().int(),
  video_id: z.string(),
  title: z.string(),
  duration: z.string().optional(),
  has_transcript: z.boolean().optional(),
});

/**
 * Whole video cache: a map of playlist ID to an array of cached video entries.
 * Used by numbered references in the Ink layer's playlist commands.
 */
export const VideoCacheSchema = z.record(z.string(), z.array(CachedVideoSchema));

/**
 * Single cached playlist entry. Same shape as v1 `CachedPlaylist`.
 */
export const CachedPlaylistSchema = z.object({
  num: z.number().int(),
  id: z.string(),
  title: z.string(),
  video_count: z.number().int().optional(),
});

/**
 * Whole playlist cache: an ordered array of cached playlist entries.
 */
export const PlaylistCacheSchema = z.array(CachedPlaylistSchema);

// --------------------------------------------------------------------------
// Inferred types (kept under their v1 names so callers don't have to rename)
// --------------------------------------------------------------------------

export type CachedVideo = z.infer<typeof CachedVideoSchema>;
export type VideoCache = z.infer<typeof VideoCacheSchema>;
export type CachedPlaylist = z.infer<typeof CachedPlaylistSchema>;

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

const CACHE_DIR = 'data';
const VIDEO_CACHE_FILE = path.join(CACHE_DIR, 'video_cache.json');
const PLAYLIST_CACHE_FILE = path.join(CACHE_DIR, 'playlist_cache.json');

/**
 * Ensure cache directory exists. Creates it (recursive) if it does not.
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Read a JSON file and parse it through the given Zod schema. Returns the
 * parsed value on success, `null` on any failure (file missing, unreadable,
 * malformed JSON, shape mismatch). Failures are logged at `debug` level —
 * the caller treats them as cache misses and refetches.
 *
 * This is the wedge that makes "P5 — bare except: swallows JSONDecodeError
 * and PermissionError identically" impossible to reproduce. Every failure
 * mode is distinguished in logs but normalised to a single sentinel
 * (`null`) at the API surface.
 */
function readAndParse<T>(filePath: string, schema: z.ZodType<T>): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    logger.debug(
      { filePath, err: error instanceof Error ? error.message : String(error) },
      'Cache read failed; treating as cache miss'
    );
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    logger.debug(
      { filePath, err: error instanceof Error ? error.message : String(error) },
      'Cache JSON parse failed; treating as cache miss'
    );
    return null;
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    logger.debug(
      { filePath, issues: result.error.issues },
      'Cache shape parse failed; treating as cache miss'
    );
    return null;
  }

  return result.data;
}

// --------------------------------------------------------------------------
// Video cache
// --------------------------------------------------------------------------

/**
 * Save videos for a playlist to cache.
 *
 * Reads existing cache shape-safely, merges the new playlist entry, and
 * writes back atomically (in the same sense as v1 — single
 * `writeFileSync`).
 *
 * @param playlistId - Playlist ID to scope the videos under.
 * @param videos - Array of cached video entries.
 */
export function saveVideoCache(playlistId: string, videos: CachedVideo[]): void {
  try {
    ensureCacheDir();

    // Use shape-safe load: if the existing cache is malformed, start fresh
    // rather than throwing. The new playlist entry will overwrite any prior.
    const existing = readAndParse(VIDEO_CACHE_FILE, VideoCacheSchema) ?? {};
    const updated: VideoCache = { ...existing, [playlistId]: videos };

    fs.writeFileSync(VIDEO_CACHE_FILE, JSON.stringify(updated, null, 2));

    logger.info({ playlistId, count: videos.length }, 'Video cache saved');
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error), playlistId },
      'Failed to save video cache'
    );
    throw error;
  }
}

/**
 * Load cached videos for a playlist.
 *
 * @param playlistId - Playlist ID.
 * @returns Array of cached videos, or `null` if not found (file missing,
 *          shape-broken, or no entry for this playlist).
 */
export function loadVideoCache(playlistId: string): CachedVideo[] | null {
  const cache = readAndParse(VIDEO_CACHE_FILE, VideoCacheSchema);
  if (cache === null) {
    return null;
  }
  return cache[playlistId] ?? null;
}

/**
 * Get a single cached video by its position number inside a playlist.
 *
 * @param playlistId - Playlist ID.
 * @param videoNum - 1-indexed video position number.
 * @returns Cached video, or `null` if not found.
 */
export function getVideoByNumber(
  playlistId: string,
  videoNum: number
): CachedVideo | null {
  const videos = loadVideoCache(playlistId);
  if (!videos) {
    return null;
  }
  return videos.find((v) => v.num === videoNum) ?? null;
}

// --------------------------------------------------------------------------
// Playlist cache
// --------------------------------------------------------------------------

/**
 * Save playlists to cache (replaces the whole file).
 *
 * @param playlists - Array of cached playlist entries.
 */
export function savePlaylistCache(playlists: CachedPlaylist[]): void {
  try {
    ensureCacheDir();
    fs.writeFileSync(PLAYLIST_CACHE_FILE, JSON.stringify(playlists, null, 2));
    logger.info({ count: playlists.length }, 'Playlist cache saved');
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Failed to save playlist cache'
    );
    throw error;
  }
}

/**
 * Load cached playlists.
 *
 * @returns Array of cached playlists, or an empty array on cache miss
 *          (file missing or shape-broken).
 */
export function loadPlaylistCache(): CachedPlaylist[] {
  return readAndParse(PLAYLIST_CACHE_FILE, PlaylistCacheSchema) ?? [];
}

/**
 * Get a playlist by its position number from the cache.
 *
 * @param playlistNum - 1-indexed playlist position number.
 * @returns Cached playlist, or `null` if not found.
 */
export function getPlaylistByNumber(playlistNum: number): CachedPlaylist | null {
  const playlists = loadPlaylistCache();
  return playlists.find((p) => p.num === playlistNum) ?? null;
}

/**
 * Search cached playlists by partial title match (case-insensitive).
 *
 * @param query - Search query.
 * @returns Array of matching playlists (possibly empty).
 */
export function searchPlaylistsByTitle(query: string): CachedPlaylist[] {
  const playlists = loadPlaylistCache();
  const lowerQuery = query.toLowerCase();
  return playlists.filter((p) => p.title.toLowerCase().includes(lowerQuery));
}

/**
 * Clear all cache files. No-op if a file does not exist.
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
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Failed to clear caches'
    );
    throw error;
  }
}

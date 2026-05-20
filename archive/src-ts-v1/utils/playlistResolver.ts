/**
 * Smart playlist resolution utility
 * Resolves playlist identifiers from various input formats:
 * - Numbers (from cache)
 * - Partial title matches
 * - YouTube URLs
 * - Direct playlist IDs
 */

import { DatabaseManager } from '../database/connection.js';
import { PlaylistRepository } from '../database/repositories.js';
import {
  loadPlaylistCache,
  getPlaylistByNumber,
  searchPlaylistsByTitle,
  type CachedPlaylist,
} from './cache.js';

/**
 * Resolution result
 */
export interface PlaylistResolution {
  id: string;
  title?: string;
  source: 'number' | 'title' | 'url' | 'direct' | 'database';
}

/**
 * Resolve playlist identifier from various input formats
 *
 * @param input - User input (number, title, URL, or ID)
 * @param useDatabase - Whether to fallback to database lookup (default: true)
 * @returns Resolved playlist ID and metadata, or null if not found
 */
export async function resolvePlaylistIdentifier(
  input: string,
  useDatabase: boolean = true
): Promise<PlaylistResolution | null> {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();

  // Try as number (cache lookup)
  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed);
    const cached = getPlaylistByNumber(num);
    if (cached) {
      return {
        id: cached.id,
        title: cached.title,
        source: 'number',
      };
    }
  }

  // Try as YouTube URL
  const urlMatch = trimmed.match(/[?&]list=([^&]+)/);
  if (urlMatch) {
    const playlistId = urlMatch[1];
    // Try to get title from cache or database
    const title = await getPlaylistTitle(playlistId, useDatabase);
    return {
      id: playlistId,
      title,
      source: 'url',
    };
  }

  // Try as partial title match (if not purely alphanumeric playlist ID format)
  if (!isValidPlaylistIdFormat(trimmed)) {
    const matches = searchPlaylistsByTitle(trimmed);
    if (matches.length === 1) {
      return {
        id: matches[0].id,
        title: matches[0].title,
        source: 'title',
      };
    } else if (matches.length > 1) {
      throw new MultipleMatchesError(trimmed, matches);
    }
  }

  // Try as direct playlist ID
  if (isValidPlaylistIdFormat(trimmed)) {
    const title = await getPlaylistTitle(trimmed, useDatabase);
    return {
      id: trimmed,
      title,
      source: 'direct',
    };
  }

  // Fallback: search database if enabled
  if (useDatabase) {
    const dbResult = await searchDatabase(trimmed);
    if (dbResult) {
      return dbResult;
    }
  }

  return null;
}

/**
 * Check if input matches YouTube playlist ID format
 * Playlist IDs typically start with PL, UU, FL, LL, RD and are 24-34 characters
 */
function isValidPlaylistIdFormat(input: string): boolean {
  return /^(PL|UU|FL|LL|RD|OL)[a-zA-Z0-9_-]{16,32}$/.test(input);
}

/**
 * Get playlist title from cache or database
 */
async function getPlaylistTitle(
  playlistId: string,
  useDatabase: boolean
): Promise<string | undefined> {
  // Try cache first
  const cache = loadPlaylistCache();
  const cached = cache.find((p) => p.id === playlistId);
  if (cached) {
    return cached.title;
  }

  // Try database
  if (useDatabase) {
    try {
      const db = new DatabaseManager('data/metube.db');
      const repo = new PlaylistRepository(db);
      const playlist = repo.getById(playlistId);
      db.close();
      return playlist?.title;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Search database for playlist by partial match
 */
async function searchDatabase(query: string): Promise<PlaylistResolution | null> {
  try {
    const db = new DatabaseManager('data/metube.db');
    const repo = new PlaylistRepository(db);
    const allPlaylists = repo.getAll();
    db.close();

    const lowerQuery = query.toLowerCase();
    const matches = allPlaylists.filter(
      (p) => p.title.toLowerCase().includes(lowerQuery) || p.playlist_id === query
    );

    if (matches.length === 1) {
      return {
        id: matches[0].playlist_id,
        title: matches[0].title,
        source: 'database',
      };
    } else if (matches.length > 1) {
      const cachedMatches: CachedPlaylist[] = matches.map((p, i) => ({
        num: i + 1,
        id: p.playlist_id,
        title: p.title,
        video_count: p.video_count,
      }));
      throw new MultipleMatchesError(query, cachedMatches);
    }

    return null;
  } catch (err) {
    if (err instanceof MultipleMatchesError) {
      throw err;
    }
    return null;
  }
}

/**
 * Error thrown when multiple playlists match the input
 */
export class MultipleMatchesError extends Error {
  public readonly matches: CachedPlaylist[];

  constructor(query: string, matches: CachedPlaylist[]) {
    const matchList = matches
      .slice(0, 5)
      .map((m) => `  ${m.num}. ${m.title} (${m.id})`)
      .join('\n');

    const message = `Multiple playlists match "${query}":\n${matchList}${
      matches.length > 5 ? `\n  ... and ${matches.length - 5} more` : ''
    }\n\nBe more specific or use the playlist number.`;

    super(message);
    this.name = 'MultipleMatchesError';
    this.matches = matches;
  }
}

/**
 * Batch resolve multiple playlist identifiers
 *
 * @param inputs - Array of playlist identifiers
 * @param useDatabase - Whether to use database lookup
 * @returns Array of resolved playlists (null for unresolved)
 */
export async function resolveMultiplePlaylists(
  inputs: string[],
  useDatabase: boolean = true
): Promise<(PlaylistResolution | null)[]> {
  return Promise.all(inputs.map((input) => resolvePlaylistIdentifier(input, useDatabase)));
}

/**
 * Resolve and validate playlist identifier
 * Throws error if not found instead of returning null
 *
 * @param input - User input
 * @param useDatabase - Whether to use database lookup
 * @returns Resolved playlist (guaranteed non-null)
 * @throws Error if playlist cannot be resolved
 */
export async function resolvePlaylistOrThrow(
  input: string,
  useDatabase: boolean = true
): Promise<PlaylistResolution> {
  const result = await resolvePlaylistIdentifier(input, useDatabase);

  if (!result) {
    throw new Error(
      `Playlist not found: "${input}"\n\n` +
        `Suggestions:\n` +
        `  - Run 'metube playlist list' to see tracked playlists\n` +
        `  - Run 'metube playlist discover' to browse your playlists\n` +
        `  - Use a valid YouTube playlist URL or ID`
    );
  }

  return result;
}

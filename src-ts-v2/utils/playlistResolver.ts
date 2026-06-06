/**
 * Smart playlist resolution utility.
 *
 * Lifted from `src-ts/utils/playlistResolver.ts` (v1) per PORT_PLAN Wave 3.
 * Adjustments:
 *
 *   - **ID-format regex narrowed to the canonical 5 prefixes.** v1 included
 *     `OL` (a Google Music carry-over that the YouTube Data API does not
 *     return for playlists). v2 trusts the same prefix set the branded
 *     `asPlaylistId` validator uses: `PL`, `UU`, `LL`, `FL`, `RD`. The
 *     resolver and the branded type now agree on what "looks like a
 *     playlist ID" means.
 *   - **DB surface ported to v2 repository methods.** v1 called
 *     `repo.getById` / `repo.getAll` and read `p.playlist_id`; v2's
 *     PlaylistRepository exposes `findById` / `findAll` and returns the
 *     camelCase domain shape with branded `playlistId`. The resolver
 *     speaks the v2 API exclusively — no cross-tree imports remain.
 *   - **DB lookups go through an injected `DatabaseManager`.** v1
 *     instantiated a fresh `DatabaseManager('data/metube.db')` and closed
 *     it inside helpers — fine for one-off calls but hostile to tests and
 *     to the Ink layer's command-boundary pattern (one manager per
 *     command). v2 takes the manager as a parameter; the caller owns its
 *     lifecycle.
 *
 * Resolution sources (in order):
 *
 *   1. **Number** — `/^\d+$/` → cache lookup by `num`.
 *   2. **YouTube URL** — `?list=…` → extract the ID and resolve title.
 *   3. **Partial title** — non-ID-shaped input → search the cache.
 *   4. **Direct ID** — `PL/UU/LL/FL/RD`-prefixed → resolve title.
 *   5. **Database fallback** — partial match over `playlists` table.
 */

import { ValidationError } from '../errors/index.js';
import { tryAsPlaylistId, type PlaylistId } from '../types/branded.js';

import {
  loadPlaylistCache,
  getPlaylistByNumber,
  searchPlaylistsByTitle,
  type CachedPlaylist,
} from './cache.js';

import type { DatabaseManager } from '../database/connection.js';
import { PlaylistRepository } from '../database/PlaylistRepository.js';

/**
 * Resolution result returned by `resolvePlaylistIdentifier`. `source` records
 * which of the five sources produced the hit — useful for telemetry, logs,
 * and "I typed a number; did it really come from the cache?" debugging.
 */
export interface PlaylistResolution {
  id: PlaylistId;
  title?: string;
  source: 'number' | 'title' | 'url' | 'direct' | 'database';
}

/**
 * Optional context passed to the resolver. `db` is required for the
 * database-fallback step; if omitted, the resolver still tries cache /
 * URL / direct-ID resolution and returns `null` rather than touching the
 * DB.
 */
export interface ResolveContext {
  /** Optional DB handle for the database-fallback step. */
  db?: DatabaseManager;
}

/**
 * Resolve a user-supplied identifier to a branded playlist ID and optional
 * title.
 *
 * @param input - Raw input from the CLI / Ink layer. Number, partial title,
 *                YouTube URL, or playlist ID.
 * @param ctx - Optional context, including an injectable DB handle.
 * @returns Resolution result, or `null` if no source could resolve.
 * @throws {MultipleMatchesError} If a partial title or DB search returns
 *                                 more than one match.
 * @throws {ValidationError} If an ID-shaped input fails the branded
 *                            validator.
 */
export async function resolvePlaylistIdentifier(
  input: string,
  ctx: ResolveContext = {}
): Promise<PlaylistResolution | null> {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // 1. Number → cache by position
  if (/^\d+$/.test(trimmed)) {
    const num = Number.parseInt(trimmed, 10);
    const cached = getPlaylistByNumber(num);
    if (cached !== null) {
      return brandedCachedHit(cached, 'number');
    }
  }

  // 2. YouTube URL → extract list= parameter
  const urlMatch = trimmed.match(/[?&]list=([^&]+)/);
  if (urlMatch) {
    const candidate = urlMatch[1];
    if (typeof candidate === 'string' && candidate.length > 0) {
      const branded = tryAsPlaylistId(candidate);
      if (branded === null) {
        // URL contained `list=` but the value is not a valid playlist ID.
        // Surface this as a validation problem rather than a silent miss.
        throw new ValidationError(
          'YouTube URL contained an invalid playlist ID',
          { field: 'list', value: candidate }
        );
      }
      const title = await getPlaylistTitle(branded, ctx.db);
      return { id: branded, title, source: 'url' };
    }
  }

  // 3. Partial title → cache search (only if not ID-shaped)
  if (!isLikelyPlaylistId(trimmed)) {
    const matches = searchPlaylistsByTitle(trimmed);
    if (matches.length === 1) {
      return brandedCachedHit(matches[0], 'title');
    }
    if (matches.length > 1) {
      throw new MultipleMatchesError(trimmed, matches);
    }
  }

  // 4. Direct ID → brand and resolve title
  if (isLikelyPlaylistId(trimmed)) {
    const branded = tryAsPlaylistId(trimmed);
    if (branded !== null) {
      const title = await getPlaylistTitle(branded, ctx.db);
      return { id: branded, title, source: 'direct' };
    }
  }

  // 5. Database fallback (only if we have a DB handle)
  if (ctx.db !== undefined) {
    const dbResult = searchDatabase(trimmed, ctx.db);
    if (dbResult !== null) {
      return dbResult;
    }
  }

  return null;
}

/**
 * Quick prefix-shape check. Matches the same 5 prefixes as `asPlaylistId` in
 * `types/branded.ts`. Length is left loose here on purpose — the canonical
 * regex inside `asPlaylistId` is what actually decides validity, this is
 * only the "does this look like a playlist ID at all?" heuristic so the
 * resolver knows whether to try title search or direct-ID branding.
 */
function isLikelyPlaylistId(input: string): boolean {
  return /^(PL|UU|LL|FL|RD)[A-Za-z0-9_-]+$/.test(input);
}

/**
 * Convert a `CachedPlaylist` into a branded `PlaylistResolution`. If the
 * cached entry's ID is malformed (drift between when it was cached and
 * the validator's current strictness), the resolution falls through to
 * the next source rather than throwing.
 */
function brandedCachedHit(
  cached: CachedPlaylist,
  source: 'number' | 'title'
): PlaylistResolution | null {
  const branded = tryAsPlaylistId(cached.id);
  if (branded === null) {
    return null;
  }
  return { id: branded, title: cached.title, source };
}

/**
 * Look up a playlist's title from cache first, then DB if a handle was
 * provided. Returns `undefined` rather than throwing on miss — the title
 * is non-essential metadata.
 */
async function getPlaylistTitle(
  playlistId: PlaylistId,
  db: DatabaseManager | undefined
): Promise<string | undefined> {
  // Cache first
  const cache = loadPlaylistCache();
  const cached = cache.find((p) => p.id === playlistId);
  if (cached !== undefined) {
    return cached.title;
  }

  // DB fallback (only if injected)
  if (db === undefined) {
    return undefined;
  }

  try {
    const repo = new PlaylistRepository(db);
    const playlist = repo.findById(playlistId);
    return playlist?.title;
  } catch {
    // The repo throws DatabaseError on shape/connectivity failures;
    // title is non-essential, so swallow and return undefined.
    return undefined;
  }
}

/**
 * Database fallback search. Looks for either an exact playlist-ID match or
 * a case-insensitive partial title match. Returns the resolution if there
 * is exactly one match, `null` if none, and throws `MultipleMatchesError`
 * if more than one playlist matches.
 *
 * Note: synchronous because `better-sqlite3` is synchronous. The outer
 * function is async only because cache-loading kept the `async` shape in
 * v1 — we match it for callsite compatibility.
 */
function searchDatabase(
  query: string,
  db: DatabaseManager
): PlaylistResolution | null {
  let allPlaylists: ReturnType<PlaylistRepository['findAll']>;
  try {
    const repo = new PlaylistRepository(db);
    allPlaylists = repo.findAll({ enabledOnly: false });
  } catch {
    // Same convention as `getPlaylistTitle`: DB failures collapse to
    // "no resolution found", not an unhandled throw at the resolver
    // boundary. The caller can still pick this up via `null`.
    return null;
  }

  const lowerQuery = query.toLowerCase();
  const matches = allPlaylists.filter(
    (p) =>
      p.title.toLowerCase().includes(lowerQuery) || p.playlistId === query
  );

  if (matches.length === 1) {
    return {
      id: matches[0].playlistId,
      title: matches[0].title,
      source: 'database',
    };
  }

  if (matches.length > 1) {
    const cachedMatches: CachedPlaylist[] = matches.map((p, i) => ({
      num: i + 1,
      id: p.playlistId,
      title: p.title,
      video_count: p.videoCount,
    }));
    throw new MultipleMatchesError(query, cachedMatches);
  }

  return null;
}

/**
 * Error thrown when a single input matches multiple playlists. Carries the
 * matches so the Ink layer can prompt the user to disambiguate.
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
 * Batch resolve multiple identifiers. Each is resolved independently; one
 * input's `null` does not affect the others.
 *
 * @param inputs - Array of identifiers.
 * @param ctx - Shared resolve context.
 * @returns Array of resolutions (parallel to inputs; `null` per unresolved).
 */
export async function resolveMultiplePlaylists(
  inputs: string[],
  ctx: ResolveContext = {}
): Promise<(PlaylistResolution | null)[]> {
  return Promise.all(inputs.map((input) => resolvePlaylistIdentifier(input, ctx)));
}

/**
 * Strict variant of `resolvePlaylistIdentifier`. Throws if the input
 * cannot be resolved. Used by command handlers where "no match" is an
 * end-of-line condition.
 */
export async function resolvePlaylistOrThrow(
  input: string,
  ctx: ResolveContext = {}
): Promise<PlaylistResolution> {
  const result = await resolvePlaylistIdentifier(input, ctx);

  if (result === null) {
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

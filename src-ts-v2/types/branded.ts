/**
 * Nominally-branded ID types for v2.
 *
 * Pure TypeScript phantom-type pattern: at runtime, a `VideoId` is just a
 * `string`. At compile time, you cannot pass a raw `string` (or a
 * `PlaylistId`) into a function that expects a `VideoId`. The only way to
 * obtain a `VideoId` is through `asVideoId(s)`, which validates format and
 * throws `ValidationError` on bad input.
 *
 * This forecloses the v1 class of bugs where `playlistId` was confused with
 * `id` (a YouTube video ID): once branded, the two cannot be substituted
 * for one another, and the function that crossed the wires would not
 * compile.
 *
 * Mirrors the YouTube ID format constraints used by the Python codebase
 * (`legacy/python/src/api/youtube_client.py:extract_video_id` and
 * `:extract_playlist_id`).
 */

import { ValidationError } from '../errors/index.js';

declare const videoIdBrand: unique symbol;
declare const playlistIdBrand: unique symbol;

/**
 * A validated YouTube video ID. 11 characters, alphanumeric plus `_` and `-`.
 *
 * Construct only via `asVideoId(s)` — never cast a raw `string` to `VideoId`.
 */
export type VideoId = string & { readonly [videoIdBrand]: 'VideoId' };

/**
 * A validated YouTube playlist ID. Starts with `PL`, `UU`, `LL`, `FL`, or
 * `RD`, followed by alphanumeric / `_` / `-`.
 *
 * Construct only via `asPlaylistId(s)` — never cast a raw `string`.
 */
export type PlaylistId = string & { readonly [playlistIdBrand]: 'PlaylistId' };

/**
 * YouTube video IDs are 11 characters, alphanumeric plus `_` and `-`.
 * Matches the format used by `youtube.com/watch?v=<id>` and the YouTube
 * Data API v3 `videos.list` `id` field.
 */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * YouTube playlist IDs use known prefixes:
 *   PL — user-created playlists
 *   UU — channel-uploads playlists (channelId with `UC` -> `UU`)
 *   LL — Liked videos playlists
 *   FL — Favorites
 *   RD — radio / mixes
 * After the prefix, alphanumeric / `_` / `-`. Minimum total length is
 * deliberately permissive (prefix + at least one char) — the YouTube API
 * remains the authority for liveness, this regex only catches shape errors.
 */
const PLAYLIST_ID_PATTERN = /^(PL|UU|LL|FL|RD)[A-Za-z0-9_-]+$/;

/**
 * Validate a string as a YouTube video ID and brand it.
 *
 * @param raw - Candidate string. Must be 11 characters of `A-Za-z0-9_-`.
 * @returns The same string, branded as `VideoId`.
 * @throws {ValidationError} If `raw` is not a non-empty string matching the
 *                           YouTube video-ID format.
 */
export function asVideoId(raw: string): VideoId {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ValidationError('Video ID must be a non-empty string', {
      field: 'videoId',
      value: raw,
    });
  }
  if (!VIDEO_ID_PATTERN.test(raw)) {
    throw new ValidationError(
      'Invalid YouTube video ID format (expected 11 chars of [A-Za-z0-9_-])',
      {
        field: 'videoId',
        value: raw,
      }
    );
  }
  return raw as VideoId;
}

/**
 * Validate a string as a YouTube playlist ID and brand it.
 *
 * @param raw - Candidate string. Must start with `PL`, `UU`, `LL`, `FL`, or
 *              `RD` and contain only alphanumeric / `_` / `-`.
 * @returns The same string, branded as `PlaylistId`.
 * @throws {ValidationError} If `raw` is not a non-empty string matching the
 *                           YouTube playlist-ID format.
 */
export function asPlaylistId(raw: string): PlaylistId {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ValidationError('Playlist ID must be a non-empty string', {
      field: 'playlistId',
      value: raw,
    });
  }
  if (!PLAYLIST_ID_PATTERN.test(raw)) {
    throw new ValidationError(
      'Invalid YouTube playlist ID format (expected prefix PL/UU/LL/FL/RD followed by [A-Za-z0-9_-])',
      {
        field: 'playlistId',
        value: raw,
      }
    );
  }
  return raw as PlaylistId;
}

/**
 * Non-throwing variant for use inside Zod refinements and validators that
 * already manage their own error reporting. Returns `null` on bad input.
 */
export function tryAsVideoId(raw: string): VideoId | null {
  if (typeof raw !== 'string' || !VIDEO_ID_PATTERN.test(raw)) {
    return null;
  }
  return raw as VideoId;
}

/**
 * Non-throwing variant for use inside Zod refinements and validators that
 * already manage their own error reporting. Returns `null` on bad input.
 */
export function tryAsPlaylistId(raw: string): PlaylistId | null {
  if (typeof raw !== 'string' || !PLAYLIST_ID_PATTERN.test(raw)) {
    return null;
  }
  return raw as PlaylistId;
}

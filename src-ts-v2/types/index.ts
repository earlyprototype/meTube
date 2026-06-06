/**
 * Barrel for `src-ts-v2/types/`.
 *
 * Branded ID types (`VideoId`, `PlaylistId`) and their validators are the
 * compile-time foundation for v2's "wrong shapes impossible" invariant.
 * Import from here so callers stay decoupled from internal filenames.
 */
export { asVideoId, asPlaylistId, tryAsVideoId, tryAsPlaylistId } from './branded.js';
export type { VideoId, PlaylistId } from './branded.js';

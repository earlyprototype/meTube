/**
 * Tests for branded ID validators (`asVideoId` / `asPlaylistId`).
 *
 * These guard the compile-time invariant "a VideoId cannot be confused
 * with a PlaylistId or a raw string". The tests cover the runtime
 * format-validation half — the compile-time half is exercised by the
 * type system at build time and cannot be expressed as a runtime test.
 */
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../errors/index.js';
import { asVideoId, asPlaylistId, tryAsVideoId, tryAsPlaylistId } from '../types/index.js';

describe('asVideoId', () => {
  it('returns the same string when given a valid 11-char YouTube video ID', () => {
    // Arrange
    const raw = 'dQw4w9WgXcQ';

    // Act
    const branded = asVideoId(raw);

    // Assert — runtime identity preserved, only the type is enriched
    expect(branded).toBe(raw);
    expect(typeof branded).toBe('string');
  });

  it('accepts video IDs containing underscores and hyphens', () => {
    // Arrange
    const raw = 'a_b-cDEF123';

    // Act
    const branded = asVideoId(raw);

    // Assert
    expect(branded).toBe(raw);
  });

  it('throws ValidationError when the string is too short', () => {
    // Arrange
    const raw = 'short';

    // Act + Assert
    expect(() => asVideoId(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError when the string is too long', () => {
    // Arrange
    const raw = 'dQw4w9WgXcQEXTRA';

    // Act + Assert
    expect(() => asVideoId(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError when the string contains illegal characters', () => {
    // Arrange — 11 chars but with a forbidden `!` symbol
    const raw = 'dQw4w9WgXc!';

    // Act + Assert
    expect(() => asVideoId(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError on the empty string', () => {
    // Arrange + Act + Assert
    expect(() => asVideoId('')).toThrow(ValidationError);
  });
});

describe('asPlaylistId', () => {
  it.each([
    ['PL', 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L'],
    ['UU', 'UUBJycsmduvYEL83R_U4JriQ'],
    ['LL', 'LLBJycsmduvYEL83R_U4JriQ'],
    ['FL', 'FLBJycsmduvYEL83R_U4JriQ'],
    ['RD', 'RDBJycsmduvYEL83R_U4JriQ'],
  ])('accepts a playlist ID with the %s prefix', (_prefix, raw) => {
    // Act
    const branded = asPlaylistId(raw);

    // Assert
    expect(branded).toBe(raw);
  });

  it('throws ValidationError when the prefix is not in the known set', () => {
    // Arrange
    const raw = 'XXrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L';

    // Act + Assert
    expect(() => asPlaylistId(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError on a bare "badprefix" string', () => {
    // Arrange + Act + Assert
    expect(() => asPlaylistId('badprefix')).toThrow(ValidationError);
  });

  it('throws ValidationError when no characters follow the prefix', () => {
    // Arrange — prefix alone, no body
    const raw = 'PL';

    // Act + Assert
    expect(() => asPlaylistId(raw)).toThrow(ValidationError);
  });

  it('throws ValidationError on the empty string', () => {
    // Arrange + Act + Assert
    expect(() => asPlaylistId('')).toThrow(ValidationError);
  });
});

describe('tryAsVideoId / tryAsPlaylistId (non-throwing variants)', () => {
  it('tryAsVideoId returns the branded id on valid input', () => {
    // Arrange + Act
    const result = tryAsVideoId('dQw4w9WgXcQ');

    // Assert
    expect(result).toBe('dQw4w9WgXcQ');
  });

  it('tryAsVideoId returns null on invalid input', () => {
    // Arrange + Act + Assert
    expect(tryAsVideoId('short')).toBeNull();
  });

  it('tryAsPlaylistId returns the branded id on valid input', () => {
    // Arrange
    const raw = 'PLrAXtmRdnEQy6nuLMHjMZOz59Oq8B1X1L';

    // Act
    const result = tryAsPlaylistId(raw);

    // Assert
    expect(result).toBe(raw);
  });

  it('tryAsPlaylistId returns null on invalid input', () => {
    // Arrange + Act + Assert
    expect(tryAsPlaylistId('badprefix')).toBeNull();
  });
});

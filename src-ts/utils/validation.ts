import { ValidationError } from '../errors/index.js';

/**
 * Common validation utilities
 */

/**
 * Validates that a string is non-empty
 */
export function validateNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${fieldName} must be a non-empty string`, {
      field: fieldName,
      value,
    });
  }
}

/**
 * Validates a YouTube video ID format
 */
export function validateVideoId(videoId: unknown): asserts videoId is string {
  validateNonEmptyString(videoId, 'videoId');
  
  if (!videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
    throw new ValidationError('Invalid YouTube video ID format', {
      field: 'videoId',
      value: videoId,
    });
  }
}

/**
 * Validates a YouTube playlist ID format
 */
export function validatePlaylistId(playlistId: unknown): asserts playlistId is string {
  validateNonEmptyString(playlistId, 'playlistId');
  
  if (!playlistId.match(/^[a-zA-Z0-9_-]+$/)) {
    throw new ValidationError('Invalid YouTube playlist ID format', {
      field: 'playlistId',
      value: playlistId,
    });
  }
}

/**
 * Validates a YouTube ID (video or playlist) based on type
 */
export function validateYouTubeId(id: unknown, type: 'video' | 'playlist'): asserts id is string {
  if (type === 'video') {
    validateVideoId(id);
  } else {
    validatePlaylistId(id);
  }
}

/**
 * Validates that a value is a positive integer
 */
export function validatePositiveInteger(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`, {
      field: fieldName,
      value,
    });
  }
}

/**
 * Validates that a value is a valid date
 */
export function validateDate(value: unknown, fieldName: string): asserts value is Date {
  if (!(value instanceof Date) || isNaN(value.getTime())) {
    throw new ValidationError(`${fieldName} must be a valid date`, {
      field: fieldName,
      value,
    });
  }
}

/**
 * Validates that an object has required fields
 */
export function validateRequiredFields<T extends object>(
  obj: unknown,
  requiredFields: (keyof T)[],
  objectName: string
): asserts obj is T {
  if (typeof obj !== 'object' || obj === null) {
    throw new ValidationError(`${objectName} must be an object`, {
      field: objectName,
      value: obj,
    });
  }

  for (const field of requiredFields) {
    if (!(field in obj)) {
      throw new ValidationError(`${objectName} is missing required field: ${String(field)}`, {
        field: String(field),
        context: { objectName },
      });
    }
  }
}

/**
 * Type guard to check if an error is an Error instance
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Safely extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  return String(error);
}

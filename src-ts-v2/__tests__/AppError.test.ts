/**
 * AppError + ValidationError focused tests.
 *
 * These exist mostly to pin the `cause` chain through the standard
 * `ErrorOptions` second-argument path (Node 18+). The previous
 * implementation tried to feature-detect via
 * `Error.prototype.hasOwnProperty('cause')` then `Object.defineProperty`
 * — the v2 baseline supports native cause, so the chain must flow.
 */
import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '../errors/index.js';

describe('AppError — cause property', () => {
  it('preserves the underlying error as the `cause` of the AppError', () => {
    // Arrange
    const inner = new Error('inner failure');

    // Act
    const outer = new AppError('outer wrap', { cause: inner });

    // Assert
    expect(outer.cause).toBe(inner);
    expect((outer.cause as Error).message).toBe('inner failure');
  });

  it('leaves `cause` undefined when not supplied', () => {
    // Arrange + Act
    const err = new AppError('no cause');

    // Assert
    expect(err.cause).toBeUndefined();
  });

  it('accepts non-Error cause values without throwing', () => {
    // Arrange + Act — the standard ErrorOptions allows any cause type
    const err = new AppError('weird cause', { cause: 'a string reason' });

    // Assert
    expect(err.cause).toBe('a string reason');
  });

  it('chains through ValidationError → AppError unchanged', () => {
    // Arrange
    const inner = new Error('root cause');

    // Act
    const validation = new ValidationError('boundary failure', {
      field: 'thing',
      cause: inner,
    });

    // Assert
    expect(validation.cause).toBe(inner);
    expect(validation.code).toBe('VALIDATION_ERROR');
    expect(validation.name).toBe('ValidationError');
  });

  it('preserves stack trace and name correctly', () => {
    // Arrange + Act
    const err = new AppError('with cause', { cause: new Error('x') });

    // Assert
    expect(err.name).toBe('AppError');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('AppError');
  });
});

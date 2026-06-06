/**
 * AppError / ValidationError / DatabaseError unit tests.
 *
 * Canonical regression suite for the cause-preservation bug discovered in
 * Phase 3 (Bug 2): the AppError constructor previously hid the `cause`
 * attach behind `Error.prototype.hasOwnProperty('cause')`, which is
 * ALWAYS false because `cause` is per-instance, not on the prototype.
 * The cause was never attached even when callers passed one — so every
 * downstream error class (DatabaseError, ValidationError) silently
 * dropped its inner cause, and rollbacks reported "Transaction rolled
 * back" with no usable chain.
 *
 * The fix attaches `cause` unconditionally when supplied. These tests
 * are the canonical assertion that the cause survives — they would have
 * caught Bug 2 in Wave 1 if they had existed.
 */
import { describe, expect, it } from 'vitest';

import { AppError, DatabaseError, ValidationError } from '../errors/index.js';

describe('AppError — cause preservation', () => {
  it('new AppError("msg", { code, cause: inner }).cause === inner', () => {
    // Arrange — an inner error that must survive as the cause
    const inner = new Error('underlying SQLite failure');

    // Act
    const wrapped = new AppError('outer wrapper message', {
      code: 'WRAPPED_ERROR',
      cause: inner,
    });

    // Assert — the cause is the inner error, identity-equal. This is the
    // ONE assertion that would have caught Bug 2 in Wave 1.
    expect((wrapped as AppError & { cause?: unknown }).cause).toBe(inner);

    // Sanity — the rest of the AppError surface is intact
    expect(wrapped.message).toBe('outer wrapper message');
    expect(wrapped.code).toBe('WRAPPED_ERROR');
    expect(wrapped.name).toBe('AppError');
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped).toBeInstanceOf(Error);
  });

  it('omitting `cause` leaves cause undefined (no spurious attachment)', () => {
    // Arrange + Act — construct without a cause
    const wrapped = new AppError('no cause given');

    // Assert — cause must remain absent, not set to undefined-as-own-prop
    // in a way that confuses downstream cause-chain walkers.
    const causeView = (wrapped as AppError & { cause?: unknown }).cause;
    expect(causeView).toBeUndefined();
  });

  it('explicit cause: undefined is treated as "no cause" (no attachment)', () => {
    // Arrange + Act — caller passes the field but it's undefined. We want
    // the same behaviour as omitting it entirely.
    const wrapped = new AppError('explicit undefined', { cause: undefined });

    // Assert
    const causeView = (wrapped as AppError & { cause?: unknown }).cause;
    expect(causeView).toBeUndefined();
  });

  it('cause can be any value, not only Error instances', () => {
    // Arrange — a non-Error cause (e.g. a Zod issue object, a string from
    // a parser library, a structured failure record). The contract is
    // "preserve what the caller handed us"; v2 typing says `unknown`.
    const causePayload = { kind: 'zod', issues: [{ path: ['tag'], message: 'required' }] };

    // Act
    const wrapped = new AppError('parse failed', { cause: causePayload });

    // Assert
    expect((wrapped as AppError & { cause?: unknown }).cause).toBe(causePayload);
  });
});

describe('AppError subclasses — cause flows through the inheritance chain', () => {
  it('DatabaseError preserves cause when constructed with one', () => {
    // Arrange
    const inner = new Error('SQLITE_CONSTRAINT: UNIQUE failed');

    // Act
    const wrapped = new DatabaseError('insert failed', {
      operation: 'TagRepository.insert',
      cause: inner,
    });

    // Assert
    expect((wrapped as DatabaseError & { cause?: unknown }).cause).toBe(inner);
    expect(wrapped.code).toBe('DATABASE_ERROR');
    expect(wrapped).toBeInstanceOf(DatabaseError);
    expect(wrapped).toBeInstanceOf(AppError);
  });

  it('ValidationError preserves cause when constructed with one', () => {
    // Arrange — the realistic case: ValidationError wraps a Zod failure
    const inner = new Error('Expected string, received number');

    // Act
    const wrapped = new ValidationError('tag must be a string', {
      field: 'tag',
      value: 42,
      cause: inner,
    });

    // Assert
    expect((wrapped as ValidationError & { cause?: unknown }).cause).toBe(inner);
    expect(wrapped.code).toBe('VALIDATION_ERROR');
    expect(wrapped).toBeInstanceOf(ValidationError);
    expect(wrapped).toBeInstanceOf(AppError);
  });
});

describe('AppError — defaults and structure', () => {
  it('sets sensible defaults when constructed with only a message', () => {
    // Arrange + Act
    const error = new AppError('bare message');

    // Assert
    expect(error.message).toBe('bare message');
    expect(error.code).toBe('APP_ERROR');
    expect(error.statusCode).toBe(500);
    expect(error.isOperational).toBe(true);
    expect(error.context).toBeUndefined();
  });

  it('respects explicit code, statusCode, isOperational, and context', () => {
    // Arrange + Act
    const error = new AppError('explicit fields', {
      code: 'CUSTOM_CODE',
      statusCode: 418,
      isOperational: false,
      context: { request: 'POST /tags' },
    });

    // Assert
    expect(error.code).toBe('CUSTOM_CODE');
    expect(error.statusCode).toBe(418);
    expect(error.isOperational).toBe(false);
    expect(error.context).toEqual({ request: 'POST /tags' });
  });

  it('sets name to the subclass constructor name', () => {
    // Arrange + Act
    const base = new AppError('base');
    const db = new DatabaseError('db');
    const val = new ValidationError('val');

    // Assert — `name` must reflect runtime class for log readability
    expect(base.name).toBe('AppError');
    expect(db.name).toBe('DatabaseError');
    expect(val.name).toBe('ValidationError');
  });
});

/**
 * RateLimiter input-validation tests.
 *
 * The token-bucket algorithm itself was ported as-is from v1 and is the
 * v1 win — these tests cover the *boundary* validation we added to v2 so
 * pathological inputs fail loudly instead of hanging the pipeline.
 *
 * AAA structure.
 */
import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../api/RateLimiter.js';
import { ValidationError } from '../errors/index.js';

describe('RateLimiter constructor', () => {
  it('throws ValidationError when maxRequests is zero', () => {
    // Arrange
    const config = { maxRequests: 0, windowMs: 1000 };

    // Act + Assert
    expect(() => new RateLimiter(config)).toThrowError(ValidationError);
  });

  it('throws ValidationError when maxRequests is negative', () => {
    // Arrange
    const config = { maxRequests: -1, windowMs: 1000 };

    // Act + Assert
    expect(() => new RateLimiter(config)).toThrowError(ValidationError);
  });

  it('throws ValidationError when windowMs is not finite', () => {
    // Arrange
    const config = { maxRequests: 10, windowMs: Number.POSITIVE_INFINITY };

    // Act + Assert
    expect(() => new RateLimiter(config)).toThrowError(ValidationError);
  });

  it('accepts a normal positive configuration', () => {
    // Arrange + Act
    const limiter = new RateLimiter({ maxRequests: 10, windowMs: 1000 });

    // Assert
    expect(limiter.getAvailableTokens()).toBe(10);
  });
});

describe('RateLimiter.waitForToken validation', () => {
  it('throws ValidationError when cost is zero', async () => {
    // Arrange
    const limiter = new RateLimiter({ maxRequests: 10, windowMs: 1000 });

    // Act + Assert
    await expect(limiter.waitForToken('test-op', 0)).rejects.toThrowError(ValidationError);
  });

  it('throws ValidationError when cost is negative', async () => {
    // Arrange
    const limiter = new RateLimiter({ maxRequests: 10, windowMs: 1000 });

    // Act + Assert
    await expect(limiter.waitForToken('test-op', -1)).rejects.toThrowError(ValidationError);
  });

  it('throws ValidationError when cost exceeds maxRequests (would hang)', async () => {
    // Arrange
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });

    // Act + Assert
    await expect(limiter.waitForToken('test-op', 6)).rejects.toThrowError(ValidationError);
  });

  it('accepts cost equal to maxRequests (boundary)', async () => {
    // Arrange
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });

    // Act
    await limiter.waitForToken('test-op', 5);

    // Assert
    expect(limiter.getAvailableTokens()).toBe(0);
  });
});

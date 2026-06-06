import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RetryHandler } from '../RetryHandler';
import { AppError } from '../../errors';

describe('RetryHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return result on successful first attempt', async () => {
    const handler = new RetryHandler({
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      retryableErrors: [],
    });

    const mockFn = vi.fn().mockResolvedValue('success');

    const result = await handler.execute('test-operation', mockFn);

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should retry on network errors', async () => {
    const handler = new RetryHandler({
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      retryableErrors: ['ECONNRESET'],
    });

    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('success');

    const result = await handler.execute('test-operation', mockFn);

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(3); // Failed twice, succeeded on third
  });

  it('should fail after max retries exhausted', async () => {
    const handler = new RetryHandler({
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      retryableErrors: [],
    });

    const mockFn = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));

    await expect(handler.execute('test-operation', mockFn)).rejects.toThrow(
      'Operation failed after 2 retries'
    );

    expect(mockFn).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it('should not retry on non-retryable errors', async () => {
    const handler = new RetryHandler({
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      retryableErrors: [],
    });

    const mockFn = vi.fn().mockRejectedValue(new Error('404 Not Found'));

    await expect(handler.execute('test-operation', mockFn)).rejects.toThrow('404 Not Found');

    expect(mockFn).toHaveBeenCalledTimes(1); // Should fail immediately
  });

  it('should retry on rate limit errors', async () => {
    const handler = new RetryHandler({
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      retryableErrors: ['rate limit', 'quota'],
    });

    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Rate limit exceeded'))
      .mockResolvedValue('success');

    const result = await handler.execute('test-operation', mockFn);

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should apply exponential backoff', async () => {
    const handler = new RetryHandler({
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      retryableErrors: [],
    });

    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue('success');

    const start = Date.now();
    const result = await handler.execute('test-operation', mockFn);
    const elapsed = Date.now() - start;

    expect(result).toBe('success');
    // First retry: 100ms, second retry: 200ms = ~300ms minimum
    // With jitter it could be up to 375ms
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should throw AppError with proper context', async () => {
    const handler = new RetryHandler({
      maxRetries: 1,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      retryableErrors: [],
    });

    const originalError = new Error('Network failure');
    const mockFn = vi.fn().mockRejectedValue(originalError);

    try {
      await handler.execute('critical-operation', mockFn);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.message).toContain('Operation failed after 1 retries');
      expect(appError.code).toBe('MAX_RETRIES_EXCEEDED');
    }
  });

  it('should handle custom retryable errors', async () => {
    const handler = new RetryHandler({
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      retryableErrors: ['CUSTOM_ERROR'],
    });

    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('CUSTOM_ERROR occurred'))
      .mockResolvedValue('recovered');

    const result = await handler.execute('test-operation', mockFn);

    expect(result).toBe('recovered');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });
});

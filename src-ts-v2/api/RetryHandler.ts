/**
 * Retry handler with exponential backoff + jitter — KEEP-AS-IS lift from
 * `src-ts/api/RetryHandler.ts`. Only the imports for `AppError` and
 * `RetryConfig` were repointed to v2 paths. The algorithm is the v1 win:
 * selective retry, capped exponential delay, explicit retryable-error
 * matching.
 *
 * Features:
 *   - Configurable max retries
 *   - Exponential backoff with jitter
 *   - Selective retry (only transient errors)
 *   - Detailed Pino logging
 */
import logger from '../utils/logger.js';
import { AppError } from '../errors/index.js';
import { RetryConfig } from './types.js';

export class RetryHandler {
  private readonly config: RetryConfig;

  /**
   * Create a new RetryHandler instance.
   *
   * @param config - Retry configuration
   */
  constructor(config: RetryConfig) {
    this.config = config;

    logger.info(
      {
        maxRetries: config.maxRetries,
        baseDelayMs: config.baseDelayMs,
        maxDelayMs: config.maxDelayMs,
      },
      'RetryHandler initialized'
    );
  }

  /**
   * Execute function with retry logic.
   *
   * @param operation - Name of operation (for logging)
   * @param fn - Async function to execute
   * @returns Result of function
   * @throws {AppError} If all retries exhausted
   */
  async execute<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        logger.debug({ operation, attempt }, 'Executing with retry');
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Check if error is retryable
        if (!this.isRetryable(error)) {
          logger.warn({ operation, error }, 'Non-retryable error, failing immediately');
          throw error;
        }

        // Check if we have retries left
        if (attempt === this.config.maxRetries) {
          logger.error({ operation, attempt, error }, 'All retries exhausted');
          break;
        }

        // Calculate backoff delay with jitter
        const delay = this.calculateDelay(attempt);
        logger.info({ operation, attempt, delay, error }, 'Retryable error, waiting before retry');

        await this.sleep(delay);
      }
    }

    throw new AppError(`Operation failed after ${this.config.maxRetries} retries`, {
      code: 'MAX_RETRIES_EXCEEDED',
      cause: lastError,
      context: { operation },
    });
  }

  /**
   * Check if an error should be retried.
   *
   * @param error - Error to check
   * @returns True if error is retryable
   */
  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      // Network errors (retry)
      if (
        message.includes('econnreset') ||
        message.includes('etimedout') ||
        message.includes('enotfound') ||
        message.includes('econnrefused') ||
        message.includes('network')
      ) {
        return true;
      }

      // API rate limit errors (retry)
      if (message.includes('quota') || message.includes('rate limit') || message.includes('429')) {
        return true;
      }

      // Server errors (retry)
      if (message.includes('503') || message.includes('502') || message.includes('500')) {
        return true;
      }

      // Client errors (don't retry)
      if (
        message.includes('400') ||
        message.includes('401') ||
        message.includes('403') ||
        message.includes('404')
      ) {
        return false;
      }

      // Check retryableErrors from config
      for (const retryableError of this.config.retryableErrors) {
        if (message.includes(retryableError.toLowerCase())) {
          return true;
        }
      }
    }

    // Default: don't retry unknown errors
    return false;
  }

  /**
   * Calculate exponential backoff delay with jitter.
   *
   * @param attempt - Current attempt number (0-based)
   * @returns Delay in milliseconds
   */
  private calculateDelay(attempt: number): number {
    // Exponential backoff: baseDelay * 2^attempt
    const exponential = this.config.baseDelayMs * Math.pow(2, attempt);

    // Add jitter (random 0-25% variance)
    const jitter = exponential * 0.25 * Math.random();

    // Cap at max delay
    return Math.min(exponential + jitter, this.config.maxDelayMs);
  }

  /**
   * Sleep for specified duration.
   *
   * @param ms - Milliseconds to sleep
   * @returns Promise that resolves after sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

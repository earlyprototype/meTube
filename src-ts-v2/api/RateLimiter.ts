/**
 * Token bucket rate limiter — KEEP-AS-IS lift from
 * `src-ts/api/RateLimiter.ts`. Only the import for `RateLimiterConfig`
 * was repointed to the v2 `api/types.js` barrel. The algorithm is the v1
 * win: simple, well-tested, no global state, async-friendly.
 *
 * Features:
 *   - Configurable max requests per time window
 *   - Automatic token refill
 *   - Operation cost tracking (caller passes cost per call)
 *   - Pino-logged
 */
import { ValidationError } from '../errors/index.js';
import logger from '../utils/logger.js';
import { RateLimiterConfig } from './types.js';

function assertPositiveFinite(field: 'maxRequests' | 'windowMs', value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`RateLimiter config.${field} must be a positive finite number`, {
      field,
      value,
    });
  }
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly config: RateLimiterConfig;

  /**
   * Create a new RateLimiter instance.
   *
   * @param config - Rate limiter configuration
   * @throws {ValidationError} when maxRequests or windowMs is not a positive finite number
   */
  constructor(config: RateLimiterConfig) {
    assertPositiveFinite('maxRequests', config.maxRequests);
    assertPositiveFinite('windowMs', config.windowMs);

    this.config = config;
    this.tokens = config.maxRequests;
    this.lastRefill = Date.now();

    logger.info(
      {
        maxRequests: config.maxRequests,
        windowMs: config.windowMs,
      },
      'RateLimiter initialized'
    );
  }

  /**
   * Wait for rate limit to allow request.
   *
   * @param operation - Name of operation (for logging and cost calculation)
   * @param cost - Cost of this operation (default: 1)
   * @throws {ValidationError} when cost is not a positive finite number, or when
   *   cost exceeds the configured maxRequests (the call would otherwise hang
   *   forever waiting for a refill that can never satisfy it).
   */
  async waitForToken(operation: string, cost = 1): Promise<void> {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new ValidationError('RateLimiter cost must be a positive finite number', {
        field: 'cost',
        value: cost,
        context: { operation },
      });
    }
    if (cost > this.config.maxRequests) {
      throw new ValidationError(
        'RateLimiter cost exceeds configured maxRequests; would hang forever',
        {
          field: 'cost',
          value: cost,
          context: { operation, maxRequests: this.config.maxRequests },
        }
      );
    }

    this.refillTokens();

    while (this.tokens < cost) {
      const waitMs = this.calculateWaitTime(cost);
      logger.info(
        {
          operation,
          cost,
          tokensAvailable: this.tokens,
          waitMs,
        },
        'Rate limit reached, waiting'
      );

      await this.sleep(waitMs);
      this.refillTokens();
    }

    this.tokens -= cost;
    logger.debug(
      {
        operation,
        cost,
        tokensRemaining: this.tokens,
      },
      'Token consumed'
    );
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const windows = Math.floor(elapsed / this.config.windowMs);

    if (windows > 0) {
      this.tokens = Math.min(
        this.config.maxRequests,
        this.tokens + windows * this.config.maxRequests
      );
      this.lastRefill = now;

      logger.debug({ tokensAfterRefill: this.tokens }, 'Tokens refilled');
    }
  }

  /**
   * Calculate time to wait for enough tokens.
   *
   * @param cost - Cost of operation
   * @returns Wait time in milliseconds
   */
  private calculateWaitTime(cost: number): number {
    const tokensNeeded = cost - this.tokens;
    const windowsNeeded = Math.ceil(tokensNeeded / this.config.maxRequests);
    return windowsNeeded * this.config.windowMs;
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

  /**
   * Get current token count (for testing/monitoring).
   *
   * @returns Current available tokens
   */
  getAvailableTokens(): number {
    this.refillTokens();
    return this.tokens;
  }

  /**
   * Reset the rate limiter to initial state.
   */
  reset(): void {
    this.tokens = this.config.maxRequests;
    this.lastRefill = Date.now();
    logger.debug('RateLimiter reset');
  }
}

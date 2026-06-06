/**
 * Base application error class.
 *
 * All custom errors should extend this class. `cause` is passed via the
 * standard `ErrorOptions` second argument to `super()` — Node 18+ (the
 * v2 baseline) supports `Error.cause` natively, so the previous
 * `Error.prototype.hasOwnProperty('cause')` feature-detect plus
 * `Object.defineProperty` shim is no longer needed (and was inverted
 * anyway — native support means the cause flows through `super()`,
 * not via a manual property write).
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code?: string;
      statusCode?: number;
      isOperational?: boolean;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);

    this.name = this.constructor.name;
    this.code = options.code || 'APP_ERROR';
    this.statusCode = options.statusCode || 500;
    this.isOperational = options.isOperational ?? true;
    this.context = options.context;

    // Maintains proper stack trace for where our error was thrown
    Error.captureStackTrace(this, this.constructor);
  }
}

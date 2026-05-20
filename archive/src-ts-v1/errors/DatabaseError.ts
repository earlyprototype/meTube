import { AppError } from './AppError.js';

/**
 * Error thrown when database operations fail
 */
export class DatabaseError extends AppError {
  constructor(
    message: string,
    options: {
      operation?: string;
      table?: string;
      cause?: unknown;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message, {
      code: 'DATABASE_ERROR',
      statusCode: 500,
      isOperational: true,
      cause: options.cause,
      context: {
        operation: options.operation,
        table: options.table,
        ...options.context,
      },
    });
  }
}

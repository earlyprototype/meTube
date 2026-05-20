import { AppError } from './AppError.js';

/**
 * Error thrown when input validation fails
 */
export class ValidationError extends AppError {
  constructor(
    message: string,
    options: {
      field?: string;
      value?: unknown;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      isOperational: true,
      cause: options.cause,
      context: {
        field: options.field,
        value: options.value,
        ...options.context,
      },
    });
  }
}

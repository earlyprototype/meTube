import pino from 'pino';

/**
 * Structured logger using Pino
 *
 * Usage:
 *   logger.info({ context: 'value' }, 'Message');
 *   logger.error({ error: err.message }, 'Error occurred');
 */

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';
const isDebug = process.env.DEBUG === 'true';

const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : isDebug ? 'debug' : 'error'),
  transport:
    isProd || isTest || !isDebug
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
            singleLine: false,
          },
        },
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Create a child logger with additional context
 * @param context - Additional context to include in all log messages
 */
export function createLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

export default logger;

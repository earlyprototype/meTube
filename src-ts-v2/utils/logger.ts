import { join } from 'node:path';

import pino from 'pino';

/**
 * Structured logger using Pino.
 *
 * Output is FILE-ONLY (`logs/metube.log`, cwd-relative). Nothing here ever
 * writes to stdout/stderr — raw JSON log lines on stdout interleave with Ink's
 * live frames and shred the TUI. The file destination keeps per-video
 * transcript/Whisper failure causes diagnosable without touching the terminal.
 *
 * Usage:
 *   logger.info({ context: 'value' }, 'Message');
 *   logger.error({ error: err.message }, 'Error occurred');
 */

/**
 * Default log file path, cwd-relative (consistent with the app's `data/` and
 * `reports/` conventions, both resolved against process.cwd()).
 */
export const LOG_FILE_PATH = join('logs', 'metube.log');

export interface LoggerConfig {
  level: string;
  /** Whether to attach the file destination. False under test so no logs/ artifact is created. */
  useFile: boolean;
  /** Resolved log file path when useFile is true. */
  dest: string;
}

/**
 * Pure option-builder for the logger. Extracted so the level/destination
 * decisions are unit-testable without constructing a real pino instance or
 * touching the filesystem.
 *
 * Level precedence: test => silent UNCONDITIONALLY (even with LOG_LEVEL set);
 * otherwise explicit LOG_LEVEL wins, then DEBUG=true => debug, default => info.
 * Test silence is non-overridable because stray LOG_LEVEL in a CI/dev shell
 * must never let log lines leak into the test runner and interleave with Ink
 * frames. The default is 'info' (not 'error') now that output is file-bound:
 * it restores diagnosability of per-video failures without risking the TUI.
 */
export function buildLoggerConfig(env: NodeJS.ProcessEnv): LoggerConfig {
  const isTest = env.NODE_ENV === 'test';
  const isDebug = env.DEBUG === 'true';

  const level = isTest ? 'silent' : env.LOG_LEVEL || (isDebug ? 'debug' : 'info');

  return {
    level,
    // Never attach a file destination under test: tests import this module
    // transitively, and a real file handle leaves logs/ artifacts and can
    // wedge teardown on Windows.
    useFile: !isTest,
    dest: LOG_FILE_PATH,
  };
}

const config = buildLoggerConfig(process.env);

/**
 * Synchronous destination on purpose. One-shot CLI commands exit quickly; an
 * async (buffered) destination can drop the tail of the log on process exit,
 * losing exactly the per-video failure lines this file exists to preserve.
 * The write volume here is low, so the sync cost is irrelevant.
 *
 * `mkdir: true` creates the logs/ directory on first write.
 */
const destination = config.useFile
  ? pino.destination({ dest: config.dest, mkdir: true, sync: true })
  : undefined;

const logger = destination
  ? pino(
      {
        level: config.level,
        formatters: {
          level: (label) => {
            return { level: label };
          },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      destination
    )
  : pino({
      level: config.level,
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

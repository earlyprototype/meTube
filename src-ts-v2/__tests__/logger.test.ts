/**
 * Unit coverage for the logger's option-building logic.
 *
 * Background: the logger is file-bound (logs/metube.log). It must NEVER write
 * to stdout/stderr — JSON log lines on stdout interleave with Ink's live frames
 * and corrupt the TUI. These tests pin the level-precedence decisions and the
 * test-environment "no file destination" guarantee (so `npm test` leaves no
 * logs/ artifact). The module-level singleton consumes buildLoggerConfig, so
 * testing the pure function covers the real wiring without filesystem side
 * effects.
 */

import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import logger, { buildLoggerConfig, createLogger, LOG_FILE_PATH } from '../utils/logger.js';

/** A clean env baseline so each case asserts one variable in isolation. */
const baseEnv = (): NodeJS.ProcessEnv => ({});

describe('buildLoggerConfig — level precedence', () => {
  it('respects an explicit LOG_LEVEL over every default', () => {
    const env = { ...baseEnv(), LOG_LEVEL: 'warn', NODE_ENV: 'test', DEBUG: 'true' };

    const { level } = buildLoggerConfig(env);

    expect(level).toBe('warn');
  });

  it('is silent in the test environment when LOG_LEVEL is unset', () => {
    const env = { ...baseEnv(), NODE_ENV: 'test' };

    const { level } = buildLoggerConfig(env);

    expect(level).toBe('silent');
  });

  it("defaults to 'info' outside test/debug (file-bound diagnosability)", () => {
    const env = { ...baseEnv(), NODE_ENV: 'production' };

    const { level } = buildLoggerConfig(env);

    expect(level).toBe('info');
  });

  it("raises the level to 'debug' when DEBUG=true and not under test", () => {
    const env = { ...baseEnv(), DEBUG: 'true' };

    const { level } = buildLoggerConfig(env);

    expect(level).toBe('debug');
  });

  it("keeps 'silent' under test even when DEBUG=true (test beats debug)", () => {
    const env = { ...baseEnv(), NODE_ENV: 'test', DEBUG: 'true' };

    const { level } = buildLoggerConfig(env);

    expect(level).toBe('silent');
  });
});

describe('buildLoggerConfig — file destination', () => {
  it('does NOT attach a file destination under test (no logs/ artifact)', () => {
    const env = { ...baseEnv(), NODE_ENV: 'test' };

    const { useFile } = buildLoggerConfig(env);

    expect(useFile).toBe(false);
  });

  it('attaches a file destination outside test', () => {
    const env = { ...baseEnv(), NODE_ENV: 'production' };

    const { useFile } = buildLoggerConfig(env);

    expect(useFile).toBe(true);
  });

  it('targets logs/metube.log, cwd-relative', () => {
    const { dest } = buildLoggerConfig(baseEnv());

    expect(dest).toBe(join('logs', 'metube.log'));
    expect(LOG_FILE_PATH).toBe(join('logs', 'metube.log'));
  });
});

describe('logger module API (unchanged contract)', () => {
  it('exposes the standard pino level methods', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.child).toBe('function');
  });

  it('createLogger returns a child logger with the same method surface', () => {
    const child = createLogger({ scope: 'test' });

    expect(typeof child.info).toBe('function');
    expect(typeof child.child).toBe('function');
  });
});

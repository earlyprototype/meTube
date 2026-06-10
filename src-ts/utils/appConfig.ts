/**
 * UI-side config access (task 8 / PARITY.md row E).
 *
 * Every command hardcoded `data/metube.db` and `'reports'` and nothing read
 * `config/config.yaml`, despite a full Zod loader existing. This thin wrapper
 * resolves the DB path + reports dir from `loadConfig()` so the live path honors
 * the file. Python loads config at the top of every command (cli.py:168-184);
 * this mirrors that — sync, cheap, per-invocation, no global singleton (a
 * singleton would break the per-test config injection the loader supports via
 * its `configPath` option).
 *
 * ConfigError (present-but-broken config) propagates OUT of these helpers
 * unchanged, so each command's existing try/catch surfaces it through
 * ErrorDisplay with the CONFIG_ERROR remediation (task 4).
 */

import { loadConfig } from '../../src-ts-v2/config/loadConfig.js';

/** Resolved filesystem paths a UI command needs, read from config. */
export interface AppPaths {
  /** SQLite database path (`config.database.path`). */
  readonly dbPath: string;
  /** Reports output directory, trailing slash stripped (`config.reports.output_dir`). */
  readonly reportsDir: string;
}

/**
 * Load and resolve the UI paths from `config/config.yaml` (or schema defaults
 * when the file is absent).
 *
 * @returns `{ dbPath, reportsDir }` from the validated config.
 * @throws {ConfigError} If a PRESENT config file is unreadable / malformed /
 *                       non-mapping (caller's try/catch renders the remediation).
 */
export function loadAppPaths(): AppPaths {
  const config = loadConfig();
  return {
    dbPath: config.database.path,
    // The schema default is 'reports/'; the generator joins this with the
    // filename, so a trailing slash is harmless — but strip it to match the
    // prior literal 'reports' and keep paths tidy.
    reportsDir: config.reports.output_dir.replace(/\/+$/, ''),
  };
}

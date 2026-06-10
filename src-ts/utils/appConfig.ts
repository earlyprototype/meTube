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

/**
 * Matches a string that is still an unsubstituted `${VAR}` placeholder.
 *
 * The config loader (`loadConfig` → `substituteEnvVars`) deliberately leaves a
 * `${VAR}` literal untouched when the env var is unset (Python parity — an
 * unset key must not crash the parse). `config/config.yaml` carries
 * `gemini_api_key: ${GEMINI_API_KEY}`, so with the env var unset the loaded
 * value is the literal string `'${GEMINI_API_KEY}'` — truthy, but NOT a real
 * key. Callers that treat any truthy value as "configured" would then lie.
 *
 * Anchored full-match: only a value that is exactly `${NAME}` (and nothing
 * else) counts as a placeholder. A real key, or a string that merely contains
 * `${...}`, is not a placeholder.
 */
export function isUnsubstitutedPlaceholder(value: string | null | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
}

/**
 * Whether a usable Gemini API key is actually configured.
 *
 * True when either the config value or `GEMINI_API_KEY` is a non-empty string
 * that is NOT an unsubstituted `${VAR}` placeholder. This is the predicate
 * `init` uses for its status line — it must not report "configured" when the
 * only "value" present is the literal `${GEMINI_API_KEY}` left behind by the
 * loader when the env var is unset.
 *
 * Note: this deliberately diverges from the Python original, which has the
 * same latent flaw (a present-but-unsubstituted placeholder reads as truthy).
 * See the PYTHON-BUG precedent in `docs/PARITY.md`.
 *
 * @param configValue - `config.api.gemini_api_key` as returned by the loader.
 * @param envValue - `process.env.GEMINI_API_KEY` (defaults to the live env).
 */
export function isGeminiConfigured(
  configValue: string | null | undefined,
  envValue: string | undefined = process.env.GEMINI_API_KEY
): boolean {
  const fromConfig = Boolean(configValue) && !isUnsubstitutedPlaceholder(configValue);
  const fromEnv = Boolean(envValue) && !isUnsubstitutedPlaceholder(envValue);
  return fromConfig || fromEnv;
}

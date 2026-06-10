/**
 * Config loader — reads `config/config.yaml`, applies recursive `${VAR}`
 * environment-variable substitution, and validates against the existing
 * Zod schema (`schemas/config.ts`).
 *
 * Ports `legacy/python/src/cli.py:load_config` + `_substitute_env_vars`
 * (lines 168-208). The live v2 path had no loader: every command hardcoded
 * `data/metube.db` etc. and nothing read the file. This closes that gap.
 *
 * Behavioural parity with Python:
 *
 *   1. **Read + parse YAML.** If `config/config.yaml` exists and parses to a
 *      mapping, use it; otherwise fall back to schema defaults (Python falls
 *      back to `DEFAULT_CONFIG` — whose values match the Zod defaults).
 *   2. **Recursive `${VAR}` substitution.** Strings, objects, and arrays are
 *      walked. `${NAME}` is replaced with `process.env.NAME` ONLY when that
 *      env value is truthy; an unset or empty env var leaves the literal
 *      `${NAME}` in place. This mirrors Python's `if env_value:` guard
 *      exactly — load-bearing, because the schema's optional `gemini_api_key`
 *      accepts the literal string, so an unset key must not crash the parse.
 *   3. **Merge over defaults.** Python merges absent top-level keys from
 *      `DEFAULT_CONFIG`; here the Zod schema self-defaults every section, so
 *      a sparse YAML still parses to a complete `MeTubeConfig`. Merge is
 *      therefore handled by the schema, not a hand-rolled deep-merge.
 *   4. **Validate.** The substituted object is parsed through
 *      `MeTubeConfigSchema`. A schema violation throws (a malformed config is
 *      a real error the operator must fix) — but a *missing* or
 *      *unreadable / non-mapping* file is tolerated the way Python tolerates
 *      a missing file: fall back to defaults.
 *
 * Sync by design: matches Python's synchronous loader and keeps Wave 2
 * command call-sites simple (no `await` needed to resolve the DB path).
 *
 * Logging: pino only (no console). A missing or malformed file logs at
 * `debug` / `warn` and continues with defaults.
 */

import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { MeTubeConfigSchema, type MeTubeConfig } from '../schemas/config.js';
import logger from '../utils/logger.js';

/**
 * Default location of the config file, relative to the process working
 * directory. Matches Python's `Path('config/config.yaml')`.
 */
export const DEFAULT_CONFIG_PATH = 'config/config.yaml';

/**
 * Matches `${VAR_NAME}` placeholders. Mirrors the Python regex
 * `r'\$\{([^}]+)\}'` — the capture group is the variable name (any run of
 * characters that is not a closing brace). Global so multiple placeholders
 * in one string are all replaced.
 */
const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Options accepted by {@link loadConfig}.
 */
export interface LoadConfigOptions {
  /**
   * Path to the YAML config file. Resolved relative to `process.cwd()` when
   * not absolute. Defaults to {@link DEFAULT_CONFIG_PATH}. Primarily an
   * override seam for tests; production callers omit it.
   */
  readonly configPath?: string;
}

/**
 * Recursively substitute `${VAR}` placeholders in a parsed-config value.
 *
 * Walks strings, plain objects, and arrays. For a string, every `${NAME}`
 * occurrence is replaced with `process.env.NAME` — but ONLY when that env
 * value is truthy (non-empty). An unset or empty env var leaves the literal
 * `${NAME}` untouched, matching Python's `if env_value:` guard. Non-string
 * scalars (numbers, booleans, null, undefined) pass through unchanged.
 *
 * Immutable: returns new objects/arrays; the input is never mutated.
 *
 * @param value - A node of the parsed config tree (`unknown` — this runs on
 *                untrusted file contents before Zod validation).
 * @returns A structurally-identical value with `${VAR}` placeholders resolved.
 */
export function substituteEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_PATTERN, (literal, varName: string) => {
      const envValue = process.env[varName];
      // Python: `if env_value:` — only substitute on a truthy value.
      // Otherwise the original `${VAR}` literal is preserved.
      return envValue ? envValue : literal;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteEnvVars(item));
  }

  // Plain object (but not null, not a Date, etc.). `yaml.load` produces plain
  // objects for mappings, so a prototype check is sufficient and avoids
  // walking class instances.
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteEnvVars(child);
    }
    return out;
  }

  // Numbers, booleans, null, undefined — untouched.
  return value;
}

/**
 * Read the config file (if any), substitute env vars, and validate against
 * the schema. See the module header for the full Python-parity contract.
 *
 * @param options - Optional overrides (notably `configPath` for tests).
 * @returns A fully-populated, validated `MeTubeConfig`. Every section is
 *          present (schema defaults fill gaps), so callers can read
 *          `config.database.path` etc. without null checks.
 * @throws {ZodError} If a PRESENT, well-formed YAML mapping fails schema
 *                    validation (a real config error). A missing or
 *                    unreadable / non-mapping file does NOT throw — it falls
 *                    back to schema defaults, matching Python's missing-file
 *                    behaviour.
 */
export function loadConfig(options: LoadConfigOptions = {}): MeTubeConfig {
  const configPath = path.resolve(process.cwd(), options.configPath ?? DEFAULT_CONFIG_PATH);

  const { object: rawObject, source } = readConfigObject(configPath);
  const substituted = substituteEnvVars(rawObject);

  // Zod parse is the merge-over-defaults step: every section self-defaults,
  // so a sparse (or empty) object becomes a complete MeTubeConfig.
  const config = MeTubeConfigSchema.parse(substituted);

  logger.debug({ configPath, source }, 'Config loaded');

  return config;
}

/**
 * Where the config object came from — `'file'` when a usable YAML mapping was
 * read, `'defaults'` when it fell back to schema defaults.
 */
type ConfigSource = 'file' | 'defaults';

/**
 * Read and YAML-parse the config file into a plain object, tolerating
 * absence and malformation.
 *
 * Falls back to an empty object (→ schema defaults) when:
 *   - the file does not exist (Python's primary fallback),
 *   - the file cannot be read,
 *   - the YAML parses to anything other than a mapping (scalar / array /
 *     null) — a non-mapping config is unusable, so we degrade to defaults
 *     rather than letting a stray document crash startup.
 *
 * @param configPath - Absolute path to the YAML file.
 * @returns `{ object, source }` — the parsed mapping (or `{}` on any
 *          tolerated miss) plus where it came from, for logging.
 */
function readConfigObject(configPath: string): {
  object: Record<string, unknown>;
  source: ConfigSource;
} {
  const defaults = { object: {} as Record<string, unknown>, source: 'defaults' as const };

  if (!fs.existsSync(configPath)) {
    logger.debug({ configPath }, 'Config file not found; using defaults');
    return defaults;
  }

  let contents: string;
  try {
    contents = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    logger.warn(
      { configPath, err: error instanceof Error ? error.message : String(error) },
      'Config file unreadable; using defaults'
    );
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(contents);
  } catch (error) {
    logger.warn(
      { configPath, err: error instanceof Error ? error.message : String(error) },
      'Config file is not valid YAML; using defaults'
    );
    return defaults;
  }

  // A mapping is the only usable shape. yaml.load returns `undefined` for an
  // empty file, a scalar for `!!str ...`, an array for a sequence — none of
  // which are a config object.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(
      { configPath, parsedType: Array.isArray(parsed) ? 'array' : typeof parsed },
      'Config file did not parse to a mapping; using defaults'
    );
    return defaults;
  }

  return { object: parsed as Record<string, unknown>, source: 'file' };
}

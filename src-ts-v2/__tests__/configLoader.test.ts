/**
 * Tests for the config loader (`src-ts-v2/config/loadConfig.ts`).
 *
 * Ports the behavioural contract of Python `cli.py:load_config` +
 * `_substitute_env_vars` (lines 168-208):
 *   - Reads `config/config.yaml`, applies RECURSIVE `${VAR}` env-var
 *     substitution over strings/objects/arrays, merges over defaults
 *     (here: Zod schema defaults), validates with the existing
 *     `MeTubeConfigSchema`.
 *   - Unset `${VAR}` is left literal (Python only replaces on a truthy
 *     env value).
 *   - Missing / unreadable file → schema defaults (parse `{}`).
 *
 * Strategy: write a throwaway YAML file under `os.tmpdir()` per test and
 * point the loader at it via the `configPath` override. No real network,
 * no dependency on the repo's checked-in `config/config.yaml`. Env vars
 * are set/cleared per test and restored in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, substituteEnvVars } from '../config/loadConfig.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

function rememberEnv(...keys: string[]): void {
  for (const key of keys) {
    savedEnv[key] = process.env[key];
  }
}

function writeYaml(contents: string): string {
  const file = path.join(tmpDir, 'config.yaml');
  fs.writeFileSync(file, contents, 'utf-8');
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metube-config-'));
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// substituteEnvVars — the recursive ${VAR} engine
// --------------------------------------------------------------------------

describe('substituteEnvVars', () => {
  it('replaces ${VAR} in a string when the env var is set', () => {
    rememberEnv('METUBE_TEST_KEY');
    process.env.METUBE_TEST_KEY = 'sk-secret';

    expect(substituteEnvVars('${METUBE_TEST_KEY}')).toBe('sk-secret');
  });

  it('leaves ${VAR} literal when the env var is UNSET (Python parity)', () => {
    rememberEnv('METUBE_MISSING_KEY');
    delete process.env.METUBE_MISSING_KEY;

    // Python only replaces on a truthy env value; otherwise the literal
    // ${VAR} survives. This is load-bearing: the schema's optional
    // gemini_api_key accepts the literal string, so an unset key does not
    // crash the parse.
    expect(substituteEnvVars('${METUBE_MISSING_KEY}')).toBe('${METUBE_MISSING_KEY}');
  });

  it('leaves ${VAR} literal when the env var is the empty string', () => {
    rememberEnv('METUBE_EMPTY_KEY');
    process.env.METUBE_EMPTY_KEY = '';

    // Python's `if env_value:` is falsy on '' → no replacement.
    expect(substituteEnvVars('${METUBE_EMPTY_KEY}')).toBe('${METUBE_EMPTY_KEY}');
  });

  it('substitutes multiple ${VAR} occurrences in one string', () => {
    rememberEnv('METUBE_A', 'METUBE_B');
    process.env.METUBE_A = 'foo';
    process.env.METUBE_B = 'bar';

    expect(substituteEnvVars('${METUBE_A}/${METUBE_B}')).toBe('foo/bar');
  });

  it('recurses into objects', () => {
    rememberEnv('METUBE_NESTED');
    process.env.METUBE_NESTED = 'deep';

    const input = { api: { key: '${METUBE_NESTED}', static: 'unchanged' } };
    expect(substituteEnvVars(input)).toEqual({
      api: { key: 'deep', static: 'unchanged' },
    });
  });

  it('recurses into arrays', () => {
    rememberEnv('METUBE_ARR');
    process.env.METUBE_ARR = 'X';

    const input = { langs: ['${METUBE_ARR}', 'literal'] };
    expect(substituteEnvVars(input)).toEqual({ langs: ['X', 'literal'] });
  });

  it('leaves non-string scalars (numbers, booleans, null) untouched', () => {
    const input = { n: 3, b: true, z: null };
    expect(substituteEnvVars(input)).toEqual({ n: 3, b: true, z: null });
  });

  it('does not mutate the input object (immutability)', () => {
    rememberEnv('METUBE_IMMUT');
    process.env.METUBE_IMMUT = 'Y';

    const input = { a: '${METUBE_IMMUT}' };
    const output = substituteEnvVars(input);

    expect(input.a).toBe('${METUBE_IMMUT}'); // original untouched
    expect((output as { a: string }).a).toBe('Y');
  });
});

// --------------------------------------------------------------------------
// loadConfig — full read + substitute + merge + validate
// --------------------------------------------------------------------------

describe('loadConfig', () => {
  it('loads a YAML file, substitutes env vars, and validates against the schema', () => {
    rememberEnv('METUBE_GEMINI');
    process.env.METUBE_GEMINI = 'resolved-key';

    const file = writeYaml(`
api:
  gemini_api_key: \${METUBE_GEMINI}
  gemini_model: gemini-test-model
database:
  path: custom/path.db
extraction:
  languages:
    - en
    - fr
`);

    const config = loadConfig({ configPath: file });

    expect(config.api.gemini_api_key).toBe('resolved-key');
    expect(config.api.gemini_model).toBe('gemini-test-model');
    expect(config.database.path).toBe('custom/path.db');
    expect(config.extraction.languages).toEqual(['en', 'fr']);
  });

  it('fills missing sections from schema defaults (merge-over-defaults)', () => {
    // Only the database section present; every other section must default.
    const file = writeYaml(`
database:
  path: only/db.db
`);

    const config = loadConfig({ configPath: file });

    expect(config.database.path).toBe('only/db.db');
    // Defaults from MeTubeConfigSchema:
    expect(config.api.gemini_model).toBe('gemini-3-flash-preview');
    expect(config.reports.output_dir).toBe('reports/');
    expect(config.extraction.auto_transcript).toBe(true);
    expect(config.extraction.whisper.model).toBe('base');
    expect(config.logging.level).toBe('INFO');
  });

  it('returns full schema defaults when the file does not exist', () => {
    const missing = path.join(tmpDir, 'does-not-exist.yaml');

    const config = loadConfig({ configPath: missing });

    expect(config.database.path).toBe('data/metube.db');
    expect(config.api.gemini_model).toBe('gemini-3-flash-preview');
    expect(config.reports.output_dir).toBe('reports/');
  });

  it('returns schema defaults when the file is unreadable / malformed YAML', () => {
    // A YAML document that parses to a scalar (not a mapping) — the loader
    // must tolerate it the way Python tolerates a missing file, not crash.
    const file = writeYaml(`!!str just-a-scalar-not-a-map`);

    const config = loadConfig({ configPath: file });

    expect(config.database.path).toBe('data/metube.db');
  });

  it('keeps a literal ${VAR} for an unset env var (does not crash the parse)', () => {
    rememberEnv('METUBE_ABSENT_GEMINI');
    delete process.env.METUBE_ABSENT_GEMINI;

    const file = writeYaml(`
api:
  gemini_api_key: \${METUBE_ABSENT_GEMINI}
`);

    const config = loadConfig({ configPath: file });

    // Matches Python: unsubstituted literal survives; optional string field
    // accepts it. Downstream code treats a literal ${...} as "no key set".
    expect(config.api.gemini_api_key).toBe('${METUBE_ABSENT_GEMINI}');
  });

  it('agrees with the repo-root config/config.yaml shape (real file parses)', () => {
    // Guard against schema/file drift: the checked-in config must validate.
    const repoConfig = path.resolve(process.cwd(), 'config', 'config.yaml');
    const config = loadConfig({ configPath: repoConfig });

    // The real file sets these concrete values.
    expect(config.database.path).toBe('data/metube.db');
    expect(config.extraction.whisper.enabled).toBe(true);
    expect(config.reports.output_dir).toBe('reports/');
  });
});

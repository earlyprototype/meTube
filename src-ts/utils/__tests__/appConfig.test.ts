/**
 * Coverage for loadAppPaths (task 8 / PARITY.md row E): the UI-side resolver
 * that reads the DB path + reports dir from config instead of hardcoding them.
 * Verifies the config values flow through, the reports trailing slash is
 * stripped, and a present-but-broken config throws ConfigError (so each
 * command's catch can render the remediation).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const loadConfigSpy = vi.fn();

vi.mock('../../../src-ts-v2/config/loadConfig.js', () => ({
  loadConfig: () => loadConfigSpy(),
}));

import {
  loadAppPaths,
  isUnsubstitutedPlaceholder,
  isGeminiConfigured,
} from '../appConfig.js';
import { ConfigError } from '../../../src-ts-v2/errors/ConfigError.js';

afterEach(() => {
  loadConfigSpy.mockReset();
});

describe('loadAppPaths', () => {
  it('returns the DB path and reports dir from config', () => {
    loadConfigSpy.mockReturnValue({
      database: { path: '/custom/db.sqlite' },
      reports: { output_dir: '/custom/reports/' },
    });

    const paths = loadAppPaths();

    expect(paths.dbPath).toBe('/custom/db.sqlite');
    // Trailing slash stripped.
    expect(paths.reportsDir).toBe('/custom/reports');
  });

  it('strips multiple trailing slashes from the reports dir', () => {
    loadConfigSpy.mockReturnValue({
      database: { path: 'data/metube.db' },
      reports: { output_dir: 'reports///' },
    });

    expect(loadAppPaths().reportsDir).toBe('reports');
  });

  it('propagates a ConfigError from a broken config (for the remediation path)', () => {
    loadConfigSpy.mockImplementation(() => {
      throw new ConfigError('broken yaml', { configPath: 'config/config.yaml' });
    });

    expect(() => loadAppPaths()).toThrow(ConfigError);
  });
});

describe('isUnsubstitutedPlaceholder', () => {
  it('returns true for an exact ${VAR} literal', () => {
    expect(isUnsubstitutedPlaceholder('${GEMINI_API_KEY}')).toBe(true);
    expect(isUnsubstitutedPlaceholder('${A}')).toBe(true);
    expect(isUnsubstitutedPlaceholder('${_underscore_lead}')).toBe(true);
  });

  it('returns false for a real key value', () => {
    expect(isUnsubstitutedPlaceholder('AIzaSyExampleRealKey123')).toBe(false);
  });

  it('returns false for empty, null, or undefined', () => {
    expect(isUnsubstitutedPlaceholder('')).toBe(false);
    expect(isUnsubstitutedPlaceholder(null)).toBe(false);
    expect(isUnsubstitutedPlaceholder(undefined)).toBe(false);
  });

  it('returns false for a string that merely contains a placeholder or has a bad var name', () => {
    expect(isUnsubstitutedPlaceholder('prefix-${VAR}')).toBe(false);
    expect(isUnsubstitutedPlaceholder('${VAR}-suffix')).toBe(false);
    // A leading digit is not a valid env-var name.
    expect(isUnsubstitutedPlaceholder('${1BAD}')).toBe(false);
  });
});

describe('isGeminiConfigured', () => {
  it('treats a literal ${VAR} placeholder with no env as NOT configured', () => {
    expect(isGeminiConfigured('${GEMINI_API_KEY}', undefined)).toBe(false);
  });

  it('treats a real key in config as configured', () => {
    expect(isGeminiConfigured('AIzaSyRealKey', undefined)).toBe(true);
  });

  it('treats an env-only key as configured even when config is a placeholder', () => {
    expect(isGeminiConfigured('${GEMINI_API_KEY}', 'env-key')).toBe(true);
  });

  it('treats an env-only key as configured when config is absent', () => {
    expect(isGeminiConfigured(undefined, 'env-key')).toBe(true);
  });

  it('treats both-absent as NOT configured', () => {
    expect(isGeminiConfigured(undefined, undefined)).toBe(false);
    expect(isGeminiConfigured(null, undefined)).toBe(false);
  });

  it('treats an env placeholder as NOT configured', () => {
    // Defensive: if the env itself somehow held the literal, it is not a key.
    expect(isGeminiConfigured(undefined, '${GEMINI_API_KEY}')).toBe(false);
  });
});

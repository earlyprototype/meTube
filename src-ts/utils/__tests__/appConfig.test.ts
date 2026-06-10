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

import { loadAppPaths } from '../appConfig.js';
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

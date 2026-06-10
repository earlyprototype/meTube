/**
 * End-to-end coverage that a ConfigError from the config loader surfaces
 * through ExtractCommand's ErrorDisplay WITH the CONFIG_ERROR remediation
 * (task 8 requirement: "A ConfigError thrown by loadConfig must surface through
 * the normal ErrorDisplay path with the remediation entry from task 4").
 *
 * loadAppPaths is mocked to throw the ConfigError the loader would raise for a
 * present-but-broken config; everything else the path would reach is irrelevant
 * because the throw happens before any service call.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../../../src-ts-v2/errors/ConfigError.js';

vi.mock('../../utils/appConfig.js', () => ({
  loadAppPaths: () => {
    throw new ConfigError("Config file at 'config/config.yaml' is not valid YAML: bad indent", {
      configPath: 'config/config.yaml',
    });
  },
}));

// Keep the resolver/auth/etc. unreached but importable.
vi.mock('../../../src-ts-v2/database/connection.js', () => ({
  DatabaseManager: class {
    constructor(_p: string) {}
    close() {}
  },
}));

import { ExtractCommand } from '../ExtractCommand.js';

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExtractCommand — ConfigError remediation', () => {
  it('renders the CONFIG_ERROR remediation steps on a broken config', async () => {
    const { lastFrame } = render(
      <ExtractCommand type="playlist" id="PLtest" flags={{}} onComplete={() => {}} />
    );
    await settle();

    const frame = lastFrame() ?? '';
    // The error message surfaces.
    expect(frame).toContain('not valid YAML');
    // The remediation block (numbered "Try this" steps) names config.yaml.
    expect(frame).toContain('Try this:');
    expect(frame).toContain('config/config.yaml');
  });
});

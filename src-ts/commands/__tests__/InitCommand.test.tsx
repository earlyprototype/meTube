/**
 * Coverage for init feedback (PARITY.md section C, task 5): the authenticated
 * channel name + Gemini-key status lines Python prints (cli.py:254-267). The TS
 * success box previously showed only a generic message.
 *
 * v2 services + the channel lookup are stubbed at the module boundary.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateSpy = vi.fn().mockResolvedValue({});
const fetchChannelTitleSpy = vi.fn();
const loadConfigSpy = vi.fn();

vi.mock('../../../src-ts-v2/database/connection.js', () => ({
  DatabaseManager: class {
    constructor(_path: string) {}
    close() {}
  },
}));

vi.mock('../../../src-ts-v2/auth/YouTubeAuth.js', () => ({
  YouTubeAuth: class {
    constructor(_opts?: unknown) {}
    async authenticate() {
      return authenticateSpy();
    }
    loadTokens() {
      throw new Error('no tokens');
    }
  },
}));

vi.mock('../../../src-ts-v2/config/loadConfig.js', () => ({
  loadConfig: () => loadConfigSpy(),
}));

vi.mock('../../utils/channelInfo.js', () => ({
  fetchChannelTitle: (...args: unknown[]) => fetchChannelTitleSpy(...args),
}));

// StatusPanel touches the DB on mount; stub it out for a hermetic render.
vi.mock('../../components/StatusPanel.js', () => ({
  StatusPanel: () => null,
}));

import { InitCommand } from '../InitCommand.js';

function config(geminiKey?: string) {
  return {
    api: {
      youtube_credentials: 'client_secret.json',
      token_file: 'tokens.json',
      gemini_api_key: geminiKey,
      gemini_model: 'gemini-3-flash-preview',
      rate_limit_delay: 0.3,
      max_retries: 3,
    },
    database: { path: 'data/metube.db', backup_enabled: true, backup_path: '', auto_vacuum: true },
    extraction: {},
    reports: {},
    logging: {},
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let savedGeminiKey: string | undefined;

beforeEach(() => {
  authenticateSpy.mockClear().mockResolvedValue({});
  fetchChannelTitleSpy.mockReset();
  loadConfigSpy.mockReset();
  savedGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  if (savedGeminiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = savedGeminiKey;
  }
  vi.restoreAllMocks();
});

describe('init feedback', () => {
  it('renders the authenticated channel name', async () => {
    loadConfigSpy.mockReturnValue(config('a-key'));
    fetchChannelTitleSpy.mockResolvedValue('My Channel');

    const { frames } = render(<InitCommand onComplete={() => {}} />);
    await settle();

    expect(frames.join('\n')).toContain('Authenticated as:');
    expect(frames.join('\n')).toContain('My Channel');
  });

  it('shows the Gemini-key configured line when a key is present', async () => {
    loadConfigSpy.mockReturnValue(config('a-key'));
    fetchChannelTitleSpy.mockResolvedValue(null);

    const { frames } = render(<InitCommand onComplete={() => {}} />);
    await settle();

    expect(frames.join('\n')).toContain('Gemini API key configured');
  });

  it('shows the Gemini-key warning when no key is configured', async () => {
    loadConfigSpy.mockReturnValue(config(undefined));
    fetchChannelTitleSpy.mockResolvedValue(null);

    const { frames } = render(<InitCommand onComplete={() => {}} />);
    await settle();

    expect(frames.join('\n')).toContain('Gemini API key not set');
  });

  it('falls back to env GEMINI_API_KEY when config omits it', async () => {
    process.env.GEMINI_API_KEY = 'env-key';
    loadConfigSpy.mockReturnValue(config(undefined));
    fetchChannelTitleSpy.mockResolvedValue(null);

    const { frames } = render(<InitCommand onComplete={() => {}} />);
    await settle();

    expect(frames.join('\n')).toContain('Gemini API key configured');
  });

  it('shows the warning when config holds an unsubstituted ${VAR} placeholder and env is unset', async () => {
    // config/config.yaml carries `gemini_api_key: ${GEMINI_API_KEY}`; with the
    // env var unset the loader leaves that literal in place. It is truthy but
    // not a real key, so init must NOT claim Gemini is configured.
    loadConfigSpy.mockReturnValue(config('${GEMINI_API_KEY}'));
    fetchChannelTitleSpy.mockResolvedValue(null);

    const { frames } = render(<InitCommand onComplete={() => {}} />);
    await settle();

    const all = frames.join('\n');
    expect(all).toContain('Gemini API key not set');
    expect(all).not.toContain('Gemini API key configured');
  });

  it('treats env GEMINI_API_KEY as configured even when config holds a placeholder', async () => {
    // A real env key wins over the unsubstituted config placeholder.
    process.env.GEMINI_API_KEY = 'env-key';
    loadConfigSpy.mockReturnValue(config('${GEMINI_API_KEY}'));
    fetchChannelTitleSpy.mockResolvedValue(null);

    const { frames } = render(<InitCommand onComplete={() => {}} />);
    await settle();

    expect(frames.join('\n')).toContain('Gemini API key configured');
  });

  it('still completes when the channel name cannot be fetched', async () => {
    loadConfigSpy.mockReturnValue(config('a-key'));
    fetchChannelTitleSpy.mockResolvedValue(null);

    const { frames } = render(<InitCommand onComplete={() => {}} />);
    await settle();

    const all = frames.join('\n');
    expect(all).toContain('Initialization Complete');
    expect(all).not.toContain('Authenticated as:');
  });
});

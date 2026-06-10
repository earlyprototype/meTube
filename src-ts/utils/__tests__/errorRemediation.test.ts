/**
 * Coverage for the error-code -> remediation-steps map (PARITY.md section C,
 * task 4). Python maps an error code to a numbered fix list
 * (`legacy/python/src/cli.py:236-243` for the missing-credentials case;
 * :266-267 for the Gemini-key warning). The v2 UI previously surfaced only a
 * bare code token. `getRemediation` reinstates the numbered steps; codes
 * without an entry return `undefined` so they render exactly as before.
 */

import { describe, it, expect } from 'vitest';

import { getRemediation } from '../errorRemediation.js';

describe('getRemediation', () => {
  it('maps MISSING_CREDS to the numbered Google-Cloud setup steps Python prints', () => {
    const steps = getRemediation('MISSING_CREDS');

    expect(steps).toBeDefined();
    // Python prints exactly five steps (cli.py:238-242).
    expect(steps).toHaveLength(5);
    expect(steps?.[0]).toContain('console.cloud.google.com');
    expect(steps?.some((s) => s.includes('YouTube Data API'))).toBe(true);
    expect(steps?.some((s) => s.includes('client_secret.json'))).toBe(true);
  });

  it('maps CONFIG_ERROR to config.yaml guidance, folding in the cause when given', () => {
    const steps = getRemediation('CONFIG_ERROR', {
      configPath: 'config/config.yaml',
      cause: 'bad indentation at line 3',
    });

    expect(steps).toBeDefined();
    const joined = steps?.join('\n') ?? '';
    expect(joined).toContain('config/config.yaml');
    expect(joined).toContain('bad indentation at line 3');
  });

  it('renders CONFIG_ERROR guidance even without context', () => {
    const steps = getRemediation('CONFIG_ERROR');

    expect(steps).toBeDefined();
    expect(steps?.join('\n')).toContain('config.yaml');
  });

  it('maps Gemini failures to the GEMINI_API_KEY .env guidance', () => {
    const steps = getRemediation('GEMINI_API_ERROR');

    expect(steps).toBeDefined();
    expect(steps?.some((s) => s.includes('GEMINI_API_KEY'))).toBe(true);
  });

  it('maps the Whisper toolchain codes to install guidance', () => {
    expect(getRemediation('PYTHON_NOT_FOUND')?.join('\n')).toContain('Python');
    expect(getRemediation('YT_DLP_NOT_FOUND')?.join('\n')).toContain('yt-dlp');
  });

  it('returns undefined for an unmapped code (renders as before)', () => {
    expect(getRemediation('YOUTUBE_API_ERROR')).toBeUndefined();
    expect(getRemediation('SOME_NOVEL_CODE')).toBeUndefined();
  });

  it('returns undefined when no code is supplied', () => {
    expect(getRemediation(undefined)).toBeUndefined();
  });
});

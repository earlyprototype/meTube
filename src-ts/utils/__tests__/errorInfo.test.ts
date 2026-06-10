/**
 * Coverage for buildErrorInfo — the shared adapter that turns an unknown
 * thrown value into the `{ code, remediationContext }` ErrorDisplay needs to
 * render code-driven remediation (task 4). Used by every command's error path
 * so the numbered fix steps appear uniformly.
 */

import { describe, it, expect } from 'vitest';

import { AppError } from '../../../src-ts-v2/errors/AppError.js';
import { ConfigError } from '../../../src-ts-v2/errors/ConfigError.js';
import { buildErrorInfo } from '../errorInfo.js';

describe('buildErrorInfo', () => {
  it('returns null for a non-AppError value (renders message only)', () => {
    expect(buildErrorInfo(new Error('plain'))).toBeNull();
    expect(buildErrorInfo('a string')).toBeNull();
    expect(buildErrorInfo(undefined)).toBeNull();
  });

  it('extracts the code from an AppError', () => {
    const info = buildErrorInfo(new AppError('boom', { code: 'MISSING_CREDS' }));

    expect(info).not.toBeNull();
    expect(info?.code).toBe('MISSING_CREDS');
  });

  it('threads configPath + the message as cause for a ConfigError', () => {
    const err = new ConfigError("Config file at 'config/config.yaml' is not valid YAML: bad indent", {
      configPath: 'config/config.yaml',
    });

    const info = buildErrorInfo(err);

    expect(info?.code).toBe('CONFIG_ERROR');
    expect(info?.remediationContext?.configPath).toBe('config/config.yaml');
    // The cause is the human-readable message the loader built.
    expect(info?.remediationContext?.cause).toContain('not valid YAML');
  });

  it('omits remediationContext when an AppError carries no useful context', () => {
    const info = buildErrorInfo(new AppError('boom', { code: 'YOUTUBE_API_ERROR' }));

    expect(info?.code).toBe('YOUTUBE_API_ERROR');
    expect(info?.remediationContext).toBeUndefined();
  });
});

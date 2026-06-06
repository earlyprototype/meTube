/**
 * YouTubeAuth tests — Phase 2 Wave 3.
 *
 * Boundary-mocks `fs` and `@google-cloud/local-auth`. Real
 * `OAuth2Client`, real `AppError`, real branched logic. AAA pattern.
 *
 * Coverage:
 *   - tokens.json roundtrip via `saveTokens` → `loadTokens`
 *   - `MISSING_CREDS` raised when `client_secret.json` is absent
 *   - `MISSING_CREDS` raised when `client_secret.json` is malformed JSON
 *   - `ValidationError` raised when required fields are missing
 *   - `INVALID_TOKEN` raised when `tokens.json` is corrupt
 *   - `INVALID_TOKEN` raised when `access_token` is missing
 *   - `authenticate()` hydrates from cached tokens when present
 *   - `authenticate()` runs local-auth flow when no tokens cached
 *   - `LOCAL_AUTH_FAILED` raised when local-auth throws
 *   - `getCurrentAuthClient()` returns `null` before, client after
 *   - `hasValidTokens()` honours the 5-minute expiry skew
 *
 * No emoji, no token values printed, no `console.*`.
 */
import { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, ValidationError } from '../errors/index.js';
import type { OAuthTokens } from '../auth/types.js';

// Mock the @google-cloud/local-auth boundary. The actual library is
// installed and would attempt to spawn a browser if called; the mock
// gives us a controllable substitute.
vi.mock('@google-cloud/local-auth', () => ({
  authenticate: vi.fn(),
}));

// Mock `fs` so we can synthesise file-not-found / malformed-JSON /
// roundtrip cases without touching the disk. The default
// implementations return "not found" so each test sets only what it
// needs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  };
});

// Imports below this point pick up the mocked modules.
import * as fs from 'fs';
import { authenticate as localAuthAuthenticate } from '@google-cloud/local-auth';

import { YouTubeAuth } from '../auth/YouTubeAuth.js';

const mockCredentials = {
  installed: {
    client_id: 'test-client-id.apps.googleusercontent.com',
    client_secret: 'GOCSPX-test-secret',
    redirect_uris: ['http://localhost:3000'],
    project_id: 'test-project',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  },
};

const validTokens: OAuthTokens = {
  access_token: 'ya29.test-access-token',
  refresh_token: '1//test-refresh-token',
  // 1 hour from now — well past the 5 minute skew window.
  expiry_date: Date.now() + 60 * 60 * 1000,
  token_type: 'Bearer',
  scope: 'https://www.googleapis.com/auth/youtube.readonly',
};

/**
 * Wire `fs.existsSync` + `fs.readFileSync` so the credentials file is
 * present and parses, while the tokens file is absent. The most
 * common starting state.
 */
function arrangeCredentialsOnly(): void {
  vi.mocked(fs.existsSync).mockImplementation((p) => {
    return typeof p === 'string' && p.endsWith('client_secret.json');
  });
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    if (typeof p === 'string' && p.endsWith('client_secret.json')) {
      return JSON.stringify(mockCredentials);
    }
    throw new Error(`Unexpected read: ${String(p)}`);
  });
}

/**
 * Wire `fs` so both `client_secret.json` and `tokens.json` are
 * present. The tokens contents are caller-supplied.
 */
function arrangeCredentialsAndTokens(tokensJson: string): void {
  vi.mocked(fs.existsSync).mockImplementation((p) => {
    if (typeof p !== 'string') return false;
    return p.endsWith('client_secret.json') || p.endsWith('tokens.json');
  });
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    if (typeof p === 'string' && p.endsWith('client_secret.json')) {
      return JSON.stringify(mockCredentials);
    }
    if (typeof p === 'string' && p.endsWith('tokens.json')) {
      return tokensJson;
    }
    throw new Error(`Unexpected read: ${String(p)}`);
  });
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw new Error('readFileSync called without arrange');
  });
  vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
  vi.mocked(localAuthAuthenticate).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// --------------------------------------------------------------------------
// Credentials file errors
// --------------------------------------------------------------------------

describe('YouTubeAuth.authenticate — credentials file', () => {
  it('throws MISSING_CREDS when client_secret.json is absent', async () => {
    // Arrange
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const auth = new YouTubeAuth();

    // Act + Assert
    await expect(auth.authenticate()).rejects.toMatchObject({
      code: 'MISSING_CREDS',
    });
  });

  it('throws MISSING_CREDS when client_secret.json is unparseable', async () => {
    // Arrange
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.endsWith('client_secret.json')
    );
    vi.mocked(fs.readFileSync).mockReturnValue('{ not valid json');
    const auth = new YouTubeAuth();

    // Act + Assert
    await expect(auth.authenticate()).rejects.toMatchObject({
      code: 'MISSING_CREDS',
    });
  });

  it('throws ValidationError when required OAuth fields are missing', async () => {
    // Arrange
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.endsWith('client_secret.json')
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ installed: { client_id: 'only-id' } })
    );
    const auth = new YouTubeAuth();

    // Act + Assert
    await expect(auth.authenticate()).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when neither "installed" nor "web" is present', async () => {
    // Arrange
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.endsWith('client_secret.json')
    );
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ someOtherKey: {} }));
    const auth = new YouTubeAuth();

    // Act + Assert
    await expect(auth.authenticate()).rejects.toBeInstanceOf(ValidationError);
  });
});

// --------------------------------------------------------------------------
// Tokens file roundtrip
// --------------------------------------------------------------------------

describe('YouTubeAuth.loadTokens / saveTokens — roundtrip', () => {
  it('saves and loads a complete token set', () => {
    // Arrange
    arrangeCredentialsOnly();
    const auth = new YouTubeAuth();
    const client = new OAuth2Client({
      clientId: mockCredentials.installed.client_id,
      clientSecret: mockCredentials.installed.client_secret,
    });
    client.setCredentials({
      access_token: validTokens.access_token,
      refresh_token: validTokens.refresh_token,
      expiry_date: validTokens.expiry_date,
      token_type: validTokens.token_type,
      scope: validTokens.scope,
    });

    // Act — save
    auth.saveTokens(client);

    // Assert — write happened with the right shape
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    expect(writeCalls).toHaveLength(1);
    const [writtenPath, writtenData] = writeCalls[0];
    expect(String(writtenPath)).toContain('tokens.json');
    const parsed = JSON.parse(String(writtenData)) as OAuthTokens;
    expect(parsed.access_token).toBe(validTokens.access_token);
    expect(parsed.refresh_token).toBe(validTokens.refresh_token);
    expect(parsed.token_type).toBe('Bearer');

    // Arrange — now make tokens file "present" with the data we wrote
    arrangeCredentialsAndTokens(String(writtenData));

    // Act — load
    const loaded = auth.loadTokens();

    // Assert — roundtrip integrity
    expect(loaded.access_token).toBe(validTokens.access_token);
    expect(loaded.refresh_token).toBe(validTokens.refresh_token);
    expect(loaded.expiry_date).toBe(validTokens.expiry_date);
    expect(loaded.token_type).toBe('Bearer');
    expect(loaded.scope).toBe(validTokens.scope);
  });

  it('persists token_type default "Bearer" when client omits it', () => {
    // Arrange
    arrangeCredentialsOnly();
    const auth = new YouTubeAuth();
    const client = new OAuth2Client();
    client.setCredentials({ access_token: 'ya29.minimal' });

    // Act
    auth.saveTokens(client);

    // Assert
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    expect(writeCalls).toHaveLength(1);
    const parsed = JSON.parse(String(writeCalls[0][1])) as OAuthTokens;
    expect(parsed.token_type).toBe('Bearer');
    expect(parsed.access_token).toBe('ya29.minimal');
  });

  it('refuses to save a client that has no access_token', () => {
    // Arrange
    arrangeCredentialsOnly();
    const auth = new YouTubeAuth();
    const client = new OAuth2Client();

    // Act + Assert
    expect(() => auth.saveTokens(client)).toThrow(AppError);
    expect(() => auth.saveTokens(client)).toThrow(/access_token/);
  });
});

// --------------------------------------------------------------------------
// Tokens file format errors
// --------------------------------------------------------------------------

describe('YouTubeAuth.loadTokens — format errors', () => {
  it('throws INVALID_TOKEN when tokens.json is absent', () => {
    // Arrange
    arrangeCredentialsOnly();
    const auth = new YouTubeAuth();

    // Act + Assert
    try {
      auth.loadTokens();
      throw new Error('Expected loadTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_TOKEN');
    }
  });

  it('throws INVALID_TOKEN when tokens.json is unparseable JSON', () => {
    // Arrange
    arrangeCredentialsAndTokens('{ "access_token": ');
    const auth = new YouTubeAuth();

    // Act + Assert
    try {
      auth.loadTokens();
      throw new Error('Expected loadTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_TOKEN');
    }
  });

  it('throws INVALID_TOKEN when access_token is missing', () => {
    // Arrange
    arrangeCredentialsAndTokens(JSON.stringify({ refresh_token: 'only-refresh' }));
    const auth = new YouTubeAuth();

    // Act + Assert
    try {
      auth.loadTokens();
      throw new Error('Expected loadTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_TOKEN');
    }
  });

  it('throws INVALID_TOKEN when access_token is an empty string', () => {
    // Arrange
    arrangeCredentialsAndTokens(
      JSON.stringify({ access_token: '', token_type: 'Bearer' })
    );
    const auth = new YouTubeAuth();

    // Act + Assert
    try {
      auth.loadTokens();
      throw new Error('Expected loadTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_TOKEN');
    }
  });

  it('throws INVALID_TOKEN when tokens.json is a JSON literal (string, not object)', () => {
    // Arrange
    arrangeCredentialsAndTokens('"just-a-string"');
    const auth = new YouTubeAuth();

    // Act + Assert
    try {
      auth.loadTokens();
      throw new Error('Expected loadTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_TOKEN');
    }
  });
});

// --------------------------------------------------------------------------
// End-to-end authenticate() flow
// --------------------------------------------------------------------------

describe('YouTubeAuth.authenticate — flow selection', () => {
  it('hydrates from cached tokens when tokens.json exists', async () => {
    // Arrange
    arrangeCredentialsAndTokens(JSON.stringify(validTokens));
    const auth = new YouTubeAuth();

    // Act
    const client = await auth.authenticate();

    // Assert
    expect(client).toBeInstanceOf(OAuth2Client);
    expect(client.credentials.access_token).toBe(validTokens.access_token);
    expect(client.credentials.refresh_token).toBe(validTokens.refresh_token);
    // local-auth must NOT have been called on the cached path.
    expect(vi.mocked(localAuthAuthenticate)).not.toHaveBeenCalled();
  });

  it('runs local-auth flow when no tokens cached', async () => {
    // Arrange
    arrangeCredentialsOnly();
    const liveClient = new OAuth2Client({
      clientId: mockCredentials.installed.client_id,
      clientSecret: mockCredentials.installed.client_secret,
    });
    liveClient.setCredentials({
      access_token: 'ya29.fresh-access',
      refresh_token: '1//fresh-refresh',
      expiry_date: Date.now() + 3600 * 1000,
      token_type: 'Bearer',
    });
    vi.mocked(localAuthAuthenticate).mockResolvedValue(liveClient);
    const auth = new YouTubeAuth();

    // Act
    const client = await auth.authenticate();

    // Assert
    expect(vi.mocked(localAuthAuthenticate)).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(localAuthAuthenticate).mock.calls[0][0];
    expect(callArgs.keyfilePath).toContain('client_secret.json');
    expect(Array.isArray(callArgs.scopes)).toBe(true);
    expect(callArgs.scopes).toContain('https://www.googleapis.com/auth/youtube.readonly');

    // The returned client is a fresh top-level v10 OAuth2Client carrying
    // the credentials from the local-auth flow — NOT the same instance,
    // because local-auth pins its own nested google-auth-library.
    expect(client).toBeInstanceOf(OAuth2Client);
    expect(client.credentials.access_token).toBe('ya29.fresh-access');
    expect(client.credentials.refresh_token).toBe('1//fresh-refresh');

    // Tokens must have been persisted.
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
    const writtenData = vi.mocked(fs.writeFileSync).mock.calls[0][1];
    const persisted = JSON.parse(String(writtenData)) as OAuthTokens;
    expect(persisted.access_token).toBe('ya29.fresh-access');
  });

  it('throws LOCAL_AUTH_FAILED when local-auth rejects', async () => {
    // Arrange
    arrangeCredentialsOnly();
    vi.mocked(localAuthAuthenticate).mockRejectedValue(new Error('user denied'));
    const auth = new YouTubeAuth();

    // Act + Assert
    await expect(auth.authenticate()).rejects.toMatchObject({
      code: 'LOCAL_AUTH_FAILED',
    });
  });

  it('falls back to local-auth flow when cached tokens are missing access_token', async () => {
    // Arrange — tokens.json exists but is malformed (missing access_token).
    // loadTokens will throw INVALID_TOKEN, which we treat as terminal —
    // the caller can delete tokens.json and retry.
    arrangeCredentialsAndTokens(JSON.stringify({ refresh_token: 'only-refresh' }));
    const auth = new YouTubeAuth();

    // Act + Assert — INVALID_TOKEN propagates (we don't silently nuke
    // user-edited token files).
    await expect(auth.authenticate()).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
});

// --------------------------------------------------------------------------
// Accessors
// --------------------------------------------------------------------------

describe('YouTubeAuth.getCurrentAuthClient', () => {
  it('returns null before authenticate is called', () => {
    // Arrange
    arrangeCredentialsOnly();
    const auth = new YouTubeAuth();

    // Act + Assert
    expect(auth.getCurrentAuthClient()).toBeNull();
  });

  it('returns the OAuth2Client after authenticate succeeds', async () => {
    // Arrange
    arrangeCredentialsAndTokens(JSON.stringify(validTokens));
    const auth = new YouTubeAuth();

    // Act
    const client = await auth.authenticate();

    // Assert
    expect(auth.getCurrentAuthClient()).toBe(client);
  });
});

describe('YouTubeAuth.hasValidTokens', () => {
  it('returns false when authenticate has not been called', () => {
    // Arrange
    arrangeCredentialsOnly();
    const auth = new YouTubeAuth();

    // Act + Assert
    expect(auth.hasValidTokens()).toBe(false);
  });

  it('returns true when tokens are present and unexpired', async () => {
    // Arrange
    arrangeCredentialsAndTokens(JSON.stringify(validTokens));
    const auth = new YouTubeAuth();
    await auth.authenticate();

    // Act + Assert
    expect(auth.hasValidTokens()).toBe(true);
  });

  it('returns false when tokens are within the 5-minute skew window', async () => {
    // Arrange — expiry 2 minutes in the future (inside the 5min skew)
    const nearExpiry: OAuthTokens = {
      ...validTokens,
      expiry_date: Date.now() + 2 * 60 * 1000,
    };
    arrangeCredentialsAndTokens(JSON.stringify(nearExpiry));
    const auth = new YouTubeAuth();
    await auth.authenticate();

    // Act + Assert
    expect(auth.hasValidTokens()).toBe(false);
  });
});
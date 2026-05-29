/**
 * YouTubeAuth tests - auth regression repair.
 *
 * After the Wave 3 -> repair swap, the implementation is back to v1's
 * hand-rolled OAuth flow (OAuthServer + manual `generateAuthUrl` /
 * `getToken`) wrapped in v2's public API surface. Tests boundary-mock:
 *
 *   - `fs` for credentials / tokens disk reads + writes
 *   - `../auth/OAuthServer.js` for `captureAuthorizationCode` +
 *     `openBrowser` so the browser flow is fully controllable
 *   - `OAuth2Client.prototype.getToken` for the code-for-tokens
 *     exchange
 *
 * Real `OAuth2Client` (the constructor + `generateAuthUrl` +
 * `setCredentials` + `credentials` getter are exercised), real
 * `AppError`, real branched logic. AAA pattern.
 *
 * Coverage:
 *   - tokens.json roundtrip via `saveTokens` -> `loadTokens`
 *   - `MISSING_CREDS` raised when `client_secret.json` is absent
 *   - `MISSING_CREDS` raised when `client_secret.json` is malformed
 *     JSON
 *   - `ValidationError` raised when required fields are missing
 *   - `INVALID_TOKEN` raised when `tokens.json` is corrupt
 *   - `INVALID_TOKEN` raised when `access_token` is missing
 *   - `authenticate()` hydrates from cached tokens when present
 *   - `authenticate()` runs OAuthServer flow when no tokens cached
 *   - `authenticate()` threads CSRF state into the auth URL and the
 *     OAuthServer `expectedState`
 *   - `authenticate()` picks redirect URI from `client_secret.json`
 *     (prefer localhost:3000 -> localhost -> first)
 *   - `LOCAL_AUTH_FAILED` raised when capture fails
 *   - `LOCAL_AUTH_FAILED` raised when `getToken` fails
 *   - `LOCAL_AUTH_FAILED` raised when exchange returns no
 *     access_token
 *   - `getCurrentAuthClient()` returns `null` before, client after
 *   - `hasValidTokens()` honours the 5-minute expiry skew
 *
 * No emoji, no token values printed, no `console.*`.
 */
import { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, ValidationError } from '../errors/index.js';
import type { OAuthTokens } from '../auth/types.js';

// Mock the OAuthServer module - we control the captured code and the
// browser-launch outcome without spinning up a real HTTP server.
vi.mock('../auth/OAuthServer.js', () => ({
  captureAuthorizationCode: vi.fn(),
  openBrowser: vi.fn(),
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
import { captureAuthorizationCode, openBrowser } from '../auth/OAuthServer.js';

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
  // 1 hour from now - well past the 5 minute skew window.
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

/**
 * Wire `fs` with a custom credentials JSON string. Used to test the
 * redirect-URI selection logic against credentials shapes that differ
 * from the default `mockCredentials`.
 */
function arrangeCustomCredentials(credsJson: string): void {
  vi.mocked(fs.existsSync).mockImplementation((p) => {
    return typeof p === 'string' && p.endsWith('client_secret.json');
  });
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    if (typeof p === 'string' && p.endsWith('client_secret.json')) {
      return credsJson;
    }
    throw new Error(`Unexpected read: ${String(p)}`);
  });
}

/**
 * Stub `OAuth2Client.prototype.getToken` to return the given
 * credentials. The real method would round-trip to Google; we
 * short-circuit it for tests. Returns the mock so callers can assert
 * on call args (e.g. that `redirect_uri` was threaded through).
 */
function stubGetTokenWith(creds: Record<string, unknown>): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(OAuth2Client.prototype, 'getToken')
    .mockResolvedValue({ tokens: creds, res: null } as never);
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw new Error('readFileSync called without arrange');
  });
  vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
  vi.mocked(captureAuthorizationCode).mockReset();
  vi.mocked(openBrowser).mockReset();
  // Default openBrowser to succeed - individual tests override.
  vi.mocked(openBrowser).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// --------------------------------------------------------------------------
// Credentials file errors
// --------------------------------------------------------------------------

describe('YouTubeAuth.authenticate - credentials file', () => {
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

describe('YouTubeAuth.loadTokens / saveTokens - roundtrip', () => {
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

    // Act - save
    auth.saveTokens(client);

    // Assert - write happened with the right shape
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    expect(writeCalls).toHaveLength(1);
    const [writtenPath, writtenData] = writeCalls[0];
    expect(String(writtenPath)).toContain('tokens.json');
    const parsed = JSON.parse(String(writtenData)) as OAuthTokens;
    expect(parsed.access_token).toBe(validTokens.access_token);
    expect(parsed.refresh_token).toBe(validTokens.refresh_token);
    expect(parsed.token_type).toBe('Bearer');

    // Arrange - now make tokens file "present" with the data we wrote
    arrangeCredentialsAndTokens(String(writtenData));

    // Act - load
    const loaded = auth.loadTokens();

    // Assert - roundtrip integrity
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

describe('YouTubeAuth.loadTokens - format errors', () => {
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
    arrangeCredentialsAndTokens(JSON.stringify({ access_token: '', token_type: 'Bearer' }));
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

describe('YouTubeAuth.authenticate - flow selection', () => {
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
    // OAuthServer must NOT have been called on the cached path.
    expect(vi.mocked(captureAuthorizationCode)).not.toHaveBeenCalled();
    expect(vi.mocked(openBrowser)).not.toHaveBeenCalled();
  });

  it('runs OAuthServer flow when no tokens cached', async () => {
    // Arrange
    arrangeCredentialsOnly();
    vi.mocked(captureAuthorizationCode).mockResolvedValue('mock-authorization-code');
    const getTokenSpy = stubGetTokenWith({
      access_token: 'ya29.fresh-access',
      refresh_token: '1//fresh-refresh',
      expiry_date: Date.now() + 3600 * 1000,
      token_type: 'Bearer',
    });
    const auth = new YouTubeAuth();

    // Act
    const client = await auth.authenticate();

    // Assert - OAuthServer capture was called with a port + state
    expect(vi.mocked(captureAuthorizationCode)).toHaveBeenCalledTimes(1);
    const captureArgs = vi.mocked(captureAuthorizationCode).mock.calls[0][0];
    expect(captureArgs?.port).toBe(3000);
    expect(typeof captureArgs?.expectedState).toBe('string');
    expect((captureArgs?.expectedState ?? '').length).toBeGreaterThan(0);

    // Browser open was attempted
    expect(vi.mocked(openBrowser)).toHaveBeenCalledTimes(1);
    const browserUrl = vi.mocked(openBrowser).mock.calls[0][0];
    expect(browserUrl).toContain('access_type=offline');
    expect(browserUrl).toContain('prompt=consent');
    expect(browserUrl).toContain('response_type=code');
    expect(browserUrl).toContain('state=');
    expect(browserUrl).toContain('localhost%3A3000');

    // Token exchange was called with the matching redirect_uri
    expect(getTokenSpy).toHaveBeenCalledTimes(1);
    const tokenArgs = getTokenSpy.mock.calls[0][0];
    expect(tokenArgs).toMatchObject({
      code: 'mock-authorization-code',
      redirect_uri: 'http://localhost:3000',
    });

    // The returned client carries the credentials from the exchange.
    expect(client).toBeInstanceOf(OAuth2Client);
    expect(client.credentials.access_token).toBe('ya29.fresh-access');
    expect(client.credentials.refresh_token).toBe('1//fresh-refresh');

    // Tokens must have been persisted.
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
    const writtenData = vi.mocked(fs.writeFileSync).mock.calls[0][1];
    const persisted = JSON.parse(String(writtenData)) as OAuthTokens;
    expect(persisted.access_token).toBe('ya29.fresh-access');
  });

  it('threads the same CSRF state into the auth URL and OAuthServer', async () => {
    // Arrange
    arrangeCredentialsOnly();
    vi.mocked(captureAuthorizationCode).mockResolvedValue('mock-code');
    stubGetTokenWith({ access_token: 'ya29.t', token_type: 'Bearer' });
    const auth = new YouTubeAuth();

    // Act
    await auth.authenticate();

    // Assert - extract state from both sides and compare
    const urlPassed = String(vi.mocked(openBrowser).mock.calls[0][0]);
    const urlState = new URL(urlPassed).searchParams.get('state');
    const captureState = vi.mocked(captureAuthorizationCode).mock.calls[0][0]?.expectedState;
    expect(urlState).toBeTruthy();
    expect(urlState).toBe(captureState);
  });

  it('proceeds even when openBrowser fails (user pastes URL manually)', async () => {
    // Arrange
    arrangeCredentialsOnly();
    vi.mocked(openBrowser).mockRejectedValue(new Error('no display'));
    vi.mocked(captureAuthorizationCode).mockResolvedValue('mock-code');
    stubGetTokenWith({ access_token: 'ya29.t', token_type: 'Bearer' });
    const auth = new YouTubeAuth();

    // Act
    const client = await auth.authenticate();

    // Assert - capture still ran and produced a usable client
    expect(vi.mocked(captureAuthorizationCode)).toHaveBeenCalledTimes(1);
    expect(client.credentials.access_token).toBe('ya29.t');
  });

  it('throws LOCAL_AUTH_FAILED when captureAuthorizationCode rejects', async () => {
    // Arrange
    arrangeCredentialsOnly();
    vi.mocked(captureAuthorizationCode).mockRejectedValue(
      new AppError('user denied', { code: 'OAUTH_USER_DENIED' })
    );
    const auth = new YouTubeAuth();

    // Act + Assert
    await expect(auth.authenticate()).rejects.toMatchObject({
      code: 'LOCAL_AUTH_FAILED',
    });
  });

  it('throws LOCAL_AUTH_FAILED when getToken rejects', async () => {
    // Arrange
    arrangeCredentialsOnly();
    vi.mocked(captureAuthorizationCode).mockResolvedValue('mock-code');
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockRejectedValue(new Error('invalid_grant'));
    const auth = new YouTubeAuth();

    // Act + Assert
    await expect(auth.authenticate()).rejects.toMatchObject({
      code: 'LOCAL_AUTH_FAILED',
    });
  });

  it('throws LOCAL_AUTH_FAILED when token exchange returns no access_token', async () => {
    // Arrange
    arrangeCredentialsOnly();
    vi.mocked(captureAuthorizationCode).mockResolvedValue('mock-code');
    stubGetTokenWith({ token_type: 'Bearer' });
    const auth = new YouTubeAuth();

    // Act + Assert
    await expect(auth.authenticate()).rejects.toMatchObject({
      code: 'LOCAL_AUTH_FAILED',
    });
  });

  it('propagates INVALID_TOKEN when cached tokens are malformed', async () => {
    // Arrange - tokens.json exists but is missing access_token.
    // loadTokens throws INVALID_TOKEN, which we treat as terminal -
    // the caller can delete tokens.json and retry.
    arrangeCredentialsAndTokens(JSON.stringify({ refresh_token: 'only-refresh' }));
    const auth = new YouTubeAuth();

    // Act + Assert - INVALID_TOKEN propagates (we don't silently nuke
    // user-edited token files).
    await expect(auth.authenticate()).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
});

// --------------------------------------------------------------------------
// Redirect URI selection
// --------------------------------------------------------------------------

describe('YouTubeAuth.authenticate - redirect URI selection', () => {
  it('prefers localhost:3000 when present in redirect_uris', async () => {
    // Arrange - multiple URIs; localhost:3000 is not first
    arrangeCustomCredentials(
      JSON.stringify({
        installed: {
          client_id: 'id',
          client_secret: 'secret',
          redirect_uris: [
            'urn:ietf:wg:oauth:2.0:oob',
            'http://localhost:8080',
            'http://localhost:3000',
          ],
        },
      })
    );
    vi.mocked(captureAuthorizationCode).mockResolvedValue('mock-code');
    stubGetTokenWith({ access_token: 'ya29.t', token_type: 'Bearer' });
    const auth = new YouTubeAuth();

    // Act
    await auth.authenticate();

    // Assert
    const browserUrl = String(vi.mocked(openBrowser).mock.calls[0][0]);
    expect(browserUrl).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000');
  });

  it('falls back to any localhost entry when localhost:3000 is absent', async () => {
    // Arrange
    arrangeCustomCredentials(
      JSON.stringify({
        installed: {
          client_id: 'id',
          client_secret: 'secret',
          redirect_uris: ['urn:ietf:wg:oauth:2.0:oob', 'http://localhost:8080'],
        },
      })
    );
    vi.mocked(captureAuthorizationCode).mockResolvedValue('mock-code');
    stubGetTokenWith({ access_token: 'ya29.t', token_type: 'Bearer' });
    const auth = new YouTubeAuth();

    // Act
    await auth.authenticate();

    // Assert
    const browserUrl = String(vi.mocked(openBrowser).mock.calls[0][0]);
    expect(browserUrl).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A8080');
  });

  it('falls back to first redirect_uri when no localhost entry is present', async () => {
    // Arrange
    arrangeCustomCredentials(
      JSON.stringify({
        installed: {
          client_id: 'id',
          client_secret: 'secret',
          redirect_uris: ['https://example.com/callback', 'urn:ietf:wg:oauth:2.0:oob'],
        },
      })
    );
    vi.mocked(captureAuthorizationCode).mockResolvedValue('mock-code');
    stubGetTokenWith({ access_token: 'ya29.t', token_type: 'Bearer' });
    const auth = new YouTubeAuth();

    // Act
    await auth.authenticate();

    // Assert
    const browserUrl = String(vi.mocked(openBrowser).mock.calls[0][0]);
    expect(browserUrl).toContain('redirect_uri=https%3A%2F%2Fexample.com%2Fcallback');
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
    // Arrange - expiry 2 minutes in the future (inside the 5min skew)
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

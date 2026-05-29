/**
 * YouTubeAuth - OAuth 2.0 authentication for the YouTube Data API v3.
 *
 * This module restores v1's working hand-rolled OAuth flow inside v2's
 * public API surface. The earlier Wave 3 rewrite swapped in
 * `@google-cloud/local-auth`, which broke against the user's Google
 * Cloud Console OAuth client configuration (the library picks an
 * ephemeral redirect URI shape that does not match what's registered
 * in their Console). The fix: keep v2's public-API shape so the Ink
 * layer (src-ts/commands/*.tsx) does not need to change, but use v1's
 * proven implementation under the hood:
 *
 *   1. `OAuth2Client.generateAuthUrl(...)` with explicit
 *      `redirect_uri`, `access_type: 'offline'`, `prompt: 'consent'`,
 *      and `response_type: 'code'` (the v1 Windows fix from commit
 *      `3a35462` - googleapis no longer auto-sets `response_type` for
 *      Desktop clients).
 *   2. Hand-rolled `OAuthServer` (`captureAuthorizationCode`) on
 *      `localhost:3000` (the v1 port fix - port 80 requires admin on
 *      Windows; port 3000 is the URI the user has registered in their
 *      Console).
 *   3. Redirect URI picked from `client_secret.json`'s `redirect_uris`
 *      array (prefer `localhost:3000`, fall back to `localhost`, fall
 *      back to first entry) - matches v1 exactly so the user's Console
 *      config keeps working.
 *
 * v2 wins kept on top of the v1 flow:
 *   - OAuth `state` parameter generated per-auth via
 *     `crypto.randomBytes(32).toString('hex')` and threaded into
 *     `captureAuthorizationCode`'s `expectedState`. RFC 6749 section
 *     10.12 - cheap defence-in-depth.
 *   - Pino logging throughout (no `console.*`). Token contents are
 *     NEVER logged.
 *   - `AppError` with explicit codes (`MISSING_CREDS`,
 *     `INVALID_TOKEN`, `LOCAL_AUTH_FAILED`, `TOKENS_SAVE_FAILED`) so
 *     callers can branch on cause.
 *   - Zod-friendly shape-checking on `client_secret.json` and
 *     `tokens.json` (manual narrow rather than a Zod schema - kept
 *     simple because the shapes are tiny and stable).
 *
 * Public surface - kept identical to the Wave 3 v2 so the Ink call
 * sites do not move:
 *   - `authenticate(): Promise<OAuth2Client>` - one-shot end-to-end
 *     flow
 *   - `getCurrentAuthClient(): OAuth2Client | null` - accessor for
 *     callers that already share the client
 *   - `loadTokens(): OAuthTokens` - read tokens.json from disk;
 *     throws `INVALID_TOKEN` on missing/malformed (the Ink layer uses
 *     try/catch as a disk probe and tolerates this)
 *   - `saveTokens(client: OAuth2Client): void` - extract credentials
 *     from a live client and persist
 *   - `hasValidTokens(): boolean` - whether the cached client has
 *     non-expired tokens
 *
 * Sensitive-file contract: token contents are never printed or
 * logged. Tokens are written via `fs.writeFileSync(..., 'utf-8')` to
 * `tokens.json` (gitignored).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { OAuth2Client, type Credentials } from 'google-auth-library';

import { AppError, ValidationError } from '../errors/index.js';
import logger from '../utils/logger.js';
import type { OAuthConfig, OAuthCredentials, OAuthTokens, YouTubeAuthOptions } from './types.js';
import { captureAuthorizationCode, openBrowser } from './OAuthServer.js';

/**
 * Default OAuth scopes. Read-only for listing playlists / videos plus
 * force-ssl for the rare write endpoints (e.g.
 * `playlistItems.insert`).
 */
const DEFAULT_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

/**
 * Default local server port. NOT 80 - 80 requires admin on Windows.
 * 3000 matches what users actually register in their Google Cloud
 * Console redirect URIs (the v1 audit fix from commit `3a35462`).
 */
const DEFAULT_PORT = 3000;

/**
 * Skew tolerance for "is the access token still valid?" - 5 minutes,
 * matching v1.
 */
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * OAuth 2.0 authentication helper for YouTube Data API v3.
 *
 * Typical usage:
 *
 *   ```ts
 *   const auth = new YouTubeAuth();
 *   const client = await auth.authenticate();
 *   // pass `client` into googleapis:
 *   //   google.youtube({ version: 'v3', auth: client })
 *   ```
 */
export class YouTubeAuth {
  private readonly credentialsPath: string;
  private readonly tokensPath: string;
  private readonly scopes: string[];
  private readonly port: number;
  private currentClient: OAuth2Client | null = null;

  constructor(options: YouTubeAuthOptions = {}) {
    this.credentialsPath = options.credentialsPath
      ? path.resolve(options.credentialsPath)
      : path.resolve(process.cwd(), 'client_secret.json');
    this.tokensPath = options.tokensPath
      ? path.resolve(options.tokensPath)
      : path.resolve(process.cwd(), 'tokens.json');
    this.scopes = options.scopes ? [...options.scopes] : [...DEFAULT_SCOPES];
    this.port = options.port ?? DEFAULT_PORT;
  }

  /**
   * Drive an end-to-end auth flow:
   *   1. If `tokens.json` exists and parses, hydrate an
   *      `OAuth2Client` and return it (googleapis refreshes
   *      transparently on next API call).
   *   2. Otherwise, run the v1-style local server flow: generate a
   *      CSRF state, build the auth URL with explicit `redirect_uri`
   *      + `response_type=code`, start the one-shot localhost:3000
   *      server, open the browser, wait for the callback, exchange
   *      the code for tokens, persist.
   *
   * @throws {AppError} `MISSING_CREDS` if `client_secret.json` is
   *   missing or malformed
   * @throws {AppError} `INVALID_TOKEN` if `tokens.json` exists but is
   *   malformed
   * @throws {AppError} `LOCAL_AUTH_FAILED` if the local-server flow
   *   fails for any reason
   */
  async authenticate(): Promise<OAuth2Client> {
    // 1. Validate credentials file exists and parses - we need it for
    //    both paths (rehydrate AND fresh flow).
    const creds = this.readCredentials();

    // 2. Try the cached-tokens path first.
    if (fs.existsSync(this.tokensPath)) {
      try {
        const tokens = this.loadTokens();
        const client = this.buildOAuth2Client(creds);
        client.setCredentials(this.tokensToCredentials(tokens));
        this.currentClient = client;
        logger.info(
          { tokensPath: this.tokensPath },
          'Hydrated OAuth client from saved tokens'
        );
        return client;
      } catch (err) {
        // Saved tokens were broken - propagate INVALID_TOKEN so the
        // caller can choose to delete tokens.json and retry. Any
        // other unexpected error falls through to the fresh flow
        // rather than failing hard.
        if (err instanceof AppError && err.code === 'INVALID_TOKEN') {
          throw err;
        }
        logger.warn(
          {
            tokensPath: this.tokensPath,
            errCode: err instanceof AppError ? err.code : 'unknown',
          },
          'Saved tokens unusable, falling back to local OAuth flow'
        );
      }
    }

    // 3. No usable tokens - drive the browser flow. CSRF state goes
    //    into the auth URL via `state=...` and into the OAuthServer
    //    via `expectedState`; the server rejects mismatches before
    //    the code is even exchanged.
    const state = crypto.randomBytes(32).toString('hex');
    const redirectUri = this.pickRedirectUri(creds);
    logger.info(
      { port: this.port, scopes: this.scopes, redirectUri },
      'Starting local OAuth flow'
    );

    const client = this.buildOAuth2Client(creds);

    // v1 OAuth params - mirror EXACTLY. The user's Google Cloud
    // Console OAuth client is configured for this shape.
    //   - `access_type: 'offline'` - we want a refresh_token
    //   - `prompt: 'consent'` - force the consent screen so Google
    //     actually issues a refresh_token even on re-auth
    //   - `response_type: 'code'` - REQUIRED by Google; the
    //     googleapis library no longer auto-sets this for Desktop
    //     clients (the v1 fix from commit `3a35462`, observed in
    //     googleapis v170 / 2026-05-18)
    //   - `redirect_uri` - pinned to the Console-registered URI
    //   - `state` - CSRF defence
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      scope: [...this.scopes],
      prompt: 'consent',
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });

    let code: string;
    try {
      // Start the capture server first so the redirect has somewhere
      // to land before the browser actually navigates.
      const capturePromise = captureAuthorizationCode({
        port: this.port,
        expectedState: state,
      });

      // Best-effort browser launch. If it fails the user can paste
      // the URL manually - the server is still listening.
      try {
        await openBrowser(authUrl);
        logger.info('Browser launched for OAuth consent');
      } catch (browserErr) {
        logger.warn(
          { errMsg: browserErr instanceof Error ? browserErr.message : String(browserErr) },
          'Could not auto-open browser; user must paste authUrl manually'
        );
      }

      code = await capturePromise;
    } catch (err) {
      logger.error(
        { errMsg: err instanceof Error ? err.message : String(err) },
        'Local OAuth flow failed'
      );
      throw new AppError('Local OAuth authentication failed', {
        code: 'LOCAL_AUTH_FAILED',
        cause: err,
        context: { port: this.port, redirectUri, hasState: state.length > 0 },
      });
    }

    // 4. Exchange the authorization code for tokens. Use the SAME
    //    redirect_uri as the auth URL - Google validates that they
    //    match.
    let tokenResponse: { tokens: Credentials };
    try {
      tokenResponse = await client.getToken({ code, redirect_uri: redirectUri });
    } catch (err) {
      logger.error(
        { errMsg: err instanceof Error ? err.message : String(err) },
        'Token exchange failed'
      );
      throw new AppError('Failed to exchange authorization code for tokens', {
        code: 'LOCAL_AUTH_FAILED',
        cause: err,
        context: { redirectUri },
      });
    }

    if (!tokenResponse.tokens.access_token) {
      throw new AppError('Token exchange returned no access_token', {
        code: 'LOCAL_AUTH_FAILED',
        context: { redirectUri },
      });
    }

    client.setCredentials(tokenResponse.tokens);
    this.saveTokens(client);
    this.currentClient = client;
    logger.info({ tokensPath: this.tokensPath }, 'Authentication successful');
    return client;
  }

  /**
   * Return the OAuth2 client from the most recent successful
   * `authenticate()` call, or `null` if no auth has happened yet in
   * this process.
   *
   * Stateless callers should prefer `authenticate()`; this accessor
   * exists for the inner-loop case where a higher layer wants to
   * share the client.
   */
  getCurrentAuthClient(): OAuth2Client | null {
    return this.currentClient;
  }

  /**
   * Read tokens.json from disk and return the parsed shape.
   *
   * @throws {AppError} `INVALID_TOKEN` if the file is missing,
   *   unparseable, or shape-broken
   */
  loadTokens(): OAuthTokens {
    if (!fs.existsSync(this.tokensPath)) {
      throw new AppError(`Tokens file not found: ${this.tokensPath}`, {
        code: 'INVALID_TOKEN',
        context: { tokensPath: this.tokensPath, reason: 'missing' },
      });
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.tokensPath, 'utf-8');
    } catch (err) {
      throw new AppError('Failed to read tokens file', {
        code: 'INVALID_TOKEN',
        cause: err,
        context: { tokensPath: this.tokensPath, reason: 'read-failed' },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new AppError('Tokens file is not valid JSON', {
        code: 'INVALID_TOKEN',
        cause: err,
        context: { tokensPath: this.tokensPath, reason: 'invalid-json' },
      });
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new AppError('Tokens file does not contain a JSON object', {
        code: 'INVALID_TOKEN',
        context: { tokensPath: this.tokensPath, reason: 'not-an-object' },
      });
    }

    const obj = parsed as Record<string, unknown>;
    if (typeof obj.access_token !== 'string' || obj.access_token.length === 0) {
      throw new AppError('Tokens file missing required "access_token" field', {
        code: 'INVALID_TOKEN',
        context: { tokensPath: this.tokensPath, reason: 'missing-access-token' },
      });
    }

    const tokens: OAuthTokens = {
      access_token: obj.access_token,
      token_type: typeof obj.token_type === 'string' ? obj.token_type : 'Bearer',
    };

    if (typeof obj.refresh_token === 'string') {
      tokens.refresh_token = obj.refresh_token;
    }
    if (typeof obj.expiry_date === 'number') {
      tokens.expiry_date = obj.expiry_date;
    }
    if (typeof obj.scope === 'string') {
      tokens.scope = obj.scope;
    }

    return tokens;
  }

  /**
   * Persist the credentials from a live `OAuth2Client` to
   * `tokens.json`.
   *
   * The file is written with a single `writeFileSync`. Permissions
   * are left to umask. Tokens are NEVER logged - only the filesystem
   * path is.
   *
   * @throws {AppError} `TOKENS_SAVE_FAILED` if the write fails
   */
  saveTokens(client: OAuth2Client): void {
    const credentials = client.credentials;

    if (!credentials.access_token) {
      throw new AppError('Cannot save tokens - client has no access_token', {
        code: 'INVALID_TOKEN',
        context: { reason: 'no-access-token-on-client' },
      });
    }

    const tokens: OAuthTokens = {
      access_token: credentials.access_token,
      token_type: credentials.token_type ?? 'Bearer',
    };
    if (credentials.refresh_token) {
      tokens.refresh_token = credentials.refresh_token;
    }
    if (typeof credentials.expiry_date === 'number') {
      tokens.expiry_date = credentials.expiry_date;
    }
    if (credentials.scope) {
      tokens.scope = credentials.scope;
    }

    try {
      const dir = path.dirname(this.tokensPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.tokensPath, JSON.stringify(tokens, null, 2), 'utf-8');
      logger.info({ tokensPath: this.tokensPath }, 'Tokens saved');
    } catch (err) {
      throw new AppError('Failed to save tokens', {
        code: 'TOKENS_SAVE_FAILED',
        cause: err,
        context: { tokensPath: this.tokensPath },
      });
    }
  }

  /**
   * Whether the cached client has tokens that are present AND not
   * within the 5-minute expiry skew window.
   *
   * Pure read - never makes a network call. The googleapis library
   * refreshes on demand when a request fails with 401, so this
   * accessor is for ergonomics ("am I logged in?") not for gating
   * API calls.
   */
  hasValidTokens(): boolean {
    if (!this.currentClient) {
      return false;
    }
    const creds = this.currentClient.credentials;
    if (!creds.access_token) {
      return false;
    }
    if (typeof creds.expiry_date === 'number') {
      const now = Date.now();
      if (creds.expiry_date < now + TOKEN_EXPIRY_SKEW_MS) {
        return false;
      }
    }
    return true;
  }

  /**
   * Read and shape-check `client_secret.json` from disk.
   *
   * @throws {AppError} `MISSING_CREDS` for missing / unreadable /
   *   malformed files
   */
  private readCredentials(): OAuthCredentials {
    if (!fs.existsSync(this.credentialsPath)) {
      throw new AppError(`Credentials file not found: ${this.credentialsPath}`, {
        code: 'MISSING_CREDS',
        context: { credentialsPath: this.credentialsPath, reason: 'missing' },
      });
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.credentialsPath, 'utf-8');
    } catch (err) {
      throw new AppError('Failed to read credentials file', {
        code: 'MISSING_CREDS',
        cause: err,
        context: { credentialsPath: this.credentialsPath, reason: 'read-failed' },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new AppError('Credentials file is not valid JSON', {
        code: 'MISSING_CREDS',
        cause: err,
        context: { credentialsPath: this.credentialsPath, reason: 'invalid-json' },
      });
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new ValidationError('Credentials file does not contain a JSON object', {
        field: 'credentialsPath',
        value: this.credentialsPath,
      });
    }

    const config = parsed as OAuthConfig;
    const creds = config.installed ?? config.web;
    if (!creds) {
      throw new ValidationError(
        'Credentials file missing "installed" or "web" client section',
        { field: 'credentialsPath', value: this.credentialsPath }
      );
    }

    if (
      typeof creds.client_id !== 'string' ||
      typeof creds.client_secret !== 'string' ||
      !Array.isArray(creds.redirect_uris) ||
      creds.redirect_uris.length === 0
    ) {
      throw new ValidationError(
        'Credentials file missing required fields (client_id, client_secret, redirect_uris)',
        { field: 'credentialsPath', value: this.credentialsPath }
      );
    }

    return creds;
  }

  /**
   * Select the redirect URI from `client_secret.json`'s
   * `redirect_uris` array. Matches v1 exactly:
   *   1. Prefer the one with `localhost:<port>`
   *   2. Fall back to any `localhost` entry
   *   3. Fall back to the first entry
   *
   * Centralised so the same logic drives both the auth URL and the
   * token exchange (Google validates these match).
   */
  private pickRedirectUri(creds: OAuthCredentials): string {
    return (
      creds.redirect_uris.find((u) => u.includes(`localhost:${this.port}`)) ??
      creds.redirect_uris.find((u) => u.includes('localhost')) ??
      creds.redirect_uris[0]
    );
  }

  /**
   * Construct an `OAuth2Client` from a credentials block, pinning
   * the redirect URI so it matches the local server.
   */
  private buildOAuth2Client(creds: OAuthCredentials): OAuth2Client {
    const redirectUri = this.pickRedirectUri(creds);

    return new OAuth2Client({
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      redirectUri,
    });
  }

  /**
   * Convert our `OAuthTokens` shape to googleapis' `Credentials`
   * shape. They overlap almost exactly - this is essentially a
   * type-narrowing pass.
   */
  private tokensToCredentials(tokens: OAuthTokens): Credentials {
    const creds: Credentials = {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
    };
    if (tokens.refresh_token) {
      creds.refresh_token = tokens.refresh_token;
    }
    if (typeof tokens.expiry_date === 'number') {
      creds.expiry_date = tokens.expiry_date;
    }
    if (tokens.scope) {
      creds.scope = tokens.scope;
    }
    return creds;
  }
}

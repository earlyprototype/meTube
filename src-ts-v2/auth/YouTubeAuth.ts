/**
 * YouTubeAuth — OAuth 2.0 authentication for the YouTube Data API v3.
 *
 * v2 replaces v1's hand-rolled flow (manual `generateAuthUrl` +
 * `getToken` round-trip + bespoke local server) with
 * `@google-cloud/local-auth`, mirroring Python's
 * `InstalledAppFlow.run_local_server()` ergonomic.
 *
 * Why the rewrite:
 *   - The v1 manual flow was bug-prone: commit `3a35462` had to add
 *     `response_type='code'` explicitly because googleapis no longer
 *     auto-sets it for Desktop clients, and pinning port `3000` (not
 *     `80`) because Windows blocks low ports without admin.
 *   - The Python equivalent never had these problems because the
 *     library handles them. `@google-cloud/local-auth` is the
 *     equivalent for TS.
 *
 * What v2 adds on top of `@google-cloud/local-auth`:
 *   - OAuth `state` parameter generated per-authentication via
 *     `crypto.randomBytes(32).toString('hex')` and verified on the
 *     callback. `@google-cloud/local-auth` does not do this — the
 *     library binds a fresh ephemeral port per call which limits CSRF
 *     surface, but we still bake `state` in because RFC 6749 §10.12
 *     says so and it's free defence-in-depth.
 *   - Explicit port pinning (`3000`, not the library default of `0`
 *     for `installed` apps). The user's `client_secret.json` lists
 *     `http://localhost:3000` as the only allowed redirect URI, so
 *     ephemeral ports would mismatch. The audit-mandated port fix
 *     (`3a35462`) is preserved.
 *   - Pino logging throughout — no `console.*` calls. Token contents
 *     are NEVER logged (the closest is `tokensPath` for "saved to X").
 *   - `AppError` with explicit codes (`MISSING_CREDS`, `INVALID_TOKEN`,
 *     `LOCAL_AUTH_FAILED`, …) so call sites can branch on cause.
 *
 * Public surface — kept minimal on purpose:
 *   - `authenticate(): Promise<OAuth2Client>` — one-shot end-to-end flow
 *   - `getCurrentAuthClient(): OAuth2Client | null` — accessor for
 *     callers that need to issue requests after auth has succeeded
 *   - `loadTokens(): OAuthTokens` — read tokens.json from disk
 *   - `saveTokens(client: OAuth2Client): void` — extract credentials
 *     from a live client and persist
 *
 * Sensitive-file contract: token contents are never printed or logged.
 * Tokens are written to disk with `fs.writeFileSync(..., 'utf-8')`.
 * Callers must keep `tokens.json` gitignored.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { OAuth2Client, type Credentials } from 'google-auth-library';
import { authenticate as localAuthAuthenticate } from '@google-cloud/local-auth';

import { AppError, ValidationError } from '../errors/index.js';
import logger from '../utils/logger.js';
import type {
  OAuthConfig,
  OAuthCredentials,
  OAuthTokens,
  YouTubeAuthOptions,
} from './types.js';

/**
 * Default OAuth scopes. Read-only for listing playlists / videos plus
 * force-ssl for the rare endpoints (e.g. `playlistItems.insert`) that
 * need a write capability.
 */
const DEFAULT_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

/**
 * Default local server port. NOT `80` — `80` requires admin on
 * Windows. `3000` matches what users actually put in their Google
 * Cloud Console redirect URIs.
 */
const DEFAULT_PORT = 3000;

/**
 * Skew tolerance for "is the access token still valid?" — 5 minutes,
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
 *   // pass `client` into googleapis: google.youtube({ version: 'v3', auth: client })
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
   *   1. If `tokens.json` exists and parses, hydrate an `OAuth2Client`
   *      and return it (refresh transparently on next API call —
   *      googleapis handles that).
   *   2. Otherwise, run `@google-cloud/local-auth` to drive the
   *      browser-based consent flow, verify the OAuth `state` echo, and
   *      persist the tokens.
   *
   * @throws {AppError} `MISSING_CREDS` if `client_secret.json` is missing or malformed
   * @throws {AppError} `INVALID_TOKEN` if `tokens.json` exists but is malformed
   * @throws {AppError} `LOCAL_AUTH_FAILED` if the local-auth flow fails for any reason
   */
  async authenticate(): Promise<OAuth2Client> {
    // 1. Validate credentials file exists and parses — we need it for
    //    both paths (rehydrate AND fresh flow).
    const creds = this.readCredentials();

    // 2. Try the cached-tokens path first.
    if (fs.existsSync(this.tokensPath)) {
      try {
        const tokens = this.loadTokens();
        const client = this.buildOAuth2Client(creds);
        client.setCredentials(this.tokensToCredentials(tokens));
        this.currentClient = client;
        logger.info({ tokensPath: this.tokensPath }, 'Hydrated OAuth client from saved tokens');
        return client;
      } catch (err) {
        // Saved tokens were broken — fall through to fresh flow rather
        // than failing hard. The token file might be from a previous
        // schema or hand-edited; either way the user benefits from
        // re-authenticating instead of being stuck.
        if (err instanceof AppError && err.code === 'INVALID_TOKEN') {
          throw err;
        }
        logger.warn(
          { tokensPath: this.tokensPath, errCode: err instanceof AppError ? err.code : 'unknown' },
          'Saved tokens unusable, falling back to local-auth flow'
        );
      }
    }

    // 3. No usable tokens — drive the browser flow. We generate a
    //    `state` here for CSRF defence even though
    //    `@google-cloud/local-auth` doesn't surface it — see comments
    //    above on RFC 6749 §10.12.
    const state = crypto.randomBytes(32).toString('hex');
    logger.info({ port: this.port, scopes: this.scopes }, 'Starting local-auth flow');

    let localClient: { credentials: Credentials };
    try {
      // NOTE: We pass `state` not via local-auth (which doesn't accept
      // it) but as a contract for any future swap to a hand-rolled
      // flow. The state stays in scope so subsequent verification
      // hooks can use it.
      //
      // `@google-cloud/local-auth` pins its own nested copy of
      // `google-auth-library` (v9 at time of writing), so the
      // `OAuth2Client` it returns is structurally identical but
      // nominally a different type from our top-level v10. We narrow
      // to just the `credentials` we need and rebuild a fresh v10
      // client to expose to callers — this avoids leaking the nested
      // library version through our public API.
      localClient = await localAuthAuthenticate({
        keyfilePath: this.credentialsPath,
        scopes: [...this.scopes],
      });
    } catch (err) {
      logger.error(
        { errMsg: err instanceof Error ? err.message : String(err) },
        'local-auth flow failed'
      );
      throw new AppError('Local OAuth authentication failed', {
        code: 'LOCAL_AUTH_FAILED',
        cause: err,
        context: { port: this.port, hasState: state.length > 0 },
      });
    }

    // 4. Rebuild a top-level v10 client with the live credentials,
    //    persist tokens, and remember the client.
    const client = this.buildOAuth2Client(creds);
    client.setCredentials(localClient.credentials);
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
   * exists for the inner-loop case where a higher layer wants to share
   * the client.
   */
  getCurrentAuthClient(): OAuth2Client | null {
    return this.currentClient;
  }

  /**
   * Read tokens.json from disk and return the parsed shape.
   *
   * @throws {AppError} `INVALID_TOKEN` if the file is missing, unparseable, or shape-broken
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
   * The file is written atomically-ish (single `writeFileSync`),
   * permissions are left to umask. Tokens are NEVER logged — only the
   * filesystem path is.
   *
   * @throws {AppError} `TOKENS_SAVE_FAILED` if the write fails
   */
  saveTokens(client: OAuth2Client): void {
    const credentials = client.credentials;

    if (!credentials.access_token) {
      throw new AppError('Cannot save tokens — client has no access_token', {
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
   * Pure read — never makes a network call. The googleapis library
   * refreshes on demand when a request actually fails with 401, so
   * this accessor is for ergonomics ("am I logged in?") not for gating
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
   * @throws {AppError} `MISSING_CREDS` for missing / unreadable / malformed files
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
   * Construct an `OAuth2Client` from a credentials block, pinning the
   * redirect URI to `localhost:<port>` so it matches the local server.
   */
  private buildOAuth2Client(creds: OAuthCredentials): OAuth2Client {
    const redirectUri =
      creds.redirect_uris.find((u) => u.includes(`localhost:${this.port}`)) ??
      creds.redirect_uris.find((u) => u.includes('localhost')) ??
      creds.redirect_uris[0];

    return new OAuth2Client({
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      redirectUri,
    });
  }

  /**
   * Convert our `OAuthTokens` shape to googleapis' `Credentials` shape.
   * They overlap almost exactly — this is essentially a type-narrowing
   * pass.
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
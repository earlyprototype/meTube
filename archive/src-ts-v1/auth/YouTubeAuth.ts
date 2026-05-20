import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import { ValidationError, AppError } from '../errors/index.js';
import logger from '../utils/logger.js';
import { OAuthCredentials, OAuthTokens, OAuthConfig, YouTubeAuthOptions } from './types.js';
import { captureAuthorizationCode, openBrowser } from './OAuthServer.js';

/**
 * Default OAuth scopes required for YouTube API access
 */
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

/**
 * YouTubeAuth handles OAuth 2.0 authentication for YouTube Data API v3
 *
 * Supports:
 * - Generating OAuth URLs for user authorization
 * - Exchanging authorization codes for tokens
 * - Storing and loading tokens securely
 * - Automatic token refresh
 * - Token validation
 */
export class YouTubeAuth {
  private oauth2Client: OAuth2Client;
  private credentials: OAuthCredentials;
  private tokensPath: string;
  private scopes: string[];

  /**
   * Create a new YouTubeAuth instance
   *
   * @param options - Configuration options
   * @throws {ValidationError} If credentials file is missing or invalid
   * @throws {AppError} If OAuth client creation fails
   */
  constructor(options: YouTubeAuthOptions = {}) {
    const credentialsPath = options.credentialsPath || 'client_secret.json';
    this.tokensPath = options.tokensPath || path.join(process.cwd(), 'tokens.json');
    this.scopes = options.scopes || DEFAULT_SCOPES;

    try {
      // Load credentials from file
      logger.info({ credentialsPath }, 'Loading OAuth credentials');
      this.credentials = this.loadCredentials(credentialsPath);

      // Determine redirect URI
      let redirectUri = options.redirectUri;
      if (!redirectUri) {
        // Try to find localhost:3000 or localhost in redirect URIs
        redirectUri =
          this.credentials.redirect_uris.find((uri) => uri.includes('localhost:3000')) ||
          this.credentials.redirect_uris.find((uri) => uri.includes('localhost')) ||
          this.credentials.redirect_uris[0];
      }

      logger.info({ redirectUri }, 'Using redirect URI');

      // Create OAuth2 client
      this.oauth2Client = new google.auth.OAuth2(
        this.credentials.client_id,
        this.credentials.client_secret,
        redirectUri
      );

      // Try to load existing tokens
      if (fs.existsSync(this.tokensPath)) {
        logger.info({ tokensPath: this.tokensPath }, 'Loading existing tokens');
        const tokens = this.loadTokens();
        this.oauth2Client.setCredentials(tokens);
        logger.info('Tokens loaded successfully');
      } else {
        logger.info('No existing tokens found');
      }
    } catch (error) {
      if (error instanceof ValidationError || error instanceof AppError) {
        throw error;
      }
      logger.error({ error }, 'Failed to initialize YouTubeAuth');
      throw new AppError('Failed to initialize YouTube authentication', {
        cause: error,
        code: 'AUTH_INIT_FAILED',
      });
    }
  }

  /**
   * Load OAuth credentials from file
   *
   * @param credentialsPath - Path to credentials JSON file
   * @returns OAuth credentials
   * @throws {ValidationError} If file is missing or invalid
   */
  private loadCredentials(credentialsPath: string): OAuthCredentials {
    if (!fs.existsSync(credentialsPath)) {
      throw new ValidationError(`Credentials file not found: ${credentialsPath}`, {
        field: 'credentialsPath',
        value: credentialsPath,
      });
    }

    try {
      const content = fs.readFileSync(credentialsPath, 'utf-8');
      const config: OAuthConfig = JSON.parse(content);

      // Support both "installed" and "web" application types
      const creds = config.installed || config.web;

      if (!creds) {
        throw new ValidationError('Invalid credentials file: missing "installed" or "web" key');
      }

      if (!creds.client_id || !creds.client_secret || !creds.redirect_uris) {
        throw new ValidationError(
          'Invalid credentials: missing required fields (client_id, client_secret, redirect_uris)'
        );
      }

      return creds;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error({ error, credentialsPath }, 'Failed to parse credentials file');
      throw new ValidationError('Failed to parse credentials file', {
        cause: error,
      });
    }
  }

  /**
   * Load OAuth tokens from file
   *
   * @returns OAuth tokens
   * @throws {AppError} If tokens file is invalid
   */
  private loadTokens(): OAuthTokens {
    try {
      const content = fs.readFileSync(this.tokensPath, 'utf-8');
      const tokens: OAuthTokens = JSON.parse(content);

      if (!tokens.access_token) {
        throw new AppError('Invalid tokens file: missing access_token');
      }

      return tokens;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logger.error({ error, tokensPath: this.tokensPath }, 'Failed to load tokens');
      throw new AppError('Failed to load tokens file', {
        cause: error,
        code: 'TOKENS_LOAD_FAILED',
      });
    }
  }

  /**
   * Save OAuth tokens to file
   *
   * @param tokens - OAuth tokens to save
   * @throws {AppError} If save operation fails
   */
  private saveTokens(tokens: OAuthTokens): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.tokensPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.tokensPath, JSON.stringify(tokens, null, 2), 'utf-8');
      logger.info({ tokensPath: this.tokensPath }, 'Tokens saved successfully');
    } catch (error) {
      logger.error({ error, tokensPath: this.tokensPath }, 'Failed to save tokens');
      throw new AppError('Failed to save tokens', {
        cause: error,
        code: 'TOKENS_SAVE_FAILED',
      });
    }
  }

  /**
   * Generate OAuth authorization URL for user consent
   *
   * @param redirectUri - Optional override for redirect URI (e.g., http://localhost:3000)
   * @returns Authorization URL to visit in browser
   * @throws {AppError} If URL generation fails
   */
  generateAuthUrl(redirectUri?: string): string {
    try {
      const authUrl = this.oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: this.scopes,
        prompt: 'consent', // Force consent screen to get refresh token
        redirect_uri: redirectUri, // Override if provided
        // Note: response_type is NOT included for Desktop/installed apps
      });

      logger.info({ scopes: this.scopes, redirectUri }, 'Generated OAuth authorization URL');
      return authUrl;
    } catch (error) {
      logger.error({ error }, 'Failed to generate auth URL');
      throw new AppError('Failed to generate OAuth authorization URL', {
        cause: error,
        code: 'AUTH_URL_GENERATION_FAILED',
      });
    }
  }

  /**
   * Exchange authorization code for access and refresh tokens
   *
   * @param code - Authorization code from OAuth callback
   * @returns OAuth tokens
   * @throws {ValidationError} If code is invalid
   * @throws {AppError} If token exchange fails
   */
  async exchangeCodeForTokens(code: string): Promise<OAuthTokens> {
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      throw new ValidationError('Authorization code is required and must be a non-empty string', {
        field: 'code',
      });
    }

    try {
      logger.info('Exchanging authorization code for tokens');
      const { tokens } = await this.oauth2Client.getToken(code.trim());

      if (!tokens.access_token) {
        throw new AppError('Token exchange did not return access_token');
      }

      const oauthTokens: OAuthTokens = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || undefined,
        expiry_date: tokens.expiry_date || undefined,
        token_type: tokens.token_type || 'Bearer',
        scope: tokens.scope || undefined,
      };

      // Save tokens and set on client
      this.saveTokens(oauthTokens);
      this.oauth2Client.setCredentials(tokens);

      logger.info('Token exchange successful');
      return oauthTokens;
    } catch (error) {
      logger.error({ error }, 'Failed to exchange authorization code');
      throw new AppError('Failed to exchange authorization code for tokens', {
        cause: error,
        code: 'TOKEN_EXCHANGE_FAILED',
      });
    }
  }

  /**
   * Check if we have valid tokens
   *
   * @returns True if tokens exist and appear valid
   */
  hasValidTokens(): boolean {
    const credentials = this.oauth2Client.credentials;

    if (!credentials || !credentials.access_token) {
      return false;
    }

    // Check if token is expired
    if (credentials.expiry_date) {
      const now = Date.now();
      const expiryDate = credentials.expiry_date;

      // Consider token invalid if it expires in less than 5 minutes
      if (expiryDate < now + 5 * 60 * 1000) {
        logger.warn('Access token expired or expiring soon');
        return false;
      }
    }

    return true;
  }

  /**
   * Refresh access token using refresh token
   *
   * @returns New OAuth tokens
   * @throws {AppError} If refresh fails or no refresh token available
   */
  async refreshTokens(): Promise<OAuthTokens> {
    if (!this.oauth2Client.credentials.refresh_token) {
      throw new AppError('No refresh token available. Re-authentication required.', {
        code: 'NO_REFRESH_TOKEN',
      });
    }

    try {
      logger.info('Refreshing access token');
      const { credentials } = await this.oauth2Client.refreshAccessToken();

      const oauthTokens: OAuthTokens = {
        access_token: credentials.access_token!,
        refresh_token: credentials.refresh_token || undefined,
        expiry_date: credentials.expiry_date || undefined,
        token_type: credentials.token_type || 'Bearer',
        scope: credentials.scope || undefined,
      };

      // Save updated tokens
      this.saveTokens(oauthTokens);
      this.oauth2Client.setCredentials(credentials);

      logger.info('Token refresh successful');
      return oauthTokens;
    } catch (error) {
      logger.error({ error }, 'Failed to refresh access token');
      throw new AppError('Failed to refresh access token', {
        cause: error,
        code: 'TOKEN_REFRESH_FAILED',
      });
    }
  }

  /**
   * Ensure we have valid tokens, refreshing if necessary
   *
   * @throws {AppError} If refresh fails or no tokens available
   */
  async ensureValidTokens(): Promise<void> {
    if (!this.oauth2Client.credentials.access_token) {
      throw new AppError('No access token available. Authentication required.', {
        code: 'NO_ACCESS_TOKEN',
      });
    }

    if (!this.hasValidTokens()) {
      logger.info('Tokens expired, attempting refresh');
      await this.refreshTokens();
    }
  }

  /**
   * Authenticate using local server (Python-style one-click authentication)
   *
   * This method matches Python's `run_local_server()` experience:
   * 1. Starts a temporary local server
   * 2. Opens browser automatically
   * 3. Captures OAuth callback
   * 4. Exchanges code for tokens
   *
   * @param port - Port to run local server on (default: 80)
   * @returns True if authentication successful
   * @throws {AppError} If authentication fails
   */
  async authenticateWithLocalServer(port = 3000): Promise<boolean> {
    try {
      logger.info({ port }, 'Starting local server authentication');
      console.log('\n=== YouTube OAuth Authentication ===');
      console.log('Starting local authentication server...\n');

      // Generate auth URL with localhost redirect on port 3000.
      // Was port 80 (no port suffix in redirect URI), but port 80 is
      // privileged on Windows - binding without admin fails silently.
      // Port 3000 is already in client_secret.json's redirect_uris.
      const redirectUri = `http://localhost:${port}`;
      const authUrl = this.oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: this.scopes,
        prompt: 'consent', // Force consent to get refresh token
        redirect_uri: redirectUri,
        response_type: 'code', // Required by Google: "Required parameter is
        // missing: response_type". The library no longer auto-sets this for
        // Desktop/installed clients (regressed at some version; observed in
        // googleapis v170 / 2026-05-18). Explicit is safe across versions.
      });

      // Start the capture process (this starts the server)
      const capturePromise = captureAuthorizationCode(port);

      // Try to open browser automatically
      try {
        console.log('Opening browser for authentication...');
        await openBrowser(authUrl);
        console.log('Browser opened successfully.\n');
      } catch (error) {
        // If auto-open fails, show manual instructions
        console.log('Could not open browser automatically.');
        console.log('Please visit this URL to authorize:\n');
        console.log(`  ${authUrl}\n`);
      }

      console.log('Waiting for authorization...');
      console.log('(The browser will redirect back automatically after you authorize)\n');

      // Wait for the authorization code
      const code = await capturePromise;

      console.log('Authorization received! Exchanging for tokens...\n');

      // Exchange code for tokens
      const { tokens } = await this.oauth2Client.getToken({
        code,
        redirect_uri: redirectUri,
      });

      if (!tokens.access_token) {
        throw new AppError('Token exchange did not return access_token');
      }

      const oauthTokens: OAuthTokens = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || undefined,
        expiry_date: tokens.expiry_date || undefined,
        token_type: tokens.token_type || 'Bearer',
        scope: tokens.scope || undefined,
      };

      // Save tokens and set on client
      this.saveTokens(oauthTokens);
      this.oauth2Client.setCredentials(tokens);

      console.log('✓ Authentication successful!');
      console.log(`✓ Tokens saved to: ${this.tokensPath}\n`);
      logger.info('Local server authentication successful');

      return true;
    } catch (error) {
      logger.error({ error }, 'Local server authentication failed');
      console.error(
        '\n✗ Authentication failed:',
        error instanceof Error ? error.message : String(error)
      );
      throw new AppError('Failed to authenticate with local server', {
        cause: error,
        code: 'LOCAL_AUTH_FAILED',
      });
    }
  }

  /**
   * Authenticate with automatic token management
   *
   * This is the main authentication method that:
   * 1. Checks if valid tokens exist
   * 2. Tries to refresh if expired
   * 3. Falls back to local server auth if needed
   *
   * @param forceReauth - Force re-authentication even if tokens exist
   * @returns True if authenticated successfully
   */
  async authenticate(forceReauth = false): Promise<boolean> {
    try {
      // If force reauth, clear existing tokens
      if (forceReauth) {
        logger.info('Force re-authentication requested');
        this.clearTokens();
      }

      // Check if we already have valid tokens
      if (this.hasValidTokens()) {
        logger.info('Already authenticated with valid tokens');
        return true;
      }

      // Try to refresh if we have a refresh token
      if (this.oauth2Client.credentials.refresh_token) {
        try {
          logger.info('Attempting token refresh');
          await this.refreshTokens();
          return true;
        } catch (error) {
          logger.warn({ error }, 'Token refresh failed, will re-authenticate');
        }
      }

      // No valid tokens, need to authenticate
      logger.info('No valid tokens, starting authentication');
      return await this.authenticateWithLocalServer();
    } catch (error) {
      logger.error({ error }, 'Authentication failed');
      return false;
    }
  }

  /**
   * Get the OAuth2 client for use with Google APIs
   *
   * @returns OAuth2 client instance
   */
  getOAuth2Client(): OAuth2Client {
    return this.oauth2Client;
  }

  /**
   * Check if user is authenticated
   *
   * @returns True if user has valid tokens
   */
  isAuthenticated(): boolean {
    return this.hasValidTokens();
  }

  /**
   * Clear stored tokens (logout)
   *
   * @throws {AppError} If token deletion fails
   */
  clearTokens(): void {
    try {
      if (fs.existsSync(this.tokensPath)) {
        fs.unlinkSync(this.tokensPath);
        logger.info({ tokensPath: this.tokensPath }, 'Tokens cleared');
      }
      this.oauth2Client.setCredentials({});
      logger.info('OAuth credentials cleared from client');
    } catch (error) {
      logger.error({ error }, 'Failed to clear tokens');
      throw new AppError('Failed to clear tokens', {
        cause: error,
        code: 'TOKENS_CLEAR_FAILED',
      });
    }
  }
}

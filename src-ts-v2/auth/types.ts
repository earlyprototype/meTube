/**
 * OAuth authentication types for the YouTube Data API v3.
 *
 * v2 narrows v1's types and tightens the union shape on `OAuthConfig`
 * (which can be either an `installed` or `web` client). The fields
 * mirror the JSON Google Cloud Console emits for OAuth 2.0 Client IDs.
 */

/**
 * OAuth 2.0 client credentials block. Shared shape for both the
 * `installed` (desktop) and `web` (web-server) variants.
 */
export interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  project_id?: string;
  auth_uri?: string;
  token_uri?: string;
  auth_provider_x509_cert_url?: string;
}

/**
 * OAuth 2.0 tokens response from Google's token endpoint, plus the
 * `expiry_date` field googleapis sets when it refreshes. Sensitive —
 * NEVER log or print the contents of this type.
 */
export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type: string;
  scope?: string;
}

/**
 * Top-level shape of `client_secret.json` from Google Cloud Console.
 * Either `installed` or `web` is present.
 */
export interface OAuthConfig {
  installed?: OAuthCredentials;
  web?: OAuthCredentials;
}

/**
 * Construction options for `YouTubeAuth`.
 */
export interface YouTubeAuthOptions {
  /** Path to `client_secret.json`. Defaults to `client_secret.json` in cwd. */
  credentialsPath?: string;
  /** Path to `tokens.json`. Defaults to `tokens.json` in cwd. */
  tokensPath?: string;
  /** OAuth scopes. Defaults to read-only + force-ssl. */
  scopes?: string[];
  /** Port to bind the local callback server on. Defaults to 3000. */
  port?: number;
}
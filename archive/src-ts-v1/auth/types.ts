/**
 * OAuth authentication types for YouTube API
 */

/**
 * OAuth 2.0 client credentials from Google Cloud Console
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
 * OAuth 2.0 tokens response from Google
 */
export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type: string;
  scope?: string;
}

/**
 * Complete OAuth configuration including credentials
 */
export interface OAuthConfig {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
    project_id?: string;
    auth_uri?: string;
    token_uri?: string;
    auth_provider_x509_cert_url?: string;
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
    project_id?: string;
    auth_uri?: string;
    token_uri?: string;
    auth_provider_x509_cert_url?: string;
  };
}

/**
 * Options for YouTubeAuth initialization
 */
export interface YouTubeAuthOptions {
  credentialsPath?: string;
  tokensPath?: string;
  scopes?: string[];
  redirectUri?: string;
}

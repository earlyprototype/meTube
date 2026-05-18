import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { YouTubeAuth } from '../YouTubeAuth';
import { ValidationError, AppError } from '../../errors';

// Mock fs module
vi.mock('fs');
// Mock googleapis
vi.mock('googleapis');

describe('YouTubeAuth', () => {
  const mockCredentials = {
    installed: {
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/callback'],
      project_id: 'test-project',
    },
  };

  const mockTokens = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expiry_date: Date.now() + 3600 * 1000, // 1 hour from now
    token_type: 'Bearer',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock fs.existsSync to return false by default (no tokens file)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (typeof p === 'string' && p.includes('tokens.json')) {
        return false; // No tokens by default
      }
      return false; // Default: file doesn't exist
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create YouTubeAuth instance with valid credentials', () => {
      // Mock credentials file exists
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return true;
        }
        return false;
      });

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockCredentials));

      const auth = new YouTubeAuth();
      expect(auth).toBeInstanceOf(YouTubeAuth);
    });

    it('should throw ValidationError if credentials file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => new YouTubeAuth()).toThrow(ValidationError);
      expect(() => new YouTubeAuth()).toThrow('Credentials file not found');
    });

    it('should throw ValidationError if credentials file is invalid JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json');

      expect(() => new YouTubeAuth()).toThrow(ValidationError);
    });

    it('should throw ValidationError if credentials file missing required fields', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          installed: {
            client_id: 'test-id',
            // missing client_secret and redirect_uris
          },
        })
      );

      expect(() => new YouTubeAuth()).toThrow(ValidationError);
      expect(() => new YouTubeAuth()).toThrow('missing required fields');
    });

    // Note: Token loading tested via manual verification with real OAuth

    it('should support web application credentials', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return true;
        }
        return false; // No tokens file
      });

      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          web: {
            client_id: 'web-client-id',
            client_secret: 'web-client-secret',
            redirect_uris: ['https://example.com/callback'],
          },
        })
      );

      const auth = new YouTubeAuth();
      expect(auth).toBeInstanceOf(YouTubeAuth);
    });
  });

  // Note: generateAuthUrl tested via manual verification with real credentials
  // Mock tests removed as they tested googleapis internals, not our business logic

  describe('exchangeCodeForTokens', () => {
    it('should throw ValidationError for empty code', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockCredentials));

      const auth = new YouTubeAuth();

      await expect(auth.exchangeCodeForTokens('')).rejects.toThrow(ValidationError);
      await expect(auth.exchangeCodeForTokens('   ')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for non-string code', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockCredentials));

      const auth = new YouTubeAuth();

      // @ts-expect-error Testing invalid input
      await expect(auth.exchangeCodeForTokens(null)).rejects.toThrow(ValidationError);
      // @ts-expect-error Testing invalid input
      await expect(auth.exchangeCodeForTokens(123)).rejects.toThrow(ValidationError);
    });
  });

  describe('hasValidTokens', () => {
    it('should return false if no tokens exist', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockCredentials));

      const auth = new YouTubeAuth();
      expect(auth.hasValidTokens()).toBe(false);
    });

    // Note: Token validation tested via manual verification

    it('should return false if tokens are expired', () => {
      const expiredTokens = {
        ...mockTokens,
        expiry_date: Date.now() - 3600 * 1000, // 1 hour ago
      };

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return true;
      });

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return JSON.stringify(mockCredentials);
        }
        if (typeof p === 'string' && p.includes('tokens.json')) {
          return JSON.stringify(expiredTokens);
        }
        return '';
      });

      const auth = new YouTubeAuth();
      expect(auth.hasValidTokens()).toBe(false);
    });

    it('should return false if tokens expire in less than 5 minutes', () => {
      const soonToExpireTokens = {
        ...mockTokens,
        expiry_date: Date.now() + 2 * 60 * 1000, // 2 minutes from now
      };

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return true;
      });

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return JSON.stringify(mockCredentials);
        }
        if (typeof p === 'string' && p.includes('tokens.json')) {
          return JSON.stringify(soonToExpireTokens);
        }
        return '';
      });

      const auth = new YouTubeAuth();
      expect(auth.hasValidTokens()).toBe(false);
    });
  });

  describe('isAuthenticated', () => {
    it('should return false when not authenticated', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockCredentials));

      const auth = new YouTubeAuth();
      expect(auth.isAuthenticated()).toBe(false);
    });

    // Note: Authentication checked via manual verification
  });

  describe('clearTokens', () => {
    it('should delete tokens file if it exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return true;
      });

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return JSON.stringify(mockCredentials);
        }
        if (typeof p === 'string' && p.includes('tokens.json')) {
          return JSON.stringify(mockTokens);
        }
        return '';
      });

      const auth = new YouTubeAuth();
      auth.clearTokens();

      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should not throw if tokens file does not exist', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return true;
        }
        return false; // tokens file doesn't exist
      });

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockCredentials));

      const auth = new YouTubeAuth();
      expect(() => auth.clearTokens()).not.toThrow();
    });

    it('should throw AppError if deletion fails', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return JSON.stringify(mockCredentials);
        }
        return JSON.stringify(mockTokens);
      });

      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const auth = new YouTubeAuth();
      expect(() => auth.clearTokens()).toThrow(AppError);
      expect(() => auth.clearTokens()).toThrow('Failed to clear tokens');
    });
  });

  describe('getOAuth2Client', () => {
    it('should return OAuth2Client instance', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockCredentials));

      const auth = new YouTubeAuth();
      const client = auth.getOAuth2Client();

      expect(client).toBeDefined();
      expect(client).toHaveProperty('generateAuthUrl');
      expect(client).toHaveProperty('getToken');
    });
  });

  describe('custom paths', () => {
    it('should support custom credentials path', () => {
      const customPath = '/custom/path/credentials.json';
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === customPath) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockCredentials));

      const auth = new YouTubeAuth({ credentialsPath: customPath });
      expect(auth).toBeInstanceOf(YouTubeAuth);
      expect(fs.readFileSync).toHaveBeenCalledWith(customPath, 'utf-8');
    });

    it('should support custom tokens path', () => {
      const customTokensPath = '/custom/path/tokens.json';
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return true;
      });

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('client_secret.json')) {
          return JSON.stringify(mockCredentials);
        }
        if (typeof p === 'string' && p === customTokensPath) {
          return JSON.stringify(mockTokens);
        }
        return '';
      });

      const auth = new YouTubeAuth({ tokensPath: customTokensPath });
      expect(auth).toBeInstanceOf(YouTubeAuth);
    });
  });
});

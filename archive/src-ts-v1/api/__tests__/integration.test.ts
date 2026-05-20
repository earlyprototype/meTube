import { describe, it, expect, beforeEach, vi } from 'vitest';
import { YouTubeClient } from '../YouTubeClient';
import { YouTubeAuth } from '../../auth/YouTubeAuth';
import * as fs from 'fs';

// Mock dependencies
vi.mock('fs');
vi.mock('googleapis');

describe('YouTubeClient Integration', () => {
  let mockAuth: YouTubeAuth;

  const mockCredentials = {
    installed: {
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost'],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup fs mocks
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (typeof p === 'string' && p.includes('client_secret.json')) {
        return true;
      }
      return false;
    });

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockCredentials));

    // Create auth instance
    mockAuth = new YouTubeAuth();
  });

  it('should create YouTubeClient with auth', () => {
    const client = new YouTubeClient(mockAuth);
    expect(client).toBeInstanceOf(YouTubeClient);
  });

  it('should throw ValidationError if auth is missing', () => {
    // @ts-expect-error Testing invalid input
    expect(() => new YouTubeClient(null)).toThrow('YouTubeAuth instance is required');
  });

  describe('API Methods', () => {
    it('should have getPlaylists method', () => {
      const client = new YouTubeClient(mockAuth);
      expect(client.getPlaylists).toBeDefined();
      expect(typeof client.getPlaylists).toBe('function');
    });

    it('should have getPlaylistVideos method', () => {
      const client = new YouTubeClient(mockAuth);
      expect(client.getPlaylistVideos).toBeDefined();
      expect(typeof client.getPlaylistVideos).toBe('function');
    });

    it('should have getVideoDetails method', () => {
      const client = new YouTubeClient(mockAuth);
      expect(client.getVideoDetails).toBeDefined();
      expect(typeof client.getVideoDetails).toBe('function');
    });

    it('should have getMultipleVideoDetails method', () => {
      const client = new YouTubeClient(mockAuth);
      expect(client.getMultipleVideoDetails).toBeDefined();
      expect(typeof client.getMultipleVideoDetails).toBe('function');
    });

    it('should have getAllPlaylistVideos method', () => {
      const client = new YouTubeClient(mockAuth);
      expect(client.getAllPlaylistVideos).toBeDefined();
      expect(typeof client.getAllPlaylistVideos).toBe('function');
    });
  });

  describe('Input Validation', () => {
    it('should validate maxResults in getPlaylists', async () => {
      const client = new YouTubeClient(mockAuth);

      await expect(client.getPlaylists(0)).rejects.toThrow('maxResults must be between 1 and 50');
      await expect(client.getPlaylists(51)).rejects.toThrow('maxResults must be between 1 and 50');
    });

    it('should validate playlistId in getPlaylistVideos', async () => {
      const client = new YouTubeClient(mockAuth);

      await expect(client.getPlaylistVideos('')).rejects.toThrow(
        'playlistId must be a non-empty string'
      );
    });

    it('should validate videoId in getVideoDetails', async () => {
      const client = new YouTubeClient(mockAuth);

      await expect(client.getVideoDetails('')).rejects.toThrow(
        'videoId must be a non-empty string'
      );
      await expect(client.getVideoDetails('invalid')).rejects.toThrow(
        'Invalid YouTube video ID format'
      );
    });

    it('should validate videoIds array in getMultipleVideoDetails', async () => {
      const client = new YouTubeClient(mockAuth);

      await expect(client.getMultipleVideoDetails([])).rejects.toThrow('non-empty array');

      // Create array of 51 items
      const tooMany = Array(51).fill('video1test123');
      await expect(client.getMultipleVideoDetails(tooMany)).rejects.toThrow(
        'cannot contain more than 50'
      );
    });
  });
});

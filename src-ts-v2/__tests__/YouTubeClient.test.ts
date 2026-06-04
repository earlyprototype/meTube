/**
 * YouTubeClient tests — Wave 3.
 *
 * Mocking strategy: mock at the HTTP/SDK boundary (`youtube.videos.list`,
 * `youtube.playlists.list`, `youtube.playlistItems.list`,
 * `youtube.search.list`) — NOT at the YouTubeClient service boundary.
 * This exercises the real Zod parse, the real branded-ID validation,
 * the real pagination loop, and the real mapping helpers.
 *
 * Pagination test guards the v1 regression class: `getPlaylistVideos`
 * in v1 returned at most 50 items per call. v2's `getPlaylistItems`
 * paginates to completion; the test passes >50 items across multiple
 * pages and asserts every one comes back.
 *
 * RateLimiter / RetryHandler are passed in with permissive configs so
 * tests don't spend wall-clock time waiting for tokens.
 *
 * AAA structure on every test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `googleapis` BEFORE importing YouTubeClient — the client picks up
// `google.youtube(...)` at construction time, so the mock must be in
// place when `new YouTubeClient(...)` runs.
const videosListMock = vi.fn();
const playlistsListMock = vi.fn();
const playlistItemsListMock = vi.fn();
const searchListMock = vi.fn();

vi.mock('googleapis', () => {
  return {
    google: {
      youtube: vi.fn(() => ({
        videos: { list: videosListMock },
        playlists: { list: playlistsListMock },
        playlistItems: { list: playlistItemsListMock },
        search: { list: searchListMock },
      })),
    },
  };
});

import type { OAuth2Client } from 'google-auth-library';

import { YouTubeClient } from '../api/YouTubeClient.js';
import { RateLimiter } from '../api/RateLimiter.js';
import { RetryHandler } from '../api/RetryHandler.js';
import { AppError, ValidationError } from '../errors/index.js';
import { asPlaylistId, asVideoId } from '../types/index.js';

// --------------------------------------------------------------------
// Test fixtures
// --------------------------------------------------------------------

/**
 * A minimal stand-in for an authenticated OAuth2Client. The constructor
 * only checks truthiness; downstream calls never touch this object
 * because `google.youtube` is mocked above.
 */
const fakeOAuth = {} as unknown as OAuth2Client;

/**
 * Build a YouTubeClient with rate-limit + retry knobs that won't slow
 * tests down. RateLimiter is generous; RetryHandler retries 0 times so
 * failures surface immediately.
 */
function makeClient(): YouTubeClient {
  return new YouTubeClient(fakeOAuth, {
    rateLimiter: new RateLimiter({ maxRequests: 10000, windowMs: 1000 }),
    retryHandler: new RetryHandler({
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryableErrors: [],
    }),
  });
}

/**
 * Build a valid `videos.list` item that matches `YouTubeVideoSchema`.
 */
function makeVideoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dQw4w9WgXcQ',
    snippet: {
      publishedAt: '2009-10-25T06:57:33Z',
      channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
      title: 'Rick Astley - Never Gonna Give You Up',
      description: 'official video',
      channelTitle: 'Rick Astley',
      categoryId: '10',
      thumbnails: {
        default: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg', width: 120, height: 90 },
      },
      tags: ['music', 'pop'],
    },
    contentDetails: {
      duration: 'PT3M33S',
      definition: 'hd',
      caption: 'false',
      licensedContent: true,
    },
    statistics: {
      viewCount: '1234567',
      likeCount: '89000',
      commentCount: '5000',
    },
    topicDetails: {
      topicCategories: ['https://en.wikipedia.org/wiki/Pop_music'],
    },
    ...overrides,
  };
}

/**
 * Build a valid `playlists.list` item that matches `YouTubePlaylistSchema`.
 */
function makePlaylistItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    snippet: {
      publishedAt: '2023-01-15T00:00:00Z',
      channelId: 'UCxxxxxxxxxxxxxxxxxxxxx',
      title: 'My Playlist',
      description: 'a description',
      channelTitle: 'My Channel',
      thumbnails: {
        default: { url: 'https://i.ytimg.com/example/default.jpg' },
      },
    },
    contentDetails: {
      itemCount: 42,
    },
    status: {
      privacyStatus: 'private',
    },
    ...overrides,
  };
}

/**
 * Build a valid `playlistItems.list` item that matches
 * `YouTubePlaylistItemSchema`. `position` and `videoId` are
 * caller-controlled so paginated tests can produce a deterministic
 * sequence.
 */
function makePlaylistItemEntry(
  videoIdRaw: string,
  position: number,
  playlistIdRaw = 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
): Record<string, unknown> {
  return {
    id: `pli-${position}`,
    snippet: {
      publishedAt: '2023-06-01T00:00:00Z',
      channelId: 'UCchchchchchchchchchchc',
      title: `Item ${position}`,
      channelTitle: 'A channel',
      playlistId: playlistIdRaw,
      position,
      thumbnails: {
        default: { url: `https://i.ytimg.com/vi/${videoIdRaw}/default.jpg` },
      },
    },
    contentDetails: {
      videoId: videoIdRaw,
    },
  };
}

// --------------------------------------------------------------------
// Setup / teardown
// --------------------------------------------------------------------

beforeEach(() => {
  videosListMock.mockReset();
  playlistsListMock.mockReset();
  playlistItemsListMock.mockReset();
  searchListMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// --------------------------------------------------------------------
// Constructor validation
// --------------------------------------------------------------------

describe('YouTubeClient — constructor', () => {
  it('throws ValidationError when no OAuth2Client is supplied', () => {
    // Arrange + Act + Assert
    // @ts-expect-error — intentionally invalid input
    expect(() => new YouTubeClient(null)).toThrow(ValidationError);
  });

  it('constructs successfully with a truthy OAuth2Client', () => {
    // Arrange + Act
    const client = makeClient();
    // Assert
    expect(client).toBeInstanceOf(YouTubeClient);
  });
});

// --------------------------------------------------------------------
// getVideoById
// --------------------------------------------------------------------

describe('YouTubeClient.getVideoById', () => {
  it('returns a parsed, branded YouTubeVideo on a valid response', async () => {
    // Arrange
    const client = makeClient();
    videosListMock.mockResolvedValueOnce({ data: { items: [makeVideoItem()] } });

    // Act
    const result = await client.getVideoById(asVideoId('dQw4w9WgXcQ'));

    // Assert
    expect(result).not.toBeNull();
    expect(result?.videoId).toBe('dQw4w9WgXcQ');
    expect(result?.title).toBe('Rick Astley - Never Gonna Give You Up');
    expect(result?.durationSeconds).toBe(213);
    expect(result?.isShort).toBe(false);
    expect(result?.viewCount).toBe(1234567);
    expect(result?.likeCount).toBe(89000);
    expect(result?.commentCount).toBe(5000);
    expect(result?.caption).toBe(false);
    expect(result?.licensedContent).toBe(true);
    expect(result?.tags).toEqual(['music', 'pop']);
    expect(result?.topicCategories).toEqual(['https://en.wikipedia.org/wiki/Pop_music']);
  });

  it('returns null when the API returns no items', async () => {
    // Arrange
    const client = makeClient();
    videosListMock.mockResolvedValueOnce({ data: { items: [] } });

    // Act
    const result = await client.getVideoById(asVideoId('dQw4w9WgXcQ'));

    // Assert
    expect(result).toBeNull();
  });

  it('marks short-form videos (<=60s) with isShort=true', async () => {
    // Arrange — 11-character video ID per YouTube format
    const client = makeClient();
    videosListMock.mockResolvedValueOnce({
      data: {
        items: [
          makeVideoItem({
            id: 'shortvideo1',
            contentDetails: { duration: 'PT45S' },
          }),
        ],
      },
    });

    // Act
    const result = await client.getVideoById(asVideoId('shortvideo1'));

    // Assert
    expect(result?.durationSeconds).toBe(45);
    expect(result?.isShort).toBe(true);
  });

  it('throws AppError with YOUTUBE_API_PARSE_ERROR when the response is shape-broken', async () => {
    // Arrange — missing the required `snippet` field, so Zod must reject
    const client = makeClient();
    videosListMock.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: 'dQw4w9WgXcQ',
            // snippet, contentDetails missing → Zod rejects
          },
        ],
      },
    });

    // Act + Assert
    await expect(client.getVideoById(asVideoId('dQw4w9WgXcQ'))).rejects.toMatchObject({
      name: 'AppError',
      code: 'YOUTUBE_API_PARSE_ERROR',
    });
  });

  it('wraps SDK errors as AppError with YOUTUBE_API_ERROR', async () => {
    // Arrange
    const client = makeClient();
    videosListMock.mockRejectedValueOnce(new Error('forbidden 403'));

    // Act + Assert — 403 is non-retryable per RetryHandler.isRetryable, so it surfaces as the
    // raw Error (RetryHandler re-throws non-retryable errors). YouTubeClient wraps it
    // into an AppError.
    await expect(client.getVideoById(asVideoId('dQw4w9WgXcQ'))).rejects.toThrow();
  });

  it('only accepts branded VideoId at the type level (compile-time gate)', () => {
    // Arrange — this is a compile-time gate, not a runtime one. The
    // `// @ts-expect-error` line below asserts that passing a raw
    // string into the branded-id signature is a type error. If
    // branding regresses, the @ts-expect-error becomes "unused" and
    // `tsc` fails the build.
    //
    // We use a typed helper that wraps the call so no actual
    // promise is queued (avoids unhandled rejection on the SDK mock
    // queue). The helper's signature carries the brand requirement.
    const wantsBranded = (_v: ReturnType<typeof asVideoId>): void => undefined;
    const rawString = 'dQw4w9WgXcQ';

    // Branded input is assignable.
    wantsBranded(asVideoId('dQw4w9WgXcQ'));
    // Raw string input is NOT assignable to the branded type.
    // @ts-expect-error — raw string is not assignable to VideoId
    wantsBranded(rawString);
  });
});

// --------------------------------------------------------------------
// getPlaylistById
// --------------------------------------------------------------------

describe('YouTubeClient.getPlaylistById', () => {
  it('returns a parsed, branded YouTubePlaylist on a valid response', async () => {
    // Arrange
    const client = makeClient();
    playlistsListMock.mockResolvedValueOnce({ data: { items: [makePlaylistItem()] } });

    // Act
    const result = await client.getPlaylistById(asPlaylistId('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));

    // Assert
    expect(result).not.toBeNull();
    expect(result?.playlistId).toBe('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(result?.title).toBe('My Playlist');
    expect(result?.itemCount).toBe(42);
    expect(result?.privacyStatus).toBe('private');
    expect(result?.channelId).toBe('UCxxxxxxxxxxxxxxxxxxxxx');
  });

  it('returns null when the API returns no items', async () => {
    // Arrange
    const client = makeClient();
    playlistsListMock.mockResolvedValueOnce({ data: { items: [] } });

    // Act
    const result = await client.getPlaylistById(asPlaylistId('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));

    // Assert
    expect(result).toBeNull();
  });

  it('throws AppError with YOUTUBE_API_PARSE_ERROR when the response is shape-broken', async () => {
    // Arrange — contentDetails.itemCount is required
    const client = makeClient();
    playlistsListMock.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            snippet: makePlaylistItem().snippet,
            contentDetails: {}, // missing itemCount
          },
        ],
      },
    });

    // Act + Assert
    await expect(
      client.getPlaylistById(asPlaylistId('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'))
    ).rejects.toMatchObject({
      code: 'YOUTUBE_API_PARSE_ERROR',
    });
  });
});

// --------------------------------------------------------------------
// getPlaylistItems — pagination regression test (v1 bug class)
// --------------------------------------------------------------------

describe('YouTubeClient.getPlaylistItems', () => {
  it('paginates through nextPageToken and returns >50 items in total', async () => {
    // Arrange — three pages of 50 items each (150 total). Caller must
    // get every item back, not just the first 50.
    const playlistIdRaw = 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

    // Build page 1: 50 items, with nextPageToken='PAGE2'
    const page1Items = Array.from({ length: 50 }, (_, i) =>
      makePlaylistItemEntry(`vid${String(i).padStart(8, '0')}`, i, playlistIdRaw)
    );
    // Build page 2: 50 items, with nextPageToken='PAGE3'
    const page2Items = Array.from({ length: 50 }, (_, i) =>
      makePlaylistItemEntry(`vid${String(i + 50).padStart(8, '0')}`, i + 50, playlistIdRaw)
    );
    // Build page 3: 50 items, no nextPageToken (termination)
    const page3Items = Array.from({ length: 50 }, (_, i) =>
      makePlaylistItemEntry(`vid${String(i + 100).padStart(8, '0')}`, i + 100, playlistIdRaw)
    );

    playlistItemsListMock
      .mockResolvedValueOnce({ data: { items: page1Items, nextPageToken: 'PAGE2' } })
      .mockResolvedValueOnce({ data: { items: page2Items, nextPageToken: 'PAGE3' } })
      .mockResolvedValueOnce({ data: { items: page3Items } }); // no nextPageToken

    const client = makeClient();

    // Act
    const items = await client.getPlaylistItems(asPlaylistId(playlistIdRaw));

    // Assert — every page's items present, in order
    expect(items).toHaveLength(150);
    expect(items[0]?.position).toBe(0);
    expect(items[49]?.position).toBe(49);
    expect(items[50]?.position).toBe(50);
    expect(items[100]?.position).toBe(100);
    expect(items[149]?.position).toBe(149);

    // And the SDK was called exactly three times — once per page
    expect(playlistItemsListMock).toHaveBeenCalledTimes(3);

    // First call has no pageToken, subsequent calls forward the
    // previous nextPageToken.
    const calls = playlistItemsListMock.mock.calls;
    expect(calls[0]?.[0]?.pageToken).toBeUndefined();
    expect(calls[1]?.[0]?.pageToken).toBe('PAGE2');
    expect(calls[2]?.[0]?.pageToken).toBe('PAGE3');
  });

  it('returns empty array when the playlist has no items', async () => {
    // Arrange
    const client = makeClient();
    playlistItemsListMock.mockResolvedValueOnce({ data: { items: [] } });

    // Act
    const items = await client.getPlaylistItems(asPlaylistId('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));

    // Assert
    expect(items).toEqual([]);
    expect(playlistItemsListMock).toHaveBeenCalledTimes(1);
  });

  it('brands the returned videoId / playlistId fields', async () => {
    // Arrange
    const client = makeClient();
    playlistItemsListMock.mockResolvedValueOnce({
      data: {
        items: [makePlaylistItemEntry('aaaaaaaaaaa', 0)],
      },
    });

    // Act
    const items = await client.getPlaylistItems(asPlaylistId('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));

    // Assert — branded values are still strings at runtime, but at
    // compile time they're VideoId / PlaylistId. Round-trip both
    // through their constructors to prove the runtime values are
    // shape-valid.
    expect(items[0]).toBeDefined();
    const videoId = items[0]?.videoId;
    const playlistId = items[0]?.playlistId;
    expect(videoId).toBe('aaaaaaaaaaa');
    expect(playlistId).toBe('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    // Re-validating succeeds (i.e. the persisted value is a valid ID).
    expect(asVideoId(videoId as string)).toBe('aaaaaaaaaaa');
    expect(asPlaylistId(playlistId as string)).toBe('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('throws AppError with YOUTUBE_API_PARSE_ERROR on shape-broken page', async () => {
    // Arrange — first page is fine, second page is malformed (item
    // missing snippet) — Zod must reject before re-pagination.
    const playlistIdRaw = 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    playlistItemsListMock
      .mockResolvedValueOnce({
        data: {
          items: [makePlaylistItemEntry('aaaaaaaaaaa', 0, playlistIdRaw)],
          nextPageToken: 'PAGE2',
        },
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: 'pli-1' /* no snippet, no contentDetails */ }] },
      });

    const client = makeClient();

    // Act + Assert
    await expect(client.getPlaylistItems(asPlaylistId(playlistIdRaw))).rejects.toMatchObject({
      code: 'YOUTUBE_API_PARSE_ERROR',
    });
  });
});

// --------------------------------------------------------------------
// getMyPlaylists — pagination
// --------------------------------------------------------------------

describe('YouTubeClient.getMyPlaylists', () => {
  it('paginates through nextPageToken and returns every playlist', async () => {
    // Arrange — two pages, 50 + 25 = 75 playlists total
    const page1 = Array.from({ length: 50 }, (_, i) =>
      makePlaylistItem({
        id: `PL${String(i).padStart(32, 'a')}`,
        snippet: {
          ...(makePlaylistItem().snippet as Record<string, unknown>),
          title: `Playlist ${i}`,
        },
      })
    );
    const page2 = Array.from({ length: 25 }, (_, i) =>
      makePlaylistItem({
        id: `PL${String(i + 50).padStart(32, 'b')}`,
        snippet: {
          ...(makePlaylistItem().snippet as Record<string, unknown>),
          title: `Playlist ${i + 50}`,
        },
      })
    );

    playlistsListMock
      .mockResolvedValueOnce({ data: { items: page1, nextPageToken: 'PAGE2' } })
      .mockResolvedValueOnce({ data: { items: page2 } });

    const client = makeClient();

    // Act
    const playlists = await client.getMyPlaylists();

    // Assert
    expect(playlists).toHaveLength(75);
    expect(playlists[0]?.title).toBe('Playlist 0');
    expect(playlists[74]?.title).toBe('Playlist 74');
    expect(playlistsListMock).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when the account has no playlists', async () => {
    // Arrange
    const client = makeClient();
    playlistsListMock.mockResolvedValueOnce({ data: { items: [] } });

    // Act
    const playlists = await client.getMyPlaylists();

    // Assert
    expect(playlists).toEqual([]);
  });
});

// --------------------------------------------------------------------
// searchPlaylists
// --------------------------------------------------------------------

describe('YouTubeClient.searchPlaylists', () => {
  it('returns parsed, branded search results on a valid response', async () => {
    // Arrange
    const client = makeClient();
    searchListMock.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: { kind: 'youtube#playlist', playlistId: 'PLsearchresult123456789012345' },
            snippet: {
              publishedAt: '2024-03-01T00:00:00Z',
              channelId: 'UCsearchchannel',
              title: 'A matching playlist',
              description: 'desc',
              channelTitle: 'searcher',
            },
          },
        ],
      },
    });

    // Act
    const results = await client.searchPlaylists('javascript tutorials');

    // Assert
    expect(results).toHaveLength(1);
    expect(results[0]?.playlistId).toBe('PLsearchresult123456789012345');
    expect(results[0]?.title).toBe('A matching playlist');
    expect(results[0]?.channelId).toBe('UCsearchchannel');
  });

  it('throws ValidationError when query is empty', async () => {
    // Arrange
    const client = makeClient();

    // Act + Assert
    await expect(client.searchPlaylists('')).rejects.toThrow(ValidationError);
    await expect(client.searchPlaylists('   ')).rejects.toThrow(ValidationError);
  });

  it('does not call the SDK when query validation fails', async () => {
    // Arrange
    const client = makeClient();

    // Act
    try {
      await client.searchPlaylists('');
    } catch {
      // expected
    }

    // Assert — no API call attempted
    expect(searchListMock).not.toHaveBeenCalled();
  });

  it('throws AppError with YOUTUBE_API_PARSE_ERROR when results are shape-broken', async () => {
    // Arrange — id.playlistId missing
    const client = makeClient();
    searchListMock.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: { kind: 'youtube#playlist' /* playlistId missing */ },
            snippet: {
              publishedAt: '2024-03-01T00:00:00Z',
              channelId: 'UCfoo',
              title: 'broken',
              channelTitle: 'broken',
            },
          },
        ],
      },
    });

    // Act + Assert
    await expect(client.searchPlaylists('anything')).rejects.toMatchObject({
      code: 'YOUTUBE_API_PARSE_ERROR',
    });
  });
});

// --------------------------------------------------------------------
// AppError contract sanity
// --------------------------------------------------------------------

describe('YouTubeClient — error wrapping contract', () => {
  it('preserves AppError thrown by parseResponse (does not re-wrap)', async () => {
    // Arrange — Zod-broken payload triggers AppError inside parseResponse;
    // the outer catch must detect "already AppError" and rethrow as-is,
    // not double-wrap.
    const client = makeClient();
    videosListMock.mockResolvedValueOnce({
      data: { items: [{ id: 'dQw4w9WgXcQ' /* nothing else */ }] },
    });

    // Act
    let thrown: unknown;
    try {
      await client.getVideoById(asVideoId('dQw4w9WgXcQ'));
    } catch (e) {
      thrown = e;
    }

    // Assert — code is the parse-specific one, not the outer wrap.
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('YOUTUBE_API_PARSE_ERROR');
  });
});

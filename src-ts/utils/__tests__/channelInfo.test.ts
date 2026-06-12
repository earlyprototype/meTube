/**
 * Coverage for fetchChannelTitle (task 5) — the UI-side channel lookup that
 * powers init's "Authenticated as: {channel}" line. It calls channels.list
 * mine=true through the existing googleapis surface. Best-effort: any failure
 * returns null so init still reports success.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const channelsListSpy = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    youtube: () => ({
      channels: {
        list: (...args: unknown[]) => channelsListSpy(...args),
      },
    }),
  },
}));

import { fetchChannelTitle } from '../channelInfo.js';
import type { OAuth2Client } from 'google-auth-library';

const FAKE_CLIENT = {} as OAuth2Client;

afterEach(() => {
  channelsListSpy.mockReset();
});

describe('fetchChannelTitle', () => {
  it('returns the channel title from channels.list mine=true', async () => {
    channelsListSpy.mockResolvedValue({
      data: { items: [{ snippet: { title: 'My Channel' } }] },
    });

    expect(await fetchChannelTitle(FAKE_CLIENT)).toBe('My Channel');
    expect(channelsListSpy).toHaveBeenCalledWith({ part: ['snippet'], mine: true });
  });

  it('returns null when the account has no channel items', async () => {
    channelsListSpy.mockResolvedValue({ data: { items: [] } });

    expect(await fetchChannelTitle(FAKE_CLIENT)).toBeNull();
  });

  it('returns null when the title is missing or empty', async () => {
    channelsListSpy.mockResolvedValue({ data: { items: [{ snippet: {} }] } });
    expect(await fetchChannelTitle(FAKE_CLIENT)).toBeNull();

    channelsListSpy.mockResolvedValue({ data: { items: [{ snippet: { title: '' } }] } });
    expect(await fetchChannelTitle(FAKE_CLIENT)).toBeNull();
  });

  it('returns null (does not throw) when the API call rejects', async () => {
    channelsListSpy.mockRejectedValue(new Error('quota exceeded'));

    expect(await fetchChannelTitle(FAKE_CLIENT)).toBeNull();
  });
});

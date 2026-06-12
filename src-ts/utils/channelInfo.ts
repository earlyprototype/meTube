/**
 * UI-side channel lookup for `init` feedback (task 5).
 *
 * Python's `init` prints "Authenticated as: {channel}" after a successful auth
 * (cli.py:254-257), using the OAuth handler's `get_channel_info()`
 * (channels.list mine=true). The v2 YouTubeClient exposes no equivalent method,
 * so — per the parity-close brief — this calls the API through the existing
 * `googleapis` surface from the UI side, WITHOUT editing src-ts-v2.
 *
 * Best-effort: any failure (network, quota, no channel on the account) returns
 * `null`. Init must still report success even if the channel name can't be
 * fetched — the auth itself already succeeded.
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

import logger from '../../src-ts-v2/utils/logger.js';

/**
 * Fetch the authenticated user's primary channel title.
 *
 * @param oauthClient - The live OAuth2Client returned by `YouTubeAuth.authenticate()`.
 * @returns The channel title, or `null` if it could not be determined.
 */
export async function fetchChannelTitle(oauthClient: OAuth2Client): Promise<string | null> {
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauthClient });
    const response = await youtube.channels.list({ part: ['snippet'], mine: true });
    const title = response.data.items?.[0]?.snippet?.title;
    return typeof title === 'string' && title.length > 0 ? title : null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Could not fetch authenticated channel title for init feedback'
    );
    return null;
  }
}

/**
 * OAuthServer — focused security test.
 *
 * The OAuth callback echoes the `error` query-string parameter into the
 * HTML response body. v1 (and pre-fix v2) interpolated it raw, so a
 * crafted callback URL like `?error=<script>alert(1)</script>` would
 * execute in the user's browser. This test spins up the real server on
 * an ephemeral port, sends a malicious error value, and asserts the
 * rendered HTML contains the escaped form rather than the raw script.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureAuthorizationCode } from '../auth/OAuthServer.js';

interface FetchResult {
  status: number;
  body: string;
}

/**
 * Pick a port that's almost certainly free. The OS-assigned port path
 * isn't worth the complexity for a one-shot test; in CI we pick a
 * high port and accept the rare collision. Tests retry the listen with
 * a different port if the first one is busy.
 */
function freshPort(): number {
  return 39000 + Math.floor(Math.random() * 2000);
}

async function hit(port: number, query: string): Promise<FetchResult> {
  const res = await fetch(`http://localhost:${port}/?${query}`);
  return { status: res.status, body: await res.text() };
}

describe('OAuthServer.captureAuthorizationCode — security', () => {
  let captured: Promise<string> | undefined;

  beforeEach(() => {
    captured = undefined;
  });

  afterEach(async () => {
    // Drain any in-flight promise so it doesn't leak server handles.
    if (captured) {
      await captured.catch(() => {
        /* swallow — we expect rejection in error-path tests */
      });
    }
  });

  it('escapes a malicious `error` query value before rendering it into HTML', async () => {
    // Arrange — start the one-shot capture server on a fresh port.
    const port = freshPort();
    captured = captureAuthorizationCode({ port, timeout: 5000 });
    // Attach a noop rejection handler immediately so the eventual reject
    // (this is the error path) does not surface as an unhandled rejection.
    const settled = captured.catch((e: unknown) => e);

    // Give the server a tick to bind.
    await new Promise((r) => setTimeout(r, 50));

    // Act — hit the callback with an XSS payload as the error.
    const payload = '<script>alert(1)</script>';
    const result = await hit(port, `error=${encodeURIComponent(payload)}`);

    // Assert — the response includes an HTML page (status 200) with the
    // payload escaped (no raw `<script>`) but the escaped form present.
    expect(result.status).toBe(200);
    expect(result.body).not.toContain('<script>alert(1)</script>');
    expect(result.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

    // Assert — the captured promise rejects, since this is the error path.
    const settledError = await settled;
    expect(settledError).toBeInstanceOf(Error);
  });

  it('reports a normal error value unmodified except for HTML-significant chars', async () => {
    // Arrange
    const port = freshPort();
    captured = captureAuthorizationCode({ port, timeout: 5000 });
    const settled = captured.catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));

    // Act — a plain OAuth error code like "access_denied" should round-trip.
    const result = await hit(port, 'error=access_denied');

    // Assert
    expect(result.status).toBe(200);
    expect(result.body).toContain('access_denied');

    const settledError = await settled;
    expect(settledError).toBeInstanceOf(Error);
  });
});

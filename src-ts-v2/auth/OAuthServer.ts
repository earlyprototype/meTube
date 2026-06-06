/**
 * Temporary local OAuth server (v2) — lifted from v1's `OAuthServer.ts`
 * with two tightenings:
 *
 *   1. **OAuth `state` verification.** v1 had no CSRF protection on the
 *      callback. v2 accepts an `expectedState` option; if set, the
 *      callback must echo it back exactly or the promise rejects with
 *      `OAUTH_STATE_MISMATCH`. RFC 6749 §10.12.
 *   2. **Errors wrapped as `AppError` with explicit codes.** v1 threw
 *      bare `Error`; downstream code couldn't switch on cause. v2 uses
 *      `AppError` with `OAUTH_*` codes throughout.
 *
 * Everything else is the v1 shape — one-shot server on `localhost:port`,
 * inline HTML rendered to the user's browser, cleanup on every
 * terminal event, browser auto-open via the platform's launcher.
 */

import http from 'http';
import { URL } from 'url';

import { AppError } from '../errors/index.js';
import logger from '../utils/logger.js';

/**
 * Options for capturing the OAuth authorization code from the
 * one-shot local server.
 */
export interface CaptureOptions {
  /** Port to bind the temporary server on. Defaults to 3000. */
  port?: number;
  /** Timeout in milliseconds. Defaults to 5 minutes. */
  timeout?: number;
  /**
   * Expected `state` parameter for CSRF protection. If set, the
   * callback must echo it back exactly; otherwise the promise rejects
   * with `OAUTH_STATE_MISMATCH`.
   */
  expectedState?: string;
}

/**
 * Minimal HTML-attribute/text escaper. The OAuth callback echoes
 * untrusted query-string values into the response body (`error=...`),
 * so any character that closes a tag or starts a script needs to be
 * escaped before interpolation. Five-char escape is sufficient for
 * inner-text + double-quoted attributes; the body never interpolates
 * into single-quoted contexts or `<script>` blocks.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline HTML helper. Server dies on capture, so no external assets. */
function renderHtml(title: string, heading: string, body: string, color: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
    .status { color: ${color}; }
  </style>
</head>
<body>
  <h1 class="status">${heading}</h1>
  ${body}
</body>
</html>`;
}

/**
 * Start a one-shot HTTP server that catches an OAuth callback at `/`
 * and resolves with the `code` query parameter.
 *
 * Rejects on:
 *   - `EADDRINUSE` → `OAUTH_PORT_IN_USE`
 *   - timeout → `OAUTH_TIMEOUT`
 *   - user denies access → `OAUTH_USER_DENIED`
 *   - missing `code` parameter → `OAUTH_NO_CODE`
 *   - state mismatch when `expectedState` is set → `OAUTH_STATE_MISMATCH`
 *   - server-side exception → `OAUTH_CALLBACK_CRASH` / `OAUTH_SERVER_ERROR`
 *
 * On every terminal event the server is closed and the timeout
 * cleared, so the process can exit cleanly.
 */
export async function captureAuthorizationCode(options: CaptureOptions = {}): Promise<string> {
  const port = options.port ?? 3000;
  const timeout = options.timeout ?? 5 * 60 * 1000;
  const expectedState = options.expectedState;

  return new Promise<string>((resolve, reject) => {
    let server: http.Server | null = null;
    let timeoutId: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };

    server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);

        if (url.pathname !== '/') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        if (error) {
          // Untrusted query-string value — escape before interpolating
          // into the response body. A crafted callback URL such as
          // `?error=<script>alert(1)</script>` would otherwise execute
          // in the user's browser.
          const safeError = escapeHtml(error);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            renderHtml(
              'Authorization Failed',
              'Authorization Failed',
              `<p>Error: ${safeError}</p><p>You can close this window and return to the terminal.</p>`,
              '#d32f2f'
            )
          );
          cleanup();
          reject(
            new AppError(`OAuth error: ${error}`, {
              code: 'OAUTH_USER_DENIED',
              context: { error },
            })
          );
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(
            renderHtml(
              'Invalid Request',
              'Invalid OAuth Callback',
              '<p>No authorization code received.</p>',
              '#d32f2f'
            )
          );
          cleanup();
          reject(
            new AppError('Invalid OAuth callback — no code received', {
              code: 'OAUTH_NO_CODE',
            })
          );
          return;
        }

        if (expectedState !== undefined && state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(
            renderHtml(
              'State Mismatch',
              'State Mismatch',
              '<p>OAuth state parameter did not match. Possible CSRF attempt.</p>',
              '#d32f2f'
            )
          );
          cleanup();
          reject(
            new AppError('OAuth state parameter mismatch — possible CSRF attempt', {
              code: 'OAUTH_STATE_MISMATCH',
            })
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          renderHtml(
            'Authorization Successful',
            'Authorization Successful',
            '<p>You can close this window and return to the terminal.</p><p>The application is now authorized to access your YouTube data.</p>',
            '#388e3c'
          )
        );

        logger.info('Authorization code captured');
        cleanup();
        resolve(code);
      } catch (err) {
        logger.error({ err }, 'Error handling OAuth callback');
        res.writeHead(500);
        res.end('Internal Server Error');
        cleanup();
        reject(
          new AppError('OAuth callback handler crashed', {
            code: 'OAUTH_CALLBACK_CRASH',
            cause: err,
          })
        );
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === 'EADDRINUSE') {
        reject(
          new AppError(
            `Port ${port} is already in use. Close other applications or pick a different port.`,
            { code: 'OAUTH_PORT_IN_USE', context: { port }, cause: err }
          )
        );
      } else {
        reject(
          new AppError('OAuth callback server error', {
            code: 'OAUTH_SERVER_ERROR',
            cause: err,
          })
        );
      }
    });

    server.listen(port, () => {
      logger.info({ port }, 'OAuth callback server listening');
    });

    timeoutId = setTimeout(() => {
      cleanup();
      reject(
        new AppError(`Authorization timeout — no response received within ${timeout / 1000}s`, {
          code: 'OAUTH_TIMEOUT',
          context: { timeoutMs: timeout },
        })
      );
    }, timeout);
  });
}

/**
 * Open a URL in the user's default browser, cross-platform.
 *
 * Delegates to the `open` npm package, which handles cross-platform
 * URL escaping correctly. The previous hand-rolled `cmd /c start ""`
 * shell-out on Windows truncated OAuth URLs at the first `&` query
 * separator because `cmd start` interprets `&` as a command separator
 * — Google then rejected the request with "Required parameter is
 * missing: response_type".
 *
 * `open` v11 returns `Promise<ChildProcess>` that resolves once the
 * child process is spawned (not when the browser finishes rendering),
 * which matches our best-effort contract.
 */
export async function openBrowser(url: string): Promise<void> {
  const open = (await import('open')).default;
  try {
    await open(url);
  } catch (err) {
    logger.warn({ err }, 'Failed to open browser automatically');
    throw new AppError('Failed to open browser', {
      code: 'OPEN_BROWSER_FAILED',
      cause: err,
    });
  }
}

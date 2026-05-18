/**
 * Temporary local OAuth server to capture authorization code
 * Automatically handles the OAuth redirect and extracts the code
 */

import http from 'http';
import { URL } from 'url';
import logger from '../utils/logger.js';

export interface OAuthServerResult {
  code: string;
  success: boolean;
  error?: string;
}

/**
 * Start a temporary HTTP server to capture OAuth authorization code
 *
 * @param port - Port to listen on (default: 3000)
 * @param timeout - Timeout in milliseconds (default: 5 minutes)
 * @returns Promise that resolves with the authorization code
 */
export async function captureAuthorizationCode(port = 3000, timeout = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: http.Server | null = null;
    let timeoutId: NodeJS.Timeout | null = null;

    // Cleanup function
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (server) {
        server.close();
      }
    };

    // Create HTTP server to handle OAuth callback
    server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || '', `http://localhost:${port}`);

        // Check if this is the OAuth callback
        if (url.pathname === '/') {
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) {
            // OAuth error (user denied access, etc.)
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <title>Authorization Failed</title>
                <style>
                  body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                  .error { color: #d32f2f; }
                </style>
              </head>
              <body>
                <h1 class="error">Authorization Failed</h1>
                <p>Error: ${error}</p>
                <p>You can close this window and return to the terminal.</p>
              </body>
              </html>
            `);

            cleanup();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (code) {
            // Success! We got the authorization code
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <title>Authorization Successful</title>
                <style>
                  body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                  .success { color: #388e3c; }
                </style>
              </head>
              <body>
                <h1 class="success">✓ Authorization Successful!</h1>
                <p>You can close this window and return to the terminal.</p>
                <p>The application is now authorized to access your YouTube data.</p>
              </body>
              </html>
            `);

            logger.info('Authorization code captured successfully');
            cleanup();
            resolve(code);
            return;
          }

          // No code or error - invalid callback
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Invalid Request</title>
            </head>
            <body>
              <h1>Invalid OAuth Callback</h1>
              <p>No authorization code received.</p>
            </body>
            </html>
          `);

          cleanup();
          reject(new Error('Invalid OAuth callback - no code received'));
        } else {
          // Favicon or other request - ignore
          res.writeHead(404);
          res.end();
        }
      } catch (error) {
        logger.error({ error }, 'Error handling OAuth callback');
        res.writeHead(500);
        res.end('Internal Server Error');
        cleanup();
        reject(error);
      }
    });

    // Handle server errors
    server.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(`Port ${port} is already in use. Please close other applications or try again.`)
        );
      } else {
        reject(error);
      }
    });

    // Start server
    server.listen(port, () => {
      logger.info({ port }, 'OAuth server listening for authorization callback');
      console.log(`\n🌐 OAuth server started on http://localhost:${port}`);
    });

    // Set timeout
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Authorization timeout - no response received within 5 minutes'));
    }, timeout);
  });
}

/**
 * Open URL in default browser
 * Cross-platform implementation
 *
 * @param url - URL to open
 */
export async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('child_process');

  let command: string;
  let args: string[];

  // Detect platform and use appropriate command
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    // Linux/Unix
    command = 'xdg-open';
    args = [url];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });

    child.on('error', (error) => {
      logger.warn({ error }, 'Failed to open browser automatically');
      reject(error);
    });

    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * One-shot diagnostic probe for `YouTubeClient.getMyPlaylists()`.
 *
 * The Ink UI surfaces "failed to fetch playlists" on `playlist discover`
 * but the underlying AppError.cause / context / stack get eaten by the
 * UI. This script reproduces the call OUTSIDE the Ink layer with every
 * possible diagnostic dial cranked.
 *
 * What it does:
 *   1. Force LOG_LEVEL=debug + DEBUG=true BEFORE the v2 logger is
 *      imported (the logger snapshots env at module-load time).
 *   2. Construct YouTubeAuth pointing at the project-root
 *      client_secret.json + tokens.json (exactly what the CLI uses).
 *   3. authenticate() — which on a fresh tokens.json just hydrates the
 *      OAuth2Client without a browser flow.
 *   4. Inspect what's actually in the token (scopes, expiry, refresh
 *      token presence) WITHOUT printing the token bytes.
 *   5. Construct YouTubeClient and call getMyPlaylists().
 *   6. On success — print count + the first few titles, exit 0.
 *   7. On failure — recursively walk error.cause to surface the real
 *      googleapis / Zod / HTTP root cause, dump the raw API response if
 *      one is attached anywhere in the chain, print any AppError
 *      context, and exit 1.
 *
 * Convention: scripts/dev/ is exempt from the no-console.* rule per
 * CLAUDE.md — it's ad-hoc developer tooling, not production code.
 *
 * Run with: npx tsx scripts/dev/probe-getmyplaylists.ts
 */

/* eslint-disable no-console */

// MUST be set before importing the v2 logger — pino snapshots env at
// module-load. Doing this after the import would log at the default
// level ("error") and we'd see nothing of the internal flow.
process.env.LOG_LEVEL = 'debug';
process.env.DEBUG = 'true';

import * as path from 'path';
import * as fs from 'fs';

import { YouTubeAuth } from '../../src-ts-v2/auth/YouTubeAuth.js';
import { YouTubeClient } from '../../src-ts-v2/api/YouTubeClient.js';
import { AppError } from '../../src-ts-v2/errors/index.js';

const PROJECT_ROOT = path.resolve(process.cwd());
const CRED_PATH = path.join(PROJECT_ROOT, 'client_secret.json');
const TOKENS_PATH = path.join(PROJECT_ROOT, 'tokens.json');

function banner(title: string): void {
  const bar = '='.repeat(72);
  console.log('\n' + bar);
  console.log(title);
  console.log(bar);
}

function safe<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    console.error(`[safe] ${label} threw: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Recursively walk error.cause printing everything useful. googleapis
 * wraps HTTP errors as GaxiosError with `.response.data` / `.code` /
 * `.errors`. Zod errors have `.issues`. AppError has `.code` /
 * `.context` / `.cause`.
 */
function dumpError(err: unknown, depth = 0): void {
  const indent = '  '.repeat(depth);
  if (err === null || err === undefined) {
    console.error(`${indent}(null/undefined error)`);
    return;
  }

  if (!(err instanceof Error)) {
    console.error(`${indent}non-Error thrown: ${typeof err}`, err);
    return;
  }

  console.error(`${indent}[depth ${depth}] ${err.name}: ${err.message}`);

  // AppError fields
  const anyErr = err as unknown as Record<string, unknown>;
  if (typeof anyErr.code === 'string') {
    console.error(`${indent}  code: ${anyErr.code}`);
  }
  if (typeof anyErr.statusCode === 'number') {
    console.error(`${indent}  statusCode: ${anyErr.statusCode}`);
  }
  if (anyErr.context !== undefined) {
    console.error(`${indent}  context:`, anyErr.context);
  }

  // GaxiosError / fetch-style fields
  if (anyErr.status !== undefined) {
    console.error(`${indent}  status: ${String(anyErr.status)}`);
  }
  if (anyErr.response !== undefined && anyErr.response !== null) {
    const resp = anyErr.response as Record<string, unknown>;
    console.error(`${indent}  response.status: ${String(resp.status)}`);
    console.error(`${indent}  response.statusText: ${String(resp.statusText)}`);
    if (resp.data !== undefined) {
      console.error(`${indent}  response.data:`, JSON.stringify(resp.data, null, 2));
    }
    if (resp.headers !== undefined) {
      // Trim potentially large header objects
      const headers = resp.headers as Record<string, unknown>;
      const keepKeys = [
        'content-type',
        'www-authenticate',
        'x-goog-api-version',
        'x-debug-message',
      ];
      const trimmed: Record<string, unknown> = {};
      for (const k of keepKeys) {
        if (headers[k] !== undefined) trimmed[k] = headers[k];
      }
      console.error(`${indent}  response.headers (selected):`, trimmed);
    }
  }
  if (Array.isArray(anyErr.errors)) {
    console.error(`${indent}  errors[]:`, anyErr.errors);
  }
  // Zod
  if (Array.isArray(anyErr.issues)) {
    console.error(`${indent}  zod issues[]:`, anyErr.issues);
  }

  // Stack — short version
  if (typeof err.stack === 'string') {
    const stackLines = err.stack.split('\n').slice(0, 8).join('\n');
    console.error(`${indent}  stack (top 8 lines):\n${stackLines}`);
  }

  // Recurse into cause
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause !== undefined && cause !== err) {
    console.error(`${indent}  ---- cause ----`);
    dumpError(cause, depth + 1);
  }
}

async function main(): Promise<void> {
  banner('PROBE: getMyPlaylists()');
  console.log('cwd:               ', process.cwd());
  console.log('credentialsPath:   ', CRED_PATH);
  console.log('tokensPath:        ', TOKENS_PATH);
  console.log('LOG_LEVEL:         ', process.env.LOG_LEVEL);
  console.log('DEBUG:             ', process.env.DEBUG);
  console.log('NODE_ENV:          ', process.env.NODE_ENV ?? '(unset)');
  console.log('node version:      ', process.version);

  banner('STEP 1: file presence');
  const credExists = fs.existsSync(CRED_PATH);
  const tokensExists = fs.existsSync(TOKENS_PATH);
  console.log('client_secret.json exists:', credExists);
  console.log('tokens.json exists:       ', tokensExists);
  if (!credExists || !tokensExists) {
    console.error('Missing required files. Aborting.');
    process.exit(2);
  }

  banner('STEP 2: client_secret.json shape (NON-SENSITIVE FIELDS ONLY)');
  safe('inspect client_secret.json', () => {
    const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf-8')) as Record<string, unknown>;
    const section = (raw.installed ?? raw.web) as Record<string, unknown> | undefined;
    if (!section) {
      console.log('  no installed/web section!');
      return;
    }
    console.log('  section type:        ', raw.installed ? 'installed' : 'web');
    console.log(
      '  client_id (last 12): ',
      typeof section.client_id === 'string'
        ? '...' + section.client_id.slice(-12)
        : '(missing/non-string)'
    );
    console.log(
      '  project_id:          ',
      section.project_id ?? '(missing — this is the Google Cloud project we hit)'
    );
    console.log('  redirect_uris:       ', section.redirect_uris);
    console.log('  auth_uri:            ', section.auth_uri);
    console.log('  token_uri:           ', section.token_uri);
  });

  banner('STEP 3: tokens.json shape (NO TOKEN BYTES)');
  safe('inspect tokens.json', () => {
    const raw = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8')) as Record<string, unknown>;
    console.log('  has access_token:    ', typeof raw.access_token === 'string');
    console.log(
      '  access_token length: ',
      typeof raw.access_token === 'string' ? raw.access_token.length : '(n/a)'
    );
    console.log('  has refresh_token:   ', typeof raw.refresh_token === 'string');
    console.log('  token_type:          ', raw.token_type);
    console.log('  scope:               ', raw.scope);
    if (typeof raw.expiry_date === 'number') {
      const now = Date.now();
      const delta = raw.expiry_date - now;
      console.log('  expiry_date:         ', new Date(raw.expiry_date).toISOString());
      console.log('  ms until expiry:     ', delta, `(expired: ${delta < 0})`);
    } else {
      console.log('  expiry_date:         ', raw.expiry_date, '(non-numeric)');
    }
  });

  banner('STEP 4: YouTubeAuth.authenticate()');
  const auth = new YouTubeAuth({
    credentialsPath: CRED_PATH,
    tokensPath: TOKENS_PATH,
  });

  let oauthClient;
  try {
    oauthClient = await auth.authenticate();
    console.log('  authenticate() returned an OAuth2Client');
    const creds = oauthClient.credentials;
    console.log('  credentials.token_type:    ', creds.token_type);
    console.log('  credentials.scope:         ', creds.scope);
    console.log(
      '  credentials.expiry_date:   ',
      typeof creds.expiry_date === 'number'
        ? new Date(creds.expiry_date).toISOString()
        : creds.expiry_date
    );
    console.log('  has refresh_token:         ', !!creds.refresh_token);
  } catch (err) {
    console.error('  authenticate() threw:');
    dumpError(err);
    process.exit(3);
  }

  banner('STEP 5: YouTubeClient + getMyPlaylists()');
  let client;
  try {
    client = new YouTubeClient(oauthClient);
    console.log('  YouTubeClient constructed');
  } catch (err) {
    console.error('  YouTubeClient constructor threw:');
    dumpError(err);
    process.exit(4);
  }

  try {
    const playlists = await client.getMyPlaylists();
    banner('SUCCESS');
    console.log(`  Fetched ${playlists.length} playlists.`);
    for (const p of playlists.slice(0, 10)) {
      console.log(
        `    - ${p.title}  [${p.playlistId}]  itemCount=${p.itemCount}  privacy=${p.privacyStatus ?? '(unknown)'}`
      );
    }
    if (playlists.length > 10) {
      console.log(`    ... (${playlists.length - 10} more)`);
    }
    process.exit(0);
  } catch (err) {
    banner('FAILURE — getMyPlaylists() threw');
    if (err instanceof AppError) {
      console.error('Top-level error is an AppError.');
    } else if (err instanceof Error) {
      console.error('Top-level error is a plain Error (not AppError).');
    } else {
      console.error('Top-level error is NOT an Error instance.');
    }
    dumpError(err);
    process.exit(5);
  }
}

main().catch((err) => {
  banner('UNCAUGHT in main()');
  dumpError(err);
  process.exit(99);
});

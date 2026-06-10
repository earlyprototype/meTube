import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { YouTubeAuth } from '../../src-ts-v2/auth/YouTubeAuth.js';
import { DatabaseManager } from '../../src-ts-v2/database/connection.js';
import { loadConfig } from '../../src-ts-v2/config/loadConfig.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';
import { StatusPanel } from '../components/StatusPanel.js';
import { fetchChannelTitle } from '../utils/channelInfo.js';
import { isGeminiConfigured } from '../utils/appConfig.js';
import { buildErrorInfo, type ErrorInfo } from '../utils/errorInfo.js';
import { safeTitle } from '../utils/terminal.js';
import { symbols } from '../utils/colors.js';
import logger from '../../src-ts-v2/utils/logger.js';

interface InitCommandProps {
  force?: boolean;
  onComplete?: () => void;
}

export function InitCommand({ force = false, onComplete }: InitCommandProps) {
  const { exit } = useApp();
  const [status, setStatus] = useState<'initializing' | 'authenticating' | 'success' | 'error'>(
    'initializing'
  );
  const [message, setMessage] = useState('Initializing...');
  const [error, setError] = useState<string | null>(null);
  const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);
  // Authenticated channel name (Python: "Authenticated as: {channel}",
  // cli.py:257). Null when it couldn't be fetched — auth still succeeded.
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  // Whether a Gemini API key is configured (Python prints a configured /
  // warning line, cli.py:262-267).
  const [geminiConfigured, setGeminiConfigured] = useState<boolean>(false);

  useEffect(() => {
    async function init() {
      try {
        // Load config (replaces the hardcoded data/metube.db path; provides
        // the credential/token paths and the Gemini key). A present-but-broken
        // config throws ConfigError, which surfaces through the normal error
        // path with the CONFIG_ERROR remediation (task 8).
        const config = loadConfig();

        // Whether a Gemini API key is configured — Python checks
        // config['api']['gemini_api_key'] (cli.py:263), which resolves from the
        // env via ${VAR} substitution, falling back to the env directly so an
        // un-templated config still reflects a set key. isGeminiConfigured adds
        // the placeholder guard: when GEMINI_API_KEY is unset, the loader leaves
        // the literal '${GEMINI_API_KEY}' in config.api.gemini_api_key (truthy
        // but not a real key), so a naive Boolean() would wrongly report
        // "configured". We deliberately diverge from the Python bug here.
        setGeminiConfigured(isGeminiConfigured(config.api.gemini_api_key));

        // Step 1: Check database — v2 DatabaseManager opens lazily in the
        // constructor and schema-bootstraps; close() is idempotent.
        setMessage('Checking database...');
        const db = new DatabaseManager(config.database.path);
        db.close();

        // Step 2: Authenticate
        setStatus('authenticating');
        setMessage('Authenticating with YouTube...');

        const auth = new YouTubeAuth({
          credentialsPath: config.api.youtube_credentials,
          tokensPath: config.api.token_file,
        });

        // v2 has no `force` parameter on authenticate(); the equivalent is to
        // delete the tokens file before calling. When --force is set, drop the
        // existing tokens so authenticate() runs the full browser flow.
        if (force) {
          const fs = await import('fs');
          if (fs.existsSync(config.api.token_file)) {
            fs.unlinkSync(config.api.token_file);
            logger.info('Deleted tokens for forced re-authentication');
          }
        }

        // authenticate() returns an OAuth2Client whether it ran the full flow
        // or short-circuited on a valid tokens file (hydrate + return). Either
        // way we now hold a usable client for the channel lookup — so unlike
        // the old loadTokens() early-return, the "already authenticated" path
        // still surfaces the channel name + Gemini status Python prints.
        const oauthClient = await auth.authenticate();

        // Best-effort channel name (Python "Authenticated as: {channel}",
        // cli.py:257). Null on any failure — auth already succeeded.
        const title = await fetchChannelTitle(oauthClient);
        if (title) {
          setChannelTitle(safeTitle(title));
        }

        setStatus('success');
        setMessage('Authentication successful!');
        if (onComplete) {
          onComplete();
        } else {
          setTimeout(() => exit(), 2000);
        }
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
        setErrorInfo(buildErrorInfo(err));
        if (!onComplete) {
          setTimeout(() => exit(), 100);
        }
      }
    }

    init();
  }, [force, exit, onComplete]);

  if (status === 'error') {
    return (
      <ErrorDisplay
        message={error || 'Initialization failed'}
        code={errorInfo?.code}
        remediationContext={errorInfo?.remediationContext}
        suggestions={
          // Keep the generic init hints only when there is no code-driven
          // remediation; a mapped code (e.g. MISSING_CREDS, CONFIG_ERROR)
          // provides more specific steps.
          errorInfo?.code
            ? undefined
            : [
                'Check that client_secret.json exists',
                'Verify your internet connection',
                'Run with --force to re-authenticate',
              ]
        }
      />
    );
  }

  if (status === 'success') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box borderStyle="round" borderColor="green" padding={1} flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="green">
              OK Initialization Complete
            </Text>
          </Box>
          <Box>
            <Text>{message}</Text>
          </Box>
          {/* Authenticated channel name (Python cli.py:257). */}
          {channelTitle && (
            <Box marginTop={1}>
              <Text>
                Authenticated as: <Text bold>{channelTitle}</Text>
              </Text>
            </Box>
          )}
          {/* Gemini-key status (Python cli.py:262-267). */}
          <Box marginTop={1}>
            {geminiConfigured ? (
              <Text color="green">{symbols.check} Gemini API key configured</Text>
            ) : (
              <Text color="yellow">
                {symbols.warning} Gemini API key not set (LLM parsing disabled — set GEMINI_API_KEY
                in .env)
              </Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>You can now use all MeTube commands</Text>
          </Box>
        </Box>
        <StatusPanel />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" padding={1} flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="cyan">
            YouTube Authentication
          </Text>
        </Box>
        <Box>
          <Text>
            <Spinner type="dots" /> {message}
          </Text>
        </Box>
        {status === 'authenticating' && (
          <Box marginTop={1}>
            <Text dimColor>If browser doesn't open, check the console for URL</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { YouTubeAuth } from '../auth/YouTubeAuth.js';
import { DatabaseManager } from '../database/connection.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';
import { StatusPanel } from '../components/StatusPanel.js';

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

  useEffect(() => {
    async function init() {
      try {
        // Step 1: Check database
        setMessage('Checking database...');
        const db = new DatabaseManager('data/metube.db');
        db.getConnection();
        db.close();

        // Step 2: Authenticate
        setStatus('authenticating');
        setMessage('Authenticating with YouTube...');

        const auth = new YouTubeAuth({
          credentialsPath: 'client_secret.json',
          tokensPath: 'tokens.json',
        });

        if (!force && auth.hasValidTokens()) {
          setMessage('Already authenticated with valid tokens');
          setStatus('success');
          // In REPL mode, call onComplete; in direct mode, exit after 2 seconds
          if (onComplete) {
            onComplete();
          } else {
            setTimeout(() => exit(), 2000);
          }
          return;
        }

        const authenticated = await auth.authenticate(force);

        if (authenticated) {
          setStatus('success');
          setMessage('Authentication successful!');
          // In REPL mode, call onComplete; in direct mode, exit after 2 seconds
          if (onComplete) {
            onComplete();
          } else {
            setTimeout(() => exit(), 2000);
          }
        } else {
          setStatus('error');
          setError('Authentication failed');
          if (!onComplete) {
            setTimeout(() => exit(), 100);
          }
        }
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
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
        suggestions={[
          'Check that client_secret.json exists',
          'Verify your internet connection',
          'Run with --force to re-authenticate',
        ]}
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

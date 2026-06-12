import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { DatabaseManager } from '../../src-ts-v2/database/connection.js';
import { YouTubeAuth } from '../../src-ts-v2/auth/YouTubeAuth.js';
import { WhisperExtractor } from '../../src-ts-v2/extractors/WhisperExtractor.js';
import { symbols, inkColors, status } from '../utils/colors.js';
import { loadAppPaths } from '../utils/appConfig.js';

interface StatusPanelProps {
  showDetails?: boolean;
}

export function StatusPanel({ showDetails = true }: StatusPanelProps) {
  const [dbStatus, setDbStatus] = useState<'checking' | 'connected' | 'error'>('checking');
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<'checking' | 'valid' | 'invalid'>('checking');
  const [whisperStatus, setWhisperStatus] = useState<'checking' | 'available' | 'unavailable'>(
    'checking'
  );

  useEffect(() => {
    // Check database — v2 DatabaseManager opens + bootstraps the schema
    // in the constructor. Constructing without throwing means we have a
    // working connection. DB path from config (task 8); a broken config
    // throws ConfigError here, honestly reported as a DB error.
    try {
      const resolvedDbPath = loadAppPaths().dbPath;
      // Capture the real path so the panel shows the configured DB, not a
      // hardcoded "(metube.db)" literal that lies when config points elsewhere.
      setDbPath(resolvedDbPath);
      const db = new DatabaseManager(resolvedDbPath);
      setDbStatus('connected');
      db.close();
    } catch {
      setDbStatus('error');
    }

    // Check auth — v2 YouTubeAuth's hasValidTokens() requires a prior
    // authenticate() call to populate currentClient. For a disk-only
    // probe we attempt loadTokens() and treat any throw as "invalid".
    try {
      const auth = new YouTubeAuth();
      auth.loadTokens();
      setAuthStatus('valid');
    } catch {
      setAuthStatus('invalid');
    }

    // Check Whisper
    const whisper = new WhisperExtractor();
    setWhisperStatus(whisper.isAvailable() ? 'available' : 'unavailable');
  }, []);

  const getStatusIcon = (status: string) => {
    if (status === 'checking') return '...';
    if (status === 'connected' || status === 'valid' || status === 'available')
      return symbols.check;
    return symbols.cross;
  };

  const getStatusColor = (status: string) => {
    if (status === 'checking') return inkColors.orange;
    if (status === 'connected' || status === 'valid' || status === 'available') return 'green';
    return 'red';
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box
        borderStyle="round"
        borderColor={status.border.normal}
        padding={1}
        flexDirection="column"
      >
        <Box marginBottom={1}>
          <Text bold color={inkColors.orange}>
            System Status
          </Text>
        </Box>

        <Box>
          <Text color={getStatusColor(dbStatus)}>{getStatusIcon(dbStatus)} Database</Text>
          {showDetails && dbPath !== null && <Text dimColor> ({dbPath})</Text>}
        </Box>

        <Box>
          <Text color={getStatusColor(authStatus)}>{getStatusIcon(authStatus)} YouTube API</Text>
          {showDetails && authStatus === 'invalid' && <Text dimColor> (run: metube init)</Text>}
        </Box>

        <Box>
          <Text color={getStatusColor(whisperStatus)}>{getStatusIcon(whisperStatus)} Whisper</Text>
          {showDetails && whisperStatus === 'unavailable' && <Text dimColor> (Python venv)</Text>}
        </Box>
      </Box>
    </Box>
  );
}

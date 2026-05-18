import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { DatabaseManager } from '../database/connection.js';
import { YouTubeAuth } from '../auth/YouTubeAuth.js';
import { WhisperExtractor } from '../extractors/WhisperExtractor.js';
import { symbols, inkColors, status } from '../utils/colors.js';

interface StatusPanelProps {
  showDetails?: boolean;
}

export function StatusPanel({ showDetails = true }: StatusPanelProps) {
  const [dbStatus, setDbStatus] = useState<'checking' | 'connected' | 'error'>('checking');
  const [authStatus, setAuthStatus] = useState<'checking' | 'valid' | 'invalid'>('checking');
  const [whisperStatus, setWhisperStatus] = useState<'checking' | 'available' | 'unavailable'>('checking');

  useEffect(() => {
    // Check database
    try {
      const db = new DatabaseManager('data/metube.db');
      db.getConnection();
      setDbStatus('connected');
      db.close();
    } catch {
      setDbStatus('error');
    }

    // Check auth
    try {
      const auth = new YouTubeAuth();
      setAuthStatus(auth.hasValidTokens() ? 'valid' : 'invalid');
    } catch {
      setAuthStatus('invalid');
    }

    // Check Whisper
    const whisper = new WhisperExtractor();
    setWhisperStatus(whisper.isAvailable() ? 'available' : 'unavailable');
  }, []);

  const getStatusIcon = (status: string) => {
    if (status === 'checking') return '...';
    if (status === 'connected' || status === 'valid' || status === 'available') return symbols.check;
    return symbols.cross;
  };

  const getStatusColor = (status: string) => {
    if (status === 'checking') return inkColors.orange;
    if (status === 'connected' || status === 'valid' || status === 'available') return 'green';
    return 'red';
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor={status.border.normal} padding={1} flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color={inkColors.orange}>System Status</Text>
        </Box>

        <Box>
          <Text color={getStatusColor(dbStatus)}>
            {getStatusIcon(dbStatus)} Database
          </Text>
          {showDetails && <Text dimColor> (metube.db)</Text>}
        </Box>

        <Box>
          <Text color={getStatusColor(authStatus)}>
            {getStatusIcon(authStatus)} YouTube API
          </Text>
          {showDetails && authStatus === 'invalid' && (
            <Text dimColor> (run: metube init)</Text>
          )}
        </Box>

        <Box>
          <Text color={getStatusColor(whisperStatus)}>
            {getStatusIcon(whisperStatus)} Whisper
          </Text>
          {showDetails && whisperStatus === 'unavailable' && (
            <Text dimColor> (Python venv)</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

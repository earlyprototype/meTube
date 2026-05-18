import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { symbols, inkColors, status } from '../utils/colors.js';

interface ProgressDisplayProps {
  current: number;
  total: number;
  currentVideo?: string;
  status:
    | 'downloading'
    | 'transcribing'
    | 'parsing'
    | 'saving'
    | 'completed'
    | 'downloading_audio'
    | 'whisper_transcribing';
  successCount: number;
  failureCount: number;
  startTime: Date;
  whisperProgress?: {
    stage: 'downloading' | 'transcribing' | 'complete';
    percentage?: number;
    message?: string;
  };
}

// Better progress symbols - rotating circle
const DUDE_ANIMATION = ['◐', '◓', '◑', '◒'] as const;
const COMPLETED_DUDE = '◉';

export function ProgressDisplay({
  current,
  total,
  currentVideo,
  status,
  successCount,
  failureCount,
  startTime,
  whisperProgress,
}: ProgressDisplayProps) {
  const [dudeFrame, setDudeFrame] = useState(0);

  // Animate the little dude
  useEffect(() => {
    if (status === 'completed') return;

    const interval = setInterval(() => {
      setDudeFrame((prev) => (prev + 1) % DUDE_ANIMATION.length);
    }, 500);

    return () => clearInterval(interval);
  }, [status]);

  const elapsedSeconds = Math.floor((Date.now() - startTime.getTime()) / 1000);
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const remainingSeconds = elapsedSeconds % 60;

  const percentage = Math.floor((current / total) * 100);
  const progressBarLength = 20;
  const filledLength = Math.floor((progressBarLength * current) / total);
  const progressBar = '#'.repeat(filledLength) + '-'.repeat(progressBarLength - filledLength);

  const statusText = {
    downloading: 'Extracting video data',
    transcribing: 'Extracting transcript',
    parsing: 'Parsing entities',
    saving: 'Saving to database',
    completed: 'Complete',
    downloading_audio: 'Downloading audio for Whisper',
    whisper_transcribing: 'Transcribing with Whisper AI',
  }[status];

  const littleDude = status === 'completed' ? COMPLETED_DUDE : DUDE_ANIMATION[dudeFrame];

  // Create Whisper progress bar
  let whisperProgressBar = '';
  if (whisperProgress && whisperProgress.percentage !== undefined) {
    const whisperPercent = Math.floor(whisperProgress.percentage);
    const whisperBarLength = 20;
    const whisperFilled = Math.floor((whisperBarLength * whisperPercent) / 100);
    whisperProgressBar = '█'.repeat(whisperFilled) + '░'.repeat(whisperBarLength - whisperFilled);
  }

  return (
    <Box flexDirection="column">
      {/* Header - Blue */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Starting Extraction of Playlist
        </Text>
      </Box>

      {/* Main Progress - Black/Default */}
      <Box marginBottom={1}>
        <Text>
          Progress: [{progressBar}] {current} / {total} videos ({percentage}%)
        </Text>
      </Box>

      {/* Current Video - Black with Blue accent */}
      {currentVideo && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="cyan">{littleDude}</Text>
            <Text> Extracting: </Text>
            <Text bold>{currentVideo}</Text>
          </Box>
          <Box marginLeft={3}>
            <Text dimColor>{statusText}</Text>
          </Box>
        </Box>
      )}

      {/* Whisper Progress - Separate section with its own progress bar */}
      {whisperProgress && whisperProgress.stage !== 'complete' && (
        <Box
          flexDirection="column"
          marginBottom={1}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
        >
          <Box>
            <Text color="cyan" bold>
              Whisper AI Transcription
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              {whisperProgress.stage === 'downloading'
                ? 'Downloading audio...'
                : 'Transcribing audio...'}
            </Text>
          </Box>
          {whisperProgress.percentage !== undefined && (
            <Box marginTop={1}>
              <Text color="cyan">[{whisperProgressBar}]</Text>
              <Text> {Math.floor(whisperProgress.percentage)}%</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Stats - Grey with Blue/Red accents */}
      <Box marginTop={1}>
        <Text color="cyan">Success: {successCount}</Text>
        <Text dimColor> {symbols.bullet} </Text>
        <Text color="red">Failed: {failureCount}</Text>
        <Text dimColor> {symbols.bullet} </Text>
        <Text dimColor>
          Time: {elapsedMinutes}m {remainingSeconds}s
        </Text>
      </Box>
    </Box>
  );
}

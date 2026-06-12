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
  /**
   * Per-video step-result lines for the CURRENT video (metadata, transcript
   * source + char count, entity counts). Mirrors the granular `[OK] …` lines
   * Python printed per video (video_extractor.py:118-120,160-161,184,202-205).
   * Reset by the caller when a new video starts.
   */
  stepLines?: readonly string[];
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
  stepLines,
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

  // Guard the zero-total case: extraction start (or an all-skipped run) leaves
  // total === 0, and current / total is NaN — rendering "0 / 0 videos (NaN%)".
  const progressBarLength = 20;
  // Clamp before any .repeat(): a current > total (e.g. an off-by-one event
  // ordering) would otherwise push filledLength past progressBarLength, making
  // `progressBarLength - filledLength` negative — and String.repeat throws a
  // RangeError on a negative count. Clamp percentage to [0,100] and
  // filledLength to [0,progressBarLength] so the bar always renders.
  const rawPercentage = total > 0 ? Math.floor((current / total) * 100) : 0;
  const percentage = Math.max(0, Math.min(100, rawPercentage));
  const rawFilledLength = total > 0 ? Math.floor((progressBarLength * current) / total) : 0;
  const filledLength = Math.max(0, Math.min(progressBarLength, rawFilledLength));
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
          {/* Per-video step-result lines (metadata / transcript / entities) —
              the granular [OK] lines Python streamed per video. */}
          {stepLines && stepLines.length > 0 && (
            <Box flexDirection="column" marginLeft={3} marginTop={1}>
              {stepLines.map((line, i) => (
                <Box key={i}>
                  <Text color="green">{symbols.check} </Text>
                  <Text dimColor>{line}</Text>
                </Box>
              ))}
            </Box>
          )}
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

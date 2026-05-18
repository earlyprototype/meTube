/**
 * Video commands - Individual video operations
 * Handles single video extraction and management
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { YouTubeAuth } from '../auth/YouTubeAuth.js';
import { YouTubeClient } from '../api/YouTubeClient.js';
import { DatabaseManager } from '../database/connection.js';
import { VideoExtractor } from '../extractors/VideoExtractor.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';
import { ProgressDisplay } from '../components/ProgressDisplay.js';
import { ReportCommand } from './ReportCommand.js';
import { symbols, inkColors } from '../utils/colors.js';
import logger from '../utils/logger.js';

interface VideoCommandsProps {
  subcommand?: string;
  args: string[];
  flags: Record<string, any>;
  onComplete?: () => void;
}

export function VideoCommands({ subcommand, args, flags, onComplete }: VideoCommandsProps) {
  if (!subcommand) {
    return (
      <ErrorDisplay
        message="No video subcommand specified"
        suggestions={['add <url_or_id>']}
      />
    );
  }

  if (subcommand === 'add') {
    return <VideoAdd videoInput={args[0]} flags={flags} onComplete={onComplete} />;
  }

  return <ErrorDisplay message={`Unknown video subcommand: ${subcommand}`} />;
}

/**
 * Extract single video ID from URL or return as-is
 */
function extractVideoId(input: string): string {
  // Already a video ID (11 characters)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  // Try to extract from URL
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // Return as-is and let YouTube API validate
  return input;
}

/**
 * Video Add - Extract and optionally report on a single video
 */
function VideoAdd({ 
  videoInput, 
  flags, 
  onComplete 
}: { 
  videoInput?: string; 
  flags: Record<string, any>; 
  onComplete?: () => void;
}) {
  const [status, setStatus] = useState<'validating' | 'extracting' | 'generating_report' | 'done' | 'error'>('validating');
  const [error, setError] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string>('');
  const [videoTitle, setVideoTitle] = useState<string>('');
  const [progressStatus, setProgressStatus] = useState<'downloading' | 'transcribing' | 'parsing' | 'saving' | 'completed'>('downloading');
  const [reportGenerated, setReportGenerated] = useState(false);

  useEffect(() => {
    async function extractVideo() {
      try {
        // Validate input
        if (!videoInput) {
          setError('No video URL or ID provided');
          setStatus('error');
          return;
        }

        // Extract video ID
        const extractedId = extractVideoId(videoInput);
        setVideoId(extractedId);
        
        logger.info({ input: videoInput, extractedId }, 'Extracting video ID');

        // Initialize services
        const auth = new YouTubeAuth();
        await auth.authenticate();
        const client = new YouTubeClient(auth);
        const db = new DatabaseManager('data/metube.db');

        // Configure extractor
        const extractor = new VideoExtractor(client, db, {
          autoTranscript: !flags.noTranscript,
          autoLlmParse: !flags.noLlm,
          enableWhisper: !flags.noWhisper,
          onProgress: (prog) => {
            // Map progress status to ProgressDisplay compatible status
            const statusMap: Record<string, 'downloading' | 'transcribing' | 'parsing' | 'saving' | 'completed'> = {
              'processing': 'downloading',
              'complete': 'completed',
              'failed': 'saving',
              'skipped': 'saving',
            };
            setProgressStatus(statusMap[prog.status] || 'downloading');
            if (prog.videoTitle) {
              setVideoTitle(prog.videoTitle);
            }
          },
        });

        setStatus('extracting');

        // Extract video
        const result = await extractor.extractSingleVideo(extractedId);
        
        if (result && result.videoData) {
          setVideoTitle(result.videoData.title || extractedId);
        }

        db.close();
        
        // Generate report if requested
        if (flags.report) {
          setStatus('generating_report');
          setReportGenerated(true);
        } else {
          setStatus('done');
          if (onComplete) onComplete();
        }

      } catch (err) {
        logger.error({ error: err }, 'Video extraction failed');
        
        if (err instanceof Error) {
          if (err.message.includes('not found') || err.message.includes('Video unavailable')) {
            setError(`Video not found: ${videoInput}. Check the URL or ID is correct.`);
          } else if (err.message.includes('private') || err.message.includes('unavailable')) {
            setError(`Video is private or unavailable: ${videoInput}`);
          } else {
            setError(`Extraction failed: ${err.message}`);
          }
        } else {
          setError(`Extraction failed: ${String(err)}`);
        }
        setStatus('error');
      }
    }

    extractVideo();
  }, [videoInput, flags, onComplete]);

  // Error state
  if (status === 'error') {
    return <ErrorDisplay message={error || 'Video extraction failed'} />;
  }

  // Report generation state (delegate to ReportCommand)
  if (status === 'generating_report' && reportGenerated) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {symbols.check} Video Extracted
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            Video: <Text bold color={inkColors.orange}>{videoTitle || videoId}</Text>
          </Text>
        </Box>
        <Box marginBottom={2}>
          <Text dimColor>Generating report...</Text>
        </Box>
        <ReportCommand 
          type="video" 
          id={videoId} 
          flags={flags} 
          onComplete={onComplete} 
        />
      </Box>
    );
  }

  // Done state (without report)
  if (status === 'done') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {symbols.check} Video Extracted Successfully
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            Video ID: <Text bold color={inkColors.orange}>{videoId}</Text>
          </Text>
        </Box>
        <Box>
          <Text>
            Title: <Text>{videoTitle || 'Unknown'}</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  // Extracting state
  if (status === 'extracting') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Extracting Video</Text>
        </Box>
        {videoTitle && (
          <Box marginBottom={1}>
            <Text dimColor>{videoTitle}</Text>
          </Box>
        )}
        <ProgressDisplay
          current={1}
          total={1}
          currentVideo={videoTitle}
          status={progressStatus}
          successCount={0}
          failureCount={0}
          startTime={new Date()}
        />
      </Box>
    );
  }

  // Validating state
  return (
    <Box>
      <Text>
        <Spinner type="dots" /> Validating video...
      </Text>
    </Box>
  );
}

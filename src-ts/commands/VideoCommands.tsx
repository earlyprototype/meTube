/**
 * Video commands - Individual video operations
 * Handles single video extraction and management
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { YouTubeAuth } from '../../src-ts-v2/auth/YouTubeAuth.js';
import { YouTubeClient } from '../../src-ts-v2/api/YouTubeClient.js';
import { DatabaseManager } from '../../src-ts-v2/database/connection.js';
import { VideoRepository } from '../../src-ts-v2/database/VideoRepository.js';
import { StatisticsRepository } from '../../src-ts-v2/database/StatisticsRepository.js';
import { EntityRepository } from '../../src-ts-v2/database/EntityRepository.js';
import { TranscriptRepository } from '../../src-ts-v2/database/TranscriptRepository.js';
import { DescriptionParser } from '../../src-ts-v2/parsers/DescriptionParser.js';
import { TranscriptExtractor } from '../../src-ts-v2/extractors/TranscriptExtractor.js';
import { WhisperExtractor } from '../../src-ts-v2/extractors/WhisperExtractor.js';
import { asVideoId } from '../../src-ts-v2/types/branded.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';
import { ProgressDisplay } from '../components/ProgressDisplay.js';
import { ReportCommand } from './ReportCommand.js';
import { symbols, inkColors } from '../utils/colors.js';
import logger from '../../src-ts-v2/utils/logger.js';

interface VideoCommandsProps {
  subcommand?: string;
  args: string[];
  flags: Record<string, any>;
  onComplete?: () => void;
}

export function VideoCommands({ subcommand, args, flags, onComplete }: VideoCommandsProps) {
  if (!subcommand) {
    return (
      <ErrorDisplay message="No video subcommand specified" suggestions={['add <url_or_id>']} />
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
  onComplete,
}: {
  videoInput?: string;
  flags: Record<string, any>;
  onComplete?: () => void;
}) {
  const [status, setStatus] = useState<
    'validating' | 'extracting' | 'generating_report' | 'done' | 'error'
  >('validating');
  const [error, setError] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string>('');
  const [videoTitle, setVideoTitle] = useState<string>('');
  const [progressStatus, setProgressStatus] = useState<
    'downloading' | 'transcribing' | 'parsing' | 'saving' | 'completed'
  >('downloading');
  const [reportGenerated, setReportGenerated] = useState(false);

  useEffect(() => {
    async function extractVideo() {
      // Declared before the try so the finally can close it on EVERY path
      // (success, early return, or throw). The catch previously left the
      // handle open, leaking a SQLite connection on failure.
      let db: DatabaseManager | undefined;
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

        // Brand the ID at the boundary — v2 APIs require VideoId.
        const brandedId = asVideoId(extractedId);

        // Initialize services
        const auth = new YouTubeAuth();
        const oauthClient = await auth.authenticate();
        const client = new YouTubeClient(oauthClient);
        db = new DatabaseManager('data/metube.db');

        setStatus('extracting');
        setProgressStatus('downloading');

        // v2 VideoExtractor only exposes extractPlaylist; there is no
        // public single-video method. Drive the pipeline manually using
        // the same building blocks the playlist pipeline uses.
        const details = await client.getVideoById(brandedId);
        if (!details) {
          setError(`Video not found: ${videoInput}. Check the URL or ID is correct.`);
          setStatus('error');
          return;
        }
        setVideoTitle(details.title || extractedId);

        // Persist video + statistics. Repository methods own their own
        // transactions.
        const videoRepo = new VideoRepository(db);
        videoRepo.createOrUpdate({
          video_id: brandedId,
          title: details.title,
          description: details.description,
          channel_id: details.channelId,
          channel_title: details.channelTitle,
          published_at: details.publishedAt,
          duration: details.duration,
          duration_seconds: details.durationSeconds,
          is_short: details.isShort,
          category_id: details.categoryId ?? null,
          caption: details.caption ?? null,
          licensed_content: details.licensedContent ?? null,
        });

        const statsRepo = new StatisticsRepository(db);
        statsRepo.recordSnapshot(brandedId, {
          viewCount: details.viewCount ?? 0,
          likeCount: details.likeCount ?? 0,
          commentCount: details.commentCount ?? 0,
        });

        // Transcript stage — YouTube first, Whisper fallback if enabled.
        if (!flags.noTranscript) {
          setProgressStatus('transcribing');
          const whisper = !flags.noWhisper ? new WhisperExtractor() : undefined;
          const transcriptExtractor = new TranscriptExtractor({
            whisperExtractor: whisper,
          });
          const transcript = await transcriptExtractor.extract(brandedId);
          if (transcript) {
            const transcriptRepo = new TranscriptRepository(db);
            transcriptRepo.upsert(brandedId, {
              language: transcript.language,
              fullText: transcript.full_text,
              segments: transcript.segments,
              isAutoGenerated: transcript.is_auto_generated,
            });
          }
        }

        // Description-driven entities (LLM-free path; --no-llm is the
        // current flag's intent. Gemini wiring is out of this command's
        // single-video scope.)
        if (!flags.noLlm) {
          setProgressStatus('parsing');
          const parser = new DescriptionParser();
          const parsed = parser.parse(details.title, details.description);
          const entities = parser.extractEntitiesForDatabase(parsed);
          if (entities.length > 0) {
            const entityRepo = new EntityRepository(db);
            entityRepo.insertMany(
              brandedId,
              entities.map((e) => ({
                type: e.type,
                value: e.value,
                url: e.url,
                confidence: e.confidence,
              }))
            );
          }
        }

        setProgressStatus('completed');

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
      } finally {
        // Close exactly once on every path. Idempotent: undefined when
        // we bailed before opening the handle.
        db?.close();
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
            Video:{' '}
            <Text bold color={inkColors.orange}>
              {videoTitle || videoId}
            </Text>
          </Text>
        </Box>
        <Box marginBottom={2}>
          <Text dimColor>Generating report...</Text>
        </Box>
        <ReportCommand type="video" id={videoId} flags={flags} onComplete={onComplete} />
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
            Video ID:{' '}
            <Text bold color={inkColors.orange}>
              {videoId}
            </Text>
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

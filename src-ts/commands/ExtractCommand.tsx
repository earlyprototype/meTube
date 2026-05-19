import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { YouTubeAuth } from '../auth/YouTubeAuth.js';
import { YouTubeClient } from '../api/YouTubeClient.js';
import { VideoExtractor } from '../extractors/VideoExtractor.js';
import { DatabaseManager } from '../database/connection.js';
import { PlaylistRepository } from '../database/repositories.js';
import { ProgressDisplay } from '../components/ProgressDisplay.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';
import { PostExtractionMenu } from '../components/PostExtractionMenu.js';
import { resolvePlaylistIdentifier } from '../utils/playlistResolver.js';
import { safeTitle } from '../utils/terminal.js';

interface ExtractCommandProps {
  type: string;
  id?: string;
  flags: {
    reprocess?: boolean;
    maxVideos?: number;
    all?: boolean;
  };
  onComplete?: () => void;
}

export function ExtractCommand({ type, id, flags, onComplete }: ExtractCommandProps) {
  const [status, setStatus] = useState<'initializing' | 'extracting' | 'done' | 'menu' | 'error'>(
    'initializing'
  );
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    currentVideo: string;
    status:
      | 'downloading'
      | 'downloading_audio'
      | 'whisper_transcribing'
      | 'transcribing'
      | 'parsing'
      | 'saving'
      | 'completed';
    successCount: number;
    failureCount: number;
    skippedCount: number;
    whisperProgress?: {
      stage: 'downloading' | 'transcribing' | 'complete';
      percentage?: number;
      message?: string;
    };
  }>({
    current: 0,
    total: 0,
    currentVideo: '',
    status: 'downloading',
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
    whisperProgress: undefined,
  });
  const [startTime] = useState(new Date());
  const [error, setError] = useState<string | null>(null);
  const [playlistTitle, setPlaylistTitle] = useState<string>('');
  const [extractedPlaylistId, setExtractedPlaylistId] = useState<string>('');

  useEffect(() => {
    async function extract() {
      try {
        // Handle --all flag for batch extraction
        if (flags.all || type === 'all') {
          await extractAllPlaylists();
          return;
        }

        if (type !== 'playlist') {
          setError('Only playlist extraction supported currently');
          setStatus('error');
          return;
        }

        if (!id) {
          setError('No playlist ID provided');
          setStatus('error');
          return;
        }

        // Resolve playlist identifier (number, title, URL, or ID)
        const resolved = await resolvePlaylistIdentifier(id, true);
        if (!resolved) {
          setError(
            `Playlist not found: ${id}. Try 'metube playlist list' to see tracked playlists.`
          );
          setStatus('error');
          return;
        }

        const actualPlaylistId = resolved.id;

        // Initialize services
        const auth = new YouTubeAuth();
        await auth.authenticate();

        const client = new YouTubeClient(auth);
        const db = new DatabaseManager('data/metube.db');

        // Get playlist
        const repo = new PlaylistRepository(db);
        const playlist = repo.getById(actualPlaylistId);

        if (!playlist) {
          setError(`Playlist not found: ${resolved.title || actualPlaylistId}`);
          setStatus('error');
          return;
        }

        setPlaylistTitle(playlist.title);
        setExtractedPlaylistId(actualPlaylistId);
        setStatus('extracting');

        // Extract playlist using proper method (with deduplication and progress)
        const extractor = new VideoExtractor(client, db, {
          autoTranscript: true,
          autoLlmParse: false,
          enableWhisper: true,
          onProgress: (prog) => {
            setProgress((prev) => ({
              current: prog.current,
              total: prog.total,
              currentVideo: prog.videoTitle,
              status: 'downloading',
              successCount: prog.status === 'complete' ? prog.current : prev.successCount,
              failureCount: prog.status === 'failed' ? prev.failureCount + 1 : prev.failureCount,
              skippedCount: prev.skippedCount,
              whisperProgress: prev.whisperProgress,
            }));
          },
          onWhisperProgress: (whisperProg) => {
            setProgress((prev) => ({
              ...prev,
              status:
                whisperProg.stage === 'downloading'
                  ? ('downloading_audio' as const)
                  : ('whisper_transcribing' as const),
              whisperProgress: whisperProg,
            }));
          },
        });

        // Use extractPlaylist which handles deduplication
        const result = await extractor.extractPlaylist(
          actualPlaylistId,
          !flags.reprocess, // skipExisting = true (unless --reprocess flag)
          flags.maxVideos
        );

        setProgress({
          current: result.processed,
          total: result.total,
          currentVideo: 'Complete',
          status: 'completed',
          successCount: result.new,
          failureCount: result.failed,
          skippedCount: result.skipped,
          whisperProgress: undefined,
        });

        db.close();
        setStatus('menu');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    }

    async function extractAllPlaylists() {
      try {
        // Get all enabled playlists
        const db = new DatabaseManager('data/metube.db');
        const playlistRepo = new PlaylistRepository(db);
        const allPlaylists = playlistRepo.getAll();
        const enabledPlaylists = allPlaylists.filter((p) => p.enabled);

        if (enabledPlaylists.length === 0) {
          setError(
            'No enabled playlists found. Use "metube playlist list" to see tracked playlists.'
          );
          setStatus('error');
          db.close();
          return;
        }

        // Initialize extractor
        const auth = new YouTubeAuth();
        const client = new YouTubeClient(auth);
        const extractor = new VideoExtractor(client, db);

        let totalProcessed = 0;
        let totalNew = 0;
        let totalFailed = 0;
        let totalSkipped = 0;
        let playlistsFailed = 0;

        setStatus('extracting');

        // Process each playlist sequentially
        for (let i = 0; i < enabledPlaylists.length; i++) {
          const playlist = enabledPlaylists[i];

          setPlaylistTitle(`[${i + 1}/${enabledPlaylists.length}] ${playlist.title}`);
          setExtractedPlaylistId(playlist.playlist_id);

          try {
            const result = await extractor.extractPlaylist(
              playlist.playlist_id,
              !flags.reprocess,
              flags.maxVideos
            );

            totalProcessed += result.processed;
            totalNew += result.new;
            totalFailed += result.failed;
            totalSkipped += result.skipped;

            setProgress({
              current: i + 1,
              total: enabledPlaylists.length,
              currentVideo: `Completed: ${safeTitle(playlist.title)}`,
              status: 'completed',
              successCount: totalNew,
              failureCount: totalFailed,
              skippedCount: totalSkipped,
              whisperProgress: undefined,
            });
          } catch (err) {
            playlistsFailed++;
            totalFailed++;
          }
        }

        // Final summary
        setProgress({
          current: enabledPlaylists.length,
          total: enabledPlaylists.length,
          currentVideo: 'All playlists processed',
          status: 'completed',
          successCount: totalNew,
          failureCount: totalFailed,
          skippedCount: totalSkipped,
          whisperProgress: undefined,
        });

        db.close();
        setStatus('done');

        if (onComplete) {
          setTimeout(() => onComplete(), 3000);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    }

    extract();
  }, [type, id, flags, onComplete]);

  if (status === 'error') {
    return <ErrorDisplay message={error || 'Extraction failed'} />;
  }

  if (status === 'menu') {
    return (
      <PostExtractionMenu
        playlistId={extractedPlaylistId}
        playlistTitle={playlistTitle}
        successCount={progress.successCount}
        failureCount={progress.failureCount}
        skippedCount={progress.skippedCount}
        totalVideos={progress.total}
        onViewPlaylistInfo={() => {
          // TODO: Navigate to playlist videos command
          if (onComplete) onComplete();
        }}
        onExtractMore={() => {
          // TODO: Navigate back to extraction
          if (onComplete) onComplete();
        }}
        onMainMenu={() => {
          if (onComplete) onComplete();
        }}
      />
    );
  }

  return (
    <ProgressDisplay
      current={progress.current}
      total={progress.total}
      currentVideo={progress.currentVideo}
      status={progress.status}
      successCount={progress.successCount}
      failureCount={progress.failureCount}
      startTime={startTime}
      whisperProgress={progress.whisperProgress}
    />
  );
}

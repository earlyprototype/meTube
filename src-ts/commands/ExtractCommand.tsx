import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { YouTubeAuth } from '../../src-ts-v2/auth/YouTubeAuth.js';
import { YouTubeClient } from '../../src-ts-v2/api/YouTubeClient.js';
import {
  VideoExtractor,
  type ExtractProgressEvent,
  type YouTubeClientLike,
  type PlaylistInfo,
  type VideoDetails,
  type PlaylistVideoItem,
  type PlaylistVideoOptions,
} from '../../src-ts-v2/extractors/VideoExtractor.js';
import { DescriptionParser } from '../../src-ts-v2/parsers/DescriptionParser.js';
import { DatabaseManager } from '../../src-ts-v2/database/connection.js';
import { PlaylistRepository } from '../../src-ts-v2/database/PlaylistRepository.js';
import { ProgressDisplay } from '../components/ProgressDisplay.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';
import { PostExtractionMenu } from '../components/PostExtractionMenu.js';
import { resolvePlaylistIdentifier } from '../../src-ts-v2/utils/playlistResolver.js';
import { safeTitle } from '../utils/terminal.js';
import type { VideoId, PlaylistId } from '../../src-ts-v2/types/branded.js';

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
  // Stored as a string brand — the PostExtractionMenu accepts a raw
  // string. We brand at the boundary when calling v2 repository methods.
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

        // Initialize services up-front; v2 resolver needs a DB handle for
        // the database-fallback step.
        const db = new DatabaseManager('data/metube.db');

        // Resolve playlist identifier (number, title, URL, or ID) — v2
        // resolver returns branded PlaylistId.
        const resolved = await resolvePlaylistIdentifier(id, { db });
        if (!resolved) {
          db.close();
          setError(
            `Playlist not found: ${id}. Try 'metube playlist list' to see tracked playlists.`
          );
          setStatus('error');
          return;
        }

        const actualPlaylistId = resolved.id;

        // v2 YouTubeClient takes the OAuth2Client returned by authenticate.
        const auth = new YouTubeAuth();
        const oauthClient = await auth.authenticate();
        const youTubeClient = new YouTubeClient(oauthClient);

        // Get playlist — v2 findById, returns null on miss.
        const repo = new PlaylistRepository(db);
        const playlist = repo.findById(actualPlaylistId);

        if (!playlist) {
          db.close();
          setError(`Playlist not found: ${resolved.title || actualPlaylistId}`);
          setStatus('error');
          return;
        }

        setPlaylistTitle(playlist.title);
        setExtractedPlaylistId(actualPlaylistId);
        setStatus('extracting');

        // v2 VideoExtractor expects a YouTubeClientLike shape with methods
        // (getPlaylistInfo, getPlaylistVideos, getVideoDetails) that differ
        // from the actual YouTubeClient (getPlaylistById, getPlaylistItems,
        // getVideoById). Adapter bridges the names + result shapes.
        const ytAdapter: YouTubeClientLike = makeYouTubeClientAdapter(youTubeClient);

        const extractor = new VideoExtractor(
          db,
          ytAdapter,
          {
            autoTranscript: true,
            autoLlmParse: false,
            enableWhisper: true,
            skipExisting: !flags.reprocess,
            maxVideos: flags.maxVideos,
          },
          {
            descriptionParser: new DescriptionParser(),
          }
        );

        // v2 extractPlaylist signature: (playlistId, { onProgress }).
        // Progress events are a discriminated union — map onto the
        // existing ProgressDisplay state.
        const result = await extractor.extractPlaylist(actualPlaylistId, {
          onProgress: (event: ExtractProgressEvent) => {
            mapEventToProgress(event, setProgress);
          },
        });

        setProgress({
          current: result.processed,
          total: result.total,
          currentVideo: 'Complete',
          status: 'completed',
          successCount: result.processed,
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
        // Get all enabled playlists — v2 findAll default is enabledOnly:
        // true, which is what we want here.
        const db = new DatabaseManager('data/metube.db');
        const playlistRepo = new PlaylistRepository(db);
        const enabledPlaylists = playlistRepo.findAll({ enabledOnly: true });

        if (enabledPlaylists.length === 0) {
          setError(
            'No enabled playlists found. Use "metube playlist list" to see tracked playlists.'
          );
          setStatus('error');
          db.close();
          return;
        }

        // Initialize extractor — v2 YouTubeClient takes OAuth2Client; the
        // VideoExtractor takes (db, youtubeClient, config, deps) with the
        // adapter for the differing client surface and an injected
        // descriptionParser.
        const auth = new YouTubeAuth();
        const oauthClient = await auth.authenticate();
        const youTubeClient = new YouTubeClient(oauthClient);
        const ytAdapter: YouTubeClientLike = makeYouTubeClientAdapter(youTubeClient);
        const extractor = new VideoExtractor(
          db,
          ytAdapter,
          {
            skipExisting: !flags.reprocess,
            maxVideos: flags.maxVideos,
          },
          {
            descriptionParser: new DescriptionParser(),
          }
        );

        let totalProcessed = 0;
        let totalFailed = 0;
        let totalSkipped = 0;
        let playlistsFailed = 0;

        setStatus('extracting');

        // Process each playlist sequentially — v2 playlistId is branded.
        for (let i = 0; i < enabledPlaylists.length; i++) {
          const playlist = enabledPlaylists[i];

          setPlaylistTitle(`[${i + 1}/${enabledPlaylists.length}] ${playlist.title}`);
          setExtractedPlaylistId(playlist.playlistId);

          try {
            const result = await extractor.extractPlaylist(playlist.playlistId);

            totalProcessed += result.processed;
            totalFailed += result.failed;
            totalSkipped += result.skipped;

            setProgress({
              current: i + 1,
              total: enabledPlaylists.length,
              currentVideo: `Completed: ${safeTitle(playlist.title)}`,
              status: 'completed',
              successCount: totalProcessed,
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
          successCount: totalProcessed,
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

/**
 * Adapter: bridges v2 YouTubeClient (getPlaylistById / getPlaylistItems /
 * getVideoById) into the shape v2 VideoExtractor expects
 * (getPlaylistInfo / getPlaylistVideos / getVideoDetails). This is a
 * Wave 3 sibling-drift papered over at the Ink boundary; the proper fix
 * is to reconcile names inside src-ts-v2/ in a follow-up.
 */
function makeYouTubeClientAdapter(client: YouTubeClient): YouTubeClientLike {
  return {
    async getPlaylistInfo(playlistId: PlaylistId): Promise<PlaylistInfo | null> {
      const pl = await client.getPlaylistById(playlistId);
      if (pl === null) return null;
      return {
        playlistId: pl.playlistId,
        title: pl.title,
        description: pl.description,
        videoCount: pl.itemCount,
      };
    },
    async getPlaylistVideos(
      playlistId: PlaylistId,
      opts: PlaylistVideoOptions = {}
    ): Promise<readonly PlaylistVideoItem[]> {
      const items = await client.getPlaylistItems(playlistId);
      const capped =
        opts.maxResults !== undefined ? items.slice(0, opts.maxResults) : items;
      return capped.map((it) => ({
        videoId: it.videoId,
        title: it.title ?? '',
        channelId: it.channelId ?? '',
        channelTitle: it.channelTitle ?? '',
        addedAt: it.addedAt ?? '',
        position: it.position,
      }));
    },
    async getVideoDetails(videoId: VideoId): Promise<VideoDetails | null> {
      const v = await client.getVideoById(videoId);
      if (v === null) return null;
      return {
        videoId: v.videoId,
        title: v.title,
        description: v.description,
        channelId: v.channelId,
        channelTitle: v.channelTitle,
        publishedAt: v.publishedAt,
        duration: v.duration,
        durationSeconds: v.durationSeconds,
        isShort: v.isShort,
        viewCount: v.viewCount ?? 0,
        likeCount: v.likeCount ?? 0,
        commentCount: v.commentCount ?? 0,
        tags: v.tags ?? [],
        categoryId: v.categoryId,
        caption: v.caption,
        licensedContent: v.licensedContent,
      };
    },
  };
}

/**
 * Map v2's discriminated-union ExtractProgressEvent into the existing
 * ProgressDisplay state shape. The display does not care about per-stage
 * detail — it only renders counters + current video + a status enum.
 */
type ProgressState = {
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
};

function mapEventToProgress(
  event: ExtractProgressEvent,
  setProgress: React.Dispatch<React.SetStateAction<ProgressState>>
): void {
  switch (event.kind) {
    case 'job_started':
      setProgress((prev) => ({ ...prev, total: event.total, current: 0 }));
      return;
    case 'fetch_meta':
    case 'persist':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        status: 'downloading',
      }));
      return;
    case 'transcribe':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        status: 'transcribing',
      }));
      return;
    case 'whisper':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        status: 'whisper_transcribing',
      }));
      return;
    case 'gemini':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        status: 'parsing',
      }));
      return;
    case 'video_done':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        successCount: prev.successCount + 1,
      }));
      return;
    case 'video_skipped':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        skippedCount: prev.skippedCount + 1,
      }));
      return;
    case 'video_failed':
      setProgress((prev) => ({
        ...prev,
        current: event.index,
        total: event.total,
        failureCount: prev.failureCount + 1,
      }));
      return;
    case 'job_completed':
      setProgress((prev) => ({
        ...prev,
        status: 'completed',
        successCount: event.result.processed,
        failureCount: event.result.failed,
        skippedCount: event.result.skipped,
      }));
      return;
  }
}

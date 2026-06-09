import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { YouTubeAuth } from '../../src-ts-v2/auth/YouTubeAuth.js';
import { YouTubeClient } from '../../src-ts-v2/api/YouTubeClient.js';
import { DatabaseManager } from '../../src-ts-v2/database/connection.js';
import { PlaylistRepository } from '../../src-ts-v2/database/PlaylistRepository.js';
import { VideoRepository } from '../../src-ts-v2/database/VideoRepository.js';
import { PlaylistPicker } from '../components/PlaylistPicker.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';
import { ExtractCommand } from './ExtractCommand.js';
import { inkColors, symbols } from '../utils/colors.js';
import { safeTitle } from '../utils/terminal.js';
import {
  saveVideoCache,
  savePlaylistCache,
  type CachedVideo,
  type CachedPlaylist,
} from '../../src-ts-v2/utils/cache.js';
import type { Playlist } from '../../src-ts-v2/database/PlaylistRepository.js';
import type { YouTubePlaylist } from '../../src-ts-v2/api/types.js';
import { asPlaylistId } from '../../src-ts-v2/types/branded.js';
import { resolvePlaylistIdentifier } from '../../src-ts-v2/utils/playlistResolver.js';

interface PlaylistCommandsProps {
  subcommand?: string;
  args: string[];
  flags: Record<string, any>;
  onComplete?: () => void;
  onNavigate?: (next: React.ReactElement | null) => void;
}

export function PlaylistCommands({ subcommand, args, flags, onComplete, onNavigate }: PlaylistCommandsProps) {
  if (!subcommand) {
    return (
      <ErrorDisplay
        message="No playlist subcommand specified"
        suggestions={[
          'list',
          'discover',
          'add <id>',
          'add-mine',
          'sync',
          'remove <id>',
          'videos <id>',
        ]}
      />
    );
  }

  if (subcommand === 'list') {
    return <PlaylistList onComplete={onComplete} />;
  } else if (subcommand === 'discover') {
    return <PlaylistDiscover onComplete={onComplete} onNavigate={onNavigate} />;
  } else if (subcommand === 'add') {
    return <PlaylistAdd playlistId={args[0]} onComplete={onComplete} />;
  } else if (subcommand === 'add-mine') {
    return <PlaylistAddMine flags={flags} onComplete={onComplete} />;
  } else if (subcommand === 'sync') {
    return <PlaylistSync flags={flags} onComplete={onComplete} />;
  } else if (subcommand === 'remove') {
    return <PlaylistRemove playlistId={args[0]} onComplete={onComplete} />;
  } else if (subcommand === 'videos') {
    return <PlaylistVideos playlistId={args[0]} onComplete={onComplete} />;
  }

  return <ErrorDisplay message={`Unknown playlist subcommand: ${subcommand}`} />;
}

// Subcommand: List
function PlaylistList({ onComplete }: { onComplete?: () => void }) {
  const { exit } = useApp();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const db = new DatabaseManager('data/metube.db');
    const repo = new PlaylistRepository(db);
    // v2 findAll defaults to enabledOnly: true; the listing UI wants all
    // tracked playlists regardless of enabled status.
    const all = repo.findAll({ enabledOnly: false });
    setPlaylists(all);
    setLoading(false);
    db.close();

    // Save to cache for numbered access — v2 domain shape uses camelCase
    // (`playlistId`, `videoCount`); the cache schema kept snake_case so
    // we translate at the boundary.
    if (all.length > 0) {
      const cached: CachedPlaylist[] = all.map((p, i) => ({
        num: i + 1,
        id: p.playlistId,
        title: p.title,
        video_count: p.videoCount,
      }));
      savePlaylistCache(cached);
    }

    // In REPL mode, call onComplete; in direct mode, exit after 2 seconds
    if (onComplete) {
      onComplete();
    } else {
      setTimeout(() => exit(), 2000);
    }
  }, [exit, onComplete]);

  if (loading) {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Loading playlists...
        </Text>
      </Box>
    );
  }

  if (playlists.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">No playlists found in database</Text>
        <Text dimColor>Run: metube playlist discover</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
          Saved Playlists ({playlists.length})
        </Text>
      </Box>
      {playlists.map((p, i) => (
        <Box key={p.playlistId} marginY={0}>
          <Box width={4}>
            <Text>{i + 1}</Text>
          </Box>
          <Box width={50}>
            <Text>{safeTitle(p.title)}</Text>
          </Box>
          <Box width={10}>
            <Text dimColor>({p.videoCount || 0} videos)</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// Subcommand: Discover (interactive)
export function PlaylistDiscover({
  onComplete,
  onNavigate,
}: {
  onComplete?: () => void;
  onNavigate?: (next: React.ReactElement | null) => void;
}) {
  const [status, setStatus] = useState<
    'loading' | 'picking' | 'adding' | 'done' | 'prompt_extract' | 'error'
  >('loading');
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetch() {
      try {
        // v2 YouTubeClient takes an authenticated OAuth2Client, not the
        // YouTubeAuth wrapper. authenticate() returns the client directly.
        const auth = new YouTubeAuth();
        const oauthClient = await auth.authenticate();

        const client = new YouTubeClient(oauthClient);
        // v2 getMyPlaylists paginates internally; no need for the v1 loop.
        const ytPlaylists = await client.getMyPlaylists();

        setPlaylists(ytPlaylists);
        setStatus('picking');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    }
    fetch();
  }, []);

  const handleSelect = async (playlist: any) => {
    setSelected(playlist);
    setStatus('adding');

    try {
      const db = new DatabaseManager('data/metube.db');
      const repo = new PlaylistRepository(db);

      // v2 PlaylistRepository uses camelCase domain shape and branded
      // PlaylistId. YouTube API result `playlist.playlistId` is already
      // branded by YouTubeClient; the v1 cache fallback `playlist.id`
      // remains for backwards compatibility with discover-flow shape.
      const rawId = playlist.playlistId ?? playlist.id;
      repo.createOrUpdate({
        playlistId: asPlaylistId(rawId),
        title: playlist.title,
        description: playlist.description,
        videoCount: playlist.itemCount,
        enabled: true,
      });

      db.close();
      setStatus('prompt_extract');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  const handleCancel = () => {
    process.exit(0);
  };

  if (status === 'loading') {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Fetching your YouTube playlists...
        </Text>
      </Box>
    );
  }

  if (status === 'error') {
    return <ErrorDisplay message={error || 'Failed to fetch playlists'} />;
  }

  if (status === 'picking') {
    return <PlaylistPicker playlists={playlists} onSelect={handleSelect} onCancel={handleCancel} />;
  }

  if (status === 'adding') {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Adding playlist:{' '}
          {selected?.title != null ? safeTitle(selected.title) : ''}
        </Text>
      </Box>
    );
  }

  if (status === 'prompt_extract') {
    return (
      <ExtractPrompt
        playlistId={selected?.playlistId ?? selected?.id}
        playlistTitle={selected?.title}
        videoCount={selected?.itemCount || 0}
        onComplete={onComplete}
        onNavigate={onNavigate}
      />
    );
  }

  if (status === 'done') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
            OK Playlist Added
          </Text>
        </Box>
        <Box>
          <Text>
            {selected?.title != null ? safeTitle(selected.title) : ''} ({selected?.itemCount || 0}{' '}
            videos)
          </Text>
        </Box>
      </Box>
    );
  }

  return null;
}

// Extract prompt after adding playlist
interface ExtractPromptProps {
  playlistId: string;
  playlistTitle: string;
  videoCount: number;
  onComplete?: () => void;
  onNavigate?: (next: React.ReactElement | null) => void;
}

function ExtractPrompt({
  playlistId,
  playlistTitle,
  videoCount,
  onComplete,
  onNavigate,
}: ExtractPromptProps) {
  const { exit } = useApp();
  const [answer, setAnswer] = useState<'waiting' | 'yes' | 'no'>('waiting');

  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      setAnswer('yes');
    } else if (input === 'n' || input === 'N' || key.escape) {
      setAnswer('no');
      if (onComplete) onComplete();
    }
  });

  // If user chose yes, render the ExtractCommand directly
  if (answer === 'yes') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="green">Starting extraction of {safeTitle(playlistTitle)}...</Text>
        </Box>
        <ExtractCommand
          type="playlist"
          id={playlistId}
          flags={{}}
          onComplete={onComplete}
          onNavigate={onNavigate}
        />
      </Box>
    );
  }

  if (answer === 'no') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
            OK Playlist Added
          </Text>
        </Box>
        <Box>
          <Text>
            {safeTitle(playlistTitle)} ({videoCount} videos)
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>To extract later, type: extract playlist {playlistId}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
          OK Playlist Added
        </Text>
      </Box>
      <Box>
        <Text>
          {safeTitle(playlistTitle)} ({videoCount} videos)
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
          Extract videos now? (y/n)
        </Text>
      </Box>
      <Box>
        <Text dimColor>Press Y to start extraction, N to skip</Text>
      </Box>
    </Box>
  );
}

// Subcommand: Add by ID
function PlaylistAdd({ playlistId, onComplete }: { playlistId?: string; onComplete?: () => void }) {
  const { exit } = useApp();
  const [status, setStatus] = useState<'validating' | 'fetching' | 'saving' | 'done' | 'error'>(
    'validating'
  );
  const [error, setError] = useState<string | null>(null);
  const [playlistData, setPlaylistData] = useState<any>(null);

  useEffect(() => {
    async function addPlaylist() {
      try {
        if (!playlistId) {
          setError('No playlist ID provided');
          setStatus('error');
          return;
        }

        // Brand the raw CLI string at the boundary. asPlaylistId throws
        // ValidationError on malformed input; the try/catch below surfaces
        // it as a user-readable error.
        const brandedId = asPlaylistId(playlistId);

        // Initialize services
        const db = new DatabaseManager('data/metube.db');
        const repo = new PlaylistRepository(db);

        // Check if already exists — v2 uses findById, returns null on miss.
        const existing = repo.findById(brandedId);
        if (existing) {
          setError(`Playlist already tracked: "${existing.title}"`);
          setStatus('error');
          db.close();
          return;
        }

        setStatus('fetching');

        // Fetch from YouTube — v2 YouTubeClient takes an OAuth2Client.
        const auth = new YouTubeAuth();
        const oauthClient = await auth.authenticate();
        const client = new YouTubeClient(oauthClient);

        const playlist = await client.getPlaylistById(brandedId);
        if (!playlist) {
          setError(`Playlist not found on YouTube: ${playlistId}`);
          setStatus('error');
          db.close();
          return;
        }

        setStatus('saving');

        // Save to database — v2 createOrUpdate uses camelCase + branded ID.
        repo.createOrUpdate({
          playlistId: brandedId,
          title: playlist.title,
          description: playlist.description || '',
          videoCount: playlist.itemCount || 0,
          enabled: true,
        });

        setPlaylistData(playlist);
        setStatus('done');
        db.close();

        // In REPL mode, call onComplete; in direct mode, exit after 2 seconds
        if (onComplete) {
          onComplete();
        } else {
          setTimeout(() => exit(), 2000);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    }

    addPlaylist();
  }, [playlistId, exit, onComplete]);

  if (status === 'error') {
    return <ErrorDisplay message={error || 'Failed to add playlist'} />;
  }

  if (status === 'done' && playlistData) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
            {symbols.check} Playlist Added
          </Text>
        </Box>
        <Box>
          <Text>
            {safeTitle(playlistData.title)} ({playlistData.itemCount || 0} videos)
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>To extract: metube extract playlist {playlistId}</Text>
        </Box>
      </Box>
    );
  }

  // Loading states
  return (
    <Box padding={1}>
      <Text>
        <Spinner type="dots" /> {status === 'validating' && 'Validating...'}
        {status === 'fetching' && 'Fetching playlist from YouTube...'}
        {status === 'saving' && 'Saving to database...'}
      </Text>
    </Box>
  );
}

// Subcommand: Remove
function PlaylistRemove({
  playlistId,
  onComplete,
}: {
  playlistId?: string;
  onComplete?: () => void;
}) {
  const { exit } = useApp();
  const [status, setStatus] = useState<'loading' | 'confirming' | 'removing' | 'done' | 'error'>(
    'loading'
  );
  const [error, setError] = useState<string | null>(null);
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [videoCount, setVideoCount] = useState<number>(0);
  // Branded PlaylistId stored as a string brand; v2's playlistRepo.delete
  // requires the brand. We initialize with empty + brand-on-set.
  const [resolvedPlaylistId, setResolvedPlaylistId] = useState<string>('');

  useEffect(() => {
    async function loadPlaylist() {
      try {
        if (!playlistId) {
          setError('No playlist ID provided');
          setStatus('error');
          return;
        }

        // v2 resolver takes a context object; injecting db enables the
        // database-fallback step. Note: each command owns its DB handle.
        const dbForResolve = new DatabaseManager('data/metube.db');
        const resolved = await resolvePlaylistIdentifier(playlistId, {
          db: dbForResolve,
        });
        if (!resolved) {
          dbForResolve.close();
          setError(
            `Playlist not found: ${playlistId}. Try 'metube playlist list' to see tracked playlists.`
          );
          setStatus('error');
          return;
        }

        // v2 resolver returns branded PlaylistId already.
        const actualPlaylistId = resolved.id;
        setResolvedPlaylistId(actualPlaylistId);

        const playlistRepo = new PlaylistRepository(dbForResolve);
        const videoRepo = new VideoRepository(dbForResolve);

        const pl = playlistRepo.findById(actualPlaylistId);
        if (!pl) {
          setError(
            `Playlist not found: ${resolved.title || actualPlaylistId}. Use 'metube playlist list' to see tracked playlists.`
          );
          setStatus('error');
          dbForResolve.close();
          return;
        }

        // Count associated videos — v2 method is findByPlaylist.
        const videos = videoRepo.findByPlaylist(actualPlaylistId);
        setVideoCount(videos.length);

        setPlaylist(pl);
        setStatus('confirming');
        dbForResolve.close();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    }

    loadPlaylist();
  }, [playlistId]);

  useInput((input) => {
    if (status === 'confirming') {
      if (input === 'y' || input === 'Y') {
        setStatus('removing');
        performRemoval();
      } else if (input === 'n' || input === 'N') {
        setStatus('done');
        if (onComplete) {
          onComplete();
        } else {
          setTimeout(() => exit(), 500);
        }
      }
    }
  });

  async function performRemoval() {
    try {
      const db = new DatabaseManager('data/metube.db');
      const playlistRepo = new PlaylistRepository(db);

      // Delete playlist (videos remain - user can manually delete if
      // needed). v2 delete requires branded PlaylistId — re-brand here.
      playlistRepo.delete(asPlaylistId(resolvedPlaylistId));

      setStatus('done');
      db.close();

      if (onComplete) {
        onComplete();
      } else {
        setTimeout(() => exit(), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  if (status === 'error') {
    return <ErrorDisplay message={error || 'Failed to remove playlist'} />;
  }

  if (status === 'loading') {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Loading playlist...
        </Text>
      </Box>
    );
  }

  if (status === 'confirming' && playlist) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="yellow" backgroundColor={inkColors.greyDark}>
            {symbols.warning} Confirm Removal
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            Playlist: <Text bold>{safeTitle(playlist.title)}</Text>
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Associated videos in database: {videoCount} (will be kept)</Text>
        </Box>
        <Box marginBottom={1}>
          <Text bold color="yellow">
            Remove this playlist from tracking? (y/n)
          </Text>
        </Box>
        <Box>
          <Text dimColor>Press Y to confirm, N to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (status === 'removing') {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Removing playlist...
        </Text>
      </Box>
    );
  }

  if (status === 'done') {
    if (playlist) {
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
              {symbols.check} Playlist Removed
            </Text>
          </Box>
          <Box>
            <Text>{safeTitle(playlist.title)} is no longer being tracked</Text>
          </Box>
          {videoCount > 0 && (
            <Box marginTop={1}>
              <Text dimColor>{videoCount} associated videos remain in database</Text>
            </Box>
          )}
        </Box>
      );
    } else {
      return (
        <Box padding={1}>
          <Text dimColor>Operation cancelled</Text>
        </Box>
      );
    }
  }

  return null;
}

// Subcommand: Add-Mine (bulk add all user playlists)
function PlaylistAddMine({
  flags,
  onComplete,
}: {
  flags: Record<string, any>;
  onComplete?: () => void;
}) {
  const { exit } = useApp();
  const [status, setStatus] = useState<'loading' | 'selecting' | 'adding' | 'done' | 'error'>(
    'loading'
  );
  const [error, setError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<YouTubePlaylist[]>([]);
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [addedCount, setAddedCount] = useState<number>(0);
  const [skippedCount, setSkippedCount] = useState<number>(0);

  useEffect(() => {
    async function fetchPlaylists() {
      try {
        // Initialize services — v2 YouTubeClient takes the live
        // OAuth2Client returned by authenticate().
        const auth = new YouTubeAuth();
        const oauthClient = await auth.authenticate();
        const client = new YouTubeClient(oauthClient);
        const db = new DatabaseManager('data/metube.db');
        const repo = new PlaylistRepository(db);

        // Get existing playlists — v2 findAll + camelCase playlistId.
        const existing = repo.findAll({ enabledOnly: false });
        const existingSet = new Set(existing.map((p) => p.playlistId as string));
        setExistingIds(existingSet);

        // v2 getMyPlaylists handles pagination internally and returns
        // every playlist in one call. No more do/while.
        const allPlaylists = await client.getMyPlaylists();

        // Filter by privacy if specified
        const privacyFilter = flags.privacy?.toLowerCase();
        let filtered = allPlaylists;

        if (privacyFilter && privacyFilter !== 'all') {
          filtered = allPlaylists.filter((p) => p.privacyStatus?.toLowerCase() === privacyFilter);
        }

        // Filter out existing if --skip-existing
        if (flags.skipExisting) {
          filtered = filtered.filter((p) => !existingSet.has(p.playlistId as string));
        }

        if (filtered.length === 0) {
          setError('No playlists found matching criteria');
          setStatus('error');
          db.close();
          return;
        }

        setPlaylists(filtered);

        // Auto-select all non-existing playlists
        const autoSelected = new Set<number>();
        filtered.forEach((p, i) => {
          if (!existingSet.has(p.playlistId as string)) {
            autoSelected.add(i);
          }
        });
        setSelectedIndices(autoSelected);

        setStatus('selecting');
        db.close();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    }

    fetchPlaylists();
  }, [flags]);

  useInput((input, key) => {
    if (status === 'selecting') {
      if (key.return) {
        // Confirm selection and start adding
        if (selectedIndices.size === 0) {
          setError('No playlists selected');
          setStatus('error');
        } else {
          setStatus('adding');
          performBulkAdd();
        }
      } else if (input === 'a' || input === 'A') {
        // Select all
        setSelectedIndices(new Set(playlists.map((_, i) => i)));
      } else if (input === 'n' || input === 'N') {
        // Select none
        setSelectedIndices(new Set());
      } else if (key.escape) {
        // Cancel
        setStatus('done');
        if (onComplete) {
          onComplete();
        } else {
          setTimeout(() => exit(), 500);
        }
      }
    }
  });

  async function performBulkAdd() {
    try {
      const db = new DatabaseManager('data/metube.db');
      const repo = new PlaylistRepository(db);

      let added = 0;
      let skipped = 0;

      for (const index of selectedIndices) {
        const playlist = playlists[index];

        // Skip if already exists — playlistId is branded by YouTubeClient.
        if (existingIds.has(playlist.playlistId as string)) {
          skipped++;
          continue;
        }

        // Add to database — v2 createOrUpdate uses camelCase shape; the
        // playlistId from YouTubeClient is already branded.
        repo.createOrUpdate({
          playlistId: playlist.playlistId,
          title: playlist.title,
          description: playlist.description || '',
          videoCount: playlist.itemCount || 0,
          enabled: true,
        });

        added++;
      }

      setAddedCount(added);
      setSkippedCount(skipped);
      setStatus('done');
      db.close();

      if (onComplete) {
        onComplete();
      } else {
        setTimeout(() => exit(), 3000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  if (status === 'error') {
    return <ErrorDisplay message={error || 'Failed to add playlists'} />;
  }

  if (status === 'loading') {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Fetching your playlists from YouTube...
        </Text>
      </Box>
    );
  }

  if (status === 'selecting') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
            Select Playlists to Track ({playlists.length} available)
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>
            {selectedIndices.size} selected | A = select all | N = none | Enter = confirm | Esc =
            cancel
          </Text>
        </Box>
        {playlists.slice(0, 20).map((p, i) => {
          const isSelected = selectedIndices.has(i);
          const isExisting = existingIds.has(p.playlistId as string);
          return (
            <Box key={p.playlistId} marginY={0}>
              <Text color={isSelected ? 'cyan' : 'white'}>
                {isSelected ? symbols.check : ' '} {safeTitle(p.title)}
                {isExisting && <Text dimColor> (already tracked)</Text>}
              </Text>
            </Box>
          );
        })}
        {playlists.length > 20 && (
          <Box marginTop={1}>
            <Text dimColor>... and {playlists.length - 20} more</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (status === 'adding') {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Adding {selectedIndices.size} playlists to database...
        </Text>
      </Box>
    );
  }

  if (status === 'done') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
            {symbols.check} Bulk Add Complete
          </Text>
        </Box>
        <Box>
          <Text>
            Added:{' '}
            <Text bold color="cyan">
              {addedCount}
            </Text>{' '}
            playlists
          </Text>
        </Box>
        {skippedCount > 0 && (
          <Box>
            <Text>
              Skipped: <Text dimColor>{skippedCount}</Text> (already tracked)
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Use 'metube playlist list' to see all tracked playlists</Text>
        </Box>
      </Box>
    );
  }

  return null;
}

// Subcommand: Sync (detect changes with YouTube)
function PlaylistSync({
  flags,
  onComplete,
}: {
  flags: Record<string, any>;
  onComplete?: () => void;
}) {
  const { exit } = useApp();
  const [status, setStatus] = useState<'loading' | 'reviewing' | 'syncing' | 'done' | 'error'>(
    'loading'
  );
  const [error, setError] = useState<string | null>(null);
  const [newPlaylists, setNewPlaylists] = useState<YouTubePlaylist[]>([]);
  const [deletedPlaylists, setDeletedPlaylists] = useState<Playlist[]>([]);
  const [unchangedCount, setUnchangedCount] = useState<number>(0);
  const [addCount, setAddCount] = useState<number>(0);
  const [removeCount, setRemoveCount] = useState<number>(0);

  useEffect(() => {
    async function detectChanges() {
      try {
        // Initialize services — v2 YouTubeClient takes OAuth2Client.
        const auth = new YouTubeAuth();
        const oauthClient = await auth.authenticate();
        const client = new YouTubeClient(oauthClient);
        const db = new DatabaseManager('data/metube.db');
        const repo = new PlaylistRepository(db);

        // Get tracked playlists — v2 findAll + camelCase playlistId.
        const tracked = repo.findAll({ enabledOnly: false });
        const trackedIds = new Set(tracked.map((p) => p.playlistId as string));

        // v2 getMyPlaylists handles pagination internally.
        const youtubePlaylists = await client.getMyPlaylists();

        const youtubeIds = new Set(youtubePlaylists.map((p) => p.playlistId as string));

        // Find new playlists (on YouTube but not tracked)
        const newOnes = youtubePlaylists.filter((p) => !trackedIds.has(p.playlistId as string));
        setNewPlaylists(newOnes);

        // Find deleted playlists (tracked but not on YouTube)
        const deletedOnes = tracked.filter((p) => !youtubeIds.has(p.playlistId as string));
        setDeletedPlaylists(deletedOnes);

        // Count unchanged
        const unchanged = tracked.filter((p) => youtubeIds.has(p.playlistId as string)).length;
        setUnchangedCount(unchanged);

        setStatus('reviewing');
        db.close();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    }

    detectChanges();
  }, [flags]);

  useInput((input) => {
    if (status === 'reviewing') {
      if (input === 'y' || input === 'Y') {
        setStatus('syncing');
        performSync();
      } else if (input === 'n' || input === 'N') {
        setStatus('done');
        if (onComplete) {
          onComplete();
        } else {
          setTimeout(() => exit(), 500);
        }
      }
    }
  });

  async function performSync() {
    try {
      const db = new DatabaseManager('data/metube.db');
      const repo = new PlaylistRepository(db);

      let added = 0;
      let removed = 0;

      // Add new playlists — v2 createOrUpdate uses camelCase + branded ID.
      for (const playlist of newPlaylists) {
        repo.createOrUpdate({
          playlistId: playlist.playlistId,
          title: playlist.title,
          description: playlist.description || '',
          videoCount: playlist.itemCount || 0,
          enabled: true,
        });
        added++;
      }

      // Remove deleted playlists if flag set — v2 delete takes branded ID.
      if (flags.removeDeleted) {
        for (const playlist of deletedPlaylists) {
          repo.delete(playlist.playlistId);
          removed++;
        }
      }

      setAddCount(added);
      setRemoveCount(removed);
      setStatus('done');
      db.close();

      if (onComplete) {
        onComplete();
      } else {
        setTimeout(() => exit(), 3000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  if (status === 'error') {
    return <ErrorDisplay message={error || 'Sync failed'} />;
  }

  if (status === 'loading') {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Comparing with YouTube...
        </Text>
      </Box>
    );
  }

  if (status === 'reviewing') {
    const hasChanges = newPlaylists.length > 0 || deletedPlaylists.length > 0;

    if (!hasChanges) {
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
              {symbols.check} No Changes Detected
            </Text>
          </Box>
          <Box>
            <Text>All {unchangedCount} tracked playlists are in sync with YouTube</Text>
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
            Sync Summary
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Unchanged: {unchangedCount} playlists</Text>
        </Box>

        {newPlaylists.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="green">
              New ({newPlaylists.length}):
            </Text>
            {newPlaylists.slice(0, 5).map((p) => (
              <Text key={p.playlistId} dimColor>
                + {safeTitle(p.title)}
              </Text>
            ))}
            {newPlaylists.length > 5 && (
              <Text dimColor> ... and {newPlaylists.length - 5} more</Text>
            )}
          </Box>
        )}

        {deletedPlaylists.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="red">
              Deleted ({deletedPlaylists.length}):
            </Text>
            {deletedPlaylists.slice(0, 5).map((p) => (
              <Text key={p.playlistId} dimColor>
                - {safeTitle(p.title)}
              </Text>
            ))}
            {deletedPlaylists.length > 5 && (
              <Text dimColor> ... and {deletedPlaylists.length - 5} more</Text>
            )}
          </Box>
        )}

        <Box marginTop={1}>
          <Text bold color="yellow">
            Apply changes? (y/n)
          </Text>
        </Box>
        <Box>
          <Text dimColor>
            Will add {newPlaylists.length} new playlists
            {flags.removeDeleted && ` and remove ${deletedPlaylists.length} deleted playlists`}
          </Text>
        </Box>
      </Box>
    );
  }

  if (status === 'syncing') {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Syncing playlists...
        </Text>
      </Box>
    );
  }

  if (status === 'done') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
            {symbols.check} Sync Complete
          </Text>
        </Box>
        {addCount > 0 && (
          <Box>
            <Text>
              Added:{' '}
              <Text bold color="cyan">
                {addCount}
              </Text>{' '}
              new playlists
            </Text>
          </Box>
        )}
        {removeCount > 0 && (
          <Box>
            <Text>
              Removed:{' '}
              <Text bold color="red">
                {removeCount}
              </Text>{' '}
              deleted playlists
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Use 'metube playlist list' to see all tracked playlists</Text>
        </Box>
      </Box>
    );
  }

  return null;
}

// Subcommand: Videos (show numbered list of videos in a playlist)
export function PlaylistVideos({
  playlistId,
  onComplete,
}: {
  playlistId?: string;
  onComplete?: () => void;
}) {
  const { exit } = useApp();
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [videos, setVideos] = useState<CachedVideo[]>([]);

  useEffect(() => {
    async function fetchVideos() {
      try {
        if (!playlistId) {
          setError('No playlist ID provided');
          setStatus('error');
          return;
        }

        // Initialize services
        const db = new DatabaseManager('data/metube.db');
        const playlistRepo = new PlaylistRepository(db);
        const videoRepo = new VideoRepository(db);

        // v2 resolver takes a context object; inject the DB handle for
        // database-fallback lookups.
        const resolved = await resolvePlaylistIdentifier(playlistId, { db });
        if (!resolved) {
          db.close();
          setError(
            `Playlist not found: ${playlistId}. Try 'metube playlist list' to see tracked playlists.`
          );
          setStatus('error');
          return;
        }

        // Branded PlaylistId — flows through v2 repos directly.
        const actualPlaylistId = resolved.id;

        // Get playlist info — v2 findById, returns null on miss.
        const pl = playlistRepo.findById(actualPlaylistId);
        if (!pl) {
          setError(
            `Playlist not found: ${resolved.title || actualPlaylistId}. Run 'metube playlist add ${actualPlaylistId}' first.`
          );
          setStatus('error');
          db.close();
          return;
        }

        setPlaylist(pl);

        // Get videos for this playlist — each row tagged with whether a
        // transcript exists (resolved in-query via EXISTS, no N+1). Backs
        // the A9 transcript-visibility column below.
        const playlistVideos = videoRepo.findByPlaylistWithTranscriptFlag(actualPlaylistId);

        if (playlistVideos.length === 0) {
          setError(
            `No videos found in playlist. Extract the playlist first using: metube extract playlist ${actualPlaylistId}`
          );
          setStatus('error');
          db.close();
          return;
        }

        // Format as cached videos with numbers — v2 VideoRecord keeps
        // snake_case column names; duration_seconds is the numeric column.
        // The v1 code passed `video.duration` (a string like "PT10M3S") to
        // formatDuration which expects seconds, which would have been a
        // type bug in v1 too. Use duration_seconds for v2.
        const cachedVideos: CachedVideo[] = playlistVideos.map((video, index) => ({
          num: index + 1,
          video_id: video.video_id,
          title: video.title,
          duration: video.duration_seconds ? formatDuration(video.duration_seconds) : undefined,
          has_transcript: video.has_transcript,
        }));

        // Save to cache for future reference
        saveVideoCache(actualPlaylistId, cachedVideos);

        setVideos(cachedVideos);
        setStatus('loaded');
        db.close();

        // In REPL mode, call onComplete; in direct mode, exit after 2 seconds
        if (onComplete) {
          onComplete();
        } else {
          setTimeout(() => exit(), 2000);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    }

    fetchVideos();
  }, [playlistId, exit, onComplete]);

  if (status === 'error') {
    return <ErrorDisplay message={error || 'Failed to load videos'} />;
  }

  if (status === 'loading') {
    return (
      <Box padding={1}>
        <Text>
          <Spinner type="dots" /> Loading videos...
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
          {symbols.bullet} Videos in "{playlist?.title != null ? safeTitle(playlist.title) : ''}" (
          {videos.length} videos)
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Box width={6}>
          <Text bold dimColor>
            #
          </Text>
        </Box>
        <Box width={50}>
          <Text bold dimColor>
            Title
          </Text>
        </Box>
        <Box width={12}>
          <Text bold dimColor>
            Duration
          </Text>
        </Box>
        <Box width={15}>
          <Text bold dimColor>
            Video ID
          </Text>
        </Box>
        <Box width={12}>
          <Text bold dimColor>
            Transcript
          </Text>
        </Box>
      </Box>

      {videos.map((video) => (
        <Box key={video.video_id} marginY={0}>
          <Box width={6}>
            <Text color={inkColors.orange}>{video.num}</Text>
          </Box>
          <Box width={50}>
            <Text>{truncate(safeTitle(video.title), 48)}</Text>
          </Box>
          <Box width={12}>
            <Text dimColor>{video.duration || 'N/A'}</Text>
          </Box>
          <Box width={15}>
            <Text dimColor>{video.video_id}</Text>
          </Box>
          <Box width={12}>
            <Text color={video.has_transcript ? 'cyan' : 'yellow'}>
              {video.has_transcript ? 'Yes' : 'No'}
            </Text>
          </Box>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text dimColor>Videos cached for easy reference. Use video numbers in other commands.</Text>
      </Box>
    </Box>
  );
}

/**
 * Format duration in seconds to HH:MM:SS or MM:SS
 */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Truncate text to max length with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}

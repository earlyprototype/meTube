import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Playlist } from '../../src-ts-v2/database/PlaylistRepository.js';
import { symbols, inkColors, status } from '../utils/colors.js';
import { safeTitle } from '../utils/terminal.js';

interface PlaylistPickerProps {
  playlists: any[]; // Accept both DB playlists and YouTube API playlists
  onSelect: (playlist: any) => void;
  onCancel: () => void;
}

export function PlaylistPicker({ playlists, onSelect, onCancel }: PlaylistPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemsPerPage = 10;
  const [scrollOffset, setScrollOffset] = useState(0);

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      const newIndex = Math.max(0, selectedIndex - 1);
      setSelectedIndex(newIndex);
      // Auto-scroll up if needed
      if (newIndex < scrollOffset) {
        setScrollOffset(newIndex);
      }
    } else if (key.downArrow || input === 'j') {
      const newIndex = Math.min(playlists.length - 1, selectedIndex + 1);
      setSelectedIndex(newIndex);
      // Auto-scroll down if needed
      if (newIndex >= scrollOffset + itemsPerPage) {
        setScrollOffset(newIndex - itemsPerPage + 1);
      }
    } else if (key.return) {
      onSelect(playlists[selectedIndex]);
    } else if (key.escape || input === 'q') {
      onCancel();
    }
  });

  // Get visible playlists (pagination)
  const visiblePlaylists = playlists.slice(scrollOffset, scrollOffset + itemsPerPage);
  const hasMore = scrollOffset + itemsPerPage < playlists.length;
  const hasPrevious = scrollOffset > 0;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan" backgroundColor={inkColors.greyDark}>
          Select a Playlist ({selectedIndex + 1}/{playlists.length})
        </Text>
      </Box>

      {visiblePlaylists.map((playlist, visibleIndex) => {
        const index = scrollOffset + visibleIndex;
        // Handle both DB playlists (video_count) and YouTube API playlists (itemCount)
        const videoCount = playlist.video_count ?? playlist.itemCount ?? 0;

        return (
          <Box key={playlist.id || playlist.playlist_id} flexDirection="column" marginY={0}>
            <Box>
              <Text
                color={index === selectedIndex ? 'cyan' : undefined}
                bold={index === selectedIndex}
              >
                {index === selectedIndex ? `${symbols.selected} ` : '  '}[{index + 1}]{' '}
                {safeTitle(playlist.title)} <Text dimColor>({videoCount} videos)</Text>
              </Text>
            </Box>
            {index === selectedIndex && playlist.description && (
              <Box marginLeft={5}>
                <Text dimColor>
                  {playlist.description.substring(0, 60)}
                  {playlist.description.length > 60 ? '...' : ''}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}

      <Box marginTop={1} flexDirection="column">
        {(hasPrevious || hasMore) && (
          <Box marginBottom={1}>
            <Text dimColor>
              {hasPrevious && '↑ More above'} {hasPrevious && hasMore && ' • '}{' '}
              {hasMore && '↓ More below'}
            </Text>
          </Box>
        )}
        <Text dimColor>
          ↑↓ Navigate {symbols.bullet} j/k Vim keys {symbols.bullet} Enter Select {symbols.bullet} q
          Quit
        </Text>
      </Box>
    </Box>
  );
}

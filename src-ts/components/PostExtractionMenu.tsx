/**
 * Post-extraction menu shown after extraction completes
 * Allows user to navigate to playlist info, extract more, or return to main menu
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { symbols, inkColors } from '../utils/colors.js';
import { safeTitle } from '../utils/terminal.js';

interface PostExtractionMenuProps {
  playlistId: string;
  playlistTitle?: string;
  successCount: number;
  failureCount: number;
  totalVideos: number;
  onViewPlaylistInfo?: () => void;
  onExtractMore?: () => void;
  onMainMenu?: () => void;
}

export function PostExtractionMenu({
  playlistId,
  playlistTitle,
  successCount,
  failureCount,
  totalVideos,
  onViewPlaylistInfo,
  onExtractMore,
  onMainMenu,
}: PostExtractionMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const menuItems = [
    { label: 'View Playlist Video Information', action: onViewPlaylistInfo },
    { label: 'Extract Another Playlist', action: onExtractMore },
    { label: 'Return to Main Menu', action: onMainMenu },
  ];

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => (prev === 0 ? menuItems.length - 1 : prev - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) => (prev === menuItems.length - 1 ? 0 : prev + 1));
    } else if (key.return) {
      const selectedItem = menuItems[selectedIndex];
      if (selectedItem.action) {
        selectedItem.action();
      }
    }
  });

  return (
    <Box flexDirection="column">
      {/* Completion Summary */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {symbols.check} Extraction Complete
        </Text>
      </Box>

      {playlistTitle && (
        <Box marginBottom={1}>
          <Text dimColor>Playlist: </Text>
          <Text>{safeTitle(playlistTitle)}</Text>
        </Box>
      )}

      <Box flexDirection="column" marginBottom={2}>
        <Box>
          <Text>Processed: </Text>
          <Text bold>{totalVideos}</Text>
          <Text> videos</Text>
        </Box>
        <Box>
          <Text color="cyan">Success: {successCount}</Text>
          <Text dimColor> {symbols.bullet} </Text>
          <Text color="red">Failed: {failureCount}</Text>
        </Box>
      </Box>

      {/* Menu */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          What would you like to do next?
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {menuItems.map((item, index) => (
          <Box key={index} marginY={0}>
            <Text color={index === selectedIndex ? 'cyan' : 'white'}>
              {index === selectedIndex ? symbols.selected : ' '} {item.label}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Instructions */}
      <Box marginTop={1}>
        <Text dimColor>Use ↑↓ (or j/k) to navigate, Enter to select</Text>
      </Box>
    </Box>
  );
}

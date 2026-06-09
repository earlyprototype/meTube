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
  /** Videos that ran through the extraction loop and produced a new video row. */
  successCount: number;
  /** Videos where the extraction loop threw. */
  failureCount: number;
  /** Total videos in the playlist as returned by YouTube. */
  totalVideos: number;
  /**
   * Videos filtered out before the loop because they already have video + transcript
   * rows. Was previously hidden from the UI, leading to misleading "Processed: N /
   * Success: 0 / Failed: 0" output that read as "did nothing."
   */
  skippedCount?: number;
  /**
   * Playlist items the YouTube API listed but that are degenerate
   * (private/deleted): empty thumbnails, no publish date. Not errors — the
   * playlist legitimately still lists them — but the user should know they
   * exist and weren't extracted.
   */
  unavailableCount?: number;
  /**
   * Playlist items dropped because their API payload failed shape
   * validation (malformed data or an unmodelled YouTube response change).
   * Worth surfacing distinctly from the benign "unavailable" case.
   */
  shapeMismatchCount?: number;
  /**
   * Post-run DB truth: how many `videos` rows actually exist for the
   * processed IDs. When provided, surfaced as a "Saved to DB" line and
   * cross-checked against the claimed extracted count.
   */
  verifiedVideoRows?: number;
  /** Post-run DB truth: how many `transcripts` rows actually landed. */
  verifiedTranscriptRows?: number;
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
  skippedCount = 0,
  unavailableCount,
  shapeMismatchCount,
  verifiedVideoRows,
  verifiedTranscriptRows,
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
          <Text>Found in playlist: </Text>
          <Text bold>{totalVideos}</Text>
          <Text> videos</Text>
        </Box>
        {skippedCount > 0 && (
          <Box>
            <Text dimColor>Already extracted (skipped): {skippedCount}</Text>
          </Box>
        )}
        <Box>
          <Text color="cyan">Newly extracted: {successCount}</Text>
          <Text dimColor> {symbols.bullet} </Text>
          <Text color="red">Failed: {failureCount}</Text>
        </Box>
        {unavailableCount !== undefined && unavailableCount > 0 && (
          <Box>
            <Text dimColor>Unavailable in playlist (private/deleted): {unavailableCount}</Text>
          </Box>
        )}
        {shapeMismatchCount !== undefined && shapeMismatchCount > 0 && (
          <Box>
            <Text color="yellow">Skipped (malformed API data): {shapeMismatchCount}</Text>
          </Box>
        )}
        {verifiedVideoRows !== undefined && verifiedTranscriptRows !== undefined && (
          <Box>
            <Text dimColor>
              Saved to DB: {verifiedVideoRows} videos, {verifiedTranscriptRows} transcripts
            </Text>
          </Box>
        )}
        {verifiedVideoRows !== undefined && verifiedVideoRows < successCount && (
          <Box>
            <Text color="red">
              Warning: claimed {successCount} extracted but only {verifiedVideoRows} video rows
              found in DB
            </Text>
          </Box>
        )}
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

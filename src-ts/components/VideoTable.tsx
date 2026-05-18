import React from 'react';
import { Box, Text } from 'ink';
import { symbols, inkColors, status } from '../utils/colors.js';
import { safeTitle } from '../utils/terminal.js';

interface Video {
  id?: number;
  video_id: string;
  title: string;
  channel_title?: string;
  duration?: string;
  has_transcript?: boolean;
}

interface VideoTableProps {
  videos: Video[];
  title?: string;
}

export function VideoTable({ videos, title }: VideoTableProps) {
  const truncate = (str: string, max: number) => {
    return str.length > max ? str.substring(0, max - 3) + '...' : str;
  };

  const formatDuration = (duration?: string) => {
    if (!duration) return 'N/A';
    // Parse PT format (e.g., PT17M57S)
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return duration;
    const h = match[1] || '0';
    const m = match[2] || '0';
    const s = match[3] || '0';
    if (h !== '0') return `${h}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;
    return `${m}:${s.padStart(2, '0')}`;
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor={status.border.normal} padding={1} flexDirection="column">
        {title && (
          <Box marginBottom={1}>
            <Text bold color={inkColors.orange}>{title}</Text>
          </Box>
        )}

        <Box>
          <Box width={4}><Text bold color={inkColors.orange}>#</Text></Box>
          <Box width={40}><Text bold color={inkColors.orange}>Title</Text></Box>
          <Box width={20}><Text bold color={inkColors.orange}>Channel</Text></Box>
          <Box width={10}><Text bold color={inkColors.orange}>Duration</Text></Box>
          <Box width={8}><Text bold color={inkColors.orange}>Status</Text></Box>
        </Box>

        <Box marginY={0}>
          <Text dimColor>{'-'.repeat(82)}</Text>
        </Box>

        {videos.map((video, index) => (
          <Box key={video.video_id}>
            <Box width={4}><Text dimColor>{index + 1}</Text></Box>
            <Box width={40}><Text>{truncate(safeTitle(video.title), 37)}</Text></Box>
            <Box width={20}><Text dimColor>{truncate(video.channel_title || '', 17)}</Text></Box>
            <Box width={10}><Text dimColor>{formatDuration(video.duration)}</Text></Box>
            <Box width={8}>
              <Text color={video.has_transcript ? 'green' : inkColors.orange}>
                {video.has_transcript ? `${symbols.check} Done` : '... Pending'}
              </Text>
            </Box>
          </Box>
        ))}

        <Box marginTop={1}>
          <Text dimColor>Total: {videos.length} videos</Text>
        </Box>
      </Box>
    </Box>
  );
}

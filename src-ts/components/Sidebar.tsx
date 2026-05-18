import React from 'react';
import { Box, Text } from 'ink';
import { inkColors, symbols } from '../utils/colors.js';

interface SidebarProps {
  recentCommands: string[];
  stats?: {
    authenticated: boolean;
    playlistCount: number;
    videoCount: number;
  };
}

export function Sidebar({ recentCommands, stats }: SidebarProps) {
  return (
    <Box
      flexDirection="column"
      width={24}
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={inkColors.grey}
    >
      {/* Navigation */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={inkColors.orange} backgroundColor={inkColors.greyDark}>
          COMMANDS
        </Text>
        <Box marginLeft={1} flexDirection="column">
          <Text dimColor>init</Text>
          <Text dimColor>discover</Text>
          <Text dimColor>playlist</Text>
          <Text dimColor>extract</Text>
          <Text dimColor>report</Text>
        </Box>
      </Box>

      {/* Recent Commands */}
      {recentCommands.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={inkColors.orange} backgroundColor={inkColors.greyDark}>
            RECENT
          </Text>
          <Box marginLeft={1} flexDirection="column">
            {recentCommands
              .slice(-4)
              .reverse()
              .map((cmd, i) => (
                <Text key={i} dimColor>
                  {cmd.length > 16 ? cmd.substring(0, 16) + '...' : cmd}
                </Text>
              ))}
          </Box>
        </Box>
      )}

      {/* Status */}
      {stats && (
        <Box flexDirection="column">
          <Text bold color={inkColors.orange} backgroundColor={inkColors.greyDark}>
            STATUS
          </Text>
          <Box marginLeft={1} flexDirection="column">
            <Text dimColor>{stats.authenticated ? 'Auth: Yes' : 'Auth: No'}</Text>
            <Text dimColor>{stats.playlistCount} Lists</Text>
            <Text dimColor>{stats.videoCount} Vids</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

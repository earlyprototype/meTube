import React from 'react';
import { Box, Text } from 'ink';
import { symbols, status } from '../utils/colors.js';

interface ErrorDisplayProps {
  message: string;
  details?: string;
  suggestions?: string[];
}

export function ErrorDisplay({ message, details, suggestions }: ErrorDisplayProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor={status.border.error} padding={1} flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="red">
            {symbols.cross} Error
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>{message}</Text>
        </Box>

        {suggestions && suggestions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Try this:</Text>
            {suggestions.map((suggestion, i) => (
              <Box key={i} marginLeft={2}>
                <Text dimColor>
                  {i + 1}. {suggestion}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {details && process.env.DEBUG && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Debug info:</Text>
            <Text dimColor>{details}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

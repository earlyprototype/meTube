import React from 'react';
import { Box, Text } from 'ink';
import { symbols, status } from '../utils/colors.js';
import { getRemediation, type RemediationContext } from '../utils/errorRemediation.js';

interface ErrorDisplayProps {
  message: string;
  details?: string;
  suggestions?: string[];
  /**
   * The failing error's `AppError.code`. When it maps to a remediation entry
   * (see `errorRemediation.ts`), the numbered fix steps Python printed are
   * rendered under the message. Unmapped codes change nothing.
   */
  code?: string;
  /** Structured context that specialises a few remediation messages (e.g. CONFIG_ERROR's path/cause). */
  remediationContext?: RemediationContext;
}

export function ErrorDisplay({
  message,
  details,
  suggestions,
  code,
  remediationContext,
}: ErrorDisplayProps) {
  // Prefer caller-supplied suggestions; otherwise fall back to the code->steps
  // remediation map so every command's error path gains the numbered fixes
  // without each call site re-deriving them. Explicit suggestions win because a
  // command may have more specific guidance than the generic code mapping.
  const remediation = getRemediation(code, remediationContext);
  const steps = suggestions && suggestions.length > 0 ? suggestions : remediation;

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

        {steps && steps.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Try this:</Text>
            {steps.map((suggestion, i) => (
              <Box key={i} marginLeft={2}>
                <Text dimColor>
                  {i + 1}. {suggestion}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {details && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Details:</Text>
            <Text dimColor>{details}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

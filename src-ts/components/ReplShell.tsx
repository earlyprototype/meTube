import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { inkColors, symbols } from '../utils/colors.js';

interface ReplShellProps {
  onCommand: (command: string) => void;
  onExit: () => void;
  prompt?: string;
  history?: string[];
}

export function ReplShell({ 
  onCommand, 
  onExit, 
  prompt = '>', 
  history = [] 
}: ReplShellProps) {
  const [input, setInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>(history);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useInput((inputChar, key) => {
    // Only handle navigation keys, let TextInput handle regular typing
    if (key.upArrow && commandHistory.length > 0) {
      const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
      setHistoryIndex(newIndex);
      setInput(commandHistory[commandHistory.length - 1 - newIndex]);
    } else if (key.downArrow) {
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(commandHistory[commandHistory.length - 1 - newIndex]);
      } else {
        setHistoryIndex(-1);
        setInput('');
      }
    } else if (key.ctrl && inputChar === 'c') {
      onExit();
    }
  });

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    
    if (!trimmed) {
      setInput('');
      return;
    }

    // Check for exit commands
    if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/exit' || trimmed === '/quit') {
      onExit();
      return;
    }

    // Add to history
    setCommandHistory(prev => [...prev, trimmed]);
    setHistoryIndex(-1);

    // Execute command
    onCommand(trimmed);
    setInput('');
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={inkColors.orange} bold backgroundColor={inkColors.greyDark}>{prompt}</Text>
        <Text> </Text>
        <TextInput
          key="repl-input"
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type a command or /help"
          showCursor={true}
        />
      </Box>
    </Box>
  );
}

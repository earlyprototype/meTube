/**
 * CommandExecutor - Returns command components without rendering them
 * 
 * This module separates command routing logic from rendering concerns.
 * It returns React elements that can be displayed inline in REPL mode
 * or rendered as separate instances in direct command mode.
 */

import React from 'react';
import { InitCommand } from './InitCommand.js';
import { PlaylistCommands } from './PlaylistCommands.js';
import { VideoCommands } from './VideoCommands.js';
import { ExtractCommand } from './ExtractCommand.js';
import { ReportCommand } from './ReportCommand.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';

interface ExecuteCommandOptions {
  cmd: string;
  sub?: string;
  args?: string[];
  flags?: Record<string, any>;
  onComplete?: () => void;
}

/**
 * Execute command logic and return a React element
 * 
 * @param options - Command execution options
 * @returns React element representing the command output
 */
export function executeCommandLogic({
  cmd,
  sub,
  args = [],
  flags = {},
  onComplete,
}: ExecuteCommandOptions): React.ReactElement {
  if (cmd === 'init') {
    return React.createElement(InitCommand, { 
      force: flags.force,
      onComplete,
    });
  }
  
  if (cmd === 'playlist') {
    return React.createElement(PlaylistCommands, {
      subcommand: sub || '',
      args,
      flags,
      onComplete,
    });
  }
  
  if (cmd === 'video') {
    return React.createElement(VideoCommands, {
      subcommand: sub || '',
      args,
      flags,
      onComplete,
    });
  }
  
  if (cmd === 'extract') {
    return React.createElement(ExtractCommand, {
      type: sub || '',
      id: args[0],
      flags,
      onComplete,
    });
  }
  
  if (cmd === 'report') {
    // Handle --all flag: Generate reports for all videos
    if (flags.all) {
      return React.createElement(ReportCommand, {
        type: 'all',
        id: undefined,
        flags,
        onComplete,
      });
    }
    
    return React.createElement(ReportCommand, {
      type: sub || '',
      id: args[0],
      flags,
      onComplete,
    });
  }
  
  return React.createElement(ErrorDisplay, {
    message: `Unknown command: ${cmd}`,
    suggestions: ['init', 'playlist', 'video', 'extract', 'report'],
  });
}

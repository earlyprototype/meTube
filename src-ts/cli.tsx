#!/usr/bin/env node

// Load .env into process.env BEFORE anything reads it. This MUST be the first
// import: buildGeminiAdapter (ExtractCommand.tsx) and the v2 config loader's
// ${VAR} substitution both read process.env at module-eval / call time, so the
// .env values have to be present before any of those run. Everything enters
// through this file (one-shot commands AND REPL mode), so a single load here
// covers the whole process. Ports legacy/python/src/cli.py:10,20
// (`from dotenv import load_dotenv` + `load_dotenv()`).
import 'dotenv/config';

import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { executeCommandLogic } from './commands/CommandExecutor.js';
import { ErrorDisplay } from './components/ErrorDisplay.js';
import { ReplMode } from './components/ReplMode.js';
import { parseReplInput } from './utils/replInput.js';

const cli = meow(
  `
  Usage
    $ metube <command> [options]

  Commands
    init                        Initialize OAuth authentication
    
    Playlist Management:
      playlist list             List saved playlists
      playlist discover         Discover playlists from YouTube (interactive)
      playlist add <id>         Add playlist by ID
      playlist add-mine         Bulk add all your playlists
      playlist sync             Sync tracked playlists with YouTube
      playlist remove <id>      Remove playlist from tracking
      playlist videos <id>      Show numbered list of videos in a playlist
    
    Video Operations:
      video add <url_or_id>     Extract a single video by URL or ID
    
    Extraction:
      extract playlist <id>     Extract all videos from playlist
      extract --all             Extract all enabled playlists
      extract video <id>        Extract single video
    
    Report Generation:
      report playlist <id>      Generate playlist HTML report (with aggregation)
      report video <id>         Generate video HTML report
      report --all              Generate reports for ALL videos in database

  Options
    --help                      Show this help message
    --version                   Show version number
    --force                     Force re-authentication or reprocessing
    --reprocess                 Reprocess videos (skip existing check)
    --max-videos <n>            Maximum number of videos to process
    --no-transcript             Skip transcript extraction (video add only)
    --no-llm                    Skip LLM entity parsing (video add only)
    --no-whisper                Skip Whisper fallback (video add only)
    --report                    Generate report after extraction (video add only)
    --no-open                   Don't auto-open report in browser (report only)
    --all                       Generate reports for all videos (report only) or extract all playlists (extract only)
    --privacy <type>            Filter by privacy (add-mine only: public|private|unlisted|all)
    --skip-existing             Skip already tracked playlists (add-mine only)
    --remove-deleted            Remove deleted playlists (sync only)
    --debug                     Enable debug mode

  Examples
    $ metube init
    $ metube playlist discover
    $ metube playlist add PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
    $ metube playlist add-mine --privacy public
    $ metube playlist sync --remove-deleted
    $ metube playlist videos PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
    $ metube extract playlist PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
    $ metube extract --all
    $ metube video add dQw4w9WgXcQ --report
    $ metube video add https://youtube.com/watch?v=dQw4w9WgXcQ
    $ metube report playlist PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
    $ metube report video dQw4w9WgXcQ --no-open
    $ metube report --all
    
  Interactive Mode
    $ metube                    Start interactive REPL mode
    Type 'help' in REPL for more commands, 'exit' to quit
`,
  {
    importMeta: import.meta,
    flags: {
      force: { type: 'boolean', default: false },
      reprocess: { type: 'boolean', default: false },
      maxVideos: { type: 'number' },
      noTranscript: { type: 'boolean', default: false },
      noLlm: { type: 'boolean', default: false },
      noWhisper: { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
      noOpen: { type: 'boolean', default: false },
      privacy: { type: 'string' },
      skipExisting: { type: 'boolean', default: false },
      removeDeleted: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      debug: { type: 'boolean', default: false },
    },
  }
);

const [command, subcommand, ...args] = cli.input;

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n👋 Goodbye!');
  process.exit(0);
});

// Set debug environment variable
if (cli.flags.debug) {
  process.env.DEBUG = 'true';
}

// Route to appropriate command or start REPL
if (!command) {
  // No command = start REPL mode (single Ink instance)
  render(
    <ReplMode
      onCommand={async (input, setComponent) => {
        // Parse REPL input. Flags typed inside the REPL are parsed here and
        // merged OVER cli.flags below — cli.flags only ever holds the meow
        // startup defaults in REPL mode (the process starts with no args), so
        // without this every typed flag (--reprocess, --max-videos, ...) was
        // silently dropped and the command ran with defaults.
        const { cmd, sub, args: cmdArgs, flags: typedFlags } = parseReplInput(input);

        // Get command component (doesn't call render!). `cmd` is only
        // undefined for empty input, which ReplShell already filters before
        // calling onCommand; the `?? ''` keeps the type honest and falls
        // through to the "Unknown command" display if one ever slips by.
        const component = executeCommandLogic({
          cmd: cmd ?? '',
          sub,
          args: cmdArgs,
          // Typed flags win; startup defaults remain the base.
          flags: { ...cli.flags, ...typedFlags },
          onComplete: () => {
            // Command completed in REPL - component stays visible
          },
          // Component-swap navigation: lets commands (e.g. the
          // post-extraction menu) replace the currently-rendered inline
          // component without leaving REPL. Passing null clears the
          // component back to the bare REPL prompt — the "Return to Main
          // Menu" path.
          onNavigate: (next) => setComponent(next),
        });

        // Display component inline in REPL
        setComponent(component);
      }}
      onExit={() => {
        console.log('\n\n👋 Goodbye!');
        process.exit(0);
      }}
    />
  );
} else {
  // Direct command execution (separate Ink instance with exit)
  try {
    const component = executeCommandLogic({
      cmd: command,
      sub: subcommand,
      args,
      flags: cli.flags,
      // No onComplete - direct mode will use useApp().exit()
    });
    render(component);
  } catch (error) {
    render(
      <ErrorDisplay
        message={error instanceof Error ? error.message : String(error)}
        details={error instanceof Error ? error.stack : undefined}
      />
    );
    setTimeout(() => process.exit(1), 100);
  }
}

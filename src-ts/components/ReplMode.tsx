import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ReplShell } from './ReplShell.js';
import { Sidebar } from './Sidebar.js';
import { inkColors, symbols } from '../utils/colors.js';
import { DatabaseManager } from '../../src-ts-v2/database/connection.js';
import { PlaylistRepository } from '../../src-ts-v2/database/PlaylistRepository.js';
import { VideoRepository } from '../../src-ts-v2/database/VideoRepository.js';
import { YouTubeAuth } from '../../src-ts-v2/auth/YouTubeAuth.js';
import { loadAppPaths } from '../utils/appConfig.js';

interface ReplModeProps {
  onCommand: (
    command: string,
    setComponent: (component: React.ReactElement | null) => void
  ) => Promise<void>;
  onExit: () => void;
}

const HELP_TEXT = `Available Commands:

Initialization:
  init                        Initialize OAuth authentication

Playlist Management:
  playlist list               List saved playlists
  playlist discover           Discover playlists from YouTube (interactive)
  playlist add <id>           Add playlist by ID
  playlist add-mine           Bulk add all your playlists
  playlist sync               Sync tracked playlists with YouTube
  playlist remove <id>        Remove playlist from tracking
  playlist videos <id>        Show numbered list of videos in playlist

Video Operations:
  video add <url_or_id>       Extract a single video by URL or ID

Extraction:
  extract playlist <id>       Extract all videos from playlist (with transcripts)
  extract --all               Extract all enabled playlists
  extract video <id>          Extract single video

Report Generation:
  report playlist <id>        Generate playlist HTML report (with aggregation)
  report video <id>           Generate video HTML report
  report --all                Generate reports for ALL videos in database
  
Options:
  --no-open                   Don't auto-open report in browser (report commands)
  --reprocess                 Reprocess videos (skip existing check, extract commands)
  --max-videos <n>            Limit videos to process (extract commands)
  --no-transcript             Skip transcript extraction (video add only)
  --no-llm                    Skip LLM entity parsing (video add only)
  --report                    Generate report after extraction (video add only)
  --privacy <type>            Filter by privacy (add-mine: public|private|unlisted|all)
  --skip-existing             Skip already tracked playlists (add-mine only)
  --remove-deleted            Remove deleted playlists (sync only)

REPL Commands:
  /help, help                 Show this help
  /clear, clear               Clear screen
  /history                    Show command history
  /exit, exit, quit           Exit REPL

Shortcuts:
  Ctrl+C                      Exit REPL
  ↑↓ (or j/k)                Navigate command history

Examples:
  playlist discover
  playlist add-mine --privacy public
  playlist sync --remove-deleted
  playlist videos PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
  extract playlist PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
  extract --all
  video add dQw4w9WgXcQ --report
  report video dQw4w9WgXcQ --no-open`;

export function ReplMode({ onCommand, onExit }: ReplModeProps) {
  const [output, setOutput] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [currentCommand, setCurrentCommand] = useState<React.ReactElement | null>(null);
  const [showSplash, setShowSplash] = useState(true);
  const [stats, setStats] = useState({
    authenticated: false,
    playlistCount: 0,
    videoCount: 0,
  });

  // Load stats from database and check authentication
  useEffect(() => {
    function loadStats() {
      // Probe auth OUTSIDE the DB try: a config/DB failure must not reset a
      // genuinely-authenticated state to false. The sidebar would otherwise
      // lie about auth whenever the DB path is broken — tokens loaded fine.
      // v2 YouTubeAuth has no isAuthenticated(); we probe disk via loadTokens().
      let isAuthenticated = false;
      try {
        const auth = new YouTubeAuth();
        auth.loadTokens();
        isAuthenticated = true;
      } catch {
        isAuthenticated = false;
      }

      let db: DatabaseManager | undefined;
      try {
        // Get counts from database — v2 repos use findAll(), not getAll().
        // v2 PlaylistRepository.findAll defaults to enabledOnly: true; the
        // Sidebar wants all tracked playlists so we opt out.
        db = new DatabaseManager(loadAppPaths().dbPath);
        const playlistRepo = new PlaylistRepository(db);
        const videoRepo = new VideoRepository(db);

        const playlists = playlistRepo.findAll({ enabledOnly: false });
        const videos = videoRepo.findAll();

        setStats({
          authenticated: isAuthenticated,
          playlistCount: playlists.length,
          videoCount: videos.length,
        });
      } catch (error) {
        // DB-side failure (missing/broken config or DB): keep the REAL auth
        // state and zero only the playlist/video counts.
        setStats({
          authenticated: isAuthenticated,
          playlistCount: 0,
          videoCount: 0,
        });
      } finally {
        db?.close();
      }
    }

    loadStats();
  }, []);

  // Show splash screen for 1.5 seconds
  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  // Function to refresh stats from database
  const refreshStats = () => {
    try {
      const auth = new YouTubeAuth();
      let isAuthenticated = false;
      try {
        auth.loadTokens();
        isAuthenticated = true;
      } catch {
        isAuthenticated = false;
      }

      const db = new DatabaseManager(loadAppPaths().dbPath);
      const playlistRepo = new PlaylistRepository(db);
      const videoRepo = new VideoRepository(db);

      const playlists = playlistRepo.findAll({ enabledOnly: false });
      const videos = videoRepo.findAll();

      db.close();

      setStats({
        authenticated: isAuthenticated,
        playlistCount: playlists.length,
        videoCount: videos.length,
      });
    } catch (error) {
      // Keep current stats on error
    }
  };

  const handleCommand = async (command: string) => {
    const trimmed = command.trim();

    // Add to history
    setHistory((prev) => [...prev, trimmed]);

    // Handle REPL-specific commands
    if (trimmed === '/help' || trimmed === 'help') {
      setShowHelp(true);
      setShowWorkflow(false);
      setOutput([]);
      setCurrentCommand(null);
      return;
    }

    if (trimmed === '/clear' || trimmed === 'clear') {
      setOutput([]);
      setShowHelp(false);
      setShowWorkflow(false);
      setCurrentCommand(null);
      return;
    }

    if (trimmed === '/history') {
      setOutput(['Command History:', ...history.map((cmd, i) => `  ${i + 1}. ${cmd}`)]);
      setShowHelp(false);
      setShowWorkflow(false);
      setCurrentCommand(null);
      return;
    }

    // Hide workflow hint after first real command
    setShowHelp(false);
    setShowWorkflow(false);

    // Execute the actual command
    try {
      setOutput((prev) => [...prev, `${symbols.arrow} ${trimmed}`]);
      await onCommand(trimmed, setCurrentCommand);

      // Refresh stats after commands that modify database
      const commandType = trimmed.split(' ')[0];
      if (['init', 'playlist', 'extract', 'video'].includes(commandType)) {
        setTimeout(refreshStats, 500);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setOutput((prev) => [...prev, `${symbols.cross} Error: ${errorMsg}`]);
      setCurrentCommand(null);
    }
  };

  // Splash screen on entry
  // Show splash screen on startup
  if (showSplash) {
    return (
      <Box
        flexDirection="column"
        padding={2}
        justifyContent="center"
        alignItems="center"
        height="100%"
      >
        <Box paddingX={4} paddingY={2} borderStyle="single" borderColor={inkColors.grey}>
          <Box flexDirection="column" alignItems="center">
            <Text backgroundColor={inkColors.greyDark}>
              <Text color={inkColors.orange} bold>
                {`
 ███╗   ███╗███████╗████████╗██╗   ██╗██████╗ ███████╗
 ████╗ ████║██╔════╝╚══██╔══╝██║   ██║██╔══██╗██╔════╝
 ██╔████╔██║█████╗     ██║   ██║   ██║██████╔╝█████╗  
 ██║╚██╔╝██║██╔══╝     ██║   ██║   ██║██╔══██╗██╔══╝  
 ██║ ╚═╝ ██║███████╗   ██║   ╚██████╔╝██████╔╝███████╗
 ╚═╝     ╚═╝╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚══════╝
`}
              </Text>
            </Text>
            <Box marginTop={1}>
              <Text color={inkColors.greyLight}>YouTube Video Extraction & Analysis</Text>
            </Box>
            <Box>
              <Text color={inkColors.greyLight} dimColor>
                Loading interactive mode...
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      {/* Header with Logo */}
      <Box
        borderStyle="single"
        borderColor={inkColors.grey}
        paddingX={2}
        paddingY={1}
        justifyContent="center"
        alignItems="center"
      >
        <Box flexDirection="column" alignItems="center">
          <Box backgroundColor={inkColors.greyDark}>
            <Box flexDirection="column" alignItems="center">
              <Text color={inkColors.orange} bold>
                ███╗ ███╗███████╗████████╗██╗ ██╗██████╗ ███████╗
              </Text>
              <Text color={inkColors.orange} bold>
                ████╗ ████║██╔════╝╚══██╔══╝██║ ██║██╔══██╗██╔════╝
              </Text>
              <Text color={inkColors.orange} bold>
                ██╔████╔██║█████╗ ██║ ██║ ██║██████╔╝█████╗{' '}
              </Text>
              <Text color={inkColors.orange} bold>
                ██║╚██╔╝██║██╔══╝ ██║ ██║ ██║██╔══██╗██╔══╝{' '}
              </Text>
              <Text color={inkColors.orange} bold>
                ██║ ╚═╝ ██║███████╗ ██║ ╚██████╔╝██████╔╝███████╗
              </Text>
              <Text color={inkColors.orange} bold>
                ╚═╝ ╚═╝╚══════╝ ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝
              </Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text color={inkColors.greyLight}>YouTube Video Extraction & Analysis CLI</Text>
          </Box>
        </Box>
      </Box>

      {/* Main content: Sidebar + Main area */}
      <Box flexGrow={1}>
        {/* Sidebar */}
        <Sidebar recentCommands={history} stats={stats} />

        {/* Main content area */}
        <Box
          flexDirection="column"
          flexGrow={1}
          paddingX={1}
          paddingY={1}
          borderStyle="single"
          borderColor={inkColors.grey}
        >
          {/* Workflow hint (shown on startup) */}
          {showWorkflow && (
            <Box marginBottom={1} flexDirection="column">
              <Box marginBottom={1}>
                <Text>
                  <Text color={inkColors.orange} bold backgroundColor={inkColors.greyDark}>
                    QUICK START:
                  </Text>
                  <Text dimColor>
                    {' '}
                    init {symbols.arrow} playlist discover {symbols.arrow} extract {symbols.arrow}{' '}
                    report
                  </Text>
                </Text>
              </Box>
              <Box>
                <Text dimColor>
                  Type <Text color={inkColors.orange}>help</Text> for all commands {symbols.bullet}{' '}
                  <Text color={inkColors.orange}>exit</Text> or{' '}
                  <Text color={inkColors.orange}>Ctrl+C</Text> to quit
                </Text>
              </Box>
            </Box>
          )}

          {/* Full help text (shown on /help command) */}
          {showHelp && (
            <Box marginBottom={1}>
              <Text>{HELP_TEXT}</Text>
            </Box>
          )}

          {/* Current command component (displayed inline) */}
          {currentCommand && <Box marginBottom={1}>{currentCommand}</Box>}
        </Box>
      </Box>

      {/* Input at bottom */}
      <Box borderStyle="single" borderTop={true} borderColor={inkColors.grey} paddingX={1}>
        <ReplShell onCommand={handleCommand} onExit={onExit} prompt="metube>" history={history} />
      </Box>
    </Box>
  );
}

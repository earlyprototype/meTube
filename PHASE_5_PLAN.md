# Phase 5: Ink CLI Interface - Implementation Plan

**Status:** Ready to Start  
**Date:** 2026-01-23  
**Prerequisites:** Phase 4 Complete ✅

---

## Overview

Transform MeTube into a beautiful, interactive CLI application using Ink (React for the terminal). Replace the Python Click CLI with a modern, real-time UI that provides live feedback during operations.

## Goals

1. **Primary:** Build interactive CLI with Ink components
2. **Secondary:** Provide better UX than Python version
3. **Maintain:** All existing functionality (init, playlist, extract, report)
4. **Add:** Real-time progress updates, keyboard navigation, visual feedback

## Architecture

### Command Structure

```
metube
├── init                    # OAuth authentication
├── playlist
│   ├── list               # Show saved playlists
│   ├── discover           # Fetch from YouTube API (interactive)
│   ├── add <id>           # Add playlist by ID
│   └── remove <id>        # Remove playlist
├── extract
│   ├── playlist <id>      # Extract all videos from playlist
│   ├── video <id>         # Extract single video
│   └── update             # Update existing playlists
└── report
    ├── playlist <id>      # Generate playlist report
    └── video <id>         # Generate video report
```

### Component Hierarchy

```
src-ts/
├── cli.tsx                         # Main entry point
├── commands/
│   ├── InitCommand.tsx            # OAuth flow
│   ├── PlaylistCommands.tsx       # Playlist operations
│   ├── ExtractCommands.tsx        # Extraction operations
│   └── ReportCommands.tsx         # Report generation
└── components/
    ├── ProgressDisplay.tsx        # Live extraction progress
    ├── PlaylistPicker.tsx         # Interactive playlist selector
    ├── VideoTable.tsx             # Formatted video list
    ├── StatusPanel.tsx            # System status display
    ├── ErrorDisplay.tsx           # Error formatting
    └── Spinner.tsx                # Loading indicator
```

## Implementation Phases

### Phase 5.1: Foundation (Days 1-2)

**Goal:** Basic CLI structure working with command routing

#### Tasks:

1. **Install Dependencies**
   ```bash
   npm install ink react meow chalk boxen ora
   npm install -D @types/react
   ```

2. **Create CLI Entry Point** (`src-ts/cli.tsx`)
   - Parse command-line arguments with `meow`
   - Route to command handlers
   - Handle --help and --version flags
   - Error boundary for crashes

3. **Build Wrapper Script**
   - Create executable wrapper (`bin/metube`)
   - Add shebang for Unix systems
   - Test on Windows PowerShell

4. **Configure package.json**
   - Add `bin` field pointing to CLI
   - Add `files` field for distribution
   - Update scripts for development

**Verification:**
```bash
npm link
metube --help
metube --version
```

**Quality Gate:**
- [ ] `metube --help` displays command list
- [ ] `metube --version` shows version number
- [ ] Unknown commands show helpful error
- [ ] Works in PowerShell and Bash

---

### Phase 5.2: Core Components (Days 2-4)

**Goal:** Build reusable Ink components for UI

#### Component 1: ProgressDisplay

**Purpose:** Show live extraction progress with status updates

**Features:**
- Current video being processed
- Progress counter (e.g., "3 / 25 videos")
- Status indicators (downloading, transcribing, parsing, saving)
- **"Little dude" emoji animation** (🚶🏃🎉) showing work in progress
- Elapsed time
- Success/failure counts
- Smooth progress bar animation
- Real-time updates without flickering

**Design:**
```
╔════════════════════════════════════════════════════════════╗
║ Extracting Videos                                          ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Progress: ████████████░░░░░░░░░░ 12 / 25 videos          ║
║                                                            ║
║ 🚶 Current: "How to Build a Compiler"                     ║
║    Status:  🎵 Transcribing with Whisper...                ║
║                                                            ║
║ ✓ Success: 11    ✗ Failed: 0    ⏱ Elapsed: 2m 34s       ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

**Note:** The "little dude" 🚶 emoji walks across the screen during extraction, 
providing visual feedback that work is in progress. Animation states:
- 🚶 Walking (processing)
- 🏃 Running (downloading/transcribing)
- 🎉 Celebrating (completed)

**Implementation:**
```typescript
interface ProgressDisplayProps {
  current: number;
  total: number;
  currentVideo?: string;
  status: 'downloading' | 'transcribing' | 'parsing' | 'saving';
  successCount: number;
  failureCount: number;
  startTime: Date;
  enableAnimation?: boolean; // For "little dude" walking animation
}

// Animation cycle for "little dude"
const DUDE_STATES = ['🚶', '🚶', '🏃', '🏃'] as const;
// Cycles through states every 500ms for smooth animation
```

#### Component 2: PlaylistPicker

**Purpose:** Interactive playlist selection with keyboard navigation

**Features:**
- List playlists with arrow key navigation
- Highlight selected playlist
- Show metadata (video count, description)
- Search/filter functionality
- Multi-select support (optional)

**Design:**
```
╔════════════════════════════════════════════════════════════╗
║ Select a Playlist                                          ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║   [1]  Ai (60 videos)                                     ║
║        Machine learning tutorials and talks                ║
║                                                            ║
║ → [2]  Electronics (3 videos)                             ║
║        Arduino and circuit design                          ║
║                                                            ║
║   [3]  FabLab (8 videos)                                  ║
║        Digital fabrication tutorials                       ║
║                                                            ║
╠════════════════════════════════════════════════════════════╣
║ Use ↑↓ arrows to navigate, Enter to select, Esc to cancel ║
╚════════════════════════════════════════════════════════════╝
```

**Implementation:**
```typescript
interface PlaylistPickerProps {
  playlists: Playlist[];
  onSelect: (playlist: Playlist) => void;
  onCancel: () => void;
}
```

#### Component 3: VideoTable

**Purpose:** Display videos in a formatted table

**Features:**
- Numbered list with video details
- Column formatting (title, channel, duration, status)
- Color coding for status (extracted, pending, failed)
- Truncate long titles with ellipsis

**Design:**
```
╔════════════════════════════════════════════════════════════════════════════╗
║ Videos in "Ai" Playlist                                                    ║
╠════════════════════════════════════════════════════════════════════════════╣
║                                                                            ║
║  #  Title                              Channel       Duration    Status   ║
║ ──  ─────────────────────────────────  ────────────  ──────────  ────────║
║  1  AlphaGo Moment for AI              Wes Roth      17:57       ✓ Done  ║
║  2  Bill Hicks - Positive Drug Story   KennethMabie  5:08        Pending ║
║  3  How Big Tech Ships Code            ByteByteGo    0:59        Pending ║
║                                                                            ║
╚════════════════════════════════════════════════════════════════════════════╝
```

**Implementation:**
```typescript
interface VideoTableProps {
  videos: Video[];
  showStatus?: boolean;
}
```

#### Component 4: StatusPanel

**Purpose:** Show system status and configuration

**Features:**
- Database connection status
- YouTube API quota remaining
- Whisper availability
- Config file status
- Version information

**Design:**
```
╔════════════════════════════════════════════════════════════╗
║ System Status                                              ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Database:      ✓ Connected (metube.db)                    ║
║ YouTube API:   ✓ Authenticated (93 quota remaining)       ║
║ Whisper:       ✓ Available (Python venv)                  ║
║ Config:        ✓ Loaded (config.yaml)                     ║
║                                                            ║
║ Version:       2.0.0-beta                                  ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

#### Component 5: ErrorDisplay

**Purpose:** Consistent error message formatting

**Features:**
- Clear error description
- Suggested actions
- Error code/category
- Stack trace (in debug mode)

**Design:**
```
╔════════════════════════════════════════════════════════════╗
║ ✗ Error                                                    ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Failed to authenticate with YouTube                        ║
║                                                            ║
║ Possible causes:                                           ║
║  • Tokens expired or invalid                               ║
║  • client_secret.json missing or incorrect                 ║
║  • Network connection issue                                ║
║                                                            ║
║ Try this:                                                  ║
║  1. Run: metube init                                       ║
║  2. Check your internet connection                         ║
║  3. Verify client_secret.json exists                       ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

**Verification:**
- [ ] All components render without crashes
- [ ] Components update smoothly (no flicker)
- [ ] Keyboard navigation works (arrow keys, enter, esc)
- [ ] Animations are smooth and performant
- [ ] "Little dude" animation cycles correctly
- [ ] Progress bars update in real-time
- [ ] Styling is consistent and beautiful
- [ ] Components are reusable
- [ ] Better UX than Python version (side-by-side comparison)

---

### Phase 5.3: Init Command (Day 4)

**Goal:** OAuth authentication flow with visual feedback

#### Implementation:

1. **Check Existing Auth**
   - Look for tokens.json
   - Validate if still valid
   - Show status to user

2. **OAuth Flow**
   - Display authorization URL
   - Show spinner while waiting for code
   - Capture code from local server
   - Exchange for tokens
   - Show success message

3. **Error Handling**
   - Timeout if user doesn't authorize
   - Handle invalid client_secret.json
   - Network error handling
   - Clear error messages

**User Flow:**
```bash
$ metube init

╔════════════════════════════════════════════════════════════╗
║ YouTube Authentication                                     ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Opening browser for authorization...                       ║
║                                                            ║
║ If browser doesn't open, visit:                            ║
║ https://accounts.google.com/o/oauth2/auth?...             ║
║                                                            ║
║ ⏳ Waiting for authorization...                            ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝

[Browser opens, user authorizes]

╔════════════════════════════════════════════════════════════╗
║ ✓ Authentication Successful                                ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Tokens saved to: tokens.json                               ║
║ You can now use all MeTube commands                        ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

**Verification:**
- [ ] First-time auth works
- [ ] Re-auth when tokens expired works
- [ ] Error messages are helpful
- [ ] Browser opens automatically
- [ ] Manual URL shown as fallback

---

### Phase 5.4: Playlist Commands (Days 5-6)

**Goal:** All playlist operations with interactive UI

#### Command 1: `metube playlist list`

Show saved playlists from database

```bash
$ metube playlist list

╔════════════════════════════════════════════════════════════════════════════╗
║ Saved Playlists (4)                                                        ║
╠════════════════════════════════════════════════════════════════════════════╣
║                                                                            ║
║  ID  Title         Videos  Last Updated      Status                       ║
║ ───  ────────────  ──────  ────────────────  ────────                     ║
║  1   Ai            46      2026-01-20 14:23  ✓ Active                     ║
║  2   Electronics   3       2026-01-15 09:45  ✓ Active                     ║
║  3   FabLab        7       2026-01-18 16:30  ✓ Active                     ║
║  4   PsychHacks    1       2026-01-10 11:00  ✓ Active                     ║
║                                                                            ║
╚════════════════════════════════════════════════════════════════════════════╝
```

#### Command 2: `metube playlist discover`

Fetch from YouTube API with interactive picker

```bash
$ metube playlist discover

╔════════════════════════════════════════════════════════════╗
║ Fetching Your YouTube Playlists                            ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ ⏳ Fetching playlists from YouTube...                      ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝

[Shows PlaylistPicker component with all YouTube playlists]
[User selects one]

╔════════════════════════════════════════════════════════════╗
║ ✓ Playlist Added                                           ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ "GPT" (11 videos)                                          ║
║ Added to database                                          ║
║                                                            ║
║ Run: metube extract playlist PLxxx...                      ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

#### Command 3: `metube playlist add <id>`

Add specific playlist by ID

```bash
$ metube playlist add PLqAWmFRvbe_GudGs6T3QU8UDrcdsm4mcx

╔════════════════════════════════════════════════════════════╗
║ Adding Playlist                                            ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ ⏳ Fetching playlist details...                            ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝

╔════════════════════════════════════════════════════════════╗
║ ✓ Playlist Added                                           ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Title: "GPT" (11 videos)                                   ║
║ Channel: Your Channel Name                                 ║
║                                                            ║
║ Saved to database.                                         ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

#### Command 4: `metube playlist remove <id>`

Remove playlist with confirmation

```bash
$ metube playlist remove 4

╔════════════════════════════════════════════════════════════╗
║ Remove Playlist?                                           ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ "PsychHacks" (1 video)                                     ║
║                                                            ║
║ This will remove the playlist and all extracted data.      ║
║                                                            ║
║ Are you sure? (y/N):                                       ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

**Verification:**
- [ ] All playlist commands work
- [ ] Interactive picker functional
- [ ] Error handling (invalid IDs, network issues)
- [ ] Confirmation prompts work
- [ ] Database updates correctly

---

### Phase 5.5: Extract Command (Days 6-8)

**Goal:** Video extraction with live progress display

#### Command: `metube extract playlist <id>`

Extract all videos from playlist with real-time updates

```bash
$ metube extract playlist PLqAWmFRvbe_F-W_DquxryH3Evh_95LWpT

╔════════════════════════════════════════════════════════════╗
║ Extracting Playlist: "Ai"                                  ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Found 60 videos in playlist                                ║
║ Starting extraction...                                     ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝

[Shows ProgressDisplay component with live updates]

╔════════════════════════════════════════════════════════════╗
║ Extracting Videos                                          ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Progress: ████████████░░░░░░░░░░ 12 / 60 videos          ║
║                                                            ║
║ Current: "How to Build a Compiler"                        ║
║ Status:  🎵 Transcribing with Whisper...                  ║
║                                                            ║
║ ✓ Success: 11    ✗ Failed: 0    ⏱ Elapsed: 8m 14s       ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝

[After completion]

╔════════════════════════════════════════════════════════════╗
║ ✓ Extraction Complete                                      ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Processed: 60 videos                                       ║
║ Success:   58 videos                                       ║
║ Failed:    2 videos                                        ║
║ Skipped:   0 videos (already extracted)                    ║
║                                                            ║
║ Total time: 23m 45s                                        ║
║ Average:    23.8s per video                                ║
║                                                            ║
║ Generate report: metube report playlist PLqAWm...          ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

**Features:**
- **Real-time progress bar with smooth animation**
- **"Little dude" walking animation during processing**
- Current video status (downloading, transcribing, etc.)
- Success/failure counters
- Elapsed time display
- **Interactive transitions between states**
- Error summary at end
- Graceful cancellation (Ctrl+C)
- Celebration animation on completion 🎉

**Implementation Notes:**
- Use event emitters to update progress from VideoExtractor
- Debounce UI updates to prevent flickering (max 60fps)
- Handle long-running operations gracefully
- Show detailed errors without crashing
- Implement smooth animations with `useEffect` and intervals
- Use Ink's built-in spinner components where appropriate
- "Little dude" animation should be non-distracting but delightful
- Compare side-by-side with Python CLI to ensure better UX

**Verification:**
- [ ] Progress updates smoothly (no flicker)
- [ ] All extraction steps shown with clear indicators
- [ ] "Little dude" animation runs without stutter
- [ ] Transitions between states are smooth
- [ ] Errors displayed clearly with helpful suggestions
- [ ] Ctrl+C cancels gracefully with cleanup message
- [ ] Summary stats correct with celebration on success
- [ ] Better UX than Python version (faster, prettier, more informative)

---

### Phase 5.6: Report Command (Day 8)

**Goal:** Report generation with progress indication

#### Command: `metube report playlist <id>`

Generate HTML report for playlist

```bash
$ metube report playlist 1

╔════════════════════════════════════════════════════════════╗
║ Generating Playlist Report                                 ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ Playlist: "Ai" (46 videos)                                 ║
║                                                            ║
║ ⏳ Collecting data...                                      ║
║ ⏳ Generating HTML...                                      ║
║ ⏳ Writing file...                                         ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝

╔════════════════════════════════════════════════════════════╗
║ ✓ Report Generated                                         ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║ File: reports/playlist_Ai_2026-01-23.html                  ║
║ Size: 245 KB                                               ║
║                                                            ║
║ Open with: start reports/playlist_Ai_2026-01-23.html       ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

**Verification:**
- [ ] Report generates correctly
- [ ] Progress shown during generation
- [ ] File path displayed
- [ ] Error handling (missing data, etc.)

---

## Quality Standards

### UI/UX Requirements (Excellence Criteria)

1. **Beautiful:** Modern, polished UI with consistent styling
2. **Responsive:** UI updates in real-time, no lag
3. **Interactive:** Menus and pickers with keyboard navigation
4. **Animated:** Real-time progress with smooth transitions
5. **Delightful:** "Little dude" emoji animations add personality
6. **Clear:** All text readable, no ambiguous states
7. **Helpful:** Error messages suggest solutions
8. **Consistent:** All components use same styling
9. **Accessible:** Works in different terminal sizes
10. **Better:** Demonstrably superior UX to Python version

### Code Quality

1. **Typed:** All components fully typed (no `any`)
2. **Documented:** JSDoc on all exported functions
3. **Tested:** Unit tests for command logic
4. **Modular:** Components are reusable
5. **Logged:** Structured logging throughout

### Performance

1. **Fast:** UI renders in < 100ms
2. **Smooth:** No flickering or jank
3. **Efficient:** Minimal re-renders
4. **Responsive:** Keyboard input immediate

## Testing Strategy

### Manual Testing

1. **Happy Path:**
   - Run init → playlist discover → extract → report
   - Verify all UI components render correctly
   - Check progress updates in real-time
   - Confirm reports generated

2. **Error Scenarios:**
   - Invalid command arguments
   - Network failures during API calls
   - Authentication failures
   - Missing dependencies (Whisper, FFmpeg)
   - Database connection issues

3. **Edge Cases:**
   - Empty playlists
   - Very long video titles
   - Special characters in titles
   - Cancelled operations (Ctrl+C)
   - Small terminal windows

### Automated Testing

1. **Component Tests:**
   - Snapshot tests for UI components
   - Unit tests for command handlers
   - Mock YouTube API responses

2. **Integration Tests:**
   - Full command workflows
   - Database interactions
   - File system operations

## Success Criteria

### Minimum Viable Product (MVP)

- [ ] All commands work (init, playlist, extract, report)
- [ ] Basic UI components functional
- [ ] Progress display during extraction
- [ ] Error messages clear and helpful
- [ ] Works on Windows PowerShell

### Full Feature Parity

- [ ] Interactive playlist picker
- [ ] Real-time progress updates
- [ ] Keyboard navigation
- [ ] Status indicators
- [ ] Visual feedback for all operations
- [ ] Better UX than Python version

### Excellence (Phase 5 MUST HAVE)

- [ ] Beautiful Ink UI components
- [ ] Interactive menus and pickers
- [ ] Real-time progress animations
- [ ] Smooth transitions
- [ ] "Little dude" emoji integrated into progress displays
- [ ] Better than Python version UX
- [ ] Comprehensive error handling
- [ ] Helpful hints and tips
- [ ] Fast and responsive (< 100ms render)
- [ ] Delightful user experience

## Timeline

```
Week 1:
├─ Day 1:    Foundation + Basic CLI routing
├─ Day 2:    Core components (ProgressDisplay, PlaylistPicker)
└─ Day 3:    More components (VideoTable, StatusPanel, ErrorDisplay)

Week 2:
├─ Day 4:    Init command
├─ Day 5-6:  Playlist commands
├─ Day 7-8:  Extract command
└─ Day 8:    Report command

Week 3:
└─ Day 9-10: Testing, polish, documentation
```

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Ink learning curve | Medium | Start with simple components, reference examples |
| Windows compatibility issues | High | Test early and often on PowerShell |
| Performance issues with large playlists | Medium | Implement pagination, virtual scrolling |
| Terminal size constraints | Medium | Responsive design, minimum size requirements |
| Keyboard navigation complexity | Medium | Use Ink's built-in input components |

## Dependencies

### Required Packages

```json
{
  "ink": "^5.0.0",
  "react": "^18.0.0",
  "meow": "^13.0.0",
  "chalk": "^5.0.0",
  "boxen": "^7.0.0",
  "ora": "^7.0.0",
  "cli-spinners": "^2.9.0",
  "ink-text-input": "^5.0.0",
  "ink-select-input": "^5.0.0"
}
```

### Dev Dependencies

```json
{
  "@types/react": "^18.0.0",
  "ink-testing-library": "^3.0.0"
}
```

## References

- [Ink Documentation](https://github.com/vadimdemedes/ink)
- [Ink Examples](https://github.com/vadimdemedes/ink#examples)
- [React Hooks Documentation](https://react.dev/reference/react)
- [Meow CLI Parser](https://github.com/sindresorhus/meow)

## Next Steps

After Phase 5 completion:
1. Move to Phase 6 (Report Generation with Handlebars)
2. Update documentation with CLI examples
3. Create demo video/GIF for README
4. Gather user feedback on UX

---

**Created:** 2026-01-23  
**Last Updated:** 2026-01-23  
**Status:** Ready to implement

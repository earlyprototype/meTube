# Phase 5 Integration Testing Plan

## What We Need to Test

Phase 5 is the Ink CLI interface. We've built all components and commands, but need to verify:

1. **Full workflow works** (init → discover → add → extract)
2. **New design works** (orange/grey colors, unicode symbols)
3. **All components render correctly** (with recent design changes)
4. **Backend integration works** (database, YouTube API, Whisper)
5. **Error handling works** (graceful failures, helpful messages)
6. **Interactive elements work** (keyboard navigation, selection)

## Test Scenarios

### Scenario 1: Fresh Start (No Auth)
**Goal:** Test first-time user experience

```bash
# 1. Try to list playlists (should fail gracefully)
npm run dev:list

# Expected: Error message with suggestion to run init

# 2. Run init command
npm run dev:init

# Expected: 
# - Orange heading "System Status"
# - Shows auth URL
# - Unicode symbols (✓ ✗ ⚠)
# - Grey borders
# - Waits for auth completion

# 3. After auth, list playlists again
npm run dev:list

# Expected:
# - Orange heading
# - Shows playlists from database (if any)
# - Or message "No playlists found"
```

### Scenario 2: Playlist Discovery (Interactive)
**Goal:** Test the new playlist picker UI

```bash
npm run dev:discover
```

**Expected:**
- Orange border (active)
- Orange heading "Select a Playlist"
- Orange selection indicator `▶`
- Grey video counts
- Arrow keys work (↑↓)
- Vim keys work (j/k)
- `q` quits
- Footer shows: `↑↓ Navigate • j/k Vim • Enter • q`
- Selected playlist is bold + orange
- Description shows for selected item

**Test:**
1. Press `j` - should move down
2. Press `k` - should move up
3. Press `↓` arrow - should move down
4. Press `↑` arrow - should move up
5. Press `q` - should exit cleanly
6. Run again, press Enter - should add playlist

### Scenario 3: Playlist Management
**Goal:** Test list/add/remove commands

```bash
# List playlists in database
npm run dev:list

# Expected:
# - Orange heading
# - Unicode symbols
# - Grey secondary text
# - Shows enabled playlists

# Add a playlist (if not exists)
npm run dev -- playlist add <playlist-id>

# Expected:
# - Success message with ✓
# - Orange accent

# List again to verify
npm run dev:list

# Remove a playlist
npm run dev -- playlist remove <playlist-id>

# Expected:
# - Confirmation or success message
```

### Scenario 4: Video Extraction (The Big One)
**Goal:** Test full extraction pipeline with progress display

```bash
# Extract from a small playlist (test with 1-3 videos)
npm run dev -- extract playlist <playlist-id>
```

**Expected:**
- Orange border (active operation)
- Orange heading "Extracting Videos"
- Rotating circle animation `◐◓◑◒`
- Progress bar with `#` and `-`
- Shows current video title
- Shows status: "Downloading audio" / "Transcribing with Whisper" / etc.
- Success/failure counts with unicode: `✓ Success: X • ✗ Failed: Y`
- Grey secondary text (time elapsed)
- On completion: `◉` (filled circle)

**Watch for:**
- Animation smoothness (rotating circle should be visible)
- Status updates in real-time
- Proper error handling if Whisper fails
- Clean exit when done

### Scenario 5: Error Handling
**Goal:** Test error displays

```bash
# Try invalid command
npm run dev -- invalid-command

# Try invalid playlist ID
npm run dev -- extract playlist INVALID_ID

# Try extraction without Whisper (if applicable)
```

**Expected:**
- Red border for errors
- `✗ Error` heading
- Clear error message
- Suggestions (if applicable)
- Debug info only if DEBUG=true

### Scenario 6: Status Check
**Goal:** Verify system status display

```bash
npm run dev:init
```

**Expected:**
- Orange heading "System Status"
- `✓ Database` (green) if connected
- `✓ YouTube API` (green) if authenticated
- `⚠ Whisper` (orange) if unavailable
- `✗ Whisper` (red) if error
- Grey hints in brackets

## Visual Checklist

### Colors
- [ ] Orange headings everywhere
- [ ] Orange for selected/active items
- [ ] Orange borders for active operations
- [ ] Grey borders for passive panels
- [ ] Grey secondary text (counts, hints, metadata)
- [ ] Green only for success
- [ ] Red only for errors
- [ ] No cyan anywhere (replaced with orange)

### Symbols
- [ ] `✓` for success (not "OK")
- [ ] `✗` for errors (not "X")
- [ ] `⚠` for warnings (not "!")
- [ ] `▶` for selection (not ">")
- [ ] `•` for separators (not "|")
- [ ] `◐◓◑◒` animation (not "oOoO")
- [ ] `◉` for completion (not "!")

### Keyboard Controls
- [ ] Arrow keys work (↑↓)
- [ ] Vim keys work (j/k)
- [ ] `q` quits interactive views
- [ ] Enter selects
- [ ] Esc cancels
- [ ] Ctrl+C exits gracefully

### Layout
- [ ] Borders render correctly
- [ ] Text doesn't overflow
- [ ] Alignment is consistent
- [ ] Spacing looks clean
- [ ] Footer hints are visible
- [ ] No broken boxes or characters

## Known Issues to Watch For

1. **Empty array binding** - Fixed in database manager, but verify no SQLite errors
2. **Video count display** - Fixed in PlaylistPicker, verify shows correct counts
3. **Process exit** - Verify CLI exits cleanly (no hanging)
4. **Ink rendering** - Check for any flickering or broken layouts

## Test Results Template

```markdown
## Test Results - [Date]

### Scenario 1: Fresh Start
- [ ] Error message clear when not authenticated
- [ ] Init command works
- [ ] OAuth flow completes
- [ ] Colors/symbols correct

### Scenario 2: Playlist Discovery
- [ ] Interactive picker renders
- [ ] Arrow keys work
- [ ] Vim keys work
- [ ] Selection shows orange
- [ ] Video counts display
- [ ] Description shows
- [ ] Exit works (q)

### Scenario 3: Playlist Management
- [ ] List shows playlists
- [ ] Add works
- [ ] Remove works
- [ ] Colors/symbols correct

### Scenario 4: Video Extraction
- [ ] Progress display works
- [ ] Animation visible
- [ ] Status updates in real-time
- [ ] Counts update
- [ ] Whisper integration works
- [ ] Completes successfully
- [ ] Colors/symbols correct

### Scenario 5: Error Handling
- [ ] Invalid commands handled
- [ ] Invalid IDs handled
- [ ] Errors show suggestions
- [ ] Colors correct (red border)

### Scenario 6: Status Check
- [ ] All services checked
- [ ] Status symbols correct
- [ ] Colors correct
- [ ] Hints helpful

### Visual Check
- [ ] All orange/grey colors correct
- [ ] All unicode symbols render
- [ ] No cyan remaining
- [ ] Borders consistent
- [ ] Layout clean

### Issues Found
[List any bugs, visual issues, or UX problems]

### Overall Assessment
[Pass/Fail and notes]
```

## Quick Test Script

Create `test-full-workflow.bat`:

```batch
@echo off
echo ========================================
echo Phase 5 Full Integration Test
echo ========================================
echo.

echo Test 1: System Status
echo ----------------------------------------
npm run dev:init
pause

echo.
echo Test 2: Playlist Discovery (Interactive)
echo ----------------------------------------
echo Use arrows/vim keys to navigate, Enter to add, q to quit
npm run dev:discover
pause

echo.
echo Test 3: List Playlists
echo ----------------------------------------
npm run dev:list
pause

echo.
echo Test 4: Extract Videos
echo ----------------------------------------
echo Enter playlist ID to extract (or Ctrl+C to skip):
set /p PLAYLIST_ID=Playlist ID: 
if not "%PLAYLIST_ID%"=="" (
  npm run dev -- extract playlist %PLAYLIST_ID%
)
pause

echo.
echo ========================================
echo Integration test complete!
echo ========================================
```

## Next Steps After Testing

1. **Document issues** - Create list of bugs/improvements
2. **Fix critical bugs** - Anything that breaks workflow
3. **Polish UX** - Improve any rough edges
4. **Create completion report** - Document Phase 5 as done
5. **Move to Phase 6** - Report generation (HTML outputs)

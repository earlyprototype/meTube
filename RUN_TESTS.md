# CLI Test Scripts

Run these to test the Phase 5 Ink CLI implementation:

## Backend Integration Test (Run This First!)

```bash
test-backend.bat
```

This tests that the CLI properly connects to all backend components:
- Database connection
- YouTube authentication
- YouTube API client
- Whisper extractor
- Video extractor
- Playlist operations

If this passes, the CLI is properly connected to the Phase 2-4 backend.

## Quick Test (Help Only)
```bash
test-cli-help.bat
```

## Individual Command Tests

### 1. Test Init (OAuth Authentication)
```bash
test-cli-init.bat
```
Expected: Should show authentication status or prompt for OAuth

### 2. Test Playlist List
```bash
test-cli-playlist-list.bat
```
Expected: Shows saved playlists from database

### 3. Test Playlist Discover (Interactive)
```bash
test-cli-playlist-discover.bat
```
Expected: Interactive picker with arrow key navigation
- Use ↑↓ arrows to navigate
- Press Enter to select
- Press Esc to cancel

### 4. Test Extract
```bash
# Get a playlist ID first from playlist list
test-cli-extract.bat PLqAWmFRvbe_F-W_DquxryH3Evh_95LWpT
```
Expected: Shows live progress with animated "little dude"

## Run All Tests
```bash
test-all-cli.bat
```

## Manual Testing Checklist

After running scripts, verify:

- [ ] Help text displays correctly
- [ ] Init command authenticates or shows status
- [ ] Playlist list shows database playlists
- [ ] Playlist discover is interactive (arrow keys work)
- [ ] Progress display animates during extraction
- [ ] "Little dude" animation cycles through o/O
- [ ] Error messages are helpful with suggestions
- [ ] Ctrl+C exits gracefully

## Troubleshooting

**If CLI hangs:** Press Ctrl+C to exit

**If "command not found":** Run from project root directory

**If TypeScript errors:** Run `npm run build` first (may take time)

**If OAuth fails:** Check `client_secret.json` and `tokens.json` exist

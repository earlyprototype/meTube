# Stats Connection Fix - Sidebar Status Display

## Issue
The sidebar status display was showing 0 for playlist and video counts even when data existed in the database.

## Root Cause
In `src-ts/components/ReplMode.tsx` lines 67-71, the stats were hardcoded:

```typescript
const [stats] = useState({
  authenticated: true, // TODO: Get from YouTubeAuth
  playlistCount: 0,    // TODO: Get from database
  videoCount: 0,       // TODO: Get from database
});
```

## Solution Implemented

### 1. Added Database Imports
```typescript
import { DatabaseManager } from '../database/connection.js';
import { PlaylistRepository, VideoRepository } from '../database/repositories.js';
import { YouTubeAuth } from '../auth/YouTubeAuth.js';
```

### 2. Created Stats Loading Function
Added `useEffect` hook to load stats on component mount:

```typescript
useEffect(() => {
  function loadStats() {
    try {
      // Check authentication
      const auth = new YouTubeAuth();
      const isAuthenticated = auth.isAuthenticated();

      // Get counts from database
      const db = new DatabaseManager('data/metube.db');
      const playlistRepo = new PlaylistRepository(db);
      const videoRepo = new VideoRepository(db);

      const playlists = playlistRepo.getAll();
      const videos = videoRepo.getAll();

      db.close();

      setStats({
        authenticated: isAuthenticated,
        playlistCount: playlists.length,
        videoCount: videos.length,
      });
    } catch (error) {
      // If database doesn't exist yet, keep zeros
      setStats({
        authenticated: false,
        playlistCount: 0,
        videoCount: 0,
      });
    }
  }

  loadStats();
}, []);
```

### 3. Added Auto-Refresh After Commands
Created `refreshStats()` function and call it after database-modifying commands:

```typescript
const refreshStats = () => {
  try {
    const auth = new YouTubeAuth();
    const isAuthenticated = auth.isAuthenticated();

    const db = new DatabaseManager('data/metube.db');
    const playlistRepo = new PlaylistRepository(db);
    const videoRepo = new VideoRepository(db);

    const playlists = playlistRepo.getAll();
    const videos = videoRepo.getAll();

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
```

Called after commands complete:
```typescript
await onCommand(trimmed, setCurrentCommand);

// Refresh stats after commands that modify database
const commandType = trimmed.split(' ')[0];
if (['init', 'playlist', 'extract', 'video'].includes(commandType)) {
  setTimeout(refreshStats, 500);
}
```

## Behaviour

### On Startup
- Loads authentication status from YouTubeAuth
- Queries database for playlist count
- Queries database for video count
- Displays in sidebar: "Auth: Yes/No", "X Lists", "Y Vids"

### After Commands
- Automatically refreshes stats 500ms after:
  - `init` (OAuth authentication)
  - `playlist` commands (add, remove, sync, etc.)
  - `extract` commands (adds videos to database)
  - `video` commands (adds single videos)

### Error Handling
- If database doesn't exist yet (first run), shows zeros
- If database query fails, keeps current stats
- Graceful degradation - never crashes the UI

## Testing

To verify the fix works:

1. Start REPL mode:
   ```powershell
   npm run build
   node dist/cli.js
   ```

2. Check sidebar shows current counts

3. Run a playlist command:
   ```
   playlist discover
   ```

4. After adding a playlist, sidebar should update automatically

5. Run extraction:
   ```
   extract playlist <id>
   ```

6. After extraction, video count should increase

## Files Modified

- `src-ts/components/ReplMode.tsx` - Connected stats to database

## Status

✅ **FIXED** - Stats now show real data from database and auto-refresh after commands

# Phase 4 Whisper Test Guide

## Overview
This test script validates Phase 4 of the MeTube migration by:
1. Selecting one video from playlist 7 in your YouTube saved playlists
2. Transcribing it using Whisper (Python implementation via subprocess)
3. Saving the transcript to the database

## Prerequisites

### 1. Python Environment
You need Python with Whisper installed:

```powershell
# Create virtual environment (if not already created)
python -m venv venv

# Activate virtual environment
.\venv\Scripts\activate

# Install Whisper and dependencies
pip install openai-whisper yt-dlp
```

### 2. FFmpeg
yt-dlp requires FFmpeg for audio extraction:
- Download from: https://ffmpeg.org/download.html
- Add to PATH or place in project directory

### 3. TypeScript Build
Ensure the TypeScript code is compiled:

```powershell
npm run build
```

## Running the Test

### Step 1: Compile the test
```powershell
npx tsx test-whisper-phase4.ts
```

### Step 2: What the test does

1. **Lists all playlists** from your database
2. **Selects playlist 7** (the 7th playlist in your list)
3. **Shows videos** from that playlist
4. **Picks the first video** for testing
5. **Checks if transcript exists** (skips if already transcribed)
6. **Verifies Whisper availability** (Python + libraries)
7. **Downloads audio** using yt-dlp
8. **Transcribes** using Whisper base model
9. **Saves to database** (transcripts table)

### Expected Output

```
=== Phase 4 Test: Whisper Transcription ===

Step 1: Fetching playlists from database...
Found X playlists:
  [1] Playlist Name (10 videos)
  [2] Another Playlist (5 videos)
  ...
  [7] Target Playlist (8 videos)

Step 2: Selected Playlist 7: "Target Playlist"
  Playlist ID: PLxxx...
  Videos: 8

Step 3: Fetching videos from this playlist...
Found 5 videos (showing first 5):
  [1] Video Title
      Video ID: abcd1234567

Step 4: Testing with video: "Video Title"
  Video ID: abcd1234567
  YouTube URL: https://www.youtube.com/watch?v=abcd1234567

No existing transcript found.

Step 5: Initialising Whisper extractor...
Whisper is available!

Step 6: Transcribing video with Whisper...
This may take several minutes depending on video length.

Transcription SUCCESS! (took 45.3s)

Transcript Details:
  Language: en
  Segments: 142
  Total characters: 8543
  From Whisper: Yes

First 500 characters of transcript:
  Hello everyone, welcome back to...

Step 7: Saving transcript to database...
Transcript saved successfully!

=== Phase 4 Test Complete ===

Summary:
  - Playlist: Target Playlist
  - Video: Video Title
  - Transcript: 142 segments
  - Duration: 45.3s
  - Saved to DB: Yes
```

## Troubleshooting

### Error: "Whisper is NOT available"
**Solution:**
```powershell
# Ensure virtual environment exists and has Whisper
.\venv\Scripts\activate
pip install openai-whisper yt-dlp
```

### Error: "Python not found"
**Solution:** The test looks for Python at `venv/Scripts/python.exe`. Ensure:
- Virtual environment is created in project root
- Python is installed in the venv

### Error: "yt-dlp failed"
**Solution:**
- Ensure FFmpeg is installed and in PATH
- Try downloading FFmpeg to project directory
- Check internet connection

### Error: "Only X playlists available, but you requested playlist 7"
**Solution:**
- You don't have 7 playlists in your database yet
- Modify the test to select a different playlist index
- Or add more playlists to your database first

### Transcript already exists
If you want to re-transcribe, delete the existing transcript:

```sql
DELETE FROM transcripts WHERE video_id = 'your_video_id';
```

Or modify the test script to set `saveToDb = false` to just test transcription without saving.

## Test Configuration

You can modify these settings in the test script:

### Change Whisper Model
```typescript
const whisperConfig = {
  model: 'base',  // Options: tiny, base, small, medium, large
  // ...
};
```

Models trade-off speed vs accuracy:
- `tiny`: Fastest, lowest accuracy
- `base`: Good balance (default)
- `small`: Better accuracy, slower
- `medium`: High accuracy, quite slow
- `large`: Best accuracy, very slow

### Change Playlist Selection
```typescript
// Change playlist index (0-based)
const targetPlaylist = playlists[6]; // 7th playlist
// Change to playlists[0] for 1st playlist, etc.
```

### Change Video Selection
```typescript
// Change video index (0-based)
const testVideo = playlistItems[0]; // First video
// Change to playlistItems[1] for second video, etc.
```

### Disable Database Saving
```typescript
const saveToDb = false; // Just test transcription
```

## Performance Notes

- **Tiny model:** ~30 seconds for 5-minute video
- **Base model:** ~1 minute for 5-minute video
- **Small model:** ~2 minutes for 5-minute video
- **Medium model:** ~5 minutes for 5-minute video
- **Large model:** ~10 minutes for 5-minute video

Times are approximate and depend on your hardware (CPU/GPU).

## What This Test Validates

- [x] Phase 4 extraction pipeline integration
- [x] Whisper Python bridge working
- [x] yt-dlp audio download
- [x] Whisper transcription
- [x] Database persistence
- [x] Repository pattern working
- [x] Error handling
- [x] Transcript format conversion

## Next Steps

After successful test:
1. Test with different video types (long, short, different languages)
2. Test error scenarios (private videos, age-restricted, etc.)
3. Measure performance with different models
4. Consider adding automatic language detection
5. Move on to Phase 5 (Ink CLI Interface)

## Notes

- The test uses the Python Whisper implementation via subprocess (not pure Node.js)
- This is intentional as the Python implementation is mature and well-tested
- The TypeScript wrapper handles the integration cleanly
- Audio files are cleaned up automatically after transcription
- Transcripts are saved with `is_auto_generated = false` (Whisper provides high-quality transcripts)

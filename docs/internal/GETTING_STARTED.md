# Getting Started with YouTube Shorts Extractor

This guide will walk you through setting up and using the YouTube Shorts Extractor.

## Prerequisites

- Python 3.8 or higher
- Google Cloud account (for YouTube API)
- Google AI Studio account (for Gemini API)

## Installation

### Step 1: Install Dependencies

```powershell
# Create and activate virtual environment
python -m venv venv
.\venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Install the package in editable mode
pip install -e .
```

### Step 2: Get YouTube Data API Credentials

1. Go to https://console.cloud.google.com
2. Create a new project or select an existing one
3. Navigate to "APIs & Services" > "Library"
4. Search for "YouTube Data API v3" and enable it
5. Go to "APIs & Services" > "Credentials"
6. Click "Create Credentials" > "OAuth 2.0 Client ID"
7. Configure the OAuth consent screen (required for first-time setup)
8. Select "Desktop application" as the application type
9. Download the JSON file and save it as `client_secret.json` in the project root

### Step 3: Get Gemini API Key

1. Visit https://aistudio.google.com/app/apikey
2. Click "Create API Key"
3. Select your Google Cloud project (can be the same as YouTube API)
4. Copy the API key

### Step 4: Configure Environment

1. Copy `env.example` to `.env`:
```powershell
Copy-Item env.example .env
```

2. Edit `.env` and add your Gemini API key:
```
GEMINI_API_KEY=your_actual_api_key_here
```

### Step 5: Initialize the Application

```powershell
metube init
```

This will:
- Create the SQLite database
- Open a browser for YouTube OAuth authentication
- Verify your Gemini API key configuration

## Usage Examples

### Extract a Single Video

```powershell
# Extract video with full analysis
metube video add https://youtube.com/shorts/VIDEO_ID

# Skip transcript extraction
metube video add VIDEO_ID --no-transcript

# Skip LLM parsing (faster, but no entity extraction)
metube video add VIDEO_ID --no-llm
```

### Manage Playlists

```powershell
# Add a playlist to track
metube playlist add https://youtube.com/playlist?list=PLAYLIST_ID

# List all tracked playlists
metube playlist list

# Remove a playlist
metube playlist remove PLAYLIST_ID
```

### Extract Videos from Playlist

```powershell
# Extract all videos from a specific playlist
metube extract PLAYLIST_ID

# Only process new videos (skip existing)
metube extract PLAYLIST_ID --new-only

# Limit number of videos processed
metube extract PLAYLIST_ID --max-videos 10

# Extract from all tracked playlists
metube extract --all
```

### Generate Reports

```powershell
# Generate report for a single video (opens in browser)
metube report VIDEO_ID

# Generate reports for all videos in a playlist
metube report --playlist PLAYLIST_ID

# Generate reports for all videos in database
metube report --all
```

## Understanding the Workflow

### Typical Workflow

1. **Initial Setup** (one-time)
   ```powershell
   metube init
   ```

2. **Add Source** (playlist or individual videos)
   ```powershell
   metube playlist add PLAYLIST_URL
   # or
   metube video add VIDEO_URL
   ```

3. **Extract Data**
   ```powershell
   metube extract PLAYLIST_ID
   ```

4. **Generate Reports**
   ```powershell
   metube report --playlist PLAYLIST_ID
   ```

### What Happens During Extraction

For each video, the tool:

1. **Fetches metadata** from YouTube API
   - Title, channel, views, likes, duration, etc.
   - Saves to SQLite database

2. **Extracts transcript** (if available)
   - Uses youtube-transcript-api (no API quota used)
   - Supports multiple languages with fallback
   - Stores with timestamps

3. **Parses with Gemini AI**
   - Identifies topics discussed
   - Extracts GitHub repositories mentioned
   - Finds websites/links
   - Identifies people mentioned
   - Generates tags and summary
   - Saves all entities to database

4. **Generates HTML report**
   - Beautiful, self-contained HTML file
   - Dark/light mode toggle
   - Clickable timestamps in transcript
   - Hyperlinked entities

## Configuration

### Edit config/config.yaml

```yaml
api:
  gemini_model: gemini-1.5-flash  # Change to faster model
  rate_limit_delay: 0.5           # Increase delay if hitting rate limits

extraction:
  auto_transcript: false          # Disable automatic transcript extraction
  auto_llm_parse: false           # Disable automatic LLM parsing
  languages: [en, en-US, en-GB, es]  # Add more language preferences

reports:
  output_dir: my_reports/         # Change report output directory
```

## Troubleshooting

### "Authentication failed"

- Ensure `client_secret.json` exists in the project root
- Run `metube init --force` to re-authenticate
- Check that YouTube Data API v3 is enabled in Google Cloud Console

### "Gemini API key not set"

- Verify `GEMINI_API_KEY` is set in `.env` file
- Get a new API key from https://aistudio.google.com/app/apikey
- Ensure you're using the correct variable name (no spaces)

### "No transcript available"

- Not all videos have transcripts
- Use `--no-transcript` flag to skip transcript extraction
- Check if the video is private or age-restricted

### "Quota exceeded"

- YouTube API has a daily quota of 10,000 units
- Each video extraction uses approximately 2-3 units
- Wait until quota resets (midnight Pacific Time)
- Or request a quota increase in Google Cloud Console

### "Rate limit hit"

- Gemini free tier: 15 requests/minute, 1500/day
- Increase `rate_limit_delay` in config.yaml
- Consider upgrading to paid Gemini tier

## API Quota Management

### YouTube Data API Costs

- `playlistItems.list`: 1 unit per call (50 items)
- `videos.list`: 1 unit per call (50 video IDs)
- Daily quota: 10,000 units

### Gemini API Limits (Free Tier)

- 15 requests per minute
- 1,500 requests per day
- Consider batching extractions if hitting limits

## Advanced Usage

### Database Location

Default: `data/metube.db`

To use a different database:
```powershell
$env:DATABASE_PATH="path\to\custom.db"
metube init
```

### Custom Report Templates

1. Copy `templates/video_report.html`
2. Modify the HTML/CSS
3. Save with a new name
4. Update `config.yaml` to reference your template

### Exporting Data

The SQLite database can be queried directly:

```powershell
sqlite3 data/metube.db
```

```sql
-- Get all shorts with more than 100k views
SELECT title, channel_title, view_count 
FROM videos v
JOIN video_statistics vs ON v.video_id = vs.video_id
WHERE v.is_short = 1 AND vs.view_count > 100000
ORDER BY vs.view_count DESC;
```

## Next Steps

- Explore the generated HTML reports in the `reports/` directory
- Query the database for custom analysis
- Set up scheduled extractions with Windows Task Scheduler
- Contribute improvements on GitHub

## Support

If you encounter issues:
1. Check this guide first
2. Review error messages carefully
3. Verify API credentials and quotas
4. Check the logs in `logs/metube.log`

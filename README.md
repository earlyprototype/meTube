# MeTube - YouTube Content Extractor

A comprehensive CLI tool for extracting and analysing YouTube videos with dual-layer transcript extraction (YouTube + Whisper AI fallback), automatic entity parsing from transcripts and descriptions, cached playlist discovery, and beautiful interactive HTML reports.

## Features

- **Video & Playlist Extraction**: Add single videos or entire playlists by number, title, or URL
- **Smart Playlist Caching**: Discover and add playlists by number instead of long YouTube IDs
- **Dual Transcript Extraction**: 
  - Primary: YouTube's native captions (fast, free)
  - Fallback: Local Whisper AI transcription when YouTube transcripts unavailable
- **Description Parsing**: Automatic extraction of GitHub repos and websites from video descriptions
- **AI Entity Parsing**: Extract topics, GitHub repos, websites, people, and tags using Google Gemini
- **HTML Reports**: Generate beautiful, interactive HTML reports with dark/light mode
- **SQLite Database**: Store all data locally with historical tracking
- **Progress Tracking**: Visual progress indicators with Rich terminal output
- **Rate Limiting**: Built-in delays and retry logic to handle API limits gracefully

## Installation

### Prerequisites

- Python 3.8 or higher
- Google Cloud Project with YouTube Data API v3 enabled
- Google Gemini API key (optional, for AI entity parsing)
- FFmpeg (required for Whisper audio transcription)
  - Windows: `winget install ffmpeg` or download from https://ffmpeg.org
  - The Whisper model downloads automatically on first use (75-150MB depending on model size)

### Setup

1. Clone the repository:
```powershell
git clone <repository-url>
cd metube
```

2. Create and activate virtual environment:
```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
```

3. Install dependencies:
```powershell
pip install -r requirements.txt
```

4. Install the package:
```powershell
pip install -e .
```

5. Configure API credentials:
   - Copy `env.example` to `.env`
   - Add your `GEMINI_API_KEY` to `.env`
   - Download YouTube OAuth credentials as `client_secret.json`

6. Initialize the application:
```powershell
metube init
```

## Quick Start

### Discover your playlists
```powershell
metube playlist discover
```
This caches all your playlists with numbers for easy reference.

### Add playlists by number
```powershell
metube playlist add 6          # Add playlist #6 from cache
metube playlist add Ai         # Or search by title
```

### Extract videos from playlist
```powershell
metube extract 6               # Extract playlist #6
metube extract Ai              # Or by title
```

### View and report on videos
```powershell
metube playlist videos 6       # Show numbered list of videos in playlist #6
metube report 6 18             # Generate report for playlist #6, video #18
metube report -p 6             # Generate reports for all videos in playlist #6
metube report VIDEO_ID         # Report for single video by ID
```

## CLI Commands

### Setup
- `metube init` - Initial setup (OAuth + DB + config)

### Single Video Extraction
- `metube video add <URL_or_ID>` - Extract single video with full analysis
- `metube video add <URL> --no-transcript` - Skip transcript extraction
- `metube video add <URL> --no-llm` - Skip LLM parsing

### Playlist Discovery & Management
- `metube playlist discover` - Cache all your playlists with numbers
- `metube playlist discover -i` - Interactive mode to add multiple at once
- `metube playlist add 6` - Add playlist by cache number
- `metube playlist add "Ai"` - Add by title search
- `metube playlist add <URL>` - Add by full YouTube URL
- `metube playlist add-mine` - Auto-add all your playlists
- `metube playlist list` - Show tracked playlists
- `metube playlist remove <ID>` - Stop tracking

### Batch Extraction
- `metube extract 6` - Extract playlist by cache number (skips already extracted)
- `metube extract Ai` - Extract playlist by title
- `metube extract <playlist_ID>` - Extract by full YouTube playlist ID
- `metube extract --all` - Extract all tracked playlists
- `metube extract 6 --reprocess` - Force re-extract all videos (even if already extracted)
- `metube extract --max-videos 10` - Limit number of videos processed

### Report Generation
- `metube report <video_ID>` - Generate HTML report for single video
- `metube report -p 6` - Generate reports for playlist #6
- `metube report -p Ai` - Generate reports for playlist by title
- `metube report --all` - Generate reports for all videos

## Transcript Extraction

The tool uses a dual-layer approach for maximum transcript availability:

### 1. YouTube Transcript API (Primary)
- Fast and free
- No processing required
- Respects rate limits with automatic retry
- Works for most videos with captions

### 2. Whisper AI Fallback (Automatic)
When YouTube transcripts fail or are unavailable, Whisper automatically:
1. Downloads audio using yt-dlp (M4A format for speed)
2. Transcribes using OpenAI's Whisper model
3. Saves transcript to database
4. Cleans up temporary audio files

**Performance:**
- Shorts (< 1 min): ~30-60 seconds per video
- First run: +30 seconds to download Whisper model (one-time)
- Model sizes: `tiny` (fastest) to `large` (most accurate)

**Console indicators:**
- `[OK] Transcript extracted via YouTube` - Used YouTube captions
- `[OK] Transcript extracted via Whisper` - Used Whisper fallback

## Configuration

Edit `config/config.yaml` to customize:

### API Settings
- YouTube API credentials and token files
- Gemini model selection and API key
- Rate limiting delays and retry attempts

### Extraction Behaviour
- Auto-transcript and auto-LLM parsing toggles
- Preferred transcript languages
- Batch processing size

### Whisper Fallback
```yaml
extraction:
  whisper:
    enabled: true              # Enable/disable Whisper fallback
    model: base                # Model: tiny, base, small, medium, large
    audio_format: m4a          # Audio format: m4a, mp3, wav
    temp_dir: data/temp_audio/ # Temporary storage
    cleanup_audio: true        # Delete audio after transcription
```

### Report & Database
- Report output directory and templates
- Database path and backup settings

## API Keys Setup

### YouTube Data API v3
1. Go to https://console.cloud.google.com
2. Create/select a project
3. Enable YouTube Data API v3
4. Create OAuth 2.0 Client ID (Desktop application)
5. Download as `client_secret.json`

### Google Gemini API
1. Visit https://aistudio.google.com/app/apikey
2. Click "Create API Key"
3. Copy to `.env` as `GEMINI_API_KEY=your_key_here`

Free tier: 15 requests/minute, 1500 requests/day

## Project Structure

```
metube/
├── src/
│   ├── auth/              # OAuth authentication
│   ├── api/               # YouTube API client
│   ├── database/          # SQLAlchemy models and repository
│   ├── extractors/        # Video, transcript, and Whisper extraction
│   │   ├── video_extractor.py
│   │   ├── transcript_extractor.py
│   │   └── whisper_extractor.py    # NEW: Whisper AI fallback
│   ├── parsers/           # LLM and description parsing
│   │   ├── llm_parser.py
│   │   └── description_parser.py   # NEW: Extract repos from descriptions
│   ├── reports/           # HTML report generation
│   ├── export/            # Data export utilities
│   ├── analytics/         # Statistics and analysis
│   └── cli.py             # Click-based CLI
├── config/                # Configuration files
├── data/                  # SQLite database + playlist cache (gitignored)
│   ├── metube.db
│   ├── playlist_cache.json         # NEW: Cached playlist discovery
│   └── temp_audio/                 # NEW: Temporary Whisper audio files
├── reports/               # Generated HTML reports (gitignored)
├── templates/             # HTML templates
└── tests/                 # Unit tests
```

## Database Schema

- **Videos**: Core video metadata (title, description, duration, etc.)
- **Transcripts**: Full transcripts with timestamps (YouTube or Whisper)
- **ExtractedEntities**: AI-parsed entities
  - Topics and key concepts
  - GitHub repositories (from transcripts and descriptions)
  - Websites and resources (from transcripts and descriptions)
  - People and organizations
- **Tags**: Video categorization tags
- **Playlists**: Tracked playlists
- **PlaylistItems**: Video-playlist relationships
- **VideoStatistics**: Historical statistics tracking (views, likes, comments)
- **AIAnalysis**: Gemini-generated summaries and sentiment analysis
- **ExtractionJobs**: Batch processing job history

## Key Features Explained

### Playlist Discovery & Caching
Instead of copying long YouTube playlist IDs, use the discovery system:
1. Run `metube playlist discover` once
2. Playlists are cached with numbers (1-N)
3. Use numbers everywhere: `metube playlist add 6`, `metube extract 6`, `metube report -p 6`
4. Or search by title: `metube extract "Ai"` finds playlists matching "Ai"

### Automatic Entity Extraction
The tool extracts valuable information from multiple sources:
- **From Transcripts** (via Gemini AI): Topics, people, concepts, detailed analysis
- **From Descriptions** (via regex parsing): GitHub repos, websites, direct links
- **From Metadata**: Tags, statistics, publishing information

This means even videos without transcripts can still capture GitHub repositories and websites mentioned in their descriptions.

### HTML Reports
Each report includes:
- Video metadata and statistics
- Embedded video player link
- Full transcript with timestamps (if available)
- Clickable GitHub repos and websites
- AI-generated summary and tags
- Dark/light mode toggle
- Search-friendly format

## Troubleshooting

### "Too Many Requests" Error
The YouTube Transcript API has rate limits. The tool handles this automatically:
- 2-second delays between requests
- Automatic retry with exponential backoff
- Whisper fallback when rate limited
- Slow down batch processing if needed

### Whisper Model Download
On first use, Whisper downloads its model (75-150MB). This is one-time and automatic.

### FFmpeg Not Found
Whisper requires FFmpeg for audio processing:
- Windows: `winget install ffmpeg`
- Or download from https://ffmpeg.org and add to PATH

### Gemini API Errors
If you see "API key not valid":
1. Get a free key from https://aistudio.google.com/app/apikey
2. Add to `.env` file as `GEMINI_API_KEY=your_key_here`
3. LLM parsing is optional - description parsing still works without it

## License

MIT License

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

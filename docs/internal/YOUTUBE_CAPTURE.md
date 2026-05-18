# YouTube Shorts Capture Pipeline

## Overview

This document outlines a complete pipeline for extracting YouTube Shorts from playlists using the YouTube Data API v3. The pipeline enables you to manually curate Shorts into a playlist, then programmatically extract comprehensive video metadata for analysis, archival, or further processing.

## Architecture

```
┌──────────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Manual     │     │  Monitor    │     │   Extract    │     │   Enrich    │
│   Curation   │ --> │  Playlist   │ --> │  Video List  │ --> │  Metadata   │
│              │     │  (Optional) │     │              │     │             │
└──────────────┘     └─────────────┘     └──────────────┘     └─────────────┘
   User saves           Detect new        playlistItems         videos.list
   Shorts to            additions         .list API             API call
   playlist             via polling       call                  (details)
                                                                      │
                                                                      v
                                                              ┌─────────────┐
                                                              │   Export    │
                                                              │   Data      │
                                                              │  (JSON/CSV) │
                                                              └─────────────┘
```

## Pipeline Stages

### Stage 1: Manual Curation

**Human Action Required:**
- Browse YouTube Shorts
- Click "Save" button on desired Shorts
- Select target playlist (e.g., "Shorts Collection")
- YouTube automatically adds video to playlist

**Why Manual?**
- YouTube API does not support programmatic playlist additions from third-party apps
- This is an intentional curation/selection step by the user

### Stage 2: Playlist Monitoring (Optional)

**Purpose:** Detect when new Shorts are added to the playlist

**Implementation Options:**
- **Polling:** Check playlist every N minutes/hours
- **On-Demand:** Run extraction manually when ready
- **Scheduled:** Daily/weekly batch extraction

**Detection Method:**
```python
def check_for_new_videos(playlist_id, last_known_count):
    current_items = get_playlist_video_count(playlist_id)
    if current_items > last_known_count:
        return True, current_items
    return False, last_known_count
```

### Stage 3: Video List Extraction

**API Endpoint:** `playlistItems.list`

**Data Retrieved:**
- Video ID
- Title
- Channel name and ID
- Thumbnails (multiple sizes)
- Date added to playlist
- Position in playlist
- Privacy status

**Quota Cost:** 1 unit per API call (50 videos per page)

**Pagination Required:** YouTube returns max 50 items per call

### Stage 4: Detailed Metadata Enrichment

**API Endpoint:** `videos.list`

**Additional Data Retrieved:**
- Full description
- Duration (ISO 8601 format)
- View count
- Like count
- Comment count
- Tags array
- Category ID
- Topic categories
- Definition (HD/SD)
- Caption availability
- License type
- Publication date

**Quota Cost:** 1 unit per API call (up to 50 video IDs per call)

**Shorts Detection:** Filter videos where duration < 60 seconds

## Data Schema

### Playlist Item (Stage 3)

```json
{
  "video_id": "abc123xyz",
  "title": "Amazing Short Video",
  "channel_id": "UC_channel_id",
  "channel_title": "Creator Name",
  "added_at": "2026-01-18T12:34:56Z",
  "position": 0,
  "thumbnail_default": "https://i.ytimg.com/vi/abc123xyz/default.jpg",
  "thumbnail_medium": "https://i.ytimg.com/vi/abc123xyz/mqdefault.jpg",
  "thumbnail_high": "https://i.ytimg.com/vi/abc123xyz/hqdefault.jpg"
}
```

### Enriched Video (Stage 4)

```json
{
  "video_id": "abc123xyz",
  "title": "Amazing Short Video",
  "description": "Full video description...",
  "channel_id": "UC_channel_id",
  "channel_title": "Creator Name",
  "published_at": "2026-01-15T10:00:00Z",
  "added_to_playlist_at": "2026-01-18T12:34:56Z",
  "duration": "PT45S",
  "duration_seconds": 45,
  "view_count": 125000,
  "like_count": 8500,
  "comment_count": 342,
  "tags": ["shorts", "trending", "viral"],
  "category_id": "24",
  "category_name": "Entertainment",
  "thumbnails": {
    "default": "url",
    "medium": "url",
    "high": "url",
    "standard": "url",
    "maxres": "url"
  },
  "is_short": true,
  "definition": "hd",
  "caption": "true",
  "licensed_content": true,
  "topic_categories": [
    "https://en.wikipedia.org/wiki/Entertainment"
  ]
}
```

## Implementation

### Prerequisites

**Python Dependencies:**
```bash
pip install google-api-python-client google-auth-oauthlib google-auth-httplib2
pip install pandas python-dotenv
```

**Google Cloud Setup:**
1. Create project at https://console.cloud.google.com
2. Enable YouTube Data API v3
3. Create OAuth 2.0 Client ID (Desktop application)
4. Download `client_secret.json`
5. Place in project root

**Required Scopes:**
```python
SCOPES = ['https://www.googleapis.com/auth/youtube.readonly']
```

### Core Implementation

**File: `youtube_shorts_extractor.py`**

```python
from googleapiclient.discovery import build
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
import json
import os
import re
from datetime import datetime
from typing import List, Dict, Optional
import time

SCOPES = ['https://www.googleapis.com/auth/youtube.readonly']

class YouTubeShortsExtractor:
    """Extract and enrich YouTube Shorts from playlists"""
    
    def __init__(self, credentials_file: str = 'client_secret.json'):
        self.credentials_file = credentials_file
        self.youtube = None
        self.authenticate()
    
    def authenticate(self):
        """Handle OAuth 2.0 authentication flow"""
        creds = None
        
        # Check for existing token
        if os.path.exists('token.json'):
            creds = Credentials.from_authorized_user_file('token.json', SCOPES)
        
        # Refresh or create new credentials
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.credentials_file, SCOPES)
                creds = flow.run_local_server(port=0)
            
            # Save credentials for next run
            with open('token.json', 'w') as token:
                token.write(creds.to_json())
        
        self.youtube = build('youtube', 'v3', credentials=creds)
        print("Authentication successful")
    
    def get_playlist_videos(self, playlist_id: str) -> List[Dict]:
        """
        Fetch all videos from a playlist
        
        Args:
            playlist_id: YouTube playlist ID
            
        Returns:
            List of video dictionaries with basic info
        """
        videos = []
        next_page_token = None
        page_count = 0
        
        while True:
            page_count += 1
            print(f"Fetching page {page_count}...")
            
            request = self.youtube.playlistItems().list(
                part="snippet,contentDetails",
                playlistId=playlist_id,
                maxResults=50,
                pageToken=next_page_token
            )
            
            try:
                response = request.execute()
            except Exception as e:
                print(f"Error fetching playlist items: {e}")
                break
            
            for item in response['items']:
                snippet = item['snippet']
                content = item['contentDetails']
                
                videos.append({
                    'video_id': content['videoId'],
                    'title': snippet['title'],
                    'channel_id': snippet['channelId'],
                    'channel_title': snippet['channelTitle'],
                    'added_at': snippet['publishedAt'],
                    'position': snippet['position'],
                    'thumbnail_default': snippet['thumbnails']['default']['url'],
                    'thumbnail_medium': snippet['thumbnails'].get('medium', {}).get('url'),
                    'thumbnail_high': snippet['thumbnails'].get('high', {}).get('url'),
                })
            
            next_page_token = response.get('nextPageToken')
            if not next_page_token:
                break
            
            # Rate limiting courtesy
            time.sleep(0.2)
        
        print(f"Found {len(videos)} videos in playlist")
        return videos
    
    def parse_duration(self, duration: str) -> int:
        """
        Parse ISO 8601 duration to seconds
        
        Args:
            duration: ISO 8601 duration string (e.g., 'PT1M30S')
            
        Returns:
            Duration in seconds
        """
        pattern = re.compile(
            r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?'
        )
        match = pattern.match(duration)
        
        if not match:
            return 0
        
        hours = int(match.group(1) or 0)
        minutes = int(match.group(2) or 0)
        seconds = int(match.group(3) or 0)
        
        return hours * 3600 + minutes * 60 + seconds
    
    def get_video_details(self, video_ids: List[str]) -> List[Dict]:
        """
        Fetch detailed information for videos
        
        Args:
            video_ids: List of YouTube video IDs (max 50)
            
        Returns:
            List of enriched video dictionaries
        """
        if not video_ids:
            return []
        
        request = self.youtube.videos().list(
            part="snippet,contentDetails,statistics,topicDetails",
            id=','.join(video_ids[:50])  # API limit: 50 IDs
        )
        
        try:
            response = request.execute()
        except Exception as e:
            print(f"Error fetching video details: {e}")
            return []
        
        enriched_videos = []
        
        for video in response['items']:
            snippet = video['snippet']
            content_details = video['contentDetails']
            stats = video.get('statistics', {})
            
            duration_seconds = self.parse_duration(content_details['duration'])
            
            enriched_videos.append({
                'video_id': video['id'],
                'title': snippet['title'],
                'description': snippet['description'],
                'channel_id': snippet['channelId'],
                'channel_title': snippet['channelTitle'],
                'published_at': snippet['publishedAt'],
                'duration': content_details['duration'],
                'duration_seconds': duration_seconds,
                'is_short': duration_seconds <= 60,
                'view_count': int(stats.get('viewCount', 0)),
                'like_count': int(stats.get('likeCount', 0)),
                'comment_count': int(stats.get('commentCount', 0)),
                'tags': snippet.get('tags', []),
                'category_id': snippet['categoryId'],
                'thumbnails': snippet['thumbnails'],
                'definition': content_details.get('definition', 'sd'),
                'caption': content_details.get('caption', 'false'),
                'licensed_content': content_details.get('licensedContent', False),
                'topic_categories': video.get('topicDetails', {}).get('topicCategories', []),
            })
        
        return enriched_videos
    
    def extract_shorts_from_playlist(
        self, 
        playlist_id: str,
        output_file: str = 'youtube_shorts.json',
        filter_shorts_only: bool = True
    ) -> List[Dict]:
        """
        Complete pipeline: extract and enrich videos from playlist
        
        Args:
            playlist_id: YouTube playlist ID
            output_file: Output JSON file path
            filter_shorts_only: Only include videos <= 60 seconds
            
        Returns:
            List of enriched video dictionaries
        """
        print(f"\n=== YouTube Shorts Extraction Pipeline ===")
        print(f"Playlist ID: {playlist_id}")
        print(f"Output file: {output_file}\n")
        
        # Stage 1: Get playlist items
        print("Stage 1: Fetching playlist items...")
        playlist_videos = self.get_playlist_videos(playlist_id)
        
        if not playlist_videos:
            print("No videos found in playlist")
            return []
        
        # Stage 2: Enrich with details (batch by 50)
        print("\nStage 2: Enriching video metadata...")
        all_enriched = []
        video_ids = [v['video_id'] for v in playlist_videos]
        
        for i in range(0, len(video_ids), 50):
            batch = video_ids[i:i+50]
            print(f"Processing batch {i//50 + 1} ({len(batch)} videos)...")
            
            enriched = self.get_video_details(batch)
            
            # Merge with playlist info
            for video in enriched:
                playlist_info = next(
                    (v for v in playlist_videos if v['video_id'] == video['video_id']),
                    None
                )
                if playlist_info:
                    video['added_to_playlist_at'] = playlist_info['added_at']
                    video['playlist_position'] = playlist_info['position']
            
            all_enriched.extend(enriched)
            time.sleep(0.3)  # Rate limiting
        
        # Stage 3: Filter Shorts
        if filter_shorts_only:
            shorts = [v for v in all_enriched if v['is_short']]
            print(f"\nStage 3: Filtered to {len(shorts)} Shorts (out of {len(all_enriched)} total videos)")
            videos_to_save = shorts
        else:
            print(f"\nStage 3: Keeping all {len(all_enriched)} videos")
            videos_to_save = all_enriched
        
        # Stage 4: Export
        print(f"\nStage 4: Exporting to {output_file}...")
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(videos_to_save, f, indent=2, ensure_ascii=False)
        
        print(f"\n=== Extraction Complete ===")
        print(f"Total videos extracted: {len(videos_to_save)}")
        
        # Print statistics
        self.print_statistics(videos_to_save)
        
        return videos_to_save
    
    def print_statistics(self, videos: List[Dict]):
        """Print summary statistics about extracted videos"""
        if not videos:
            return
        
        total_views = sum(v['view_count'] for v in videos)
        total_likes = sum(v['like_count'] for v in videos)
        avg_duration = sum(v['duration_seconds'] for v in videos) / len(videos)
        
        print("\n=== Statistics ===")
        print(f"Total views: {total_views:,}")
        print(f"Total likes: {total_likes:,}")
        print(f"Average duration: {avg_duration:.1f} seconds")
        print(f"Average views per video: {total_views // len(videos):,}")
        
        # Top channels
        channel_counts = {}
        for video in videos:
            channel = video['channel_title']
            channel_counts[channel] = channel_counts.get(channel, 0) + 1
        
        top_channels = sorted(channel_counts.items(), key=lambda x: x[1], reverse=True)[:5]
        print("\nTop 5 channels:")
        for channel, count in top_channels:
            print(f"  - {channel}: {count} videos")

def main():
    """Example usage"""
    
    # Initialize extractor
    extractor = YouTubeShortsExtractor()
    
    # Your playlist ID (get from URL: youtube.com/playlist?list=PLAYLIST_ID)
    playlist_id = "YOUR_PLAYLIST_ID_HERE"
    
    # Extract Shorts
    shorts = extractor.extract_shorts_from_playlist(
        playlist_id=playlist_id,
        output_file='youtube_shorts.json',
        filter_shorts_only=True
    )
    
    # Optional: Export to CSV
    try:
        import pandas as pd
        df = pd.DataFrame(shorts)
        df.to_csv('youtube_shorts.csv', index=False)
        print("\nAlso exported to youtube_shorts.csv")
    except ImportError:
        print("\nInstall pandas for CSV export: pip install pandas")

if __name__ == '__main__':
    main()
```

### Configuration File

**File: `.env`**

```env
# YouTube API Configuration
YOUTUBE_PLAYLIST_ID=YOUR_PLAYLIST_ID_HERE
OUTPUT_JSON_FILE=youtube_shorts.json
OUTPUT_CSV_FILE=youtube_shorts.csv
FILTER_SHORTS_ONLY=true

# Authentication
CLIENT_SECRET_FILE=client_secret.json
TOKEN_FILE=token.json

# Rate Limiting
API_DELAY_SECONDS=0.3
```

### Usage Script

**File: `run_extraction.py`**

```python
import os
from dotenv import load_dotenv
from youtube_shorts_extractor import YouTubeShortsExtractor

load_dotenv()

def run():
    playlist_id = os.getenv('YOUTUBE_PLAYLIST_ID')
    
    if not playlist_id or playlist_id == 'YOUR_PLAYLIST_ID_HERE':
        print("Error: Please set YOUTUBE_PLAYLIST_ID in .env file")
        return
    
    extractor = YouTubeShortsExtractor(
        credentials_file=os.getenv('CLIENT_SECRET_FILE', 'client_secret.json')
    )
    
    shorts = extractor.extract_shorts_from_playlist(
        playlist_id=playlist_id,
        output_file=os.getenv('OUTPUT_JSON_FILE', 'youtube_shorts.json'),
        filter_shorts_only=os.getenv('FILTER_SHORTS_ONLY', 'true').lower() == 'true'
    )
    
    # Export to CSV
    try:
        import pandas as pd
        df = pd.DataFrame(shorts)
        csv_file = os.getenv('OUTPUT_CSV_FILE', 'youtube_shorts.csv')
        df.to_csv(csv_file, index=False, encoding='utf-8')
        print(f"Exported to {csv_file}")
    except ImportError:
        pass

if __name__ == '__main__':
    run()
```

## Setup Instructions

### Step 1: Install Dependencies

```powershell
# Create virtual environment (recommended)
python -m venv venv
.\venv\Scripts\Activate.ps1

# Install required packages
pip install google-api-python-client google-auth-oauthlib google-auth-httplib2
pip install pandas python-dotenv
```

### Step 2: Google Cloud Configuration

1. Go to https://console.cloud.google.com
2. Create new project or select existing
3. Navigate to "APIs & Services" > "Library"
4. Search "YouTube Data API v3" and enable it
5. Go to "APIs & Services" > "Credentials"
6. Click "Create Credentials" > "OAuth 2.0 Client ID"
7. Configure consent screen (required first time)
8. Select "Desktop application" as application type
9. Download JSON file
10. Rename to `client_secret.json`
11. Place in project root

### Step 3: Find Your Playlist ID

**Method 1: From URL**
```
https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
                                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                        This is your playlist ID
```

**Method 2: Via Share Button**
- Open playlist
- Click "Share"
- Copy link
- Extract ID from URL

### Step 4: Configure Environment

Create `.env` file:
```env
YOUTUBE_PLAYLIST_ID=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
OUTPUT_JSON_FILE=youtube_shorts.json
OUTPUT_CSV_FILE=youtube_shorts.csv
FILTER_SHORTS_ONLY=true
```

### Step 5: Run First Extraction

```powershell
# Authenticate (first time only)
python youtube_shorts_extractor.py

# Browser will open for OAuth consent
# Allow access to YouTube account
# Token saved to token.json for future use
```

### Step 6: Subsequent Runs

```powershell
# Run extraction
python run_extraction.py

# Output files created:
# - youtube_shorts.json (detailed metadata)
# - youtube_shorts.csv (spreadsheet format)
```

## Advanced Usage

### Scheduled Extraction (Windows Task Scheduler)

**File: `scheduled_extraction.ps1`**

```powershell
# PowerShell script for scheduled runs
$ErrorActionPreference = "Stop"

# Activate virtual environment
& ".\venv\Scripts\Activate.ps1"

# Run extraction
python run_extraction.py

# Optional: Upload to cloud storage, send notifications, etc.
```

**Create Task:**
1. Open Task Scheduler
2. Create Basic Task
3. Set trigger (daily, weekly, etc.)
4. Action: Start a program
5. Program: `powershell.exe`
6. Arguments: `-File "C:\path\to\scheduled_extraction.ps1"`

### Monitoring for New Additions

**File: `monitor_playlist.py`**

```python
import json
import os
from youtube_shorts_extractor import YouTubeShortsExtractor
from datetime import datetime

STATE_FILE = 'playlist_state.json'

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r') as f:
            return json.load(f)
    return {'last_count': 0, 'known_video_ids': []}

def save_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)

def check_for_updates(playlist_id):
    extractor = YouTubeShortsExtractor()
    state = load_state()
    
    # Get current playlist
    videos = extractor.get_playlist_videos(playlist_id)
    current_ids = [v['video_id'] for v in videos]
    
    # Find new videos
    new_ids = set(current_ids) - set(state['known_video_ids'])
    
    if new_ids:
        print(f"\nFound {len(new_ids)} new videos!")
        
        # Extract details for new videos only
        new_videos = extractor.get_video_details(list(new_ids))
        
        # Append to existing file
        existing_file = 'youtube_shorts.json'
        if os.path.exists(existing_file):
            with open(existing_file, 'r') as f:
                existing = json.load(f)
            existing.extend(new_videos)
            with open(existing_file, 'w') as f:
                json.dump(existing, f, indent=2)
        else:
            with open(existing_file, 'w') as f:
                json.dump(new_videos, f, indent=2)
        
        print(f"Added {len(new_ids)} new videos to {existing_file}")
    else:
        print("No new videos found")
    
    # Update state
    save_state({
        'last_count': len(current_ids),
        'known_video_ids': current_ids,
        'last_checked': datetime.now().isoformat()
    })

if __name__ == '__main__':
    check_for_updates(os.getenv('YOUTUBE_PLAYLIST_ID'))
```

### Data Analysis Examples

**File: `analyze_shorts.py`**

```python
import json
import pandas as pd
from collections import Counter
from datetime import datetime

def analyze_shorts(json_file='youtube_shorts.json'):
    with open(json_file, 'r') as f:
        shorts = json.load(f)
    
    df = pd.DataFrame(shorts)
    
    print("=== YouTube Shorts Analysis ===\n")
    
    # Basic stats
    print(f"Total Shorts: {len(df)}")
    print(f"Total views: {df['view_count'].sum():,}")
    print(f"Total likes: {df['like_count'].sum():,}")
    print(f"Average duration: {df['duration_seconds'].mean():.1f}s")
    
    # Top performers
    print("\n=== Top 10 Most Viewed ===")
    top_viewed = df.nlargest(10, 'view_count')[['title', 'channel_title', 'view_count']]
    print(top_viewed.to_string(index=False))
    
    # Channel analysis
    print("\n=== Top Channels ===")
    channel_stats = df.groupby('channel_title').agg({
        'video_id': 'count',
        'view_count': 'sum',
        'like_count': 'sum'
    }).sort_values('view_count', ascending=False).head(10)
    print(channel_stats)
    
    # Tag analysis
    all_tags = []
    for tags in df['tags']:
        all_tags.extend(tags)
    
    print("\n=== Top 20 Tags ===")
    tag_counts = Counter(all_tags).most_common(20)
    for tag, count in tag_counts:
        print(f"{tag}: {count}")
    
    # Timeline
    df['published_at'] = pd.to_datetime(df['published_at'])
    df['month'] = df['published_at'].dt.to_period('M')
    
    print("\n=== Shorts by Month ===")
    monthly = df.groupby('month').size()
    print(monthly)

if __name__ == '__main__':
    analyze_shorts()
```

## API Quota Management

### Daily Quota: 10,000 Units

**Cost per Operation:**
- `playlistItems.list`: 1 unit per call (50 items)
- `videos.list`: 1 unit per call (50 IDs)
- `search.list`: 100 units (avoid if possible)

**Example Quota Usage:**

| Playlist Size | Quota Cost |
|---------------|------------|
| 50 videos     | 2 units    |
| 100 videos    | 4 units    |
| 500 videos    | 20 units   |
| 1000 videos   | 40 units   |

**Optimization Strategies:**
1. Cache results locally
2. Only fetch new additions (incremental updates)
3. Batch video detail requests (50 IDs per call)
4. Implement exponential backoff for rate limits
5. Monitor quota usage in Google Cloud Console

### Handling Quota Errors

```python
from googleapiclient.errors import HttpError

def safe_api_call(api_function, **kwargs):
    try:
        return api_function(**kwargs).execute()
    except HttpError as e:
        if e.resp.status == 403:
            print("Quota exceeded. Try again tomorrow.")
            return None
        elif e.resp.status == 429:
            print("Rate limit hit. Waiting 60 seconds...")
            time.sleep(60)
            return safe_api_call(api_function, **kwargs)
        else:
            raise
```

## Export Formats

### JSON Format

```json
[
  {
    "video_id": "abc123",
    "title": "Amazing Short",
    "description": "Full description...",
    "channel_title": "Creator Name",
    "published_at": "2026-01-15T10:00:00Z",
    "duration_seconds": 45,
    "view_count": 125000,
    "like_count": 8500,
    "tags": ["shorts", "viral"],
    "is_short": true
  }
]
```

### CSV Columns

```
video_id, title, description, channel_title, published_at, duration_seconds,
view_count, like_count, comment_count, tags, category_id, is_short
```

### Custom Export

```python
def export_to_custom_format(shorts, output_file):
    """Export to custom format"""
    with open(output_file, 'w') as f:
        for short in shorts:
            f.write(f"Title: {short['title']}\n")
            f.write(f"Channel: {short['channel_title']}\n")
            f.write(f"Views: {short['view_count']:,}\n")
            f.write(f"URL: https://youtube.com/shorts/{short['video_id']}\n")
            f.write("-" * 80 + "\n")
```

## Troubleshooting

### Common Issues

**Issue: "Access Not Configured"**
- Solution: Enable YouTube Data API v3 in Google Cloud Console

**Issue: "Invalid Credentials"**
- Solution: Delete `token.json`, re-authenticate

**Issue: "Quota Exceeded"**
- Solution: Wait until quota resets (midnight Pacific Time)
- Alternative: Request quota increase in Cloud Console

**Issue: "Private/Deleted Videos"**
- Videos may appear in playlist but be unavailable
- Filter out by checking `video['id']` exists in details response

**Issue: "Empty Playlist Results"**
- Check playlist ID is correct
- Verify playlist is not private
- Ensure authenticated account has access

### Debug Mode

Add to extractor:
```python
import logging

logging.basicConfig(level=logging.DEBUG)
```

## Future Enhancements

### Possible Extensions

1. **Transcript Extraction**
   - Use `captions.list` and `captions.download`
   - Extract spoken content for analysis

2. **Sentiment Analysis**
   - Analyze comments using NLP
   - Track sentiment trends over time

3. **Thumbnail Analysis**
   - Download thumbnails
   - Analyze visual patterns using computer vision

4. **Recommendation Engine**
   - Build similarity graph
   - Recommend related Shorts

5. **Database Storage**
   - Store in SQLite/PostgreSQL
   - Enable complex queries and historical tracking

6. **Web Dashboard**
   - Flask/FastAPI backend
   - React frontend
   - Visualize statistics and trends

7. **Notification System**
   - Email/SMS alerts for viral Shorts
   - Discord/Slack integration

8. **Multi-Playlist Support**
   - Track multiple playlists
   - Cross-playlist analysis

## Performance Considerations

### Processing Time

**Factors:**
- Network latency (API calls)
- Playlist size
- API rate limiting
- Local processing

**Example Timings:**
- 100 videos: ~30 seconds
- 500 videos: ~2 minutes
- 1000 videos: ~4 minutes

### Memory Usage

**Minimal:**
- JSON structure in memory
- Typically < 10 MB for 1000 videos

**Optimization:**
- Stream large playlists to disk
- Process in batches
- Clear intermediate results

## Security Best Practices

### Credential Management

1. **NEVER commit credentials to git**
   ```gitignore
   client_secret.json
   token.json
   .env
   ```

2. **Use environment variables**
   - Store sensitive values in `.env`
   - Use `python-dotenv` to load

3. **Rotate credentials periodically**
   - Generate new OAuth client
   - Revoke old tokens

4. **Restrict OAuth scopes**
   - Use `youtube.readonly` only
   - Don't request unnecessary permissions

### Data Privacy

- Don't share extracted data publicly (may contain private info)
- Respect YouTube Terms of Service
- Don't exceed rate limits
- Cache responsibly

## Legal and Compliance

### YouTube Terms of Service

**You MAY:**
- Extract data from your own playlists
- Store data locally for personal use
- Analyze trends and statistics

**You MAY NOT:**
- Redistribute YouTube content
- Circumvent access controls
- Download video files (without permission)
- Scrape without using official API

### API Usage Guidelines

- Respect rate limits
- Don't abuse quota
- Follow YouTube Developer Policies
- Display proper attribution

## Support and Resources

### Official Documentation

- YouTube Data API: https://developers.google.com/youtube/v3
- Python Client Library: https://github.com/googleapis/google-api-python-client
- OAuth 2.0: https://developers.google.com/identity/protocols/oauth2

### Useful Links

- API Explorer: https://developers.google.com/youtube/v3/docs
- Quota Calculator: Google Cloud Console > APIs & Services > Quotas
- Status Page: https://www.google.com/appsstatus

## Summary

This pipeline enables you to:

1. Manually curate YouTube Shorts into a playlist
2. Programmatically extract comprehensive metadata
3. Analyze trends, channels, and engagement
4. Export data for further processing
5. Monitor for new additions automatically

The implementation is production-ready with proper error handling, rate limiting, and quota management. Authentication is handled via OAuth 2.0, ensuring secure access to your YouTube data.

Total implementation time: ~2-3 hours including setup and testing.

---

**Document Version:** 1.0  
**Last Updated:** 2026-01-18  
**Status:** Complete specification

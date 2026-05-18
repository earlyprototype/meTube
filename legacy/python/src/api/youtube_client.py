"""YouTube Data API v3 client wrapper"""
import time
import re
from typing import List, Dict, Optional
from googleapiclient.errors import HttpError

from ..auth.oauth_handler import YouTubeAuthHandler


class YouTubeClient:
    """Wrapper for YouTube Data API v3"""
    
    def __init__(self, auth_handler: YouTubeAuthHandler, rate_limit_delay: float = 0.3):
        """
        Initialize YouTube client
        
        Args:
            auth_handler: Authenticated YouTubeAuthHandler instance
            rate_limit_delay: Delay between API calls in seconds
        """
        self.auth_handler = auth_handler
        self.service = auth_handler.get_service()
        self.rate_limit_delay = rate_limit_delay
        
        if not self.service:
            raise ValueError("YouTube service not initialized. Ensure authentication is successful.")
    
    def _rate_limit(self):
        """Apply rate limiting delay"""
        time.sleep(self.rate_limit_delay)
    
    @staticmethod
    def extract_video_id(url_or_id: str) -> Optional[str]:
        """
        Extract video ID from URL or return as-is if already an ID
        
        Args:
            url_or_id: YouTube URL or video ID
            
        Returns:
            Video ID or None if invalid
        """
        # If it's already an ID (11 characters, alphanumeric)
        if re.match(r'^[a-zA-Z0-9_-]{11}$', url_or_id):
            return url_or_id
        
        # Extract from various URL formats
        patterns = [
            r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)([a-zA-Z0-9_-]{11})',
            r'youtube\.com/embed/([a-zA-Z0-9_-]{11})',
            r'youtube\.com/v/([a-zA-Z0-9_-]{11})'
        ]
        
        for pattern in patterns:
            match = re.search(pattern, url_or_id)
            if match:
                return match.group(1)
        
        return None
    
    @staticmethod
    def extract_playlist_id(url_or_id: str) -> Optional[str]:
        """
        Extract playlist ID from URL or return as-is if already an ID
        
        Args:
            url_or_id: YouTube playlist URL or ID
            
        Returns:
            Playlist ID or None if invalid
        """
        # If it's already an ID (starts with PL or contains valid characters)
        if re.match(r'^[a-zA-Z0-9_-]+$', url_or_id) and len(url_or_id) > 10:
            return url_or_id
        
        # Extract from URL
        match = re.search(r'[?&]list=([a-zA-Z0-9_-]+)', url_or_id)
        if match:
            return match.group(1)
        
        return None
    
    @staticmethod
    def parse_duration(duration: str) -> int:
        """
        Parse ISO 8601 duration to seconds
        
        Args:
            duration: ISO 8601 duration string (e.g., 'PT1M30S')
            
        Returns:
            Duration in seconds
        """
        pattern = re.compile(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?')
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
            List of video dictionaries with detailed metadata
        """
        if not video_ids:
            return []
        
        # Limit to 50 IDs per API call
        video_ids = video_ids[:50]
        
        try:
            request = self.service.videos().list(
                part="snippet,contentDetails,statistics,topicDetails",
                id=','.join(video_ids)
            )
            response = request.execute()
            self._rate_limit()
        except HttpError as e:
            print(f"Error fetching video details: {e}")
            return []
        
        enriched_videos = []
        
        for video in response.get('items', []):
            snippet = video['snippet']
            content_details = video['contentDetails']
            stats = video.get('statistics', {})
            
            duration_seconds = self.parse_duration(content_details['duration'])
            
            video_data = {
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
                'caption': content_details.get('caption', 'false') == 'true',
                'licensed_content': content_details.get('licensedContent', False),
                'topic_categories': video.get('topicDetails', {}).get('topicCategories', []),
            }
            enriched_videos.append(video_data)
        
        return enriched_videos
    
    def get_single_video(self, video_id: str) -> Optional[Dict]:
        """
        Fetch details for a single video
        
        Args:
            video_id: YouTube video ID
            
        Returns:
            Video dictionary or None if not found
        """
        results = self.get_video_details([video_id])
        return results[0] if results else None
    
    def get_playlist_videos(self, playlist_id: str, max_results: int = None) -> List[Dict]:
        """
        Fetch all videos from a playlist
        
        Args:
            playlist_id: YouTube playlist ID
            max_results: Maximum number of videos to fetch (None for all)
            
        Returns:
            List of video dictionaries with basic info
        """
        videos = []
        next_page_token = None
        page_count = 0
        
        while True:
            page_count += 1
            
            try:
                request = self.service.playlistItems().list(
                    part="snippet,contentDetails",
                    playlistId=playlist_id,
                    maxResults=50,
                    pageToken=next_page_token
                )
                response = request.execute()
                self._rate_limit()
            except HttpError as e:
                print(f"Error fetching playlist items (page {page_count}): {e}")
                break
            
            for item in response.get('items', []):
                snippet = item['snippet']
                content = item['contentDetails']
                
                video_data = {
                    'video_id': content['videoId'],
                    'title': snippet['title'],
                    'channel_id': snippet['channelId'],
                    'channel_title': snippet['channelTitle'],
                    'added_at': snippet['publishedAt'],
                    'position': snippet['position'],
                    'thumbnail_default': snippet['thumbnails']['default']['url'],
                    'thumbnail_medium': snippet['thumbnails'].get('medium', {}).get('url'),
                    'thumbnail_high': snippet['thumbnails'].get('high', {}).get('url'),
                }
                videos.append(video_data)
                
                if max_results and len(videos) >= max_results:
                    return videos
            
            next_page_token = response.get('nextPageToken')
            if not next_page_token:
                break
        
        return videos
    
    def get_playlist_info(self, playlist_id: str) -> Optional[Dict]:
        """
        Get playlist metadata
        
        Args:
            playlist_id: YouTube playlist ID
            
        Returns:
            Dictionary with playlist info or None if not found
        """
        try:
            request = self.service.playlists().list(
                part="snippet,contentDetails",
                id=playlist_id
            )
            response = request.execute()
            self._rate_limit()
            
            if 'items' in response and len(response['items']) > 0:
                item = response['items'][0]
                snippet = item['snippet']
                content_details = item['contentDetails']
                
                return {
                    'playlist_id': playlist_id,
                    'title': snippet['title'],
                    'description': snippet.get('description', ''),
                    'channel_id': snippet['channelId'],
                    'channel_title': snippet['channelTitle'],
                    'published_at': snippet['publishedAt'],
                    'video_count': content_details['itemCount'],
                    'thumbnails': snippet['thumbnails']
                }
            return None
        except HttpError as e:
            print(f"Error fetching playlist info: {e}")
            return None
    
    def get_my_playlists(self) -> List[Dict]:
        """
        Get all playlists from authenticated user's account
        
        Returns:
            List of playlist dictionaries with metadata
        """
        playlists = []
        next_page_token = None
        
        while True:
            try:
                request = self.service.playlists().list(
                    part="snippet,contentDetails",
                    mine=True,
                    maxResults=50,
                    pageToken=next_page_token
                )
                response = request.execute()
                self._rate_limit()
                
                for item in response.get('items', []):
                    snippet = item['snippet']
                    content_details = item['contentDetails']
                    
                    playlist_data = {
                        'playlist_id': item['id'],
                        'title': snippet['title'],
                        'description': snippet.get('description', ''),
                        'channel_id': snippet['channelId'],
                        'channel_title': snippet['channelTitle'],
                        'published_at': snippet['publishedAt'],
                        'video_count': content_details['itemCount'],
                        'privacy_status': snippet.get('privacyStatus', 'unknown'),
                        'thumbnails': snippet.get('thumbnails', {})
                    }
                    playlists.append(playlist_data)
                
                next_page_token = response.get('nextPageToken')
                if not next_page_token:
                    break
            
            except HttpError as e:
                print(f"Error fetching playlists: {e}")
                break
        
        return playlists
    
    def search_videos(
        self,
        query: str,
        max_results: int = 50,
        video_type: str = 'any'
    ) -> List[str]:
        """
        Search for videos (note: expensive quota cost of 100 units)
        
        Args:
            query: Search query
            max_results: Maximum number of results
            video_type: 'short' for shorts only, 'any' for all
            
        Returns:
            List of video IDs
        """
        video_ids = []
        
        try:
            request = self.service.search().list(
                part="id",
                q=query,
                type="video",
                maxResults=min(max_results, 50),
                videoDuration='short' if video_type == 'short' else 'any'
            )
            response = request.execute()
            self._rate_limit()
            
            for item in response.get('items', []):
                if item['id']['kind'] == 'youtube#video':
                    video_ids.append(item['id']['videoId'])
        except HttpError as e:
            print(f"Error searching videos: {e}")
        
        return video_ids

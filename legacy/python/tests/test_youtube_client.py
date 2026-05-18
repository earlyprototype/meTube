"""Tests for YouTube API client"""
import pytest
from src.api.youtube_client import YouTubeClient


class TestYouTubeClient:
    """Test YouTubeClient functionality"""
    
    def test_extract_video_id_from_short_url(self):
        """Test extracting video ID from shorts URL"""
        url = "https://youtube.com/shorts/dQw4w9WgXcQ"
        video_id = YouTubeClient.extract_video_id(url)
        assert video_id == "dQw4w9WgXcQ"
    
    def test_extract_video_id_from_watch_url(self):
        """Test extracting video ID from watch URL"""
        url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        video_id = YouTubeClient.extract_video_id(url)
        assert video_id == "dQw4w9WgXcQ"
    
    def test_extract_video_id_from_youtu_be_url(self):
        """Test extracting video ID from youtu.be URL"""
        url = "https://youtu.be/dQw4w9WgXcQ"
        video_id = YouTubeClient.extract_video_id(url)
        assert video_id == "dQw4w9WgXcQ"
    
    def test_extract_video_id_from_plain_id(self):
        """Test handling plain video ID"""
        video_id_input = "dQw4w9WgXcQ"
        video_id = YouTubeClient.extract_video_id(video_id_input)
        assert video_id == "dQw4w9WgXcQ"
    
    def test_extract_playlist_id_from_url(self):
        """Test extracting playlist ID from URL"""
        url = "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
        playlist_id = YouTubeClient.extract_playlist_id(url)
        assert playlist_id == "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
    
    def test_parse_duration_minutes_seconds(self):
        """Test parsing ISO 8601 duration with minutes and seconds"""
        duration = "PT1M30S"
        seconds = YouTubeClient.parse_duration(duration)
        assert seconds == 90
    
    def test_parse_duration_seconds_only(self):
        """Test parsing ISO 8601 duration with seconds only"""
        duration = "PT45S"
        seconds = YouTubeClient.parse_duration(duration)
        assert seconds == 45
    
    def test_parse_duration_hours_minutes_seconds(self):
        """Test parsing ISO 8601 duration with hours, minutes, and seconds"""
        duration = "PT1H2M30S"
        seconds = YouTubeClient.parse_duration(duration)
        assert seconds == 3750

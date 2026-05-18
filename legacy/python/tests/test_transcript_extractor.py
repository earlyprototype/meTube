"""Tests for transcript extractor"""
import pytest
from src.extractors.transcript_extractor import TranscriptExtractor


class TestTranscriptExtractor:
    """Test TranscriptExtractor functionality"""
    
    def test_format_timestamp_minutes_seconds(self):
        """Test timestamp formatting for minutes and seconds"""
        extractor = TranscriptExtractor()
        timestamp = extractor._format_timestamp(90.5)
        assert timestamp == "01:30"
    
    def test_format_timestamp_hours_minutes_seconds(self):
        """Test timestamp formatting for hours, minutes, and seconds"""
        extractor = TranscriptExtractor()
        timestamp = extractor._format_timestamp(3665.0)
        assert timestamp == "01:01:05"
    
    def test_format_timestamp_seconds_only(self):
        """Test timestamp formatting for seconds only"""
        extractor = TranscriptExtractor()
        timestamp = extractor._format_timestamp(45.0)
        assert timestamp == "00:45"
    
    def test_generate_youtube_timestamp_url(self):
        """Test generating YouTube URL with timestamp"""
        url = TranscriptExtractor.generate_youtube_timestamp_url('test123', 90.5)
        assert url == "https://youtube.com/watch?v=test123&t=90s"
    
    def test_get_transcript_stats_empty(self):
        """Test transcript stats for empty transcript"""
        extractor = TranscriptExtractor()
        stats = extractor.get_transcript_stats(None)
        
        assert stats['word_count'] == 0
        assert stats['char_count'] == 0
        assert stats['segment_count'] == 0
    
    def test_get_transcript_stats_with_data(self):
        """Test transcript stats with actual data"""
        extractor = TranscriptExtractor()
        
        transcript_data = {
            'full_text': 'This is a test transcript with some words',
            'segments': [
                {'start': 0.0, 'duration': 2.0, 'text': 'This is'},
                {'start': 2.0, 'duration': 2.0, 'text': 'a test'},
                {'start': 4.0, 'duration': 3.0, 'text': 'transcript with some words'}
            ],
            'language': 'en',
            'is_auto_generated': True
        }
        
        stats = extractor.get_transcript_stats(transcript_data)
        
        assert stats['word_count'] == 8
        assert stats['segment_count'] == 3
        assert stats['language'] == 'en'
        assert stats['is_auto_generated'] is True

"""Tests for database models and repository"""
import pytest
from datetime import datetime
from src.database.connection import DatabaseManager
from src.database.models import Video, Transcript, ExtractedEntity, Tag
from src.database.repository import (
    VideoRepository,
    TranscriptRepository,
    EntityRepository,
    TagRepository
)


@pytest.fixture
def db_manager():
    """Create a test database manager"""
    db = DatabaseManager(':memory:')  # Use in-memory SQLite database
    db.create_tables()
    return db


def test_create_video(db_manager):
    """Test creating a video record"""
    with db_manager.get_session() as session:
        video_data = {
            'video_id': 'test123',
            'title': 'Test Video',
            'description': 'Test description',
            'channel_id': 'UC_test',
            'channel_title': 'Test Channel',
            'published_at': datetime.now(),
            'duration': 'PT45S',
            'duration_seconds': 45,
            'is_short': True,
            'category_id': '24'
        }
        
        video = VideoRepository.create_or_update(session, video_data)
        
        assert video.video_id == 'test123'
        assert video.title == 'Test Video'
        assert video.is_short is True


def test_get_video_by_id(db_manager):
    """Test retrieving a video by ID"""
    with db_manager.get_session() as session:
        # Create video
        video_data = {
            'video_id': 'test456',
            'title': 'Another Test',
            'description': 'Description',
            'channel_id': 'UC_test',
            'channel_title': 'Test Channel',
            'published_at': datetime.now(),
            'duration': 'PT1M30S',
            'duration_seconds': 90,
            'is_short': False,
            'category_id': '24'
        }
        VideoRepository.create_or_update(session, video_data)
    
    with db_manager.get_session() as session:
        # Retrieve video
        video = VideoRepository.get_by_video_id(session, 'test456')
        
        assert video is not None
        assert video.video_id == 'test456'
        assert video.title == 'Another Test'


def test_create_transcript(db_manager):
    """Test creating a transcript"""
    with db_manager.get_session() as session:
        # First create a video
        video_data = {
            'video_id': 'test789',
            'title': 'Video with Transcript',
            'description': 'Description',
            'channel_id': 'UC_test',
            'channel_title': 'Test Channel',
            'published_at': datetime.now(),
            'duration': 'PT45S',
            'duration_seconds': 45,
            'is_short': True,
            'category_id': '24'
        }
        VideoRepository.create_or_update(session, video_data)
        
        # Create transcript
        transcript_data = {
            'language': 'en',
            'full_text': 'This is a test transcript.',
            'segments': [
                {'start': 0.0, 'duration': 2.0, 'text': 'This is'},
                {'start': 2.0, 'duration': 2.0, 'text': 'a test transcript.'}
            ],
            'is_auto_generated': False
        }
        
        transcript = TranscriptRepository.create(session, 'test789', transcript_data)
        
        assert transcript.video_id == 'test789'
        assert transcript.language == 'en'
        assert 'test transcript' in transcript.full_text


def test_add_entities(db_manager):
    """Test adding entities"""
    with db_manager.get_session() as session:
        # Create video
        video_data = {
            'video_id': 'test_entities',
            'title': 'Video with Entities',
            'description': 'Description',
            'channel_id': 'UC_test',
            'channel_title': 'Test Channel',
            'published_at': datetime.now(),
            'duration': 'PT45S',
            'duration_seconds': 45,
            'is_short': True,
            'category_id': '24'
        }
        VideoRepository.create_or_update(session, video_data)
        
        # Add entities
        entities = [
            {'type': 'topic', 'value': 'Python', 'url': None, 'confidence': 95},
            {'type': 'github_repo', 'value': 'test-repo', 'url': 'https://github.com/test/repo', 'confidence': 90}
        ]
        
        created_entities = EntityRepository.add_entities(session, 'test_entities', entities)
        
        assert len(created_entities) == 2
        assert created_entities[0].entity_type == 'topic'
        assert created_entities[1].entity_type == 'github_repo'


def test_add_tags_to_video(db_manager):
    """Test adding tags to a video"""
    with db_manager.get_session() as session:
        # Create video
        video_data = {
            'video_id': 'test_tags',
            'title': 'Video with Tags',
            'description': 'Description',
            'channel_id': 'UC_test',
            'channel_title': 'Test Channel',
            'published_at': datetime.now(),
            'duration': 'PT45S',
            'duration_seconds': 45,
            'is_short': True,
            'category_id': '24'
        }
        VideoRepository.create_or_update(session, video_data)
        
        # Add tags
        tags = ['python', 'tutorial', 'beginner']
        TagRepository.add_tags_to_video(session, 'test_tags', tags)
    
    with db_manager.get_session() as session:
        video = VideoRepository.get_by_video_id(session, 'test_tags')
        tag_names = [tag.tag for tag in video.tags]
        
        assert len(tag_names) == 3
        assert 'python' in tag_names
        assert 'tutorial' in tag_names

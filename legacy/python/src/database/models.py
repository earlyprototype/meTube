"""SQLAlchemy database models"""
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, Boolean, DateTime, 
    ForeignKey, Table, UniqueConstraint, Index
)
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.sql import func

Base = declarative_base()


# Association table for video tags (many-to-many)
video_tags = Table(
    'video_tags',
    Base.metadata,
    Column('video_id', String, ForeignKey('videos.video_id', ondelete='CASCADE'), primary_key=True),
    Column('tag_id', Integer, ForeignKey('tags.id', ondelete='CASCADE'), primary_key=True)
)


class Video(Base):
    """Core video metadata"""
    __tablename__ = 'videos'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(String(20), unique=True, nullable=False, index=True)
    title = Column(String(500), nullable=False)
    description = Column(Text)
    channel_id = Column(String(50), nullable=False, index=True)
    channel_title = Column(String(200), nullable=False)
    published_at = Column(DateTime, nullable=False)
    duration = Column(String(20), nullable=False)  # ISO 8601 format
    duration_seconds = Column(Integer, nullable=False)
    is_short = Column(Boolean, nullable=False, default=False, index=True)
    category_id = Column(String(10))
    category_name = Column(String(100))
    definition = Column(String(10))  # 'hd' or 'sd'
    caption = Column(Boolean, default=False)
    licensed_content = Column(Boolean, default=False)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    
    # Relationships
    transcript = relationship("Transcript", back_populates="video", uselist=False, cascade="all, delete-orphan")
    statistics = relationship("VideoStatistic", back_populates="video", cascade="all, delete-orphan")
    entities = relationship("ExtractedEntity", back_populates="video", cascade="all, delete-orphan")
    tags = relationship("Tag", secondary=video_tags, back_populates="videos")
    playlist_items = relationship("PlaylistItem", back_populates="video", cascade="all, delete-orphan")
    
    def __repr__(self):
        return f"<Video(video_id='{self.video_id}', title='{self.title[:50]}')>"


class VideoStatistic(Base):
    """Historical statistics tracking"""
    __tablename__ = 'video_statistics'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(String(20), ForeignKey('videos.video_id', ondelete='CASCADE'), nullable=False, index=True)
    view_count = Column(Integer, default=0)
    like_count = Column(Integer, default=0)
    comment_count = Column(Integer, default=0)
    recorded_at = Column(DateTime, default=func.now(), index=True)
    
    # Relationships
    video = relationship("Video", back_populates="statistics")
    
    def __repr__(self):
        return f"<VideoStatistic(video_id='{self.video_id}', views={self.view_count})>"


class Transcript(Base):
    """Video transcripts with timestamps"""
    __tablename__ = 'transcripts'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(String(20), ForeignKey('videos.video_id', ondelete='CASCADE'), unique=True, nullable=False)
    language = Column(String(10), nullable=False)
    full_text = Column(Text, nullable=False)
    segments_json = Column(Text)  # JSON array of {text, start, duration}
    is_auto_generated = Column(Boolean, default=True)
    extracted_at = Column(DateTime, default=func.now())
    
    # Relationships
    video = relationship("Video", back_populates="transcript")
    
    # Full-text search index
    __table_args__ = (
        Index('ix_transcripts_fulltext', 'full_text', postgresql_using='gin'),
    )
    
    def __repr__(self):
        return f"<Transcript(video_id='{self.video_id}', language='{self.language}')>"


class ExtractedEntity(Base):
    """Entities extracted from transcripts via LLM"""
    __tablename__ = 'extracted_entities'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(String(20), ForeignKey('videos.video_id', ondelete='CASCADE'), nullable=False, index=True)
    entity_type = Column(String(50), nullable=False, index=True)  # 'topic', 'repo', 'website', 'person'
    entity_value = Column(String(500), nullable=False)
    entity_url = Column(String(1000))  # For repos and websites
    confidence = Column(Integer, default=100)  # 0-100
    extracted_at = Column(DateTime, default=func.now())
    
    # Relationships
    video = relationship("Video", back_populates="entities")
    
    __table_args__ = (
        Index('ix_entities_type_value', 'entity_type', 'entity_value'),
    )
    
    def __repr__(self):
        return f"<ExtractedEntity(type='{self.entity_type}', value='{self.entity_value}')>"


class Tag(Base):
    """Normalized tags for categorization"""
    __tablename__ = 'tags'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    tag = Column(String(100), unique=True, nullable=False, index=True)
    created_at = Column(DateTime, default=func.now())
    
    # Relationships
    videos = relationship("Video", secondary=video_tags, back_populates="tags")
    
    def __repr__(self):
        return f"<Tag(tag='{self.tag}')>"


class Playlist(Base):
    """Tracked playlists"""
    __tablename__ = 'playlists'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    playlist_id = Column(String(50), unique=True, nullable=False, index=True)
    title = Column(String(500), nullable=False)
    description = Column(Text)
    last_checked = Column(DateTime)
    video_count = Column(Integer, default=0)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    
    # Relationships
    playlist_items = relationship("PlaylistItem", back_populates="playlist", cascade="all, delete-orphan")
    extraction_jobs = relationship("ExtractionJob", back_populates="playlist", cascade="all, delete-orphan")
    
    def __repr__(self):
        return f"<Playlist(playlist_id='{self.playlist_id}', title='{self.title[:50]}')>"


class PlaylistItem(Base):
    """Many-to-many relationship between playlists and videos"""
    __tablename__ = 'playlist_items'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    playlist_id = Column(String(50), ForeignKey('playlists.playlist_id', ondelete='CASCADE'), nullable=False)
    video_id = Column(String(20), ForeignKey('videos.video_id', ondelete='CASCADE'), nullable=False)
    position = Column(Integer)
    added_at = Column(DateTime, nullable=False)
    
    # Relationships
    playlist = relationship("Playlist", back_populates="playlist_items")
    video = relationship("Video", back_populates="playlist_items")
    
    __table_args__ = (
        UniqueConstraint('playlist_id', 'video_id', name='uix_playlist_video'),
        Index('ix_playlist_items_playlist', 'playlist_id'),
        Index('ix_playlist_items_video', 'video_id'),
    )
    
    def __repr__(self):
        return f"<PlaylistItem(playlist='{self.playlist_id}', video='{self.video_id}')>"


class ExtractionJob(Base):
    """Audit trail for extraction jobs"""
    __tablename__ = 'extraction_jobs'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    playlist_id = Column(String(50), ForeignKey('playlists.playlist_id', ondelete='CASCADE'))
    job_type = Column(String(50), nullable=False)  # 'playlist', 'video', 'update'
    status = Column(String(20), nullable=False, default='pending')  # 'pending', 'running', 'completed', 'failed'
    videos_found = Column(Integer, default=0)
    videos_processed = Column(Integer, default=0)
    new_videos = Column(Integer, default=0)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    error_message = Column(Text)
    
    # Relationships
    playlist = relationship("Playlist", back_populates="extraction_jobs")
    
    __table_args__ = (
        Index('ix_jobs_status', 'status'),
        Index('ix_jobs_started', 'started_at'),
    )
    
    def __repr__(self):
        return f"<ExtractionJob(id={self.id}, status='{self.status}')>"


class AIAnalysis(Base):
    """AI-generated analysis and summaries"""
    __tablename__ = 'ai_analysis'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(String(20), ForeignKey('videos.video_id', ondelete='CASCADE'), unique=True, nullable=False)
    summary = Column(Text)  # Brief summary
    key_points = Column(Text)  # JSON array of key points
    sentiment = Column(String(20))  # 'positive', 'negative', 'neutral'
    content_type = Column(String(50))  # 'tutorial', 'review', 'entertainment', etc.
    model_used = Column(String(50))  # 'gemini-1.5-pro'
    analyzed_at = Column(DateTime, default=func.now())
    
    def __repr__(self):
        return f"<AIAnalysis(video_id='{self.video_id}')>"

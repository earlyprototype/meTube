"""Repository pattern for database operations"""
from typing import List, Optional, Dict
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import desc, func
import json

from .models import (
    Video, VideoStatistic, Transcript, ExtractedEntity,
    Tag, Playlist, PlaylistItem, ExtractionJob, AIAnalysis
)


class VideoRepository:
    """Repository for Video operations"""
    
    @staticmethod
    def create_or_update(session: Session, video_data: Dict) -> Video:
        """Create new video or update if exists"""
        video = session.query(Video).filter_by(video_id=video_data['video_id']).first()
        
        if video:
            # Update existing video
            for key, value in video_data.items():
                if hasattr(video, key):
                    setattr(video, key, value)
            video.updated_at = datetime.now()
        else:
            # Create new video
            video = Video(**video_data)
            session.add(video)
        
        session.flush()
        return video
    
    @staticmethod
    def get_by_video_id(session: Session, video_id: str) -> Optional[Video]:
        """Get video by video_id"""
        return session.query(Video).filter_by(video_id=video_id).first()
    
    @staticmethod
    def get_all(session: Session, shorts_only: bool = False) -> List[Video]:
        """Get all videos, optionally filtering for shorts"""
        query = session.query(Video)
        if shorts_only:
            query = query.filter_by(is_short=True)
        return query.all()
    
    @staticmethod
    def get_by_channel(session: Session, channel_id: str) -> List[Video]:
        """Get all videos from a channel"""
        return session.query(Video).filter_by(channel_id=channel_id).all()
    
    @staticmethod
    def search(session: Session, query_text: str) -> List[Video]:
        """Search videos by title or description"""
        search_pattern = f"%{query_text}%"
        return session.query(Video).filter(
            (Video.title.like(search_pattern)) | 
            (Video.description.like(search_pattern))
        ).all()


class StatisticsRepository:
    """Repository for VideoStatistic operations"""
    
    @staticmethod
    def add_snapshot(session: Session, video_id: str, stats: Dict) -> VideoStatistic:
        """Add a statistics snapshot"""
        stat = VideoStatistic(
            video_id=video_id,
            view_count=stats.get('view_count', 0),
            like_count=stats.get('like_count', 0),
            comment_count=stats.get('comment_count', 0),
            recorded_at=datetime.now()
        )
        session.add(stat)
        session.flush()
        return stat
    
    @staticmethod
    def get_history(session: Session, video_id: str) -> List[VideoStatistic]:
        """Get all statistics snapshots for a video"""
        return session.query(VideoStatistic)\
            .filter_by(video_id=video_id)\
            .order_by(VideoStatistic.recorded_at)\
            .all()
    
    @staticmethod
    def get_latest(session: Session, video_id: str) -> Optional[VideoStatistic]:
        """Get latest statistics for a video"""
        return session.query(VideoStatistic)\
            .filter_by(video_id=video_id)\
            .order_by(desc(VideoStatistic.recorded_at))\
            .first()


class TranscriptRepository:
    """Repository for Transcript operations"""
    
    @staticmethod
    def create(session: Session, video_id: str, transcript_data: Dict) -> Transcript:
        """Create or replace transcript"""
        # Delete existing
        session.query(Transcript).filter_by(video_id=video_id).delete()
        
        # Create new
        transcript = Transcript(
            video_id=video_id,
            language=transcript_data.get('language', 'en'),
            full_text=transcript_data['full_text'],
            segments_json=json.dumps(transcript_data.get('segments', [])),
            is_auto_generated=transcript_data.get('is_auto_generated', True),
            extracted_at=datetime.now()
        )
        session.add(transcript)
        session.flush()
        return transcript
    
    @staticmethod
    def get_by_video_id(session: Session, video_id: str) -> Optional[Transcript]:
        """Get transcript for a video"""
        return session.query(Transcript).filter_by(video_id=video_id).first()
    
    @staticmethod
    def exists(session: Session, video_id: str) -> bool:
        """Check if transcript exists for video"""
        return session.query(Transcript).filter_by(video_id=video_id).count() > 0


class EntityRepository:
    """Repository for ExtractedEntity operations"""
    
    @staticmethod
    def add_entities(session: Session, video_id: str, entities: List[Dict]) -> List[ExtractedEntity]:
        """Add multiple entities for a video"""
        entity_objects = []
        for entity_data in entities:
            entity = ExtractedEntity(
                video_id=video_id,
                entity_type=entity_data['type'],
                entity_value=entity_data['value'],
                entity_url=entity_data.get('url'),
                confidence=entity_data.get('confidence', 100),
                extracted_at=datetime.now()
            )
            session.add(entity)
            entity_objects.append(entity)
        
        session.flush()
        return entity_objects
    
    @staticmethod
    def get_by_video(session: Session, video_id: str, entity_type: str = None) -> List[ExtractedEntity]:
        """Get entities for a video, optionally filtered by type"""
        query = session.query(ExtractedEntity).filter_by(video_id=video_id)
        if entity_type:
            query = query.filter_by(entity_type=entity_type)
        return query.all()
    
    @staticmethod
    def delete_by_video(session: Session, video_id: str):
        """Delete all entities for a video"""
        session.query(ExtractedEntity).filter_by(video_id=video_id).delete()


class TagRepository:
    """Repository for Tag operations"""
    
    @staticmethod
    def get_or_create(session: Session, tag_name: str) -> Tag:
        """Get existing tag or create new one"""
        tag = session.query(Tag).filter_by(tag=tag_name.lower()).first()
        if not tag:
            tag = Tag(tag=tag_name.lower())
            session.add(tag)
            session.flush()
        return tag
    
    @staticmethod
    def add_tags_to_video(session: Session, video_id: str, tag_names: List[str]):
        """Add tags to a video"""
        video = session.query(Video).filter_by(video_id=video_id).first()
        if video:
            for tag_name in tag_names:
                tag = TagRepository.get_or_create(session, tag_name)
                if tag not in video.tags:
                    video.tags.append(tag)
            session.flush()


class PlaylistRepository:
    """Repository for Playlist operations"""
    
    @staticmethod
    def create_or_update(session: Session, playlist_data: Dict) -> Playlist:
        """Create new playlist or update if exists"""
        playlist = session.query(Playlist).filter_by(
            playlist_id=playlist_data['playlist_id']
        ).first()
        
        if playlist:
            for key, value in playlist_data.items():
                if hasattr(playlist, key):
                    setattr(playlist, key, value)
            playlist.updated_at = datetime.now()
        else:
            playlist = Playlist(**playlist_data)
            session.add(playlist)
        
        session.flush()
        return playlist
    
    @staticmethod
    def get_by_id(session: Session, playlist_id: str) -> Optional[Playlist]:
        """Get playlist by ID"""
        return session.query(Playlist).filter_by(playlist_id=playlist_id).first()
    
    @staticmethod
    def get_all(session: Session, enabled_only: bool = True) -> List[Playlist]:
        """Get all playlists"""
        query = session.query(Playlist)
        if enabled_only:
            query = query.filter_by(enabled=True)
        return query.all()
    
    @staticmethod
    def delete(session: Session, playlist_id: str):
        """Delete a playlist"""
        session.query(Playlist).filter_by(playlist_id=playlist_id).delete()


class PlaylistItemRepository:
    """Repository for PlaylistItem operations"""
    
    @staticmethod
    def add_video_to_playlist(
        session: Session,
        playlist_id: str,
        video_id: str,
        position: int = None,
        added_at: datetime = None
    ) -> PlaylistItem:
        """Add video to playlist if not already present"""
        item = session.query(PlaylistItem).filter_by(
            playlist_id=playlist_id,
            video_id=video_id
        ).first()
        
        if not item:
            item = PlaylistItem(
                playlist_id=playlist_id,
                video_id=video_id,
                position=position,
                added_at=added_at or datetime.now()
            )
            session.add(item)
            session.flush()
        
        return item
    
    @staticmethod
    def get_videos_in_playlist(session: Session, playlist_id: str) -> List[str]:
        """Get list of video IDs in a playlist"""
        items = session.query(PlaylistItem)\
            .filter_by(playlist_id=playlist_id)\
            .order_by(PlaylistItem.position)\
            .all()
        return [item.video_id for item in items]
    
    @staticmethod
    def get_items_with_videos(session: Session, playlist_id: str) -> List[PlaylistItem]:
        """Get playlist items with video objects loaded"""
        from sqlalchemy.orm import joinedload
        items = session.query(PlaylistItem)\
            .filter_by(playlist_id=playlist_id)\
            .options(joinedload(PlaylistItem.video))\
            .order_by(PlaylistItem.position)\
            .all()
        return items


class ExtractionJobRepository:
    """Repository for ExtractionJob operations"""
    
    @staticmethod
    def create(session: Session, job_data: Dict) -> ExtractionJob:
        """Create a new extraction job"""
        job = ExtractionJob(**job_data, started_at=datetime.now())
        session.add(job)
        session.flush()
        return job
    
    @staticmethod
    def update_status(
        session: Session,
        job_id: int,
        status: str,
        **kwargs
    ) -> ExtractionJob:
        """Update job status and other fields"""
        job = session.query(ExtractionJob).filter_by(id=job_id).first()
        if job:
            job.status = status
            for key, value in kwargs.items():
                if hasattr(job, key):
                    setattr(job, key, value)
            if status == 'completed':
                job.completed_at = datetime.now()
            session.flush()
        return job
    
    @staticmethod
    def get_recent(session: Session, limit: int = 10) -> List[ExtractionJob]:
        """Get recent extraction jobs"""
        return session.query(ExtractionJob)\
            .order_by(desc(ExtractionJob.started_at))\
            .limit(limit)\
            .all()


class AIAnalysisRepository:
    """Repository for AIAnalysis operations"""
    
    @staticmethod
    def create_or_update(session: Session, video_id: str, analysis_data: Dict) -> AIAnalysis:
        """Create or update AI analysis"""
        analysis = session.query(AIAnalysis).filter_by(video_id=video_id).first()
        
        if analysis:
            for key, value in analysis_data.items():
                if hasattr(analysis, key):
                    setattr(analysis, key, value)
            analysis.analyzed_at = datetime.now()
        else:
            analysis = AIAnalysis(video_id=video_id, **analysis_data, analyzed_at=datetime.now())
            session.add(analysis)
        
        session.flush()
        return analysis
    
    @staticmethod
    def get_by_video_id(session: Session, video_id: str) -> Optional[AIAnalysis]:
        """Get AI analysis for a video"""
        return session.query(AIAnalysis).filter_by(video_id=video_id).first()

"""HTML report generator using Jinja2 templates"""
import os
import json
import re
import requests
import time
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict
from jinja2 import Environment, FileSystemLoader, select_autoescape

from ..database.connection import DatabaseManager
from ..database.repository import (
    VideoRepository,
    TranscriptRepository,
    EntityRepository,
    TagRepository,
    StatisticsRepository,
    AIAnalysisRepository,
    PlaylistRepository,
    PlaylistItemRepository
)


class HTMLReportGenerator:
    """Generate HTML reports for videos"""
    
    def __init__(
        self,
        db_manager: DatabaseManager,
        template_dir: str = 'templates',
        output_dir: str = 'reports'
    ):
        """
        Initialize HTML report generator
        
        Args:
            db_manager: Database manager instance
            template_dir: Directory containing Jinja2 templates
            output_dir: Directory to save generated reports
        """
        self.db_manager = db_manager
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # Setup Jinja2 environment
        self.env = Environment(
            loader=FileSystemLoader(template_dir),
            autoescape=select_autoescape(['html', 'xml'])
        )
    
    def generate_video_report(
        self,
        video_id: str,
        output_filename: str = None
    ) -> Optional[str]:
        """
        Generate HTML report for a single video
        
        Args:
            video_id: YouTube video ID
            output_filename: Custom output filename (optional)
            
        Returns:
            Path to generated HTML file or None if failed
        """
        # Gather all data from database
        with self.db_manager.get_session() as session:
            # Get video
            video = VideoRepository.get_by_video_id(session, video_id)
            if not video:
                print(f"Video {video_id} not found in database")
                return None
            
            # Get transcript
            transcript_record = TranscriptRepository.get_by_video_id(session, video_id)
            transcript_data = None
            
            if transcript_record:
                segments = json.loads(transcript_record.segments_json) if transcript_record.segments_json else []
                
                # Format segments with timestamps
                formatted_segments = []
                for segment in segments:
                    formatted_segments.append({
                        'start': segment['start'],
                        'timestamp': self._format_timestamp(segment['start']),
                        'text': segment['text']
                    })
                
                transcript_data = {
                    'language': transcript_record.language,
                    'is_auto_generated': transcript_record.is_auto_generated,
                    'full_text': transcript_record.full_text,
                    'segments': formatted_segments,
                    'word_count': len(transcript_record.full_text.split())
                }
            
            # Get entities
            entities_raw = EntityRepository.get_by_video(session, video_id)
            entities = {
                'topics': [],
                'github_repos': [],
                'websites': [],
                'people': []
            }
            
            for entity in entities_raw:
                if entity.entity_type == 'topic':
                    entities['topics'].append(entity.entity_value)
                elif entity.entity_type == 'github_repo':
                    entities['github_repos'].append({
                        'name': entity.entity_value,
                        'url': entity.entity_url or '#'
                    })
                elif entity.entity_type == 'website':
                    entities['websites'].append({
                        'name': entity.entity_value,
                        'url': entity.entity_url or '#'
                    })
                elif entity.entity_type == 'person':
                    entities['people'].append(entity.entity_value)
            
            # Get tags
            tags = [tag.tag for tag in video.tags]
            
            # Get latest statistics
            latest_stats = StatisticsRepository.get_latest(session, video_id)
            
            # Get AI analysis
            ai_analysis = AIAnalysisRepository.get_by_video_id(session, video_id)
            analysis_data = None
            
            if ai_analysis:
                analysis_data = {
                    'summary': ai_analysis.summary,
                    'content_type': ai_analysis.content_type,
                    'sentiment': ai_analysis.sentiment,
                    'model_used': ai_analysis.model_used
                }
            
            # Prepare video data
            video_data = {
                'video_id': video.video_id,
                'title': video.title,
                'description': video.description,
                'channel_title': video.channel_title,
                'channel_id': video.channel_id,
                'published_at': video.published_at.strftime('%Y-%m-%d %H:%M:%S'),
                'duration_seconds': video.duration_seconds,
                'is_short': video.is_short,
                'view_count': latest_stats.view_count if latest_stats else 0,
                'like_count': latest_stats.like_count if latest_stats else 0,
                'comment_count': latest_stats.comment_count if latest_stats else 0,
                'thumbnail_url': self._get_thumbnail_url(video_id)
            }
        
        # Render template
        template = self.env.get_template('video_report.html')
        html_content = template.render(
            video=video_data,
            transcript=transcript_data,
            entities=entities,
            tags=tags,
            analysis=analysis_data,
            generated_at=datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        )
        
        # Save to file
        if not output_filename:
            # Sanitize video title for filename
            safe_title = self._sanitize_filename(video_data['title'])
            output_filename = f"{video_id}_{safe_title}.html"
        
        output_path = self.output_dir / output_filename
        
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(html_content)

        return str(output_path)

    @staticmethod
    def _format_timestamp(seconds: float) -> str:
        """Format seconds as MM:SS or HH:MM:SS"""
        seconds = int(seconds)
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60
        
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        else:
            return f"{minutes:02d}:{secs:02d}"
    
    @staticmethod
    def _get_thumbnail_url(video_id: str, quality: str = 'maxresdefault') -> str:
        """Get YouTube thumbnail URL"""
        return f"https://i.ytimg.com/vi/{video_id}/{quality}.jpg"
    
    @staticmethod
    def _fetch_github_description(repo_url: str) -> Optional[str]:
        """
        Fetch repository description from GitHub API
        
        Args:
            repo_url: GitHub repository URL
            
        Returns:
            Repository description or None
        """
        try:
            # Extract owner/repo from URL
            match = re.search(r'github\.com/([^/]+)/([^/]+)', repo_url)
            if not match:
                return None
            
            owner, repo = match.groups()
            # Remove .git suffix if present
            repo = repo.replace('.git', '')
            
            # Call GitHub API
            api_url = f"https://api.github.com/repos/{owner}/{repo}"
            headers = {'Accept': 'application/vnd.github.v3+json'}
            
            response = requests.get(api_url, headers=headers, timeout=5)
            
            if response.status_code == 200:
                data = response.json()
                return data.get('description', '')
            elif response.status_code == 403:
                # Rate limited - wait a bit
                time.sleep(1)
                return None
            else:
                return None
                
        except Exception:
            return None
    
    def generate_playlist_report(self, playlist_id: str, output_filename: Optional[str] = None) -> Optional[str]:
        """
        Generate a comprehensive HTML report for an entire playlist
        
        Args:
            playlist_id: YouTube playlist ID
            output_filename: Optional custom filename
            
        Returns:
            Path to generated report or None if failed
        """
        from rich.console import Console
        console = Console()
        
        with self.db_manager.get_session() as session:
            # Get playlist info
            playlist = PlaylistRepository.get_by_id(session, playlist_id)
            if not playlist:
                console.print(f"[red]Playlist not found: {playlist_id}[/red]")
                return None
            
            # Get all videos in playlist
            playlist_items = PlaylistItemRepository.get_items_with_videos(session, playlist_id)
            if not playlist_items:
                console.print(f"[yellow]No videos found in playlist[/yellow]")
                return None
            
            # Aggregate data across all videos
            all_videos_data = []
            aggregated_repos = {}  # {repo_url: {'name': ..., 'videos': [...], 'summary': ...}}
            aggregated_websites = {}
            aggregated_topics = {}
            aggregated_people = {}
            
            total_duration = 0
            total_views = 0
            videos_with_transcripts = 0
            
            for item in playlist_items:
                video = item.video
                
                # Get video stats
                latest_stats = StatisticsRepository.get_latest(session, video.video_id)
                if latest_stats:
                    total_views += latest_stats.view_count or 0
                
                total_duration += video.duration_seconds or 0
                
                # Check transcript
                transcript = TranscriptRepository.get_by_video_id(session, video.video_id)
                if transcript:
                    videos_with_transcripts += 1
                
                # Get entities for this video
                entities = EntityRepository.get_by_video(session, video.video_id)
                
                # Get AI analysis
                ai_analysis = AIAnalysisRepository.get_by_video_id(session, video.video_id)
                
                # Aggregate repos
                for entity in entities:
                    if entity.entity_type == 'github_repo':
                        repo_key = entity.entity_url or entity.entity_value
                        if repo_key not in aggregated_repos:
                            aggregated_repos[repo_key] = {
                                'name': entity.entity_value,
                                'url': entity.entity_url,
                                'videos': [],
                                'summary': None  # Will be populated from first video context
                            }
                        aggregated_repos[repo_key]['videos'].append({
                            'video_id': video.video_id,
                            'title': video.title
                        })
                        # Use AI summary if available
                        if ai_analysis and ai_analysis.summary and not aggregated_repos[repo_key]['summary']:
                            # Extract relevant context about this repo from summary
                            aggregated_repos[repo_key]['summary'] = f"Mentioned in: {video.title}"
                    
                    elif entity.entity_type == 'website':
                        site_key = entity.entity_url or entity.entity_value
                        if site_key not in aggregated_websites:
                            aggregated_websites[site_key] = {
                                'name': entity.entity_value,
                                'url': entity.entity_url,
                                'videos': []
                            }
                        aggregated_websites[site_key]['videos'].append({
                            'video_id': video.video_id,
                            'title': video.title
                        })
                    
                    elif entity.entity_type == 'topic':
                        topic_key = entity.entity_value.lower()
                        if topic_key not in aggregated_topics:
                            aggregated_topics[topic_key] = {
                                'name': entity.entity_value,
                                'count': 0,
                                'videos': []
                            }
                        aggregated_topics[topic_key]['count'] += 1
                        aggregated_topics[topic_key]['videos'].append({
                            'video_id': video.video_id,
                            'title': video.title
                        })
                    
                    elif entity.entity_type == 'person':
                        person_key = entity.entity_value.lower()
                        if person_key not in aggregated_people:
                            aggregated_people[person_key] = {
                                'name': entity.entity_value,
                                'count': 0,
                                'videos': []
                            }
                        aggregated_people[person_key]['count'] += 1
                        aggregated_people[person_key]['videos'].append({
                            'video_id': video.video_id,
                            'title': video.title
                        })
                
                # Prepare individual video data
                video_data = {
                    'video_id': video.video_id,
                    'title': video.title,
                    'channel_title': video.channel_title,
                    'published_at': video.published_at.strftime('%Y-%m-%d'),
                    'duration_seconds': video.duration_seconds,
                    'view_count': latest_stats.view_count if latest_stats else 0,
                    'like_count': latest_stats.like_count if latest_stats else 0,
                    'has_transcript': bool(transcript),
                    'thumbnail_url': self._get_thumbnail_url(video.video_id),
                    'summary': ai_analysis.summary if ai_analysis else None,
                    'topics': [e.entity_value for e in entities if e.entity_type == 'topic']
                }
                all_videos_data.append(video_data)
            
            # Sort aggregated data
            top_topics = sorted(aggregated_topics.values(), key=lambda x: x['count'], reverse=True)[:20]
            all_repos = sorted(aggregated_repos.values(), key=lambda x: len(x['videos']), reverse=True)
            all_websites = sorted(aggregated_websites.values(), key=lambda x: len(x['videos']), reverse=True)
            all_people = sorted(aggregated_people.values(), key=lambda x: x['count'], reverse=True)
            
            # Fetch GitHub repo descriptions
            console.print(f"[cyan]Fetching GitHub repo descriptions...[/cyan]")
            for repo in all_repos:
                if repo['url'] and 'github.com' in repo['url']:
                    description = self._fetch_github_description(repo['url'])
                    if description:
                        repo['description'] = description
                    time.sleep(0.1)  # Be nice to GitHub API
            
            # Calculate stats
            hours = total_duration // 3600
            minutes = (total_duration % 3600) // 60
            duration_formatted = f"{hours}h {minutes}m" if hours > 0 else f"{minutes}m"
            
            # Prepare template data
            playlist_data = {
                'playlist_id': playlist.playlist_id,
                'title': playlist.title,
                'description': playlist.description,
                'video_count': len(all_videos_data),
                'total_duration': duration_formatted,
                'total_views': f"{total_views:,}",
                'videos_with_transcripts': videos_with_transcripts,
                'transcript_percentage': int((videos_with_transcripts / len(all_videos_data)) * 100) if all_videos_data else 0
            }
            
            stats = {
                'total_topics': len(aggregated_topics),
                'total_repos': len(aggregated_repos),
                'total_websites': len(aggregated_websites),
                'total_people': len(aggregated_people)
            }
            
            # Generate filename while we still have access to playlist
            if not output_filename:
                safe_title = self._sanitize_filename(playlist.title)
                output_filename = f"playlist_{playlist_id}_{safe_title}.html"
        
        # Render template (after session closes)
        template = self.env.get_template('playlist_report.html')
        html_content = template.render(
            playlist=playlist_data,
            stats=stats,
            videos=all_videos_data,
            top_topics=top_topics,
            github_repos=all_repos,
            websites=all_websites,
            people=all_people,
            generated_at=datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        )
        
        # Save to file
        
        output_path = self.output_dir / output_filename
        
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(html_content)
        
        return str(output_path)
    
    @staticmethod
    def _sanitize_filename(filename: str, max_length: int = 50) -> str:
        """Sanitize filename by removing invalid characters"""
        # Remove invalid characters
        valid_chars = '-_.() abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        sanitized = ''.join(c if c in valid_chars else '_' for c in filename)
        
        # Truncate if too long
        if len(sanitized) > max_length:
            sanitized = sanitized[:max_length]
        
        return sanitized.strip('_')


def generate_report(
    video_id: str,
    db_manager: DatabaseManager,
    output_dir: str = 'reports'
) -> Optional[str]:
    """
    Convenience function to generate a single video report
    
    Args:
        video_id: YouTube video ID
        db_manager: Database manager
        output_dir: Output directory
        
    Returns:
        Path to generated report
    """
    generator = HTMLReportGenerator(db_manager, output_dir=output_dir)
    return generator.generate_video_report(video_id)

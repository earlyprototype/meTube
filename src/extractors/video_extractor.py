"""Main video extraction pipeline"""
from typing import List, Dict, Optional
from datetime import datetime
from rich.console import Console

from ..api.youtube_client import YouTubeClient
from ..extractors.transcript_extractor import TranscriptExtractor
from ..extractors.whisper_extractor import WhisperTranscriptExtractor
from ..parsers.llm_parser import GeminiParser
from ..parsers.description_parser import DescriptionParser
from ..database.connection import DatabaseManager
from ..database.repository import (
    VideoRepository,
    StatisticsRepository,
    TranscriptRepository,
    EntityRepository,
    TagRepository,
    PlaylistRepository,
    PlaylistItemRepository,
    ExtractionJobRepository,
    AIAnalysisRepository
)

console = Console()


class VideoExtractor:
    """Main extraction pipeline for videos"""
    
    def __init__(
        self,
        youtube_client: YouTubeClient,
        db_manager: DatabaseManager,
        auto_transcript: bool = True,
        auto_llm_parse: bool = True,
        gemini_api_key: str = None,
        languages: List[str] = None,
        transcript_rate_limit: float = 2.0,
        config: Dict = None
    ):
        """
        Initialize video extractor
        
        Args:
            youtube_client: Authenticated YouTube API client
            db_manager: Database manager instance
            auto_transcript: Automatically extract transcripts
            auto_llm_parse: Automatically parse transcripts with LLM
            gemini_api_key: Gemini API key for LLM parsing
            languages: Preferred transcript languages
            transcript_rate_limit: Delay between transcript requests (seconds, default: 2.0)
            config: Full configuration dictionary (for Whisper settings)
        """
        self.youtube_client = youtube_client
        self.db_manager = db_manager
        self.auto_transcript = auto_transcript
        self.auto_llm_parse = auto_llm_parse
        
        # Initialize Whisper if enabled
        whisper_extractor = None
        if config and config.get('extraction', {}).get('whisper', {}).get('enabled', False):
            try:
                whisper_extractor = WhisperTranscriptExtractor(config)
                console.print("[dim]Whisper fallback enabled[/dim]")
            except Exception as e:
                console.print(f"[yellow]Warning: Could not initialize Whisper: {e}[/yellow]")
        
        self.transcript_extractor = TranscriptExtractor(
            languages, 
            rate_limit_delay=transcript_rate_limit,
            whisper_extractor=whisper_extractor
        )
        self.description_parser = DescriptionParser()
        
        if auto_llm_parse:
            try:
                # Get model name from config
                model_name = config.get('api', {}).get('gemini_model', 'gemini-3-flash-preview') if config else 'gemini-3-flash-preview'
                self.llm_parser = GeminiParser(api_key=gemini_api_key, model=model_name)
            except ValueError as e:
                console.print(f"[yellow]Warning: {e}[/yellow]")
                console.print("[yellow]LLM parsing will be disabled[/yellow]")
                self.auto_llm_parse = False
                self.llm_parser = None
        else:
            self.llm_parser = None
    
    def extract_single_video(
        self,
        video_id: str,
        skip_transcript: bool = False,
        skip_llm: bool = False
    ) -> Optional[Dict]:
        """
        Extract complete data for a single video
        
        Args:
            video_id: YouTube video ID
            skip_transcript: Skip transcript extraction
            skip_llm: Skip LLM parsing
            
        Returns:
            Dictionary with extraction results or None if failed
        """
        console.print(f"\n[bold blue]Extracting video: {video_id}[/bold blue]")
        
        # Step 1: Get video metadata
        console.print("  [cyan]Fetching metadata...[/cyan]")
        video_data = self.youtube_client.get_single_video(video_id)
        
        if not video_data:
            console.print(f"  [red]Failed to fetch video metadata[/red]")
            return None
        
        # Sanitize output for Windows PowerShell
        title = video_data['title'][:60].encode('ascii', 'replace').decode('ascii')
        channel = video_data['channel_title'].encode('ascii', 'replace').decode('ascii')
        console.print(f"  [green][OK][/green] Title: {title}")
        console.print(f"  [green][OK][/green] Channel: {channel}")
        console.print(f"  [green][OK][/green] Duration: {video_data['duration_seconds']}s")
        
        # Save to database
        with self.db_manager.get_session() as session:
            # Create or update video
            video = VideoRepository.create_or_update(session, {
                'video_id': video_data['video_id'],
                'title': video_data['title'],
                'description': video_data['description'],
                'channel_id': video_data['channel_id'],
                'channel_title': video_data['channel_title'],
                'published_at': datetime.fromisoformat(video_data['published_at'].replace('Z', '+00:00')),
                'duration': video_data['duration'],
                'duration_seconds': video_data['duration_seconds'],
                'is_short': video_data['is_short'],
                'category_id': video_data['category_id'],
                'definition': video_data['definition'],
                'caption': video_data['caption'],
                'licensed_content': video_data['licensed_content']
            })
            
            # Add statistics snapshot
            StatisticsRepository.add_snapshot(session, video_id, {
                'view_count': video_data['view_count'],
                'like_count': video_data['like_count'],
                'comment_count': video_data['comment_count']
            })
            
            # Add original tags
            if video_data.get('tags'):
                TagRepository.add_tags_to_video(session, video_id, video_data['tags'])
        
        # Step 2: Parse description for GitHub repos and URLs (always runs)
        console.print("  [cyan]Parsing description...[/cyan]")
        description_parsed = self.description_parser.parse(
            video_data['title'],
            video_data.get('description', '')
        )
        
        if description_parsed['github_repos'] or description_parsed['websites']:
            console.print(f"  [green][OK][/green] Found {len(description_parsed['github_repos'])} GitHub repos")
            console.print(f"  [green][OK][/green] Found {len(description_parsed['websites'])} websites")
            
            with self.db_manager.get_session() as session:
                # Add entities from description
                desc_entities = self.description_parser.extract_entities_for_database(description_parsed)
                if desc_entities:
                    EntityRepository.add_entities(session, video_id, desc_entities)
                
                # Add tags
                desc_tags = self.description_parser.get_tags(description_parsed)
                if desc_tags:
                    TagRepository.add_tags_to_video(session, video_id, desc_tags)
        else:
            console.print("  [dim][SKIP][/dim] No links found in description")
        
        # Step 3: Extract transcript
        transcript_data = None
        if self.auto_transcript and not skip_transcript:
            console.print("  [cyan]Extracting transcript...[/cyan]")
            transcript_data = self.transcript_extractor.extract(video_id)
            
            if transcript_data:
                source = "Whisper" if transcript_data.get('from_whisper') else "YouTube"
                console.print(f"  [green][OK][/green] Transcript extracted via {source} ({len(transcript_data['full_text'])} chars)")
                
                with self.db_manager.get_session() as session:
                    TranscriptRepository.create(session, video_id, transcript_data)
            else:
                console.print("  [yellow][WARN][/yellow] No transcript available")
        
        # Step 4: Parse with LLM
        parsed_entities = None
        if self.auto_llm_parse and not skip_llm and transcript_data:
            console.print("  [cyan]Parsing with Gemini AI...[/cyan]")
            
            try:
                parsed_entities = self.llm_parser.parse_transcript(
                    transcript_data['full_text'],
                    video_data['title']
                )
                
                console.print(f"  [green][OK][/green] Found {len(parsed_entities['topics'])} topics")
                console.print(f"  [green][OK][/green] Found {len(parsed_entities['github_repos'])} repos")
                console.print(f"  [green][OK][/green] Found {len(parsed_entities['websites'])} websites")
                console.print(f"  [green][OK][/green] Found {len(parsed_entities['people'])} people")
                
                with self.db_manager.get_session() as session:
                    # Delete old entities
                    EntityRepository.delete_by_video(session, video_id)
                    
                    # Add new entities
                    entities = self.llm_parser.extract_entities_for_database(parsed_entities)
                    EntityRepository.add_entities(session, video_id, entities)
                    
                    # Add tags
                    tags = self.llm_parser.get_tags(parsed_entities)
                    if tags:
                        TagRepository.add_tags_to_video(session, video_id, tags)
                    
                    # Add AI analysis
                    analysis = self.llm_parser.get_analysis(parsed_entities)
                    AIAnalysisRepository.create_or_update(session, video_id, analysis)
            
            except Exception as e:
                # Error details already shown by llm_parser
                console.print(f"  [yellow]Skipping AI analysis[/yellow]")
        
        console.print(f"  [bold green][OK] Extraction complete![/bold green]\n")
        
        return {
            'video_data': video_data,
            'transcript_data': transcript_data,
            'parsed_entities': parsed_entities
        }
    
    def extract_playlist(
        self,
        playlist_id: str,
        skip_existing: bool = True,
        max_videos: int = None
    ) -> Dict:
        """
        Extract all videos from a playlist
        
        Args:
            playlist_id: YouTube playlist ID
            skip_existing: Skip videos already in database
            max_videos: Maximum number of videos to process
            
        Returns:
            Dictionary with extraction summary
        """
        console.print(f"\n[bold blue]Extracting playlist: {playlist_id}[/bold blue]\n")
        
        # Get playlist info
        playlist_info = self.youtube_client.get_playlist_info(playlist_id)
        
        if not playlist_info:
            console.print("[red]Failed to fetch playlist info[/red]")
            return {'success': False, 'error': 'Playlist not found'}
        
        # Sanitize playlist title for Windows PowerShell
        playlist_title = playlist_info['title'].encode('ascii', 'replace').decode('ascii')
        console.print(f"[bold]{playlist_title}[/bold]")
        console.print(f"Videos: {playlist_info['video_count']}\n")
        
        # Save playlist to database
        with self.db_manager.get_session() as session:
            PlaylistRepository.create_or_update(session, {
                'playlist_id': playlist_id,
                'title': playlist_info['title'],
                'description': playlist_info.get('description', ''),
                'video_count': playlist_info['video_count']
            })
            
            # Create extraction job
            job = ExtractionJobRepository.create(session, {
                'playlist_id': playlist_id,
                'job_type': 'playlist',
                'status': 'running'
            })
            job_id = job.id
        
        # Get all videos from playlist
        console.print("[cyan]Fetching playlist videos...[/cyan]")
        playlist_videos = self.youtube_client.get_playlist_videos(playlist_id, max_videos)
        console.print(f"[green][OK][/green] Found {len(playlist_videos)} videos\n")
        
        # Filter out existing videos if requested
        videos_to_process = []
        
        if skip_existing:
            with self.db_manager.get_session() as session:
                for video in playlist_videos:
                    existing = VideoRepository.get_by_video_id(session, video['video_id'])
                    if not existing:
                        videos_to_process.append(video)
                    else:
                        # Still add to playlist items
                        PlaylistItemRepository.add_video_to_playlist(
                            session,
                            playlist_id,
                            video['video_id'],
                            video['position'],
                            datetime.fromisoformat(video['added_at'].replace('Z', '+00:00'))
                        )
            console.print(f"[yellow]Skipping {len(playlist_videos) - len(videos_to_process)} existing videos[/yellow]\n")
        else:
            videos_to_process = playlist_videos
        
        # Process videos with progress bar
        results = {
            'total': len(playlist_videos),
            'processed': 0,
            'new': 0,
            'skipped': len(playlist_videos) - len(videos_to_process),
            'failed': 0
        }
        
        # Process videos with visual counter
        for idx, video in enumerate(videos_to_process, 1):
            video_id = video['video_id']
            video_title = video.get('title', video_id)[:50]  # Truncate long titles
            
            # Visual progress header with your little dude popping up
            console.print(f"\n[bold cyan]{'='*35}[/bold cyan] [bold yellow]\\-!-/[/bold yellow] [bold cyan]{'='*35}[/bold cyan]")
            console.print(f"[bold white]Video {idx}/{len(videos_to_process)}[/bold white] | [bold blue]{playlist_title[:40]}[/bold blue]")
            console.print(f"[dim]{video_title}[/dim]")
            console.print(f"[bold cyan]{'='*80}[/bold cyan]")
            
            try:
                self.extract_single_video(video_id)
                
                # Add to playlist items
                with self.db_manager.get_session() as session:
                    PlaylistItemRepository.add_video_to_playlist(
                        session,
                        playlist_id,
                        video_id,
                        video['position'],
                        datetime.fromisoformat(video['added_at'].replace('Z', '+00:00'))
                    )
                
                results['processed'] += 1
                results['new'] += 1
            except Exception as e:
                # Sanitize error message
                error_msg = str(e).encode('ascii', 'replace').decode('ascii')
                console.print(f"[red]Error processing {video_id}: {error_msg}[/red]")
                results['failed'] += 1
        
        # Update job status
        with self.db_manager.get_session() as session:
            ExtractionJobRepository.update_status(
                session,
                job_id,
                'completed',
                videos_found=results['total'],
                videos_processed=results['processed'],
                new_videos=results['new']
            )
        
        console.print(f"\n[bold cyan]{'='*80}[/bold cyan]")
        console.print(f"[bold green]Playlist extraction complete![/bold green]")
        console.print(f"  Processed: {results['processed']}/{results['total']}")
        console.print(f"  New: {results['new']}")
        console.print(f"  Skipped: {results['skipped']}")
        if results['failed'] > 0:
            console.print(f"  [red]Failed: {results['failed']}[/red]")
        console.print(f"[bold cyan]{'='*80}[/bold cyan]")
        
        return results

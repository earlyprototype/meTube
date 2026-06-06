"""Transcript extraction using youtube-transcript-api"""
import logging
import time
from typing import List, Dict, Optional
from rich.console import Console
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    TranscriptsDisabled,
    NoTranscriptFound,
    VideoUnavailable,
    TooManyRequests
)

console = Console()
logger = logging.getLogger(__name__)


class TranscriptExtractor:
    """Extract transcripts from YouTube videos"""
    
    def __init__(self, languages: List[str] = None, rate_limit_delay: float = 2.0, whisper_extractor=None):
        """
        Initialize transcript extractor
        
        Args:
            languages: List of language codes to try (e.g., ['en', 'en-GB', 'en-US'])
            rate_limit_delay: Delay in seconds between requests to avoid rate limiting (default: 2.0)
            whisper_extractor: Optional WhisperTranscriptExtractor for fallback
        """
        self.languages = languages or ['en', 'en-GB', 'en-US']
        self.rate_limit_delay = rate_limit_delay
        self.last_request_time = 0
        self.whisper_extractor = whisper_extractor
    
    def extract(self, video_id: str, max_retries: int = 3, use_whisper_fallback: bool = True) -> Optional[Dict]:
        """
        Extract transcript for a video
        
        Args:
            video_id: YouTube video ID
            max_retries: Maximum number of retries on rate limit (default: 3)
            use_whisper_fallback: Whether to fallback to Whisper if YouTube fails (default: True)
            
        Returns:
            Dictionary with transcript data or None if unavailable
            {
                'full_text': str,
                'segments': List[Dict],
                'language': str,
                'is_auto_generated': bool,
                'from_whisper': bool (optional)
            }
        """
        # Rate limiting: wait before making request
        current_time = time.time()
        time_since_last = current_time - self.last_request_time
        if time_since_last < self.rate_limit_delay:
            time.sleep(self.rate_limit_delay - time_since_last)
        
        self.last_request_time = time.time()
        
        # Try YouTube transcript API first
        retry_count = 0
        youtube_failed_reason = None
        
        while retry_count <= max_retries:
            try:
                transcript_data = self._extract_transcript(video_id)
                if transcript_data:
                    return transcript_data
                youtube_failed_reason = "No transcript available"
                break  # No transcript available, don't retry
            except TooManyRequests:
                retry_count += 1
                if retry_count <= max_retries:
                    # Exponential backoff: wait longer each time
                    wait_time = self.rate_limit_delay * (2 ** retry_count)
                    console.print(f"  [yellow]Rate limited - waiting {wait_time:.1f}s (retry {retry_count}/{max_retries})[/yellow]")
                    time.sleep(wait_time)
                else:
                    youtube_failed_reason = "Rate limit exceeded"
                    console.print(f"  [yellow]YouTube transcript unavailable (rate limit)[/yellow]")
                    break
        
        # Fallback to Whisper if YouTube transcript failed and Whisper is available
        if youtube_failed_reason:
            if use_whisper_fallback and self.whisper_extractor:
                try:
                    console.print(f"  [cyan]Trying Whisper fallback...[/cyan]")
                    whisper_transcript = self.whisper_extractor.extract(video_id)
                    if whisper_transcript:
                        return whisper_transcript
                    else:
                        console.print(f"  [yellow]Whisper transcription failed[/yellow]")
                except Exception as e:
                    error_msg = str(e).split('\n')[0][:100]  # First line only, max 100 chars
                    console.print(f"  [red]Whisper error: {error_msg}[/red]")
            else:
                console.print(f"  [yellow]No transcript available ({youtube_failed_reason})[/yellow]")
        
        return None
    
    def _extract_transcript(self, video_id: str) -> Optional[Dict]:
        """Internal method to extract transcript (without rate limiting logic)"""
        try:
            # Try to get transcript in preferred languages
            transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
            
            # Try manual transcripts first
            transcript = None
            is_auto_generated = False
            
            try:
                # Try to find a manual transcript in preferred languages
                for lang in self.languages:
                    try:
                        transcript = transcript_list.find_manually_created_transcript([lang])
                        is_auto_generated = False
                        break
                    except NoTranscriptFound:
                        continue
            except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable):
                # Expected: no manual transcript available; fall through to auto-generated.
                pass
            except Exception:
                logger.exception(
                    "Unexpected error iterating manual transcripts for video_id=%s",
                    video_id,
                )
                # Don't re-raise; let execution continue to auto-generated fallback

            # Fall back to auto-generated transcripts
            if not transcript:
                try:
                    for lang in self.languages:
                        try:
                            transcript = transcript_list.find_generated_transcript([lang])
                            is_auto_generated = True
                            break
                        except NoTranscriptFound:
                            continue
                except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable):
                    # Expected: no auto-generated transcript available; fall through.
                    pass
                except Exception:
                    logger.exception(
                        "Unexpected error iterating auto-generated transcripts for video_id=%s",
                        video_id,
                    )
                    # Don't re-raise; let execution continue to "any available" fallback
            
            # If still no transcript, try any available transcript
            if not transcript:
                try:
                    # Get first available transcript
                    transcript = next(iter(transcript_list))
                    is_auto_generated = transcript.is_generated
                except StopIteration:
                    return None
            
            # Fetch the actual transcript data
            segments = transcript.fetch()
            
            # Combine all text
            full_text = ' '.join(segment['text'] for segment in segments)
            
            return {
                'full_text': full_text,
                'segments': segments,
                'language': transcript.language_code,
                'is_auto_generated': is_auto_generated
            }
        
        except TranscriptsDisabled:
            console.print(f"  [dim]YouTube transcripts disabled for this video[/dim]")
            return None
        except NoTranscriptFound:
            console.print(f"  [dim]No YouTube transcript found[/dim]")
            return None
        except VideoUnavailable:
            console.print(f"  [red]Video unavailable[/red]")
            return None
        except TooManyRequests:
            # Re-raise to be handled by retry logic
            raise
        except Exception as e:
            # Extract just the first line of error for cleaner output
            error_type = type(e).__name__
            error_msg = str(e).split('\n')[0][:80]  # First line, max 80 chars
            console.print(f"  [dim]Transcript error: {error_type}[/dim]")
            return None
    
    def extract_batch(self, video_ids: List[str]) -> Dict[str, Optional[Dict]]:
        """
        Extract transcripts for multiple videos
        
        Args:
            video_ids: List of YouTube video IDs
            
        Returns:
            Dictionary mapping video_id to transcript data
        """
        results = {}
        
        for video_id in video_ids:
            results[video_id] = self.extract(video_id)
        
        return results
    
    def format_transcript_with_timestamps(self, transcript_data: Dict) -> str:
        """
        Format transcript with clickable timestamps
        
        Args:
            transcript_data: Transcript data dictionary
            
        Returns:
            Formatted transcript string
        """
        if not transcript_data or 'segments' not in transcript_data:
            return ""
        
        formatted_lines = []
        
        for segment in transcript_data['segments']:
            timestamp = self._format_timestamp(segment['start'])
            text = segment['text'].strip()
            formatted_lines.append(f"[{timestamp}] {text}")
        
        return '\n'.join(formatted_lines)
    
    @staticmethod
    def _format_timestamp(seconds: float) -> str:
        """
        Format seconds as MM:SS or HH:MM:SS
        
        Args:
            seconds: Time in seconds
            
        Returns:
            Formatted timestamp string
        """
        seconds = int(seconds)
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60
        
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        else:
            return f"{minutes:02d}:{secs:02d}"
    
    @staticmethod
    def generate_youtube_timestamp_url(video_id: str, seconds: float) -> str:
        """
        Generate YouTube URL with timestamp
        
        Args:
            video_id: YouTube video ID
            seconds: Time in seconds
            
        Returns:
            YouTube URL with timestamp parameter
        """
        timestamp_seconds = int(seconds)
        return f"https://youtube.com/watch?v={video_id}&t={timestamp_seconds}s"
    
    def get_transcript_stats(self, transcript_data: Dict) -> Dict:
        """
        Calculate statistics about a transcript
        
        Args:
            transcript_data: Transcript data dictionary
            
        Returns:
            Dictionary with statistics
        """
        if not transcript_data:
            return {
                'word_count': 0,
                'char_count': 0,
                'segment_count': 0,
                'duration_seconds': 0
            }
        
        full_text = transcript_data.get('full_text', '')
        segments = transcript_data.get('segments', [])
        
        word_count = len(full_text.split())
        char_count = len(full_text)
        segment_count = len(segments)
        
        # Calculate total duration
        duration_seconds = 0
        if segments:
            last_segment = segments[-1]
            duration_seconds = last_segment['start'] + last_segment.get('duration', 0)
        
        return {
            'word_count': word_count,
            'char_count': char_count,
            'segment_count': segment_count,
            'duration_seconds': int(duration_seconds),
            'language': transcript_data.get('language', 'unknown'),
            'is_auto_generated': transcript_data.get('is_auto_generated', True)
        }


def extract_transcript(video_id: str, languages: List[str] = None) -> Optional[Dict]:
    """
    Convenience function to extract a single transcript
    
    Args:
        video_id: YouTube video ID
        languages: Preferred languages
        
    Returns:
        Transcript data dictionary or None
    """
    extractor = TranscriptExtractor(languages)
    return extractor.extract(video_id)

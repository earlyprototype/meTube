"""Whisper-based transcript extraction for videos without YouTube transcripts"""
import logging
import os
import shutil
import warnings
from pathlib import Path
from typing import Dict, Optional
import tempfile
from rich.console import Console

console = Console()
logger = logging.getLogger(__name__)


class WhisperTranscriptExtractor:
    """Extract transcripts using Whisper and yt-dlp as fallback"""
    
    def __init__(self, config: Dict):
        """
        Initialize Whisper extractor
        
        Args:
            config: Configuration dictionary with whisper settings
        """
        self.config = config
        self.whisper_config = config.get('extraction', {}).get('whisper', {})
        self.model_name = self.whisper_config.get('model', 'base')
        self.audio_format = self.whisper_config.get('audio_format', 'm4a')
        self.temp_dir = Path(self.whisper_config.get('temp_dir', 'data/temp_audio/'))
        self.cleanup_audio = self.whisper_config.get('cleanup_audio', True)
        
        # Create temp directory
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        
        # Lazy load Whisper model (only when needed)
        self.model = None
        self.whisper = None
        self.yt_dlp = None
    
    def _load_whisper(self):
        """Lazy load Whisper model"""
        if self.model is None:
            try:
                import whisper
                self.whisper = whisper
                console.print(f"  [dim]Loading Whisper ({self.model_name})...[/dim]")
                self.model = whisper.load_model(self.model_name)
                console.print(f"  [green]Whisper ready[/green]")
            except ImportError:
                raise ImportError(
                    "openai-whisper is not installed. "
                    "Install with: pip install openai-whisper"
                )
            except Exception as e:
                raise RuntimeError(f"Failed to load Whisper model: {e}")
    
    def _load_ytdlp(self):
        """Lazy load yt-dlp"""
        if self.yt_dlp is None:
            try:
                import yt_dlp
                self.yt_dlp = yt_dlp
            except ImportError:
                raise ImportError(
                    "yt-dlp is not installed. "
                    "Install with: pip install yt-dlp"
                )
    
    def _download_audio(self, video_id: str) -> Optional[str]:
        """
        Download audio from YouTube video
        
        Args:
            video_id: YouTube video ID
            
        Returns:
            Path to downloaded audio file or None if failed
        """
        self._load_ytdlp()
        
        output_path = self.temp_dir / f"{video_id}.{self.audio_format}"
        
        ydl_opts = {
            'format': 'bestaudio/best',
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': self.audio_format,
            }],
            'outtmpl': str(self.temp_dir / f"{video_id}.%(ext)s"),
            'quiet': True,
            'no_warnings': True,
        }
        
        try:
            with self.yt_dlp.YoutubeDL(ydl_opts) as ydl:
                url = f"https://www.youtube.com/watch?v={video_id}"
                ydl.download([url])
            
            if output_path.exists():
                return str(output_path)
            else:
                console.print(f"  [red]Audio file not found[/red]")
                return None
                
        except Exception as e:
            logger.exception(
                'whisper audio download failed',
                extra={'video_id': video_id, 'output_path': str(output_path)},
            )
            console.print(f"  [red]Audio download failed[/red]")
            return None
    
    def _transcribe_audio(self, audio_path: str) -> Optional[Dict]:
        """
        Transcribe audio file using Whisper
        
        Args:
            audio_path: Path to audio file
            
        Returns:
            Transcript data dictionary or None if failed
        """
        self._load_whisper()
        
        try:
            console.print(f"  [cyan]Transcribing with Whisper...[/cyan]")
            
            # Suppress FP16 warning on CPU
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="FP16 is not supported on CPU")
                result = self.model.transcribe(audio_path, language='en')
            
            # Format segments to match YouTube transcript structure
            segments = []
            for segment in result['segments']:
                segments.append({
                    'start': segment['start'],
                    'duration': segment['end'] - segment['start'],
                    'text': segment['text'].strip()
                })
            
            return {
                'full_text': result['text'].strip(),
                'segments': segments,
                'language': result.get('language', 'en'),
                'is_auto_generated': False,  # Whisper provides manual-quality transcripts
                'from_whisper': True  # Flag to indicate source
            }
            
        except Exception as e:
            logger.exception(
                'whisper transcription failed',
                extra={'audio_path': audio_path, 'model': self.model_name},
            )
            console.print(f"  [red]Transcription failed[/red]")
            return None
    
    def _cleanup_audio_file(self, audio_path: str):
        """Delete temporary audio file"""
        try:
            if os.path.exists(audio_path):
                os.remove(audio_path)
        except Exception as e:
            # Cleanup failure is not critical - log and continue
            logger.debug('temp cleanup failed: %s', e, exc_info=True)
    
    def extract(self, video_id: str) -> Optional[Dict]:
        """
        Extract transcript using Whisper
        
        Args:
            video_id: YouTube video ID
            
        Returns:
            Transcript data dictionary or None if extraction failed
        """
        audio_path = None
        
        try:
            # Step 1: Download audio
            console.print(f"  [cyan]Downloading audio...[/cyan]")
            audio_path = self._download_audio(video_id)
            
            if not audio_path:
                return None
            
            # Step 2: Transcribe
            transcript_data = self._transcribe_audio(audio_path)
            
            return transcript_data
            
        except Exception as e:
            error_type = type(e).__name__
            console.print(f"  [red]Whisper failed: {error_type}[/red]")
            return None
            
        finally:
            # Step 3: Cleanup
            if self.cleanup_audio and audio_path:
                self._cleanup_audio_file(audio_path)
    
    def is_available(self) -> bool:
        """Check if Whisper and yt-dlp are available"""
        try:
            import whisper
            import yt_dlp
            return True
        except ImportError:
            return False

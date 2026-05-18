"""Click-based CLI interface for YouTube Shorts Extractor"""
import os
import sys
import json
import yaml
import click
from pathlib import Path
from rich.console import Console
from rich.table import Table
from dotenv import load_dotenv

from .auth.oauth_handler import YouTubeAuthHandler
from .api.youtube_client import YouTubeClient
from .database.connection import init_database, get_db_manager
from .database.repository import PlaylistRepository, VideoRepository
from .extractors.video_extractor import VideoExtractor
from .reports.html_generator import HTMLReportGenerator

# Load environment variables
load_dotenv()

console = Console()

# Cache files
PLAYLIST_CACHE_FILE = Path('data/playlist_cache.json')
VIDEO_CACHE_FILE = Path('data/video_cache.json')


def save_playlist_cache(playlists):
    """Save discovered playlists to cache"""
    PLAYLIST_CACHE_FILE.parent.mkdir(exist_ok=True)
    with open(PLAYLIST_CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(playlists, f, indent=2, ensure_ascii=False)


def load_playlist_cache():
    """Load cached playlists"""
    if not PLAYLIST_CACHE_FILE.exists():
        return None
    try:
        with open(PLAYLIST_CACHE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def save_video_cache(playlist_id, videos):
    """Save playlist videos to cache"""
    VIDEO_CACHE_FILE.parent.mkdir(exist_ok=True)
    
    # Load existing cache
    cache = {}
    if VIDEO_CACHE_FILE.exists():
        try:
            with open(VIDEO_CACHE_FILE, 'r', encoding='utf-8') as f:
                cache = json.load(f)
        except Exception:
            pass
    
    # Update cache for this playlist
    cache[playlist_id] = videos
    
    # Save back
    with open(VIDEO_CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def load_video_cache(playlist_id=None):
    """Load cached playlist videos"""
    if not VIDEO_CACHE_FILE.exists():
        return None
    try:
        with open(VIDEO_CACHE_FILE, 'r', encoding='utf-8') as f:
            cache = json.load(f)
            if playlist_id:
                return cache.get(playlist_id)
            return cache
    except Exception:
        return None


def resolve_playlist_identifier(identifier: str, db_manager=None) -> str:
    """
    Resolve playlist identifier to actual playlist ID
    
    Args:
        identifier: Can be:
            - A number (1-N) referring to cached playlist
            - A playlist title (searches cache)
            - A full YouTube playlist ID (PLxxx...)
            - A YouTube playlist URL
        db_manager: Optional database manager to check tracked playlists
    
    Returns:
        Resolved playlist ID or None if not found
    """
    # Check if it's already a playlist ID or URL
    if identifier.startswith('PL') or identifier.startswith('http'):
        # Extract ID if it's a URL
        if 'list=' in identifier:
            import re
            match = re.search(r'list=([^&]+)', identifier)
            if match:
                return match.group(1)
        return identifier
    
    # Try cache lookup
    cache = load_playlist_cache()
    if not cache:
        console.print("[yellow]No playlist cache found[/yellow]")
        console.print("[dim]Run 'metube playlist discover' first to cache your playlists[/dim]")
        return None
    
    # Check if it's a number
    if identifier.isdigit():
        num = int(identifier)
        if 1 <= num <= len(cache):
            return cache[num - 1]['playlist_id']
        else:
            console.print(f"[red]Invalid cache number: {num} (only 1-{len(cache)} available)[/red]")
            console.print("[dim]Run 'metube playlist discover' to see available playlists[/dim]")
            return None
    
    # Try title search (case-insensitive, partial match)
    matching = [p for p in cache if identifier.lower() in p['title'].lower()]
    
    if not matching:
        console.print(f"[yellow]No playlists found matching '{identifier}'[/yellow]")
        console.print("[dim]Run 'metube playlist discover' to see available playlists[/dim]")
        return None
    
    if len(matching) == 1:
        console.print(f"[dim]Using playlist: {matching[0]['title']}[/dim]")
        return matching[0]['playlist_id']
    
    # Multiple matches - show them
    console.print(f"[yellow]Multiple playlists match '{identifier}':[/yellow]")
    for idx, p in enumerate(matching, 1):
        console.print(f"  {idx}. {p['title']} ({p['video_count']} videos)")
    console.print("[dim]Please be more specific or use the playlist number from 'metube playlist discover'[/dim]")
    return None


# Default configuration
DEFAULT_CONFIG = {
    'api': {
        'youtube_credentials': 'client_secret.json',
        'token_file': 'token.json',
        'gemini_api_key': os.getenv('GEMINI_API_KEY'),
        'gemini_model': 'gemini-3-flash-preview',
        'rate_limit_delay': 0.3
    },
    'database': {
        'path': os.getenv('DATABASE_PATH', 'data/metube.db')
    },
    'extraction': {
        'auto_transcript': True,
        'auto_llm_parse': True,
        'filter_shorts_only': False,
        'languages': ['en', 'en-GB', 'en-US']
    },
    'reports': {
        'output_dir': os.getenv('REPORTS_DIR', 'reports/')
    }
}


def load_config() -> dict:
    """Load configuration from config.yaml or use defaults"""
    config_path = Path('config/config.yaml')
    
    if config_path.exists():
        with open(config_path, 'r') as f:
            config = yaml.safe_load(f)
            # Merge with defaults
            for key in DEFAULT_CONFIG:
                if key not in config:
                    config[key] = DEFAULT_CONFIG[key]
            
            # Substitute environment variables in config
            config = _substitute_env_vars(config)
            return config
    
    return DEFAULT_CONFIG


def _substitute_env_vars(config: dict) -> dict:
    """Recursively substitute ${VAR_NAME} with environment variable values"""
    import re
    
    def substitute_value(value):
        if isinstance(value, str):
            # Match ${VAR_NAME} pattern
            pattern = r'\$\{([^}]+)\}'
            matches = re.findall(pattern, value)
            for var_name in matches:
                env_value = os.getenv(var_name)
                if env_value:
                    value = value.replace(f'${{{var_name}}}', env_value)
            return value
        elif isinstance(value, dict):
            return {k: substitute_value(v) for k, v in value.items()}
        elif isinstance(value, list):
            return [substitute_value(item) for item in value]
        else:
            return value
    
    return substitute_value(config)


@click.group()
@click.version_option(version='0.1.0')
def cli():
    """YouTube Shorts Extractor - Extract, analyse, and report on YouTube videos"""
    pass


@cli.command()
@click.option('--force', is_flag=True, help='Force re-authentication')
def init(force):
    """Initialize application (OAuth + Database)"""
    console.print("\n[bold blue]YouTube Shorts Extractor - Initialisation[/bold blue]\n")
    
    config = load_config()
    
    # Step 1: Setup database
    console.print("[cyan]Setting up database...[/cyan]")
    db_manager = init_database(config['database']['path'])
    console.print(f"[green]OK[/green] Database initialised: {config['database']['path']}\n")
    
    # Step 2: Setup OAuth
    console.print("[cyan]Setting up YouTube authentication...[/cyan]")
    
    credentials_file = config['api']['youtube_credentials']
    if not os.path.exists(credentials_file):
        console.print(f"[red]Error: Credentials file not found: {credentials_file}[/red]")
        console.print("\n[yellow]Please follow these steps:[/yellow]")
        console.print("1. Go to https://console.cloud.google.com")
        console.print("2. Create/select a project")
        console.print("3. Enable YouTube Data API v3")
        console.print("4. Create OAuth 2.0 Client ID (Desktop application)")
        console.print("5. Download credentials and save as 'client_secret.json'\n")
        sys.exit(1)
    
    auth_handler = YouTubeAuthHandler(
        credentials_file=credentials_file,
        token_file=config['api']['token_file']
    )
    
    if auth_handler.authenticate(force_reauth=force):
        console.print("[green]OK[/green] YouTube authentication successful\n")
        
        # Get channel info
        channel_info = auth_handler.get_channel_info()
        if channel_info:
            snippet = channel_info['snippet']
            console.print(f"[bold]Authenticated as:[/bold] {snippet['title']}")
    else:
        console.print("[red]X[/red] YouTube authentication failed\n")
        sys.exit(1)
    
    # Step 3: Check Gemini API key
    if config['api']['gemini_api_key']:
        console.print("[green]OK[/green] Gemini API key configured\n")
    else:
        console.print("[yellow][WARN][/yellow] Gemini API key not set (LLM parsing will be disabled)")
        console.print("  Set GEMINI_API_KEY in .env file\n")
    
    console.print("[bold green]OK Initialisation complete![/bold green]\n")


@cli.group()
def video():
    """Manage individual videos"""
    pass


@video.command('add')
@click.argument('url_or_id')
@click.option('--no-transcript', is_flag=True, help='Skip transcript extraction')
@click.option('--no-llm', is_flag=True, help='Skip LLM parsing')
def video_add(url_or_id, no_transcript, no_llm):
    """Extract and analyse a single video"""
    config = load_config()
    
    # Initialize components
    auth_handler = YouTubeAuthHandler(
        config['api']['youtube_credentials'],
        config['api']['token_file']
    )
    
    if not auth_handler.authenticate():
        console.print("[red]Authentication failed. Run 'metube init' first.[/red]")
        sys.exit(1)
    
    youtube_client = YouTubeClient(auth_handler, config['api']['rate_limit_delay'])
    db_manager = get_db_manager(config['database']['path'])
    
    # Extract video ID
    video_id = youtube_client.extract_video_id(url_or_id)
    if not video_id:
        console.print(f"[red]Invalid video URL or ID: {url_or_id}[/red]")
        sys.exit(1)
    
    # Create extractor
    extractor = VideoExtractor(
        youtube_client,
        db_manager,
        auto_transcript=config['extraction']['auto_transcript'] and not no_transcript,
        auto_llm_parse=config['extraction']['auto_llm_parse'] and not no_llm,
        gemini_api_key=config['api']['gemini_api_key'],
        languages=config['extraction']['languages'],
        config=config
    )
    
    # Extract video
    result = extractor.extract_single_video(video_id)
    
    if result:
        # Generate report
        console.print("[cyan]Generating HTML report...[/cyan]")
        generator = HTMLReportGenerator(db_manager, output_dir=config['reports']['output_dir'])
        report_path = generator.generate_video_report(video_id)
        
        if report_path:
            console.print(f"[green]OK[/green] Report saved: {report_path}")


@cli.group()
def playlist():
    """Manage playlists"""
    pass


@playlist.command('add')
@click.argument('url_or_id_or_title', required=False)
@click.option('--search', '-s', help='Search for playlist by title')
def playlist_add(url_or_id_or_title, search):
    """Add a playlist to track (by URL, ID, or search by title)"""
    config = load_config()
    
    auth_handler = YouTubeAuthHandler(
        config['api']['youtube_credentials'],
        config['api']['token_file']
    )
    
    if not auth_handler.authenticate():
        console.print("[red]Authentication failed. Run 'metube init' first.[/red]")
        sys.exit(1)
    
    youtube_client = YouTubeClient(auth_handler)
    db_manager = get_db_manager(config['database']['path'])
    
    # Check if it's a number referring to cached playlists
    if url_or_id_or_title and url_or_id_or_title.isdigit():
        cache = load_playlist_cache()
        if cache:
            try:
                num = int(url_or_id_or_title)
                if 1 <= num <= len(cache):
                    playlist_info = cache[num - 1]
                    playlist_id = playlist_info['playlist_id']
                    
                    console.print(f"\n[cyan]Using cached playlist #{num}:[/cyan]")
                    console.print(f"  Title: {playlist_info['title']}")
                    console.print(f"  Videos: {playlist_info['video_count']}")
                    
                    # Skip to saving
                    with db_manager.get_session() as session:
                        PlaylistRepository.create_or_update(session, {
                            'playlist_id': playlist_id,
                            'title': playlist_info['title'],
                            'description': playlist_info.get('description', ''),
                            'video_count': playlist_info['video_count']
                        })
                    
                    console.print(f"\n[bold green]OK Playlist tracked![/bold green]")
                    console.print(f"Extract videos with: metube extract {playlist_id}")
                    return
                else:
                    console.print(f"[red]Invalid cache number: {num} (only 1-{len(cache)} available)[/red]")
                    console.print("[dim]Run 'metube playlist discover' to refresh cache[/dim]")
                    return
            except ValueError:
                pass
        else:
            console.print("[yellow]No playlist cache found[/yellow]")
            console.print("[dim]Run 'metube playlist discover' first to cache your playlists[/dim]")
            return
    
    # If search term provided, search through user's playlists
    search_term = search or url_or_id_or_title
    
    if search_term and not (search_term.startswith('http') or search_term.startswith('PL')):
        # Treat as search term
        console.print(f"\n[cyan]Searching for playlists matching: '{search_term}'[/cyan]")
        playlists = youtube_client.get_my_playlists()
        
        # Filter by search term (case-insensitive)
        matching = [p for p in playlists if search_term.lower() in p['title'].lower()]
        
        if not matching:
            console.print(f"[yellow]No playlists found matching '{search_term}'[/yellow]")
            return
        
        if len(matching) == 1:
            # Auto-select if only one match
            playlist_info = matching[0]
            playlist_id = playlist_info['playlist_id']
        else:
            # Show matches and let user choose
            console.print(f"\n[green]Found {len(matching)} matching playlists:[/green]\n")
            for idx, p in enumerate(matching, 1):
                console.print(f"  {idx}. {p['title']} ({p['video_count']} videos)")
            
            console.print("\n[cyan]Enter number to add (or 'all' for all matches):[/cyan]")
            selection = input("> ").strip()
            
            if not selection:
                console.print("[yellow]No selection made[/yellow]")
                return
            
            if selection.lower() == 'all':
                # Add all matches
                for p in matching:
                    with db_manager.get_session() as session:
                        PlaylistRepository.create_or_update(session, {
                            'playlist_id': p['playlist_id'],
                            'title': p['title'],
                            'description': p.get('description', ''),
                            'video_count': p['video_count']
                        })
                    console.print(f"[green]OK[/green] Added: {p['title'][:60]}")
                console.print(f"\n[bold green]OK Added {len(matching)} playlists![/bold green]")
                return
            
            try:
                num = int(selection)
                if 1 <= num <= len(matching):
                    playlist_info = matching[num - 1]
                    playlist_id = playlist_info['playlist_id']
                else:
                    console.print(f"[red]Invalid selection: {num}[/red]")
                    return
            except ValueError:
                console.print("[red]Invalid input. Please enter a number.[/red]")
                return
    else:
        # Traditional ID/URL approach
        if not url_or_id_or_title:
            console.print("[red]Please provide a playlist URL, ID, or search term[/red]")
            console.print("[dim]Examples:[/dim]")
            console.print("[dim]  metube playlist add <URL>[/dim]")
            console.print("[dim]  metube playlist add <ID>[/dim]")
            console.print("[dim]  metube playlist add 'My Playlist Name'[/dim]")
            console.print("[dim]  metube playlist add --search 'Shorts'[/dim]")
            return
        
        # Extract playlist ID
        playlist_id = youtube_client.extract_playlist_id(url_or_id_or_title)
        if not playlist_id:
            console.print(f"[red]Invalid playlist URL or ID: {url_or_id_or_title}[/red]")
            sys.exit(1)
        
        # Get playlist info
        playlist_info = youtube_client.get_playlist_info(playlist_id)
        if not playlist_info:
            console.print(f"[red]Playlist not found: {playlist_id}[/red]")
            sys.exit(1)
    
    # Save to database
    with db_manager.get_session() as session:
        PlaylistRepository.create_or_update(session, {
            'playlist_id': playlist_id,
            'title': playlist_info['title'],
            'description': playlist_info.get('description', ''),
            'video_count': playlist_info['video_count']
        })
    
    console.print(f"\n[green]OK[/green] Playlist added: [bold]{playlist_info['title']}[/bold]")
    console.print(f"  ID: {playlist_id}")
    console.print(f"  Videos: {playlist_info['video_count']}\n")


@playlist.command('list')
def playlist_list():
    """List all tracked playlists"""
    config = load_config()
    db_manager = get_db_manager(config['database']['path'])
    
    with db_manager.get_session() as session:
        playlists = PlaylistRepository.get_all(session, enabled_only=False)
        
        if not playlists:
            console.print("[yellow]No playlists tracked yet.[/yellow]")
            console.print("Add a playlist with: metube playlist add <URL>")
            return
        
        # Build table data within session
        table = Table(title="Tracked Playlists")
        table.add_column("Playlist ID", style="cyan")
        table.add_column("Title", style="white")
        table.add_column("Videos", justify="right", style="green")
        table.add_column("Status", style="yellow")
        
        for playlist in playlists:
            status = "OK Active" if playlist.enabled else "X Disabled"
            table.add_row(
                playlist.playlist_id,
                playlist.title[:50],
                str(playlist.video_count),
                status
            )
    
    console.print(table)


@playlist.command('videos')
@click.argument('playlist_identifier')
def playlist_videos(playlist_identifier):
    """Show numbered list of videos in a playlist
    
    Examples:
      metube playlist videos 6        # Playlist #6 from cache
      metube playlist videos Ai       # Playlist by title
      metube playlist videos PLxxx    # Full playlist ID
    """
    config = load_config()
    db_manager = get_db_manager(config['database']['path'])
    
    # Resolve playlist identifier
    playlist_id = resolve_playlist_identifier(playlist_identifier, db_manager)
    if not playlist_id:
        sys.exit(1)
    
    # Get videos from database
    with db_manager.get_session() as session:
        from .database.repository import PlaylistItemRepository
        
        # Get playlist info
        playlist_obj = PlaylistRepository.get_by_id(session, playlist_id)
        if not playlist_obj:
            console.print(f"[red]Playlist not found in database: {playlist_id}[/red]")
            console.print("[dim]Run 'metube extract {0}' first to extract this playlist[/dim]".format(playlist_identifier))
            sys.exit(1)
        
        # Get video list
        video_ids = PlaylistItemRepository.get_videos_in_playlist(session, playlist_id)
        
        if not video_ids:
            console.print(f"[yellow]No videos found in playlist '{playlist_obj.title}'[/yellow]")
            console.print("[dim]Run 'metube extract {0}' to extract videos[/dim]".format(playlist_identifier))
            return
        
        # Get video details
        videos_data = []
        for video_id in video_ids:
            video = VideoRepository.get_by_video_id(session, video_id)
            if video:
                # Sanitize title for PowerShell display
                safe_title = video.title.encode('ascii', 'replace').decode('ascii')
                videos_data.append({
                    'video_id': video.video_id,
                    'title': safe_title,
                    'duration_seconds': video.duration_seconds,
                    'has_transcript': video.transcript is not None
                })
        
        # Cache the video list
        save_video_cache(playlist_id, videos_data)
        
        # Display table
        table = Table(title=f"Videos in: {playlist_obj.title}")
        table.add_column("#", style="dim", width=4)
        table.add_column("Title", style="white")
        table.add_column("Duration", justify="right", style="cyan")
        table.add_column("Video ID", style="dim")
        table.add_column("Transcript", justify="center", style="green")
        
        for idx, video in enumerate(videos_data, 1):
            duration = f"{video['duration_seconds']}s"
            transcript_status = "OK" if video['has_transcript'] else "X"
            table.add_row(
                str(idx),
                video['title'][:50],
                duration,
                video['video_id'],
                transcript_status
            )
        
        console.print(table)
        console.print(f"\n[dim]Generate report: metube report {playlist_identifier} <video_number>[/dim]")
        console.print(f"[dim]Example: metube report {playlist_identifier} 1[/dim]")


@playlist.command('remove')
@click.argument('playlist_id')
def playlist_remove(playlist_id):
    """Remove a playlist from tracking"""
    config = load_config()
    db_manager = get_db_manager(config['database']['path'])
    
    with db_manager.get_session() as session:
        playlist_obj = PlaylistRepository.get_by_id(session, playlist_id)
        
        if not playlist_obj:
            console.print(f"[red]Playlist not found: {playlist_id}[/red]")
            sys.exit(1)
        
        PlaylistRepository.delete(session, playlist_id)
    
    console.print(f"[green]OK[/green] Playlist removed: {playlist_id}")


@playlist.command('discover')
@click.option('--privacy', type=click.Choice(['all', 'public', 'private', 'unlisted']), default='all',
              help='Filter by privacy status')
@click.option('--interactive', '-i', is_flag=True, help='Interactively select playlists to add')
def playlist_discover(privacy, interactive):
    """Discover all playlists from your YouTube account"""
    config = load_config()
    
    auth_handler = YouTubeAuthHandler(
        config['api']['youtube_credentials'],
        config['api']['token_file']
    )
    
    if not auth_handler.authenticate():
        console.print("[red]Authentication failed. Run 'metube init' first.[/red]")
        sys.exit(1)
    
    youtube_client = YouTubeClient(auth_handler)
    
    console.print("\n[cyan]Fetching your playlists from YouTube...[/cyan]")
    playlists = youtube_client.get_my_playlists()
    
    if not playlists:
        console.print("[yellow]No playlists found in your account.[/yellow]")
        return
    
    # Filter by privacy if specified
    if privacy != 'all':
        playlists = [p for p in playlists if p.get('privacy_status') == privacy]
    
    # Check which are already tracked
    db_manager = get_db_manager(config['database']['path'])
    with db_manager.get_session() as session:
        tracked = {p.playlist_id for p in PlaylistRepository.get_all(session, enabled_only=False)}
    
    # Display in a table with numbers (always shown for easy reference)
    table = Table(title=f"Your YouTube Playlists ({len(playlists)} found)")
    table.add_column("#", style="dim", width=4)
    table.add_column("Title", style="white")
    table.add_column("Videos", justify="right", style="green")
    table.add_column("Privacy", style="yellow")
    table.add_column("Tracked", style="magenta")
    
    for idx, playlist in enumerate(playlists, 1):
        is_tracked = "OK" if playlist['playlist_id'] in tracked else "X"
        table.add_row(
            str(idx),
            playlist['title'][:60],
            str(playlist['video_count']),
            playlist.get('privacy_status', 'unknown'),
            is_tracked
        )
    
    console.print(table)
    
    # Save to cache for easy reference later
    save_playlist_cache(playlists)
    console.print(f"\n[dim]Cached {len(playlists)} playlists - use numbers with 'metube playlist add <number>'[/dim]")
    
    if interactive:
        console.print("\n[cyan]Enter playlist numbers to add (comma-separated), or 'all' to add all:[/cyan]")
        console.print("[dim]Example: 1,3,5 or all[/dim]")
        selection = input("> ").strip()
        
        if not selection:
            console.print("[yellow]No selection made[/yellow]")
            return
        
        playlists_to_add = []
        
        if selection.lower() == 'all':
            playlists_to_add = [p for p in playlists if p['playlist_id'] not in tracked]
        else:
            try:
                numbers = [int(n.strip()) for n in selection.split(',')]
                for num in numbers:
                    if 1 <= num <= len(playlists):
                        if playlists[num - 1]['playlist_id'] not in tracked:
                            playlists_to_add.append(playlists[num - 1])
                    else:
                        console.print(f"[yellow]Skipping invalid number: {num}[/yellow]")
            except ValueError:
                console.print("[red]Invalid input. Please enter numbers separated by commas.[/red]")
                return
        
        if not playlists_to_add:
            console.print("[yellow]No new playlists to add[/yellow]")
            return
        
        console.print(f"\n[cyan]Adding {len(playlists_to_add)} playlists...[/cyan]\n")
        
        for playlist in playlists_to_add:
            with db_manager.get_session() as session:
                PlaylistRepository.create_or_update(session, {
                    'playlist_id': playlist['playlist_id'],
                    'title': playlist['title'],
                    'description': playlist.get('description', ''),
                    'video_count': playlist['video_count']
                })
            console.print(f"[green]OK[/green] Added: {playlist['title'][:60]}")
        
        console.print(f"\n[bold green]OK Added {len(playlists_to_add)} playlists![/bold green]")
    else:
        console.print(f"\n[dim]Use 'metube playlist add-mine' to add all playlists automatically[/dim]")
        console.print(f"[dim]Or use 'metube playlist discover -i' for interactive selection[/dim]")


@playlist.command('add-mine')
@click.option('--privacy', type=click.Choice(['all', 'public', 'private', 'unlisted']), default='all',
              help='Filter by privacy status')
@click.option('--skip-existing', is_flag=True, default=True, help='Skip already tracked playlists')
def playlist_add_mine(privacy, skip_existing):
    """Automatically add all playlists from your YouTube account"""
    config = load_config()
    
    auth_handler = YouTubeAuthHandler(
        config['api']['youtube_credentials'],
        config['api']['token_file']
    )
    
    if not auth_handler.authenticate():
        console.print("[red]Authentication failed. Run 'metube init' first.[/red]")
        sys.exit(1)
    
    youtube_client = YouTubeClient(auth_handler)
    db_manager = get_db_manager(config['database']['path'])
    
    console.print("\n[cyan]Fetching your playlists from YouTube...[/cyan]")
    playlists = youtube_client.get_my_playlists()
    
    if not playlists:
        console.print("[yellow]No playlists found in your account.[/yellow]")
        return
    
    # Filter by privacy if specified
    if privacy != 'all':
        playlists = [p for p in playlists if p.get('privacy_status') == privacy]
        console.print(f"[dim]Filtered to {len(playlists)} {privacy} playlists[/dim]")
    
    # Get already tracked playlists
    with db_manager.get_session() as session:
        tracked = {p.playlist_id for p in PlaylistRepository.get_all(session, enabled_only=False)}
    
    # Filter out already tracked if requested
    if skip_existing:
        playlists_to_add = [p for p in playlists if p['playlist_id'] not in tracked]
        skipped = len(playlists) - len(playlists_to_add)
        if skipped > 0:
            console.print(f"[yellow]Skipping {skipped} already tracked playlists[/yellow]")
    else:
        playlists_to_add = playlists
    
    if not playlists_to_add:
        console.print("[green]All playlists are already tracked![/green]")
        return
    
    console.print(f"\n[cyan]Adding {len(playlists_to_add)} playlists...[/cyan]\n")
    
    added_count = 0
    for playlist in playlists_to_add:
        with db_manager.get_session() as session:
            PlaylistRepository.create_or_update(session, {
                'playlist_id': playlist['playlist_id'],
                'title': playlist['title'],
                'description': playlist.get('description', ''),
                'video_count': playlist['video_count']
            })
        
        console.print(f"[green]OK[/green] Added: {playlist['title'][:60]} ({playlist['video_count']} videos)")
        added_count += 1
    
    console.print(f"\n[bold green]OK Added {added_count} playlists![/bold green]")
    console.print(f"[dim]Run 'metube playlist list' to see all tracked playlists[/dim]")


@playlist.command('sync')
@click.option('--remove-deleted', is_flag=True, help='Remove playlists that no longer exist')
def playlist_sync(remove_deleted):
    """Sync tracked playlists with your YouTube account"""
    config = load_config()
    
    auth_handler = YouTubeAuthHandler(
        config['api']['youtube_credentials'],
        config['api']['token_file']
    )
    
    if not auth_handler.authenticate():
        console.print("[red]Authentication failed. Run 'metube init' first.[/red]")
        sys.exit(1)
    
    youtube_client = YouTubeClient(auth_handler)
    db_manager = get_db_manager(config['database']['path'])
    
    console.print("\n[cyan]Syncing with YouTube account...[/cyan]")
    
    # Get playlists from YouTube
    youtube_playlists = youtube_client.get_my_playlists()
    youtube_ids = {p['playlist_id'] for p in youtube_playlists}
    
    # Get tracked playlists from database
    with db_manager.get_session() as session:
        tracked_playlists = PlaylistRepository.get_all(session, enabled_only=False)
        tracked_ids = {p.playlist_id for p in tracked_playlists}
    
    # Find new playlists
    new_ids = youtube_ids - tracked_ids
    
    if new_ids:
        console.print(f"\n[green]Found {len(new_ids)} new playlists[/green]")
        for playlist in youtube_playlists:
            if playlist['playlist_id'] in new_ids:
                with db_manager.get_session() as session:
                    PlaylistRepository.create_or_update(session, {
                        'playlist_id': playlist['playlist_id'],
                        'title': playlist['title'],
                        'description': playlist.get('description', ''),
                        'video_count': playlist['video_count']
                    })
                console.print(f"  [green]OK[/green] Added: {playlist['title'][:60]}")
    else:
        console.print("[green]No new playlists to add[/green]")
    
    # Find deleted playlists
    deleted_ids = tracked_ids - youtube_ids
    
    if deleted_ids:
        console.print(f"\n[yellow]Found {len(deleted_ids)} playlists no longer in your account[/yellow]")
        
        if remove_deleted:
            for playlist_id in deleted_ids:
                with db_manager.get_session() as session:
                    playlist = PlaylistRepository.get_by_id(session, playlist_id)
                    if playlist:
                        console.print(f"  [red]X[/red] Removed: {playlist.title[:60]}")
                        PlaylistRepository.delete(session, playlist_id)
        else:
            console.print(f"  [dim]Use --remove-deleted flag to remove them from tracking[/dim]")
    
    console.print(f"\n[bold green]OK Sync complete![/bold green]")


@cli.command()
@click.argument('playlist_id_or_all')
@click.option('--reprocess', is_flag=True, help='Reprocess all videos (default: skip existing)')
@click.option('--max-videos', type=int, help='Maximum number of videos to process')
def extract(playlist_id_or_all, reprocess, max_videos):
    """
    Extract videos from a playlist (skips already extracted videos by default)
    
    PLAYLIST_ID_OR_ALL can be:
    - A number (1-N) from 'metube playlist discover'
    - A playlist title (e.g., 'Ai' or 'Electronics')
    - A full YouTube playlist ID (PLxxx...)
    - A YouTube playlist URL
    - '--all' to process all tracked playlists
    
    Use --reprocess to force re-extraction of all videos
    """
    config = load_config()
    
    auth_handler = YouTubeAuthHandler(
        config['api']['youtube_credentials'],
        config['api']['token_file']
    )
    
    if not auth_handler.authenticate():
        console.print("[red]Authentication failed. Run 'metube init' first.[/red]")
        sys.exit(1)
    
    youtube_client = YouTubeClient(auth_handler, config['api']['rate_limit_delay'])
    db_manager = get_db_manager(config['database']['path'])
    
    # Get playlists to process
    if playlist_id_or_all == '--all':
        with db_manager.get_session() as session:
            playlists = PlaylistRepository.get_all(session, enabled_only=True)
        
        if not playlists:
            console.print("[yellow]No playlists to process.[/yellow]")
            return
        
        playlist_ids = [p.playlist_id for p in playlists]
    else:
        # Resolve playlist identifier (number, title, or ID)
        resolved_id = resolve_playlist_identifier(playlist_id_or_all, db_manager)
        if not resolved_id:
            sys.exit(1)
        playlist_ids = [resolved_id]
    
    # Create extractor
    extractor = VideoExtractor(
        youtube_client,
        db_manager,
        auto_transcript=config['extraction']['auto_transcript'],
        auto_llm_parse=config['extraction']['auto_llm_parse'],
        gemini_api_key=config['api']['gemini_api_key'],
        languages=config['extraction']['languages'],
        config=config
    )
    
    # Process each playlist
    for playlist_id in playlist_ids:
        result = extractor.extract_playlist(
            playlist_id,
            skip_existing=not reprocess,  # Default: skip existing (True), with --reprocess: process all (False)
            max_videos=max_videos
        )


@cli.command()
@click.argument('playlist_or_video', required=False)
@click.argument('video_number', required=False)
@click.option('--playlist', '-p', help='Generate reports for playlist (number, title, or ID)')
@click.option('--playlist-summary', '-ps', help='Generate single consolidated report for playlist')
@click.option('--all', 'generate_all', is_flag=True, help='Generate reports for all videos')
def report(playlist_or_video, video_number, playlist, playlist_summary, generate_all):
    """
    Generate HTML report for a video or playlist
    
    Examples:
      metube report dQw4w9WgXcQ          # Single video by ID
      metube report 6 18                 # Playlist #6, video #18
      metube report --all                # All videos
      metube report -p 6                 # Individual reports for all videos in playlist #6
      metube report -ps 6                # Single consolidated playlist report
      metube report -ps Ai               # Playlist summary by title
    """
    config = load_config()
    db_manager = get_db_manager(config['database']['path'])
    generator = HTMLReportGenerator(db_manager, output_dir=config['reports']['output_dir'])
    
    # Handle new syntax: metube report <playlist_id> <video_num>
    if playlist_or_video and video_number:
        # Resolve playlist
        resolved_playlist_id = resolve_playlist_identifier(playlist_or_video, db_manager)
        if not resolved_playlist_id:
            sys.exit(1)
        
        # Load video cache for this playlist
        videos_cache = load_video_cache(resolved_playlist_id)
        
        if not videos_cache:
            console.print(f"[yellow]No cached videos for playlist '{playlist_or_video}'[/yellow]")
            console.print(f"[dim]Run 'metube playlist videos {playlist_or_video}' first to cache video list[/dim]")
            sys.exit(1)
        
        # Parse video number
        try:
            video_idx = int(video_number)
            if not (1 <= video_idx <= len(videos_cache)):
                console.print(f"[red]Invalid video number: {video_number} (1-{len(videos_cache)} available)[/red]")
                console.print(f"[dim]Run 'metube playlist videos {playlist_or_video}' to see available videos[/dim]")
                sys.exit(1)
            
            # Get video ID from cache
            video_id = videos_cache[video_idx - 1]['video_id']
            video_title = videos_cache[video_idx - 1]['title']
            
            console.print(f"[cyan]Generating report for: {video_title}[/cyan]")
            
            # Generate report
            report_path = generator.generate_video_report(video_id)
            if report_path:
                console.print(f"\n[green]OK[/green] Report generated: {report_path}")
                
                # Try to open in browser
                try:
                    import webbrowser
                    webbrowser.open(f'file://{os.path.abspath(report_path)}')
                except:
                    pass
            return
            
        except ValueError:
            console.print(f"[red]Invalid video number: '{video_number}' (must be a number)[/red]")
            sys.exit(1)
    
    if generate_all:
        # Generate reports for all videos
        with db_manager.get_session() as session:
            videos = VideoRepository.get_all(session)
            # Extract data we need before session closes
            video_list = [(v.video_id, v.title) for v in videos]
        
        console.print(f"[cyan]Generating reports for {len(video_list)} videos...[/cyan]")
        
        for video_id, video_title in video_list:
            report_path = generator.generate_video_report(video_id)
            if report_path:
                console.print(f"[green]OK[/green] {video_title[:50]}")
        
        console.print(f"\n[bold green]OK Generated {len(video_list)} reports[/bold green]")
    
    elif playlist_summary:
        # Generate single consolidated playlist report
        resolved_playlist_id = resolve_playlist_identifier(playlist_summary, db_manager)
        if not resolved_playlist_id:
            sys.exit(1)
        
        console.print(f"\n[cyan]Generating consolidated playlist report...[/cyan]")
        
        report_path = generator.generate_playlist_report(resolved_playlist_id)
        if report_path:
            console.print(f"\n[green]OK[/green] Playlist report generated: {report_path}")
            
            # Try to open in browser
            try:
                import webbrowser
                webbrowser.open(f'file://{os.path.abspath(report_path)}')
            except:
                pass
    
    elif playlist:
        # Resolve playlist identifier (number, title, or ID)
        resolved_playlist_id = resolve_playlist_identifier(playlist, db_manager)
        if not resolved_playlist_id:
            sys.exit(1)
        
        # Generate reports for playlist
        with db_manager.get_session() as session:
            from .database.repository import PlaylistItemRepository
            video_ids = PlaylistItemRepository.get_videos_in_playlist(session, resolved_playlist_id)
        
        console.print(f"[cyan]Generating reports for {len(video_ids)} videos...[/cyan]")
        
        for video_id in video_ids:
            report_path = generator.generate_video_report(video_id)
            if report_path:
                console.print(f"[green]OK[/green] {video_id}")
        
        console.print(f"\n[bold green]OK Generated {len(video_ids)} reports[/bold green]")
    
    elif playlist_or_video:
        # Generate report for single video (by video ID)
        report_path = generator.generate_video_report(playlist_or_video)
        if report_path:
            console.print(f"\n[green]OK[/green] Report generated: {report_path}")
            
            # Try to open in browser
            try:
                import webbrowser
                webbrowser.open(f'file://{os.path.abspath(report_path)}')
            except:
                pass
    
    else:
        console.print("[red]Please provide arguments[/red]")
        console.print("[dim]Examples:[/dim]")
        console.print("[dim]  metube report dQw4w9WgXcQ    # Single video by ID[/dim]")
        console.print("[dim]  metube report 6 18           # Playlist #6, video #18[/dim]")
        console.print("[dim]  metube report -p 6           # All videos in playlist #6[/dim]")
        console.print("[dim]  metube report -p Ai          # Playlist by title[/dim]")
        console.print("[dim]  metube report --all          # All videos[/dim]")
        sys.exit(1)


if __name__ == '__main__':
    cli()

# Missing Features from Python Version

Based on analysis of the original Python CLI (`src/cli.py`), here are the features we had in the Python version that are not yet implemented in the TypeScript version.

---

## 1. Report Generation (CRITICAL)

### What's Missing:
The entire **HTML report generation system** is not yet ported to TypeScript.

### Python Version Had:
- `metube report <video_id>` - Generate HTML report for a single video
- `metube report <playlist_num> <video_num>` - Generate report using cached video numbers
- `metube report -p <playlist>` - Generate reports for all videos in a playlist
- `metube report -ps <playlist>` - Generate single consolidated playlist report
- `metube report --all` - Generate reports for all videos

### Features Included:
- HTML templates using Jinja2 (now need Handlebars port)
- Video reports with:
  - Full video metadata
  - Formatted transcript with timestamps
  - Extracted entities (GitHub repos, papers, tools, people, URLs)
  - Entity grouping by type
  - Word count statistics
  - Auto-open in browser
- Playlist reports with:
  - Playlist overview and stats
  - All videos with summaries
  - Aggregated entity lists
  - Cross-video insights

### Current Status:
- ❌ No report command in TypeScript CLI
- ❌ No HTMLReportGenerator ported
- ✅ Templates exist (`templates/video_report.html`, `templates/playlist_report.html`)
- ❌ Not integrated with Ink CLI

---

## 2. Video Commands (Individual Video Operations)

### What's Missing:
The entire **`metube video`** command group.

### Python Version Had:
- `metube video add <url_or_id>` - Extract and analyze a single video
  - Skip transcript with `--no-transcript`
  - Skip LLM parsing with `--no-llm`
  - Auto-generate report after extraction

### Current Status:
- ❌ No `video` command group in TypeScript
- ✅ Backend supports single video extraction (`VideoExtractor.extractSingleVideo`)
- ❌ Not exposed via CLI

---

## 3. Advanced Playlist Commands

### What's Missing:
Several playlist management features that existed in Python.

### Python Version Had:

#### a) `metube playlist videos <playlist_identifier>`
- Show numbered list of videos in a playlist
- Display video metadata (title, duration, video ID, transcript status)
- Cache video list for easy reference in other commands
- Support multiple identifier types (number, title, ID)

#### b) `metube playlist add-mine`
- Automatically add ALL playlists from your YouTube account
- Filter by privacy status (`--privacy all|public|private|unlisted`)
- Skip already tracked playlists (`--skip-existing`)
- Batch operation for quick setup

#### c) `metube playlist sync`
- Sync tracked playlists with YouTube account
- Detect new playlists and auto-add them
- Detect deleted playlists
- Option to remove deleted playlists from tracking (`--remove-deleted`)

### Current Status:
- ❌ `playlist videos` - Not implemented
- ❌ `playlist add-mine` - Not implemented  
- ❌ `playlist sync` - Not implemented
- ✅ `playlist discover` - Implemented (similar functionality but manual selection)
- ✅ `playlist list` - Implemented
- ✅ `playlist add` - Implemented (but only one at a time)
- ✅ `playlist remove` - Implemented

---

## 4. Smart Playlist Resolution System

### What's Missing:
The flexible playlist identifier resolution that made the Python CLI very user-friendly.

### Python Version Had:
A `resolve_playlist_identifier()` function that accepted:
1. **Numbers**: `metube extract 6` (refers to playlist #6 from discover cache)
2. **Titles**: `metube extract Ai` (partial title match)
3. **Full IDs**: `metube extract PLxxx...`
4. **URLs**: `metube extract https://youtube.com/playlist?list=PLxxx`

Features:
- Partial title matching (case-insensitive)
- Multiple match handling (shows options)
- Helpful error messages with suggestions
- Consistent across all commands (extract, report, playlist commands)

### Current Status:
- ✅ Basic ID resolution works for extract command
- ❌ No cached playlist number support
- ❌ No title-based lookup
- ❌ Not consistent across all commands

---

## 5. Video Caching System

### What's Missing:
The video cache that made referencing specific videos much easier.

### Python Version Had:
- `save_video_cache(playlist_id, videos)` - Cache videos from a playlist
- `load_video_cache(playlist_id)` - Load cached videos
- Enabled commands like: `metube report 6 18` (playlist #6, video #18)
- Persisted to `data/video_cache.json`

### Current Status:
- ✅ Playlist cache exists (`data/playlist_cache.json`)
- ❌ No video cache functionality
- ❌ Can't reference videos by position number

---

## 6. Interactive Mode Enhancements

### What's Missing (from Python's interactive features):

#### a) Batch Playlist Addition
Python had `metube playlist discover -i` which allowed:
- Select multiple playlists with comma-separated numbers
- Add all playlists with 'all' keyword
- Interactive confirmation before adding

#### b) Multi-Match Title Selection
When multiple playlists matched a title search:
- Show all matches with numbers
- Let user pick specific one
- Suggest being more specific

### Current Status:
- ✅ We have interactive playlist picker in TypeScript
- ❌ Can't select multiple at once
- ✅ Can add playlists one at a time

---

## 7. Configuration Management

### What's Missing:
Advanced config loading and environment variable substitution.

### Python Version Had:
- `load_config()` - Load from `config/config.yaml`
- `_substitute_env_vars()` - Replace `${VAR_NAME}` placeholders
- Merge with defaults
- Support for:
  - API settings (rate limits, model selection)
  - Database path
  - Extraction preferences
  - Report output directory

### Current Status:
- ✅ Basic config loading exists
- ❌ No environment variable substitution
- ❌ Less flexible configuration system

---

## 8. Extract Command Flexibility

### What's Missing:

#### a) `metube extract --all`
- Process all tracked playlists at once
- Only process enabled playlists
- Sequential processing

#### b) Better Reprocess Handling
Python had clear flag: `--reprocess` to force re-extraction
- Default: skip existing (smart deduplication)
- With flag: reprocess everything

### Current Status:
- ❌ No `--all` support
- ✅ `--reprocess` flag exists and works
- ✅ `--max-videos` works

---

## 9. CLI Quality of Life Features

### What's Missing:

#### a) Rich Terminal Output
Python used **Rich library** for:
- Colored, formatted output
- Tables for playlist/video lists
- Progress indicators
- Consistent styling

#### b) Helpful Error Messages
Python CLI had very detailed error messages with:
- Explanation of what went wrong
- Suggested commands to fix it
- Example usage
- Contextual hints

### Current Status:
- ✅ Ink provides good UI components
- ✅ Color scheme established
- ❌ Error messages could be more helpful
- ❌ Some commands lack usage examples

---

## Summary: Priority Order for Implementation

### HIGH PRIORITY (Core Missing Features)
1. **Report Generation** - The main output/analysis feature
   - Port HTMLReportGenerator to TypeScript
   - Implement `report` command group
   - Support video and playlist reports

2. **Playlist Videos Command** - Essential for usability
   - Show videos in a playlist
   - Cache for easy referencing
   - Enable video number-based commands

### MEDIUM PRIORITY (Power User Features)
3. **Advanced Playlist Commands**
   - `playlist add-mine` - Bulk add
   - `playlist sync` - Keep in sync with YouTube
   - `playlist videos` - List and cache

4. **Video Command Group**
   - Single video extraction via CLI
   - Direct video operations

### LOW PRIORITY (Nice to Have)
5. **Smart Resolution System**
   - Number-based playlist references
   - Title-based lookups
   - Better multi-match handling

6. **Configuration Enhancements**
   - Environment variable substitution
   - More flexible config system

7. **CLI Polish**
   - Better error messages
   - More helpful hints
   - Consistent examples

---

## What We DO Have (TypeScript Advantages)

### Modern UI/UX
- ✅ Beautiful Ink-based TUI with sidebar layout
- ✅ Interactive playlist picker with pagination
- ✅ Real-time extraction progress with callbacks
- ✅ Clean color scheme (orange/cyan/grey)
- ✅ Professional splash screen

### Better Architecture
- ✅ React-based component model
- ✅ Better separation of concerns
- ✅ Type safety with TypeScript
- ✅ Modern async/await patterns

### Enhanced REPL Mode
- ✅ Interactive REPL environment
- ✅ Command history in sidebar
- ✅ Real-time status display
- ✅ Cleaner command execution model

---

*Last Updated: 2026-01-26*

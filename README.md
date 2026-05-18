# meTube

Turn YouTube rabbit holes into structured, searchable knowledge — a CLI for people who watch to learn.

![CI](https://github.com/earlyprototype/meTube/actions/workflows/build.yml/badge.svg)

![demo](docs/demo.gif)

## What this is / why I built it

I watch a lot of YouTube. Not passively — I use it as a research tool, following threads across channels, playlists, and topics. The problem is that none of it sticks in a retrievable form. A video mention of a GitHub repo disappears into watch history. A name or concept I meant to follow up on evaporates. The consumption is real; the knowledge capture isn't.

meTube is the tool I built to fix that. It connects to your YouTube account, discovers your playlists, and extracts structured data from every video: full transcripts, GitHub repositories and websites from descriptions, topics and people parsed by Gemini, and summary metadata stored locally in SQLite. The result is a searchable, browseable knowledge base built from your actual watch history — not curated notes you had to write, but extracted automatically.

The differentiating capability is the dual-transcript pipeline. Most YouTube tools use either the YouTube Transcript API or Whisper — meTube uses both, with a graceful fallback. YouTube captions run first: fast, free, no compute. When they fail or are unavailable, Whisper picks up automatically, downloading audio via yt-dlp and transcribing locally. Videos that would otherwise be transcript-less get captured. The pipeline is transparent; you see which path was used per video.

## Current status

- Core extraction pipeline: tested, production-ready
- Database layer (SQLite via better-sqlite3): tested, production-ready
- YouTube API + OAuth authentication: tested, production-ready
- HTML report generation: code complete, never opened in a browser
- Post-extraction interactive menu: implemented, never navigated
- `video add` URL parsing: implemented, edge cases untested
- `playlist videos` cache: implemented, untested
- Whisper fallback: working — but still spawns `python whisper_extractor.py` as a subprocess; removing that Python dependency is Tier 3 architectural work, not done yet

## Quick start

The Whisper fallback requires a Python venv with `openai-whisper` and `ffmpeg` installed alongside the Node install. This is a known rough edge — the Python subprocess invocation is on the roadmap to remove, but it works today if you have a venv set up.

```sh
git clone https://github.com/earlyprototype/meTube
cd meTube
npm install
npm run build
```

Set up Google Cloud OAuth credentials (YouTube Data API v3, Desktop app type), download the credentials file, and save it as `client_secret.json` in the project root. See the [Google Cloud Console](https://console.cloud.google.com).

```sh
cp env.example .env          # then add GEMINI_API_KEY for LLM entity parsing
metube init                  # OAuth flow; writes tokens.json
metube playlist discover     # cache your playlists with short reference numbers
```

You can also use the `mtb` alias for all commands.

## Core commands

| Command | What it does |
|---|---|
| `metube init` | OAuth authentication setup; writes tokens.json |
| `metube playlist discover` | Discover and cache all your YouTube playlists with reference numbers |
| `metube playlist list` | Show tracked playlists |
| `metube playlist add <id>` | Add a playlist by YouTube ID, URL, cache number, or title search |
| `metube playlist videos <id>` | Show numbered video list for a playlist |
| `metube playlist remove <id>` | Stop tracking a playlist |
| `metube extract playlist <id>` | Extract all videos from a playlist (skips already-extracted) |
| `metube extract --all` | Extract all tracked playlists |
| `metube video add <url_or_id>` | Extract a single video by URL or ID |
| `metube report playlist <id>` | Generate HTML report for a playlist |
| `metube report video <id>` | Generate HTML report for a single video |
| `metube` | Start interactive REPL mode |

## Architecture

The canonical implementation is TypeScript, built with Ink for the terminal UI and React component model. Storage is better-sqlite3 (local SQLite, no server). Extraction runs through three layers: YouTube Data API for playlist and video metadata, youtube-transcript for native captions, and a Whisper subprocess (Python) as the audio transcription fallback when captions are unavailable. Entity parsing — topics, people, GitHub repos, websites — runs through Google Gemini. HTML reports are generated from Handlebars templates. The original Python implementation is preserved in `legacy/python/` for reference but is no longer maintained.

## Roadmap

Active board: [GitHub Project #9](https://github.com/users/earlyprototype/projects/9)

In-repo kanban: [`_kanban.md`](_kanban.md)

## License

MIT — see [`LICENSE`](LICENSE) at repo root.

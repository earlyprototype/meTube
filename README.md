# meTube

Turn YouTube rabbit holes into structured, searchable knowledge — a CLI for people who watch to learn.

![CI](https://github.com/earlyprototype/meTube/actions/workflows/build.yml/badge.svg)

## What this is / why I built it

I watch a lot of YouTube — not passively, but as a research tool, following threads across channels, playlists, and topics (I swear!). The problem is that I often lose track of that rigorous hard work. A video mention of a GitHub repo disappears into watch history. A name or concept I meant to follow up on evaporates. The consumption happens; the knowledge capture doesn't.

meTube is the personal-use tool I built to fix that. It connects to my YouTube account, discovers my playlists, and extracts structured data from every video: full transcripts, GitHub repositories and websites from descriptions, topics and people parsed by Gemini, and summary metadata stored locally in SQLite. The result is a searchable, browseable knowledge base built from actual watch history — no more hand-written and carefully filed Post-it dossiers, just automatically extracted, transcribed and curated information, deployable via delightful, interactive HTML reports.

## Dual-transcript pipeline

meTube uses both the YouTube Transcript API and Whisper, with a graceful fallback. YouTube captions run first: fast, free, no compute. If they fail or are unavailable, Whisper picks up automatically, downloading audio via yt-dlp and transcribing locally.

## What ships

| Command | What it does |
|---|---|
| `metube` (no args) | Interactive REPL mode |
| `metube init` | OAuth authentication setup; writes tokens.json |
| `metube playlist discover` | Discover and cache all your YouTube playlists with reference numbers |
| `metube playlist list` | Show tracked playlists |
| `metube playlist add <id>` | Add a playlist by YouTube ID, URL, cache number, or title search |
| `metube playlist add-mine` | Bulk add all your playlists (`--privacy`, `--skip-existing`) |
| `metube playlist sync` | Sync tracked playlists against YouTube (`--remove-deleted`) |
| `metube playlist remove <id>` | Stop tracking a playlist |
| `metube video add <url-or-id>` | Extract a single video by URL or ID |
| `metube extract playlist <id>` | Extract all videos from a playlist (skips already-extracted) |
| `metube extract --all` | Extract every enabled playlist |
| `metube report playlist <id>` | Generate HTML report for a playlist |
| `metube report video <id>` | Generate HTML report for a single video |
| `metube report --all` | Generate reports for every video in the database |

## Quick start

```sh
git clone https://github.com/earlyprototype/meTube
cd meTube
npm install
npm run build
```

Set up Google Cloud OAuth credentials (YouTube Data API v3, Desktop app type), download the credentials file, and save it as `client_secret.json` in the project root. See the [Google Cloud Console](https://console.cloud.google.com).

```sh
cp env.example .env          # add GEMINI_API_KEY for LLM entity parsing
metube init                  # interactive OAuth on http://localhost:3000; writes tokens.json
metube playlist discover     # cache your playlists with short reference numbers
metube playlist add 3        # add by cache number, ID, URL, or title search
metube extract playlist 3    # run the dual-transcript pipeline
metube report playlist 3     # generate the HTML report
```

You can also use the `mtb` alias for all commands.

## Optional: kanbanger MCP for AI sessions

If you run Claude Code (or another MCP-capable client) against this repo, the kanban board at `_kanban.md` syncs through the [kanbanger](https://github.com/earlyprototype/kanbanger) MCP server. The wiring is `.mcp.json`, but that file carries absolute, machine-specific paths so it is gitignored. Copy `.mcp.json.example` to `.mcp.json` and update the `KANBANGER_WORKSPACE` value (and the `command` path if your venv lives elsewhere) before launching your client.

## Architecture

The canonical implementation is TypeScript: Ink (React) for the terminal UI, better-sqlite3 for local storage, googleapis for YouTube Data API, youtube-transcript for native captions, Whisper subprocess for audio fallback, and Google Gemini for entity parsing. HTML reports are Handlebars templates.

Two source trees matter. `src-ts/` is the Ink UI layer — `cli.tsx` is the entry point, with the command screens in `commands/` and shared widgets in `components/` — and it imports the backend directly from `src-ts-v2/`, which owns everything below the UI: database repositories, extractors, the YouTube API client, auth, parsers, and report generation.

## License

MIT — see [`LICENSE`](LICENSE) at repo root.

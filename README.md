# meTube

Turn YouTube rabbit holes into structured, searchable knowledge — a CLI for people who watch to learn.

![CI](https://github.com/earlyprototype/meTube/actions/workflows/build.yml/badge.svg)

![demo](docs/demo.gif)

## What this is / why I built it

I have ADHD. I watch a lot of YouTube — not passively, but as a research tool, following threads across channels, playlists, and topics. The problem is that none of it sticks in a retrievable form. A video mention of a GitHub repo disappears into watch history. A name or concept I meant to follow up on evaporates. The consumption is real; the knowledge capture isn't.

meTube is the personal-use tool I built to fix that. It connects to my YouTube account, discovers my playlists, and extracts structured data from every video: full transcripts, GitHub repositories and websites from descriptions, topics and people parsed by Gemini, and summary metadata stored locally in SQLite. The result is a searchable, browseable knowledge base built from actual watch history — not curated notes I had to write, but extracted automatically.

This is also a portfolio piece. Honesty in this README beats optimism. The status section below names exactly what ships in v1.0.0 and what's deferred.

## The differentiated capability — dual-transcript pipeline

Most YouTube tools use either the YouTube Transcript API or Whisper — meTube uses both, with a graceful fallback. YouTube captions run first: fast, free, no compute. When they fail or are unavailable, Whisper picks up automatically, downloading audio via yt-dlp and transcribing locally. Videos that would otherwise be transcript-less get captured. The pipeline is transparent — you see which path was used per video.

**Architectural irony to know about:** Whisper still spawns `python whisper_extractor.py` as a subprocess. The TS binary is not yet a standalone artifact for the Whisper path — it requires a Python venv with `openai-whisper` and `ffmpeg`. De-Pythonising Whisper is on the post-v1.0.0 roadmap; today it works if you have the venv.

## What v1.0.0 ships

These commands are tested and production-ready:

| Command | What it does |
|---|---|
| `metube init` | OAuth authentication setup; writes tokens.json |
| `metube playlist discover` | Discover and cache all your YouTube playlists with reference numbers |
| `metube playlist list` | Show tracked playlists |
| `metube playlist add <id>` | Add a playlist by YouTube ID, URL, cache number, or title search |
| `metube playlist remove <id>` | Stop tracking a playlist |
| `metube extract playlist <id>` | Extract all videos from a playlist (skips already-extracted) |
| `metube report playlist <id>` | Generate HTML report for a playlist |

## What's deferred to post-v1.0.0

Out of scope for this release, will re-land one at a time gated by tests:

- REPL mode (`metube` with no args)
- `extract --all` flag
- `metube video add <url-or-id>` — single-video extraction
- `playlist add --search "title"` interactive multiselect
- `playlist add-mine` bulk add
- `playlist sync` change-detection
- Whisper de-Python (separate Tier 3 work)

See [`_kanban.md`](_kanban.md) for the live board.

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
metube init                  # interactive OAuth via @google-cloud/local-auth; writes tokens.json
metube playlist discover     # cache your playlists with short reference numbers
metube playlist add 3        # add by cache number, ID, URL, or title search
metube extract playlist 3    # run the dual-transcript pipeline
metube report playlist 3     # generate the HTML report
```

You can also use the `mtb` alias for all commands.

## Optional: kanbanger MCP for AI sessions

If you run Claude Code (or another MCP-capable client) against this repo, the kanban board at `_kanban.md` syncs through the [kanbanger](https://github.com/earlyprototype/kanbanger-partymix) MCP server. The wiring is `.mcp.json`, but that file carries absolute, machine-specific paths so it is gitignored. Copy `.mcp.json.example` to `.mcp.json` and update the `KANBANGER_WORKSPACE` value (and the `command` path if your venv lives elsewhere) before launching your client.

## Architecture

The canonical implementation is TypeScript: Ink (React) for the terminal UI, better-sqlite3 for local storage, googleapis for YouTube Data API, youtube-transcript for native captions, Whisper subprocess for audio fallback, and Google Gemini for entity parsing. HTML reports are Handlebars templates.

For the curious about why the code is shaped this way:

- [`docs/REWRITE_AUDIT.md`](docs/REWRITE_AUDIT.md) — the operational diagnostic that drove the v2 rewrite (14 agents, 6 phases)
- [`docs/adr/0001-rewrite-vs-patch.md`](docs/adr/0001-rewrite-vs-patch.md) — the rewrite-vs-patch decision record
- [`docs/PORT_PLAN.md`](docs/PORT_PLAN.md) — the executable port plan
- [`archive/src-ts-v1/WHY.md`](archive/src-ts-v1/WHY.md) — what the archived v1 backend was and why it's gone

The original Python implementation is preserved in `legacy/python/` for reference. It was the source of truth that v1.0.0 was ported from.

## License

MIT — see [`LICENSE`](LICENSE) at repo root.

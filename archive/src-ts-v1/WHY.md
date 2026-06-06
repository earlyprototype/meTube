# archive/src-ts-v1 — Why this code is here

This directory contains the first TypeScript backend of meTube. It was the canonical implementation between January 2026 and May 2026. It is no longer maintained. It is preserved as reference, not as a code path anyone should import from.

The current canonical backend lives in `src-ts-v2/`. The Ink frontend (`src-ts/cli.tsx`, `commands/`, `components/`) was never archived — it survived the rewrite intact.

This document exists because the project is also a portfolio piece, and a portfolio piece is more honest when the abandoned half is visible and explained than when it's silently deleted. The second-system narrative is part of the artifact.

---

## What was here

- `database/` — `DatabaseManager`, `repositories.ts` (a 979-LOC blob containing 6 repository classes), `models.ts`, migrations stub
- `extractors/` — `VideoExtractor`, `TranscriptExtractor`, `WhisperExtractor`
- `api/` — `YouTubeClient`, `RateLimiter`, `RetryHandler`
- `auth/` — `YouTubeAuth`, `OAuthServer`
- `parsers/` — `DescriptionParser`, `GeminiParser`
- `reports/` — `HTMLReportGenerator`
- `utils/` — `cache`, `playlistResolver`, `validation`, `logger`, `colors`, `terminal`
- `errors/` — `AppError`, `ValidationError`, `DatabaseError`
- `config.ts`

Total: 7,295 LOC. The Python source it was ported from was 4,186 LOC. The TypeScript backend was 74% larger than its Python source for ostensibly the same functionality.

## What was good

Some of this code shipped successfully and the patterns survived into v2:

- The Ink frontend, kept intact, defined a clean 20-method contract surface with the backend. That contract was the stable spec the rewrite ported against.
- `RateLimiter` and `RetryHandler` were correct. Lifted unchanged into v2.
- `OAuthServer` was recently fixed (port 3000, response_type) and worked. Lifted unchanged.
- `DescriptionParser` was regex-only, deterministic, no I/O. Lifted unchanged.
- `errors/` — the `AppError` / `ValidationError` / `DatabaseError` hierarchy was correct. Lifted unchanged.
- `logger.ts` — Pino setup was correct. Lifted unchanged.

The Ink layer in particular was never the problem. It's 3,727 LOC of clean React components defining commands and UI. Zero anti-patterns. It is the keeper artifact across both versions.

## What went wrong — the drift

The v1 backend shipped, but it was structurally untrustworthy. The audit (`docs/REWRITE_AUDIT.md`) catalogued the failure mode in detail. Five specific patterns are worth naming here so future readers don't repeat them:

### 1. `transaction()` existed but was never used

`database/connection.ts:185` correctly wrapped better-sqlite3's transaction primitive. Zero repositories called it. Three write paths (`TranscriptRepository`, entity inserts, statistics snapshots) ran non-atomic `DELETE` then `INSERT` sequences. The plumbing was shipped; nobody joined it. The Python source had `@contextmanager get_session()` for the same purpose — translated structurally, not behaviourally.

### 2. `videoData` typed as `any`, hiding the `playlistId` vs `id` bug class

`VideoExtractor.extractPlaylist` returned `videoData: any`. Downstream `PlaylistAddMine` and `PlaylistSync` then read `p.playlistId` from a `YouTubePlaylist` shape whose field was actually `id`. The compiler said nothing because the upstream type was `any`. Every invocation silently produced corrupt DB rows. This was the bug class the audit named "writer never verified the contract end-to-end."

### 3. `HTMLReportGenerator.getAnalysisData` was a stub returning undefined

`reports/HTMLReportGenerator.ts:391` had a one-line stub: `return undefined; // TODO: Query ai_analysis table`. The HTML reports omitted AI analysis data silently in every run. The companion stub at `:556` (`summary: undefined, // Would come from AI analysis`) made the same surface look complete to a casual reader.

### 4. `getPlaylistVideos` pagination dropped beyond the first 50

`VideoExtractor.ts:322` made a single API call where the YouTube Data API requires `nextPageToken` looping. Playlists with more than 50 videos silently truncated. Fixed late, but the original ship had been live for months.

### 5. `savePlaylistItem` was a 20-line stub that just logged

`VideoExtractor.ts:425` was `// This would use PlaylistItemRepository...` plus a `logger.info` line. Zero `playlist_items` rows ever landed in the DB despite extraction running successfully. Discovered by live testing four months after deploy. The Vitest suite did not catch it because the tests mocked the very call sites that were broken.

### The unifying property

Type-check passed. Build passed. Lint passed. Tests passed (because they mocked the broken call sites). The bugs surfaced only when the code was exercised against a real YouTube account. The codebase had no boundary that failed loudly when shapes drifted.

The audit named this "stubs marked complete" — a pattern, not a list of individual bugs. Same team, same day, shipped both `FEATURE_PARITY_ANALYSIS.md` ("100% parity, READY TO DEPRECATE Python") and `PRODUCTION_READINESS_ASSESSMENT.md` ("stubs marked complete, 670 lines untested"). The contradiction was the documented absence of a shared definition-of-done.

## The decision

After the audit's 14-agent multi-lens review converged on the diagnosis, the rewrite-vs-patch question was resolved in `docs/adr/0001-rewrite-vs-patch.md`. Three findings drove the choice:

1. The LOC math said the rewrite was smaller, not larger. Clean port from Python targeted ~5,500-6,000 TS LOC — below the 7,295 LOC the v1 backend had ballooned to. The bloat was the symptom; clearing it was part of the cure.
2. The bug class was unfixable by patching. "Writer never verified the contract" is a process pattern. Each patch creates the conditions for the next half-bridge. Only a structural change — Zod schemas at every boundary, branded `VideoId` / `PlaylistId`, mandatory `withTransaction<T>` — could foreclose the entire class.
3. The Ink layer survived intact. Only the broken half was replaced. The 20-method contract surface was preserved as the stable spec across the rewrite.

The decision: tightly-scoped rewrite into `src-ts-v2/`, keep Ink as-is, ship v1.0.0 with a frozen scope. Full reasoning in `docs/adr/0001-rewrite-vs-patch.md` and `docs/REWRITE_AUDIT.md`.

## The discipline added in v2

The v2 backend (`src-ts-v2/`) enforces, from day one, the invariants v1 lacked:

1. **`withTransaction<T>(work)` is the only write path.** A test intercepts raw `db.run` calls in repository contexts and fails if any write happens outside `withTransaction`. The "transaction() exists but is unused" pattern is impossible to reproduce.
2. **Zod schemas at every wire boundary.** YouTube API responses, Gemini responses, config files, cache files, command arguments — every external shape parses through Zod before becoming a typed value. The `JSON.parse(...) as ParsedTranscript` blind cast pattern is gone.
3. **Branded `VideoId` and `PlaylistId`.** Constructed via `asVideoId(s)` / `asPlaylistId(s)` validators. Once constructed they cannot be confused with each other at the type level. `p.playlistId` on a `YouTubePlaylist` is a compile error.
4. **No `any` in v2 code.** `unknown` at boundaries, narrowed via Zod or type guards. A pre-commit hook enforces it. The class of `: any`-disguised holes is closed at the file boundary.
5. **Self-bootstrapping schema.** `initDatabase()` creates all tables from `src-ts-v2/database/schema.ts`. The "Please use Python version to initialize schema" error message from v1's `connection.ts:228` is gone.
6. **Pino-only logging.** Zero `console.log` / `console.error` in `src-ts-v2/`. Pre-commit hook enforces.
7. **Stub-bomb pre-commit hook.** Rejects diff lines matching `// TODO: implement`, `// This would`, `// For now,? just log`, `return undefined; *// (placeholder|stub|will|todo)`, `: any\s*[=)]` on critical paths. Bypassable via `[stub-allowed]` in commit message, paired with a kanban follow-up.

There is also a workflow change. All implementation in the v2 cycle goes through `Agent(model: "opus", ...)` calls. The orchestrator (the AI session driving the work) never directly Edit/Writes production code. The audit pattern that produced the diagnosis (14 agents, parallel reviews, multi-lens convergence) is the same pattern that produced the implementation. This is recorded in `CLAUDE.md`.

## A note on use

This code is reference only. It is not maintained. It does not compile against the current build target. Imports from this directory will not resolve from `src-ts-v2/` because the swap at the end of Wave 4 re-pointed all the Ink layer's imports.

If you are reading this code to understand the project's history — what was tried, what shipped, what didn't hold — that is what it is here for. If you are looking for canonical behaviour, read `src-ts-v2/`.

The Python source at `legacy/python/src/` is also preserved as reference. It was the porting target for v2 after Phase 1 cleaned five identified issues. Python is the ancestor of both the dead v1 backend and the canonical v2 backend.

---

*End of WHY.md*

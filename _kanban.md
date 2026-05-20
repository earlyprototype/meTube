# meTube — v2 Cycle Kanban

> Phase 1 fix Python → Phase 2 port to `src-ts-v2/` → Phase 3 polish.
> Decision locked 2026-05-20.
>
> See `~/.claude/plans/enumerated-doodling-melody.md` for the full plan,
> `docs/HANDOVER-2026-05-20-planning.md` for the session handover,
> and `_archivedkanban.md` for the pre-v2 (Tier 0-4 era) kanban.

## BACKLOG

*   [ ] [Phase 3] REPL mode — lift `src-ts/components/ReplMode.tsx` unchanged into `src-ts-v2/components/`
*   [ ] [Phase 3] Whisper de-Python — replace `python whisper_extractor.py` subprocess with `nodejs-whisper` (Node bindings to whisper.cpp); closes the architectural irony
*   [ ] [Phase 3] Single-video command — `metube video add <url-or-id>`
*   [ ] [Phase 3] `playlist add-mine` bulk import — designed in cleanly with branded types (field-mismatch class of bug avoided at compile time)
*   [ ] [Phase 3] `playlist sync` change-detection
*   [ ] [Phase 3] `--search` interactive multiselect — Ink multiselect with `all` option
*   [ ] [Phase 3] Inline `ErrorPanel` remediation copy on known `AppError` codes (MISSING_CREDS, INVALID_TOKEN, etc.)
*   [ ] [Phase 3] Screencast / asciinema for README
*   [ ] [Phase 3] README polish — portfolio framing
*   [ ] [Phase 3] Install path validation on fresh clone
*   [ ] [Phase 3] Performance benchmark TS vs Python on a 60-video playlist extraction
*   [ ] [Phase 3] Adopt `commander` or `clipanion` for declarative flag validation at `src-ts/cli.tsx` boundary
*   [ ] [Phase 3] First integration test for dual-transcript pipeline — known fixture, YouTube path → Whisper fallback → DB persistence → entity extraction
*   [ ] [Tooling] Refine stub-bomb pre-commit hook regex to exclude TS/JS comment lines - Current hook regex matches `: any[\s]*[=)]` in ANY staged line, including JSDoc/inline comments describing fixes. Wave 3 commit (083ee18 → 4360bd3 sequence) tripped on a comment "`(seg: any)` cast in WhisperExtractor". Refine: exclude lines starting with `+\s*//`, `+\s*/\*`, or `+\s*\*` so comments don't trip the literal-type-annotation rule. Paired with [stub-allowed] bypass used in the next Wave 3 commit.

## TODO


## DOING
*   [ ] [Phase 2 Wave 4] Reports + ship v1.0.0 — HTMLReportGenerator with real `getAnalysisData` (ports only the second Python definition, P8). Archive `src-ts/{database,extractors,api,auth,parsers,reports,utils,errors,config.ts}` → `archive/src-ts-v1/`. Ink re-points to v2 via single import-alias change. README/version bump. See `docs/PORT_PLAN.md` Wave 4.


## REVIEW
*   [ ] [Phase 2 Wave 3] Pipeline — `extractPlaylist` end-to-end + live test against real YouTube account. Includes YouTubeClient (Zod-validated responses), GeminiParser (P9-stripped prompt), VideoExtractor (typed config, all writes via withTransaction). See `docs/PORT_PLAN.md` Wave 3.
*   [ ] [Phase 2 Wave 2] Data layer — 9 repositories split from current 979-LOC blob (Video, Playlist, PlaylistItem, Transcript, Entity, Statistics, Tag, ExtractionJob, AIAnalysis). All writes through `withTransaction<T>()`. Transaction-discipline enforcement test. `:memory:` SQLite tests per repo. See `docs/PORT_PLAN.md` Wave 2.
*   [ ] [Phase 2 Wave 1] Contract layer — branded `VideoId`/`PlaylistId`, Zod schemas at every wire boundary, mandatory `withTransaction<T>`, self-bootstrapping schema. Files: `src-ts-v2/{types,schemas,errors,utils,database}/`. See `docs/PORT_PLAN.md` Wave 1.


## DONE
*   [x] [Scaffold] Ship stub-bomb pre-commit hook (`.git/hooks/pre-commit`) — rejects `// TODO: implement`, `// This would`, `// For now,? just log`, `return undefined; // (placeholder|stub|will|todo)`, `: any\s*[=)]`. `[stub-allowed]` bypass for `-m` commits; `--no-verify` for editor commits
*   [x] [Scaffold] Update CLAUDE.md to v2 posture (this session, orchestrator-direct) — inverts canonical-implementation table; adds orchestration constraint; adds v2 invariants; adds stub-bomb hook reference
*   [x] [Phase 1] Fix P9 in `legacy/python/src/parsers/llm_parser.py:93` — strip embedded Python comment from Gemini prompt; use named slicing constant instead of inline `# ...` inside the f-string template
*   [x] [Phase 1] Fix P8 in `legacy/python/src/reports/html_generator.py:182-207` — delete duplicate `generate_playlist_report` dead stub (the second definition at `:267-467` is the real impl)
*   [x] [Phase 1] Fix P3+P4 in `legacy/python/src/extractors/whisper_extractor.py` — log exception context before returning None (`:103-105`, `:144-146`); log debug on silent temp-file cleanup failure (`:152-155`)
*   [x] [Phase 1] Fix P1 in `legacy/python/src/extractors/transcript_extractor.py:120-132` — replace bare `except Exception: pass` with specific types (`TranscriptsDisabled`, `NoTranscriptFound`, `VideoUnavailable`); log unexpected exceptions before re-raising

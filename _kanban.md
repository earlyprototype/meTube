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
*   [ ] [Audit/LOW] 3 quality-debt items from v2 deep-audit — A21, A30, A33 - Three LOW items from the 2026-06-04 deep audit. A21 HTML-escape the reflected error param in OAuthServer.ts:114 (localhost reflected-XSS hygiene). A30 de-duplicate the Gemini-entity confidence constants shared by VideoExtractor.ts:834 and GeminiParser. A33 two PostExtractionMenu nav handlers in shipped v1.0.0 are silent no-ops at ExtractCommand.tsx:298. Full detail in docs/PHASE3-AMENDMENTS.md LOW ledger.

## TODO

*   [ ] [Bug/HIGH] VideoExtractor counters lie — `processed`/`new` increment without verifying DB landing - Surfaced 2026-05-29 via probe-extract-single-video.ts. Today's job #24 reported `found=89, processed=3, new=3, dur=0s` but DB shows ZERO new rows since 2026-05-29 (3 most recent videos are still the Jan-20 cohort). The masking unwrap in c1e4770 should have made the underlying error visible — instead the per-video catch is silently consuming and the counter increments regardless. Repro: re-run extract on a playlist with new videos, then `SELECT COUNT(*) FROM videos WHERE created_at >= datetime('now', '-1 hour')` — counters and reality won't match. Likely location: VideoExtractor.extractPlaylist's per-video try/catch, where `processed` or `newly_extracted` increments BEFORE the repository call succeeds, or after a catch that doesn't decrement. Fix: increment counters ONLY after successful row persistence (or hold state per video, only flush to counters on the "video_done" path). Add regression test: extractor with mocked repo that throws on N-th video — counters must reflect that video as `failed`, not `processed`/`new`.
*   [ ] [Audit/HIGH] A13 — join-schema NULL-timestamp drift breaks getItemsWithVideos read (PlaylistItemRepository.ts:77-78) - Join-schema v_created_at/v_updated_at lack .nullable() so a videos row with NULL timestamps throws ZodError through getItemsWithVideos and breaks the whole playlist read. New instance of the prior created_at drift — flagged independently by 4 lenses. Fix and full detail in docs/PHASE3-AMENDMENTS.md A13.
*   [ ] [Audit/HIGH] A14 — VideoExtractor never persists transcript on playlist path — silent data loss (VideoExtractor.ts:700-767) - processVideo fetches the transcript but never upserts it (no TranscriptRepository injected) so the playlist path writes zero transcript rows while still counting the video processed. Root cause behind the counter-lie symptom. Fix and full detail in docs/PHASE3-AMENDMENTS.md A14.
*   [ ] [Audit/HIGH] A15 — GeminiParser arg-shape drift silently zeroes LLM analysis once wired (VideoExtractor.ts:724) - parseTranscript is called positionally but the real GeminiParser takes one object and throws on a non-string and the throw is swallowed as a Pino-invisible warn — so wiring the real parser silently zeroes all LLM analysis. Latent until the A2/A3 parser-wiring lands. Fix and full detail in docs/PHASE3-AMENDMENTS.md A15.
*   [ ] [Audit/HIGH] A18 — ExtractCommand injects no transcript/Whisper extractors — dual-transcript pipeline a no-op (ExtractCommand.tsx:141-218) - Both VideoExtractor constructions inject only descriptionParser so autoTranscript and enableWhisper are inert and the dual-transcript plus Whisper pipeline is a silent no-op on the primary extract-playlist path. Pairs with A14. Fix and full detail in docs/PHASE3-AMENDMENTS.md A18.

## DOING


## REVIEW
*   [ ] [Phase 2 Wave 4] Reports + ship v1.0.0 — HTMLReportGenerator with real `getAnalysisData` (ports only the second Python definition, P8). Archive `src-ts/{database,extractors,api,auth,parsers,reports,utils,errors,config.ts}` → `archive/src-ts-v1/`. Ink re-points to v2 via single import-alias change. README/version bump. See `docs/PORT_PLAN.md` Wave 4.
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

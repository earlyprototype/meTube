# MeTube — Portfolio Prep Kanban

> Remediation plan to make the TypeScript Ink rewrite portfolio-ready while
> recovering the UX wins from the original Python implementation.
> The historical phase reports formerly in `docs/internal/` (incl. `DEVELOPMENT_HANDOVER.md`) were pruned 2026-07; they live in git history.

## BACKLOG

*   [ ] [v2/Conditional] Wave 1 — Contract layer (Zod schemas, branded types, `withTransaction<T>`, schema bootstrap). Conditional on ADR 0001 approval. See `docs/PORT_PLAN.md`. ~Week 1 effort.
*   [ ] [v2/Conditional] Wave 2 — Data layer (9 repositories, transaction-discipline test). **KILL-CRITERION CHECKPOINT** end of Week 2. See `docs/PORT_PLAN.md`.
*   [ ] [v2/Conditional] Wave 3 — Pipeline (extractPlaylist end-to-end + live test against real YouTube account). See `docs/PORT_PLAN.md`.
*   [ ] [v2/Conditional] Wave 4 — Reports + ship v1.0.0 (HTMLReportGenerator with real getAnalysisData; archive src-ts/ → archive/src-ts-v1/; README/version bump). See `docs/PORT_PLAN.md`.
*   [ ] [Tier 4] Performance benchmark TS vs Python on a 60-video playlist extraction (called out in MIGRATION_COMPARISON.md as a todo, never done)
*   [ ] [Tier 4] Record a 30-second asciinema/loom of the CLI in action for the README

## TODO

*   [ ] [Tier 2] Add `withTransaction<T>(work)` wrapper to `src-ts/database/connection.ts` for auto-rollback on throw; refactor all repositories to use it (~2-3 h, ports `@contextmanager` from `legacy/python/src/database/connection.py:48-66`)
*   [ ] [Tier 2] Replace manual copy-paste OAuth in `src-ts/auth/YouTubeAuth.ts` with `@google-cloud/local-auth` one-shot localhost server flow (~2 h, mirrors `legacy/python/src/auth/oauth_handler.py:82-86`)
*   [ ] [Tier 2] Render inline error remediation copy via `<ErrorPanel>` when `AppError` has a known code (MISSING_CREDS, INVALID_TOKEN, etc.) (~2 h, ports `legacy/python/src/cli.py:235-243`)
*   [ ] [Tier 2] Restore `--search`-with-interactive-multiselect playlist flow in `src-ts/commands/PlaylistCommands.tsx`; Ink multiselect with `all` option (~3 h, ports `legacy/python/src/cli.py:391-447`)
*   [ ] [Tier 3] De-Python the Whisper path in `src-ts/extractors/WhisperExtractor.ts` — replace `python whisper_extractor.py` subprocess with `nodejs-whisper` (Node bindings to whisper.cpp) (~6-8 h; this is the architectural irony to fix before claiming TS is standalone)
*   [ ] [Tier 3] Adopt `commander` or `clipanion` for declarative flag validation at `src-ts/cli.tsx` boundary; React components still render below (~1 day, restores Click-style upfront contract)
*   [ ] [Tier 3] Write first integration test for dual-transcript pipeline in `src-ts/__tests__/dual-transcript.integration.test.ts` — known short fixture, assert YouTube path → Whisper fallback → DB persistence → entity extraction (~4 h)

## DOING

## REVIEW

*   [ ] [Audit] Platform-native rewrite-vs-patch audit completed 2026-05-19 — `docs/REWRITE_AUDIT.md` (operational), `docs/adr/0001-rewrite-vs-patch.md` (decision record), `docs/PORT_PLAN.md` (executable port plan if accepted). 14 agent invocations across 6 phases. Recommendation: **scoped rewrite of backend into `src-ts-v2/` with 2-week kill-criterion**. Patch fallback documented if kill-criterion fires. Awaiting owner approval of ADR.
*   [ ] [Audit/CRITICAL] New stub bomb surfaced: `PlaylistAddMine` and `PlaylistSync` (`src-ts/commands/PlaylistCommands.tsx:663-998`) read `p.playlistId` on `YouTubePlaylist` shape, but the field is `p.id` (api/types.ts). All objects typed `any`, so TS doesn't catch. Both commands silently produce broken DB rows (`playlist_id: undefined`). Independent of rewrite-vs-patch decision — ~5-line fix. Worth a standalone commit.
*   [ ] [Audit/HIGH] `getAnalysisData` stub at `src-ts/reports/HTMLReportGenerator.ts:391-394` returns `undefined` unconditionally. AI analysis section silently empty in every video report. Companion stub at line 556. Independent of rewrite — could ship as standalone commit (~30 LOC + new `AIAnalysisRepository`).
*   [ ] [Audit/HIGH] `getPlaylists()` truncation gap at `src-ts/extractors/VideoExtractor.ts:299-300` AND `src-ts/commands/PlaylistCommands.tsx:155-162` (PlaylistDiscover). Same class as the recently-fixed `getPlaylistVideos` pagination bug. `getPlaylistById()` already exists on YouTubeClient — 1-line fix in each of 2 sites.
*   [ ] [Tier 4] Write `docs/MIGRATION_NOTES.md` — 1-page honest accounting of what TS gained, what it traded away, what's still TODO - commit `45e64d7`: 332 lines, file:line evidence throughout; agent caught that DB auto-rollback wasn't fully lost (DatabaseManager.transaction exists at connection.ts:182 but repos don't go through it)
*   [ ] [Tier 4] Add GitHub Actions CI: `npm run build` on push + green badge - commit `6432acf`: ubuntu-latest, Node 22, npm ci + build + test, cached node_modules
*   [ ] [Housekeeping] License drift fix — align LICENSE (MIT) / package.json / README on MIT - commit `1bb3d65`
*   [ ] [QA] G1 leftover polish: Handlebars helper typing (HIGH 5 from the original review), console.error → Pino (MED 7), unused import + switch-case scoping + prettier (LOWs) - commit `842cebb`
*   [ ] [Posture] Add `CLAUDE.md` for AI sessions: project posture, conventions, Whisper-subprocess irony, sensitive-files allowlist, kanban discipline - commit `84ddf8e`
*   [ ] [Style] Prettier sweep across src-ts/ — formatting-only, 43 files, no logic diffs - commit `73478b0`
*   [ ] [Bug fix] OAuth init was broken — two latent bugs found via live `init --force` testing - commit `3a35462`: (1) port 80 → 3000 (Windows admin-bind issue, LOCAL_AUTH_FAILED before browser opens), (2) explicit `response_type='code'` (googleapis no longer auto-sets it, Google returns "Required parameter is missing"). Both exactly the kind of thing `docs/internal/MIGRATION_COMPARISON.md` warned about as "Required multiple debugging sessions"
*   [ ] [Bug fix] PostExtractionMenu label drift — "Processed: N / Success: 0 / Failed: 0" on a fully-extracted playlist read as "did nothing" - commits `f371b7a`, `715ba53`, `a593e55`: 'Processed' was really `result.total`; the actual `result.skipped` counter existed but never reached the UI. Now shows "Found in playlist: N / Already extracted (skipped): X / Newly extracted: Y · Failed: Z". Surfaces the previously-invisible skip path
*   [ ] [Bug fix] Extract pipeline silently dropping videos — two latent bugs found via live extract on the Ai playlist (86 in YouTube, only 50 considered, 0 new linkages added) - commit `930468b`: (A) `getPlaylistVideos` was called once with no pagination, capping at YouTube's per-page max of 50; now paginates via `nextPageToken`. (B) `savePlaylistItem` was a noop stub that just logged; now calls `PlaylistItemRepository.addVideoToPlaylist`. Also fixed a snake_case/camelCase field-name mismatch in the stub. Next `extract Ai` should add the 40 missing playlist_items linkages.

## DONE

*   [x] [Tier 0] Initialize git repo, baseline commit on `main` (`672ba53`)
*   [x] [Tier 0] Tighten `.gitignore` — add `tokens.json` (was typo'd as `token.json`), `*credentials*.json`, `coverage/`, `.cursor/`, `.claude/`, `nul`
*   [x] [Tier 0] Add `LICENSE` (MIT, matching README claim)
*   [x] [Tier 0] Verify no live secrets in staged blobs (scanned for `GOCSPX-`, `ya29.`, `AIzaSy`, `1//0` prefixes — zero hits)
*   [x] [Tier 0] Archive 56 dev/phase markdown files to `docs/internal/` (`git mv` preserves history)
*   [x] [Tier 0] Move Python implementation (`src/`, `tests/`, `requirements*.txt`, `setup.py`, `alembic.ini`, `pytest.ini`) to `legacy/python/` (`d5a45ed`)
*   [x] [Tier 0] Audit Python-vs-TS for lost discipline; produce remediation plan tiered by ROI
*   [x] [Tier 4] Move the 11 root `.bat` files + 4 root ad-hoc `.ts` scripts into `scripts/dev/` or delete obsolete ones (commit `dfb297d`: 3 keepers moved to scripts/dev/, 22 throwaways deleted, build still green)
*   [x] [Tier 1] Portfolio-grade `.gitignore` rewrite — secrets, build, AI-assistant state, kanbanger state, OS noise (commit `ca4516d`)
*   [x] [Tier 1] Port `${VAR}` recursive YAML substitution from `legacy/python/src/cli.py:184-208` into `src-ts/config.ts` (~30 min) - commit `97c3ee3`: substitution already existed; agent improved type safety + added Vitest coverage
*   [x] [Tier 1] Add `safeTitle()` terminal-safe Unicode helper in `src-ts/utils/terminal.ts`; apply at every `<Text>{video.title}</Text>` call site (~1 h, see `legacy/python/src/cli.py:561`) - commit `513a513`: 16 call sites wrapped across 5 components
*   [x] [Tier 1] Add GitHub repo description enrichment to `src-ts/reports/HTMLReportGenerator.ts:aggregatePlaylistData` — port `_fetch_github_description` from `legacy/python/src/reports/html_generator.py:228-265` (~45 min) - commit `513a513`: _fetchGitHubDescription() private method, 100ms throttle, 5s AbortSignal timeout, swallow-on-error
*   [x] [Tier 1] Rewrite README: lead with ADHD-tool framing, embed CLI screencast/GIF, drop Python-version setup steps (~1 h) - commit `77ef53d`: 92 lines total, well under 200 ceiling
*   [x] [Tier 1] Honest one-paragraph status banner in README — name what's untested (post-extraction menu, playlist videos, video add, HTML reports) (~15 min) - commit `77ef53d`: merged into the main README rewrite
*   [x] [QA] Follow-up: patched 4 of 5 HIGH `any`-contamination findings from typescript-reviewer - commit `30196b2`: deepMerge generic, getConfigValue → unknown, RawTranscriptSegment type, videos: Video[]; Handlebars helper typing (HIGH 5) + 5 MED + 3 LOW deferred

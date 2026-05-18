# MeTube — Portfolio Prep Kanban

> Remediation plan to make the TypeScript Ink rewrite portfolio-ready while
> recovering the UX wins from the original Python implementation.
> See `docs/internal/` for historical phase reports and `DEVELOPMENT_HANDOVER.md`.

## BACKLOG

*   [ ] [Tier 4] Performance benchmark TS vs Python on a 60-video playlist extraction (called out in MIGRATION_COMPARISON.md as a todo, never done)
*   [ ] [Tier 4] Write `docs/MIGRATION_NOTES.md` — 1-page honest accounting of what TS gained, what it traded away, what's still TODO
*   [ ] [Tier 4] Add GitHub Actions CI: `npm run build` on push + green badge
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

*   [ ] [Tier 4] Move the 11 root `.bat` files + 4 root ad-hoc `.ts` scripts into `scripts/dev/` or delete obsolete ones (commit `dfb297d`: 3 keepers moved to scripts/dev/, 22 throwaways deleted, build still green)
*   [ ] [Tier 1] Portfolio-grade `.gitignore` rewrite — secrets, build, AI-assistant state, kanbanger state, OS noise (commit `ca4516d`)
*   [ ] [Tier 1] Port `${VAR}` recursive YAML substitution from `legacy/python/src/cli.py:184-208` into `src-ts/config.ts` (~30 min) - commit `97c3ee3`: substitution already existed; agent improved type safety + added Vitest coverage
*   [ ] [Tier 1] Add `safeTitle()` terminal-safe Unicode helper in `src-ts/utils/terminal.ts`; apply at every `<Text>{video.title}</Text>` call site (~1 h, see `legacy/python/src/cli.py:561`) - commit `513a513`: 16 call sites wrapped across 5 components
*   [ ] [Tier 1] Add GitHub repo description enrichment to `src-ts/reports/HTMLReportGenerator.ts:aggregatePlaylistData` — port `_fetch_github_description` from `legacy/python/src/reports/html_generator.py:228-265` (~45 min) - commit `513a513`: _fetchGitHubDescription() private method, 100ms throttle, 5s AbortSignal timeout, swallow-on-error
*   [ ] [Tier 1] Rewrite README: lead with ADHD-tool framing, embed CLI screencast/GIF, drop Python-version setup steps (~1 h) - commit `77ef53d`: 92 lines total, well under 200 ceiling
*   [ ] [Tier 1] Honest one-paragraph status banner in README — name what's untested (post-extraction menu, playlist videos, video add, HTML reports) (~15 min) - commit `77ef53d`: merged into the main README rewrite
*   [ ] [QA] Follow-up: patched 4 of 5 HIGH `any`-contamination findings from typescript-reviewer - commit `30196b2`: deepMerge generic, getConfigValue → unknown, RawTranscriptSegment type, videos: Video[]; Handlebars helper typing (HIGH 5) + 5 MED + 3 LOW deferred

## DONE

*   [x] [Tier 0] Initialize git repo, baseline commit on `main` (`672ba53`)
*   [x] [Tier 0] Tighten `.gitignore` — add `tokens.json` (was typo'd as `token.json`), `*credentials*.json`, `coverage/`, `.cursor/`, `.claude/`, `nul`
*   [x] [Tier 0] Add `LICENSE` (MIT, matching README claim)
*   [x] [Tier 0] Verify no live secrets in staged blobs (scanned for `GOCSPX-`, `ya29.`, `AIzaSy`, `1//0` prefixes — zero hits)
*   [x] [Tier 0] Archive 56 dev/phase markdown files to `docs/internal/` (`git mv` preserves history)
*   [x] [Tier 0] Move Python implementation (`src/`, `tests/`, `requirements*.txt`, `setup.py`, `alembic.ini`, `pytest.ini`) to `legacy/python/` (`d5a45ed`)
*   [x] [Tier 0] Audit Python-vs-TS for lost discipline; produce remediation plan tiered by ROI

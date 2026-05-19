# meTube — Rewrite-vs-Patch Audit

**Date:** 2026-05-19
**Status:** Decision artifact for ADR 0001
**Method:** Multi-lens platform-native audit. 14 agent invocations across 6 phases. Read-only — no production code modified.

---

## TL;DR

The TypeScript backend (`src-ts/`) is **functional but structurally untrustworthy.** It's 74% larger than the Python source it was ported from (7,295 vs 4,186 LOC) for ostensibly the same functionality. The bug class that produced yesterday's 5 live-test failures recurs across the codebase as a documented pattern — five "stubs marked complete" confirmed, plus a new CRITICAL one surfaced by this audit: `PlaylistAddMine` and `PlaylistSync` read a `playlistId` field that doesn't exist on `YouTubePlaylist` (it's `id`), silently producing corrupt DB rows on every invocation.

The Ink frontend (`src-ts/cli.tsx`, `commands/`, `components/`) is the **keeper artifact** — 3,727 LOC, clean separation, zero anti-patterns, defining a 20-method contract with the backend.

The Python source (`legacy/python/src/`, 4,186 LOC) is a **trustworthy porting target with carve-outs**: 3 known bugs not to replicate, 4 items needing redesign rather than translation, but the architecture is layered and the repository pattern is correctly applied.

**Recommendation: tightly-scoped rewrite of the backend into `src-ts-v2/` with a 2-week kill-criterion**. Keep Ink as-is. New backend must satisfy the 20-method contract. If the new repository layer is not green-tested and integrated by end of Week 2, abandon the rewrite and execute the patch fallback (5 specific commits, ~24 hours).

---

## Table of Contents

1. [Methodology](#1-methodology)
2. [Evidence Inventory](#2-evidence-inventory--what-other-docs-already-said)
3. [LOC + Effort Math](#3-loc--effort-math)
4. [Ink↔Backend Contract Surface](#4-ink-backend-contract-surface)
5. [Module-by-Module Verdict Matrix](#5-module-by-module-verdict-matrix)
6. [Stub-Bomb Inventory](#6-stub-bomb-inventory)
7. [Five Structural Signals](#7-five-structural-signals)
8. [Two Paths Compared](#8-two-paths-compared)
9. [Recommendation](#9-recommendation)
10. [Patch Fallback (if rewrite kill-criterion fires)](#10-patch-fallback)
11. [Open Questions for the Owner](#11-open-questions-for-the-owner)

---

## 1. Methodology

Six-phase audit using Claude Code platform primitives. 14 agent invocations, ~45 min wall clock, ~430K tokens.

| Phase | Primitive | Output |
|---|---|---|
| 0 — Scaffolding | `architecture-decision-records` skill + task list | ADR shell, 7-task tracker |
| 1 — Codebase mapping | 3× `Explore` agents (parallel) | Python structural map; Ink contract map; extract-pipeline trace |
| 2 — Multi-lens review | 8× specialist agents (parallel) | silent-failure-hunter, typescript-reviewer, security-reviewer, database-reviewer, type-design-analyzer, comment-analyzer, python-reviewer, pr-test-analyzer |
| 3 — Architectural framing | 2× architect agents (parallel) | code-architect blueprint for both paths; architect independent verdict |
| 4 — Adversarial convergence | Implicit via Phase 3's two independent agents | Two architectural reads converging on diagnosis |
| 5 — Artifact | This document + ADR + (conditional) PORT_PLAN | The decision artifact |

**Read-only discipline:** zero production source files modified during the audit. Only docs added.

---

## 2. Evidence Inventory — What Other Docs Already Said

Before regenerating analysis, this audit reviewed the 7 existing migration/comparison/review docs in the project. The table below summarises stance vs reality:

| Doc | Date | Stance | Reliable? |
|---|---|---|---|
| `docs/MIGRATION_NOTES.md` | 2026-05-18 | Honest, recent, balanced | ✅ — current source of truth on what TS gained/lost vs Python |
| `docs/internal/MIGRATION_COMPARISON.md` | 2026-01-21 | Partial progress ("70% core, 60% production-ready") | ⚠️ — accurate at time, stale now |
| `docs/internal/FEATURE_PARITY_ANALYSIS.md` | 2026-01-27 AM | Cheerleader ("EXCEEDS Python, 100% parity, READY TO DEPRECATE") | ❌ — disproven within hours of its own publication |
| `docs/internal/SENIOR_DEV_REVIEW.md` | 2026-01-27 PM | Critical (5.5/10, "stubs marked complete") | ✅ — accurate diagnosis from same team that produced the cheerleader doc |
| `docs/internal/PRODUCTION_READINESS_ASSESSMENT.md` | 2026-01-27 PM | Critical follow-up ("670 lines untested, stubs marked complete") | ✅ — accurate, names PlaylistAdd and PlaylistRemove as stubs (later fixed) |
| `docs/internal/MISSING_FEATURES_STATUS.md` | 2026-01-27 | Inventory (7/15 complete) | ✅ — accurate snapshot |
| `docs/internal/DEVELOPMENT_HANDOVER.md` | 2026-01-27 PM | Candid handover (4 untested features named) | ✅ — explicitly self-flags as the candid one |

**The damning historical pattern:** Same team, same day, opposite documents. The AM cheerleader doc says "READY TO DEPRECATE PYTHON / 100% parity." The PM critical docs say "stubs marked complete, untested code claimed production-ready." That's the **documented absence of a definition-of-done** embedded in this codebase's history. Yesterday's 5 production-blocking bugs are not freak events — they're the steady-state output of that culture.

---

## 3. LOC + Effort Math

### Line counts (measured)

| Layer | LOC | Notes |
|---|---:|---|
| Python source (`legacy/python/src/`) | **4,186** | 13 modules, abandoned but functionally shipped |
| TypeScript backend (`src-ts/{api,auth,database,extractors,parsers,reports,utils,errors}`) | **7,295** | 74% larger than Python source |
| Ink frontend (`src-ts/{cli.tsx,commands,components}`) | **3,727** | The keeper artifact |
| Vitest tests (`src-ts/**/__tests__/*`) | **3,332** | 235 tests total |

### Effort estimates per path

| Path | Net LOC delta | Hours (focused work) | Partial-completion risk |
|---|---|---|---|
| **A — Surgical patch** | +520 LOC (550 add, 250 change, 30 delete) | 18–24 h | LOW — each fix orthogonal, independently shippable |
| **B — Scoped rewrite (`src-ts-v2/`)** | **−1,370 LOC net** (4,568 deleted, 3,200 added — 74% bloat collapses) | 60–80 h | HIGH — cliff at Wave 4; mitigated by 2-week kill-criterion |

The rewrite ships a **smaller** artifact than the current TS backend. That's the leading signal that the rewrite isn't an extravagance — it's removing bloat that the original team accumulated by translating Python idioms 1:1 into TS without compressing.

---

## 4. Ink↔Backend Contract Surface

Mapped by `Explore` agent (Phase 1, Task C). The contract Ink depends on is **clean** — no anti-patterns, no raw SQL in components, no direct API calls outside the service layer, no business logic in UI.

### 20 distinct method signatures the backend must satisfy

| Class / Function | Methods (signature surface) |
|---|---|
| `DatabaseManager` | `getConnection()`, `close()` |
| `YouTubeAuth` | `hasValidTokens()`, `authenticate(force?)`, `isAuthenticated()` |
| `YouTubeClient` | `getPlaylists(pageSize?, pageToken?)`, `getPlaylistById(id)`, `getPlaylistVideos(id, pageSize?, pageToken?)`, `getVideoDetails(id)` |
| `VideoExtractor` | `extractPlaylist(id, skipExisting?, maxVideos?)`, `extractSingleVideo(id, skipTranscript?, skipLlm?)` |
| `PlaylistRepository` | `getById(id)`, `getAll()`, `createOrUpdate(data)`, `delete(id)` |
| `VideoRepository` | `getByPlaylist(id)`, `getAll()` |
| `HTMLReportGenerator` | `generateVideoReport(id, opts?)`, `generatePlaylistReport(id, opts?)` |
| `WhisperExtractor` | `isAvailable()` |
| Utility | `resolvePlaylistIdentifier(id, allowPartial?)` |

### Construction pattern

All backend instances created via direct constructor invocation:
- `new DatabaseManager('data/metube.db')` — created fresh per command/component
- `new YouTubeAuth()` — per command, no force flag default
- `new YouTubeClient(auth)` — always passed auth instance
- `new VideoExtractor(client, db, {autoTranscript, autoLlmParse, enableWhisper, onProgress, onWhisperProgress})` — config object inline

No factory, no DI, no singleton. This is intentional — the Ink layer is the composition root.

### Types crossing the boundary

`Playlist`, `Video`, `PlaylistExtractionResult`, `VideoExtractionResult`, `CachedPlaylist`, `CachedVideo`, `YouTubePlaylist`, `YouTubeVideo`, `AppError`, `ValidationError`, `DatabaseError`, plus the `symbols` / `inkColors` / `status` utility objects from `colors.ts`.

### Why this matters

The Ink↔backend contract is the **stable spec** that survives either path. A backend rewrite can swap implementations behind these 20 signatures without touching Ink. A surgical patch can refactor internals freely as long as the signatures stay intact.

---

## 5. Module-by-Module Verdict Matrix

Verdicts based on Phase 1 (structural map + execution trace) and Phase 2 (8-lens review). Severity reflects audit's purpose (informing rewrite-vs-patch), not absolute code quality.

| Module | LOC | Verdict | Reason |
|---|---:|---|---|
| `src-ts/cli.tsx` | ~150 | **KEEP** | Clean entry point, meow parsing, routes to commands |
| `src-ts/commands/` (excl. `PlaylistCommands.tsx`) | ~2,000 | **KEEP** | No anti-patterns. Each Ink command is a self-contained React component using the backend cleanly |
| `src-ts/commands/PlaylistCommands.tsx` | ~1,300 | **KEEP w/ ~5-line fix** | CRITICAL field-mismatch bug in `PlaylistAddMine` + `PlaylistSync` (writes `p.playlistId`, field is `p.id`). Otherwise clean. |
| `src-ts/components/` | ~700 | **KEEP** | All UI, no backend coupling |
| `src-ts/database/connection.ts` | 323 | **SUSPECT** | `transaction()` exists at :185, NO repository uses it. `console.error` block at :164-168 violates `CLAUDE.md`. Cannot bootstrap own schema (defers to Python). |
| `src-ts/database/repositories.ts` | 979 | **SUSPECT** | 3 non-atomic DELETE+INSERT patterns; missing 3 repositories (Tag, ExtractionJob, AIAnalysis); raw `any` in models.ts type guards. Repo classes themselves are correctly shaped. |
| `src-ts/database/models.ts` | 150 | **SUSPECT** | `VideoRow = Video` identity aliases — no DB vs API shape boundary. Bare `string` for fields that have known enum values. No branded ID types. |
| `src-ts/database/migrations/` | (Alembic stub) | **MISSING** | Alembic scaffolding only, no migration scripts. Schema lives only in Python. |
| `src-ts/extractors/VideoExtractor.ts` | 793 | **BROKEN** | 4 of 6 typescript-reviewer HIGH findings touch this file. `videoData: any` on public return type. Raw SQL bypassing `StatisticsRepository`. `getPlaylists()` truncation gap. Multiple `console.error`. Tags silently dropped. |
| `src-ts/extractors/TranscriptExtractor.ts` | 426 | **SUSPECT** | `language: 'en'` and `is_auto_generated: true` hardcoded — silent data quality loss for non-English/manual captions. `any` on whisperExtractor field. |
| `src-ts/extractors/WhisperExtractor.ts` | 432 | **KEEP** (Tier 3 separate) | `isAvailable()` lies (Python-exists ≠ whisper-installed), `ytDlpAvailable` hardcoded true. Subprocess approach is the known architectural irony — separate work. |
| `src-ts/api/YouTubeClient.ts` | 508 | **SALVAGEABLE** | Largest backend file. Rate limiter + retry handler correct. Has the unused `getPlaylistById()` that should replace `getPlaylists().find()` in 2 sites. |
| `src-ts/api/RateLimiter.ts` | 133 | **KEEP** | Clean |
| `src-ts/api/RetryHandler.ts` | 159 | **KEEP** | Clean |
| `src-ts/api/types.ts` | small | **SUSPECT** | No branded `VideoId` / `PlaylistId`. Snake/camel shapes not explicitly distinguished. Root cause of yesterday's `video_count` vs `itemCount` class of bug. |
| `src-ts/auth/YouTubeAuth.ts` | 530 | **SUSPECT** | Missing OAuth `state` parameter (CSRF). 11 `console.log` calls in auth UX flow. `authenticate()` returns `false` on failure, callers don't check. JSDoc claims `default: 80` but code is `3000`. |
| `src-ts/auth/OAuthServer.ts` | small | **KEEP** | Recently fixed (port 3000, response_type) |
| `src-ts/parsers/DescriptionParser.ts` | 293 | **KEEP** | Regex-only, deterministic, no I/O. Clean. |
| `src-ts/parsers/GeminiParser.ts` | 387 | **SUSPECT** | `parsedResult: any` from `JSON.parse` — Gemini response untyped. Prompt-injection surface via untyped `videoTitle` interpolation. 4 `any` total. |
| `src-ts/reports/HTMLReportGenerator.ts` | 679 | **BROKEN** | `getAnalysisData` stub at :391 returns `undefined` unconditionally — silent data loss in every video report. N+1 query pattern in `aggregatePlaylistData`. Companion stub at :556 (`summary: undefined`). |
| `src-ts/utils/cache.ts` | 195 | **SUSPECT** | `JSON.parse` assigned directly to `VideoCache` type — no runtime validation. Stale file shape = silent wrong data. |
| `src-ts/utils/playlistResolver.ts` | 247 | **SUSPECT** | Catches all DB errors and converts to "not found" (misleading user). Opens own `DatabaseManager` instance (duplicated from caller's). Validates restrictive ID regex that excludes some valid YouTube ID prefixes. |
| `src-ts/utils/validation.ts` | 126 | **KEEP** | Clean |
| `src-ts/utils/logger.ts` | 46 | **KEEP** | Pino setup correct |
| `src-ts/utils/colors.ts`, `terminal.ts` | small | **KEEP** | UI helpers |
| `src-ts/config.ts` | small | **KEEP** | YAML + env var substitution working (recently restored). Tokens path name disagrees with `YouTubeAuth.ts` (`token.json` vs `tokens.json`). |
| `src-ts/errors/` | small | **KEEP** | `AppError`, `ValidationError`, `DatabaseError` hierarchy correct. `MultipleMatchesError` should extend `AppError` not `Error`. |

**Tally:** 8 BROKEN/SUSPECT files in the backend (the persistence and orchestration layer), 3 MISSING repositories, 0 anti-patterns in the Ink layer (200+ files).

---

## 6. Stub-Bomb Inventory

The pattern that defines this codebase's trust risk. Six confirmed cases:

| # | Where | What it claimed to do | What it actually does | Status |
|---|---|---|---|---|
| 1 | `PlaylistAdd` (`PlaylistCommands.tsx:341`) | Add playlist by ID | Was a return-text stub | **FIXED** (long ago) |
| 2 | `PlaylistRemove` (`PlaylistCommands.tsx:446`) | Remove playlist | Was a return-text stub | **FIXED** (long ago) |
| 3 | `savePlaylistItem` (`VideoExtractor.ts:774`) | Write playlist_items linkage | Was `// This would use PlaylistItemRepository...` + log | **FIXED** yesterday, commit `930468b` |
| 4 | `getPlaylistVideos` pagination (`VideoExtractor.ts:322`) | Paginate via `nextPageToken` | Was a single call, dropped beyond first 50 | **FIXED** yesterday, commit `930468b` |
| 5 | `getAnalysisData` (`HTMLReportGenerator.ts:391`) | Query `ai_analysis` table | Returns `undefined` unconditionally (`// TODO: Query ai_analysis table`) | **STILL BROKEN** |
| 6 | `PlaylistAddMine` + `PlaylistSync` field mismatch (`PlaylistCommands.tsx:690+`) | Reference `playlist.playlistId` on `YouTubePlaylist` shape | Reads `undefined` (field is `id`), writes broken DB rows | **STILL BROKEN — surfaced by this audit** |

Additional "stub-like" patterns surfaced but not classified as stub-bombs:

| Where | Pattern | Impact |
|---|---|---|
| `WhisperExtractor.ts:380-384` | `isAvailable()` returns `true` if Python venv exists (doesn't check whisper installed) | False-positive availability |
| `WhisperExtractor.ts:416-417` | `ytDlpAvailable = true; // Can't easily check without spawning` | Hardcoded health check |
| `VideoExtractor.ts:524-526` | `// Use raw SQL for now (can create StatisticsRepository later if needed)` — but `StatisticsRepository` **already exists** at `repositories.ts:866` | Comment lies; repository was built but never wired |
| `HTMLReportGenerator.ts:556` | `summary: undefined, // Would come from AI analysis` | Companion stub to #5 |
| `legacy/python/src/reports/html_generator.py:182-207` | Duplicate `generate_playlist_report` method definition — first is dead stub, second is real implementation | Known Python bug; do NOT port |

**The defining property of this class of bug:** type-check passes, build passes, lint passes, tests pass (because the tests mock the very call sites that are broken). They surface only in live testing. Yesterday's 5 bugs all share this property; the 2 STILL-BROKEN entries above will produce identical symptoms once exercised.

---

## 7. Five Structural Signals

The audit's most consequential output. Not bugs — diagnostics about the embedded culture.

### Signal 1 — 74% LOC inflation for the same functionality

TS backend is 7,295 LOC. Python source is 4,186 LOC. For idiomatic TS over clean Python, expected ratio: 1.2-1.4x. Observed: 1.74x.

That extra 3,000 LOC is not type signatures or error classes (those are real value). It's:
- Defensive plumbing around `any`-typed boundaries
- Duplicated mapping shims (snake_case ⟷ camelCase done inline in 16+ places instead of one adapter)
- Identity type aliases (`VideoRow = Video`) that don't enforce invariants
- Ceremony that exists because the design grew rather than landed

A clean rewrite from Python should land at ~5,500-6,000 TS LOC. Below the current TS bloat. That's measurable signal that the rewrite removes weight rather than adds it.

### Signal 2 — Same bug class keeps shipping

`p.playlistId` reading from a `YouTubePlaylist` that has `id`. `savePlaylistItem` logging instead of writing. `getPlaylistVideos` skipping pagination. `getAnalysisData` returning `undefined`. `playlist.video_count` reading from a shape that has `itemCount`.

All five are the same shape: **writer never verified the contract end-to-end.** The codebase has no boundary that fails loudly when shapes drift. In a healthy TS codebase, `p.playlistId` on a `YouTubePlaylist` would be a compile error. Here it survives because the upstream is typed `any`.

**This is not 5 bugs. It is one missing discipline expressed 5 times.** And it keeps producing more.

### Signal 3 — `transaction()` exists but is unused

`src-ts/database/connection.ts:185` correctly wraps better-sqlite3's transaction. Zero repositories call it. The Python equivalent (`@contextmanager get_session()` at `legacy/python/src/database/connection.py:48-66`) was the per-call atomicity discipline. The TS equivalent was built and then nobody integrated it.

This "shipped the plumbing, stopped at the join" pattern recurs:
- `StatisticsRepository` exists at `repositories.ts:866` but `VideoExtractor.ts:526` bypasses it with raw SQL
- 3 missing repositories (Tag, ExtractionJob, AIAnalysis) — interfaces declared in `models.ts:68-124`, no repository classes
- `HTMLReportGenerator.getAnalysisData` is called but doesn't query
- Pino logger is imported but `console.error` blocks remain in production hot paths

The codebase is full of half-bridges.

### Signal 4 — AM-cheerleader / PM-critic split

Same migration team, same day (2026-01-27), opposite documents:
- AM: `FEATURE_PARITY_ANALYSIS.md` — "100% parity, EXCEEDS Python, READY TO DEPRECATE"
- PM: `SENIOR_DEV_REVIEW.md` + `PRODUCTION_READINESS_ASSESSMENT.md` — "5.5/10, stubs marked complete, 670 lines untested"

Not contradiction — the **documented absence of a shared definition-of-done**. "Complete" meant "file exists" in the morning and "runs in live test" by afternoon. A codebase whose authors don't agree on done will produce stubs marked complete forever.

### Signal 5 — Four critical files at zero test coverage

| File | Function | Test coverage |
|---|---|---:|
| `src-ts/components/PostExtractionMenu.tsx` | Final post-extract UX | **0 tests** |
| `src-ts/reports/HTMLReportGenerator.ts` | Marquee output artifact | **0 tests** |
| `src-ts/commands/VideoCommands.tsx` | `video add` entry point + URL parsing | **0 tests** |
| `src-ts/utils/cache.ts` | Playlist video cache | **0 tests** |
| `src-ts/utils/playlistResolver.ts` | Multi-format playlist ID resolution | **0 tests** |

The pattern: 235 tests exist (not 130 as the migration team claimed), but they cluster on extractors and APIs (where the team felt safe) and abandon the command and report layers (where the contract with the user actually lives). Yesterday's 5 bugs map precisely onto these gaps.

### What the signals mean

**The rewrite was executed as translation rather than redesign.** Modules mapped Python→TS 1:1. Snake_case identifiers kept alongside camelCase. Enough types written to make the compiler quiet, not enough to make wrong shapes impossible. Scaffolding built without integration. Shipped to "complete" on file existence, not contract verification.

That's the embedded culture. It's not malice or incompetence — it's a normal failure mode of translation work without a strong contract discipline. The question this audit is answering is: **is that culture cheaper to debug out, or to leave behind?**

---

## 8. Two Paths Compared

### Path A — Surgical Patch

**Nature:** Forensic. Read code someone else wrote; verify each function does what its name claims; fix the cases where it doesn't.

**Required work (concrete):**
1. Fix `playlistId`→`id` field mismatch in `PlaylistAddMine` + `PlaylistSync` (~5 LOC)
2. Replace `getPlaylists().find()` truncation with `getPlaylistById()` in 2 sites (~6 LOC)
3. Implement `getAnalysisData` properly (~30 LOC) + new `AIAnalysisRepository` (~100 LOC)
4. Add 2 more missing repositories: `TagRepository`, `ExtractionJobRepository` (~250 LOC)
5. Add `withTransaction<T>` wrapper; refactor 6+ write paths (~150 LOC change)
6. Replace `any` on critical paths (~50 sites)
7. Remove `console.error` calls (3 in src-ts + 1 in YouTubeAuth)
8. Wire `StatisticsRepository` into VideoExtractor
9. Make 3 DELETE+INSERT patterns atomic
10. Add OAuth `state` parameter
11. Move `diagnose-oauth.ts` to `scripts/dev/`
12. Write tests for the 5 zero-coverage files (~200 LOC)

**Effort:** 18-24 hours focused work. Net +520 LOC.

**Risk profile:** Low partial-completion risk — each fix is orthogonal, any single one ships value alone. High vigilance cost — requires sustained mistrust of the existing code (a posture that lapses, per CLAUDE.md ADHD framework).

**Failure mode:** Patch list grows faster than it shrinks. Six weeks in, dev has fixed 14 things, found 11 new things, kanban is longer than at start. The artifact never reaches "done" because "done" isn't defined — "trustworthy" is a feeling, not a checkpoint. Project decays from rewrite to legacy in the dev's own head.

**What dev needs to be good at:** sustained mistrust across thousands of lines without burnout. Being the QA the original team wasn't.

### Path B — Tightly-Scoped Rewrite (`src-ts-v2/`)

**Nature:** Carving. Use Python source as trusted reference; reimplement against the 20-method Ink contract; leave the bad TS behind.

**Required work (concrete, scoped):**
1. **v2 scope only:** `init`, `playlist {discover, list, add, remove}`, `extract playlist <id>`, `report playlist <id>`
2. **Out of scope for v2:** REPL mode, `--all` extraction, single-video commands, `--search` multiselect, Whisper de-Python, AI analysis re-port
3. **Wave 1 (foundation):** Zod schemas + branded `VideoId`/`PlaylistId` + `withTransaction<T>` mandatory
4. **Wave 2 (data):** 9 repositories split from current 979-LOC blob, each ~100-180 LOC
5. **Wave 3 (boundary):** YouTubeClient with Zod-validated responses + YouTubeAuth with `@google-cloud/local-auth` + state parameter
6. **Wave 4 (pipeline):** VideoExtractor with mandatory transaction wrapping
7. **Wave 5 (reports):** HTMLReportGenerator with `getAnalysisData` properly implemented
8. **Wave 6 (verify):** integration test against real YouTube account

**Effort:** 60-80 hours focused work. **Net −1,370 LOC** (the bloat collapses).

**Risk profile:** Higher partial-completion risk — there's a cliff at Wave 4 where the project is non-functional until VideoExtractor compiles clean. Mitigated by keeping `src-ts/` in place during the rewrite (no destructive change until v2 is proven).

**Failure mode:** Second-system effect. Scope drift ("while I'm here, also fix..."). Two implementations coexisting in repo for months while dev makes feature decisions across both.

**What dev needs to be good at:** scope discipline. Refusing the "while I'm here" temptation. Defining DONE upfront and honoring it.

### Comparison along the framework axes

| Axis (from owner's CLAUDE.md framework) | Path A | Path B |
|---|---|---|
| Self-holding (ambient > invokable > mental) | Loses — requires sustained vigilance | Wins — boundary is binary (compiles or doesn't) |
| Definite DONE state | Loses — "no more bugs" is unfalsifiable | Wins — explicit acceptance criteria, single CI workflow |
| Clear-cut artifact | Loses — patched mess remains as starting point | Wins — `src-ts-v2/` vs archived `src-ts/v1/` tells the second-system story |
| Portfolio narrative | "Inherited a mess and fixed it" — best when mess is third-party's | "Hit wall, recognised it, scoped tighter, shipped" — rarer, more interesting |
| Risk of stalling at 75% | Lower (sprawling, but each commit ships value) | Higher (cliff at Wave 4) — but mitigated by kill-criterion |
| Risk of never reaching deployment-half | High (energy goes to internal half forever) | Lower (scoped milestone forces deployment thinking) |

---

## 9. Recommendation

**Tightly-scoped rewrite of the backend into `src-ts-v2/`, with a 2-week kill-criterion.**

### Why rewrite

Three findings converge on this verdict:

1. **The LOC math says the rewrite is smaller, not larger.** −1,370 LOC net. The bloat is the symptom; clearing it is the cure.
2. **The bug class is unfixable by patching.** "Writer never verified the contract" is a process pattern, not a list of fixes. Each patch creates the conditions for the next half-bridge. The rewrite's first wave (Zod schemas + branded types) makes the entire class of bug impossible at compile time.
3. **The Ink layer survives intact.** The keeper artifact (3,727 LOC, clean) is preserved. Only the broken half is replaced.

### Why scoped

The Jan 2026 migration team's failure mode is exactly what a solo dev with ADHD is most exposed to: ambitious scope, no fixed DONE, drift to "75% done forever." The mitigation is **constrained scope from day one**. v2 ships the 5 listed commands and nothing else. Other features re-land post-ship, one at a time, gated by tests.

### Why kill-criterion

If the rewrite stalls, the dev needs an off-ramp that doesn't feel like failure. The kill-criterion makes the experiment honest:

> If, at the end of Week 2, the new repository layer is not green-tested and integrated, abandon the rewrite and execute the patch fallback.

Two weeks of evenings is the most a solo dev should sink into a sunk-cost trap before it starts to feel like one. The patch fallback (Section 10) becomes the proven backup plan.

### Build order (compressed)

1. **Week 1 — Contract layer.** Zod schemas + branded `VideoId`/`PlaylistId` for every wire boundary. Generate TS types from Zod. Make wrong shapes impossible.
2. **Week 2 — Data layer.** 9 repositories. `withTransaction<T>` mandatory. Test that asserts every write path goes through wrapper. **Kill-criterion checkpoint here.**
3. **Week 3 — Pipeline.** Port `extractPlaylist` end-to-end. Live-test against real account before week ends. Live test is the signal-of-done, not "compiles clean."
4. **Week 4 — Reports + ship.** HTMLReportGenerator with real `getAnalysisData`. Archive `src-ts/` → `archive/src-ts-v1/` with `WHY.md` explaining the second-system narrative. README points to v2. Bump to `1.0.0`.

### Milestone definition (single sentence)

> Done is when `npm run build && npm test` is green, the sequence `metube init && metube playlist add <ID> && metube extract playlist <ID> && metube report playlist <ID>` succeeds end-to-end on a freshly-cloned machine against a real YouTube account, the HTML report contains topic/person/repo data, and the README reflects this.

### What success looks like in 4 weeks

- `src-ts-v2/` is built, tested, 5 scoped commands work against a real account
- `src-ts/` renamed to `archive/src-ts-v1/` with `WHY.md` telling the narrative honestly
- README points to v2 as canonical
- Kanban is shorter than today, not longer
- CI green
- At least 3 live testing sessions (one per week from Week 2) used as signal-of-done

### What success looks like in 12 weeks

- Deployment-half reached (per owner's framework)
- Marketplace/distribution question asked
- README has a screencast
- Whisper-Python irony resolved OR honestly named without undermining portfolio claim
- The "would I send this link to a hiring manager today" test passes without hedging

---

## 10. Patch Fallback

If the Week 2 kill-criterion fires, execute the surgical patch as 5 sequential commits, in this order:

### Commit 1 — Type discipline (the contract enforcement)
Replace every `any` in `VideoExtractor`, `PlaylistCommands.tsx`, and `GeminiParser` with Zod-parsed shapes. Ship the regression test for `p.playlistId` drift specifically. **~4 hours**.

Files: `src-ts/extractors/VideoExtractor.ts`, `src-ts/commands/PlaylistCommands.tsx`, `src-ts/parsers/GeminiParser.ts`, new tests.

### Commit 2 — Transaction discipline
Move every repository write to `withTransaction()`. Delete `console.error` from `connection.ts:164` and `VideoExtractor.ts:559-566`. **~3 hours**.

Files: `src-ts/database/connection.ts`, `src-ts/database/repositories.ts`, `src-ts/extractors/VideoExtractor.ts`.

### Commit 3 — Stub closure
Implement `getAnalysisData` properly (query `ai_analysis` table via new `AIAnalysisRepository`). Or, if the design isn't ready, throw an explicit `NotImplementedError` instead of silently `return undefined`. **~3 hours**.

Files: `src-ts/database/AIAnalysisRepository.ts` (new), `src-ts/reports/HTMLReportGenerator.ts`.

### Commit 4 — Test coverage (the discipline reinforcement)
Add tests for `PostExtractionMenu`, `HTMLReportGenerator`, `VideoCommands` URL parsing, `cache`, `playlistResolver` — exercising real DB writes via in-memory SQLite, not mocks. **~10 hours**.

Files: 5 new test files under `src-ts/__tests__/` or alongside modules.

### Commit 5 — Missing repositories
Ship `TagRepository`, `ExtractionJobRepository`. Wire into `VideoExtractor`. **~4 hours**.

Files: `src-ts/database/TagRepository.ts` (new), `src-ts/database/ExtractionJobRepository.ts` (new), `src-ts/extractors/VideoExtractor.ts`.

**Total: ~24 hours. Patch shippable in 1-2 weeks of evenings.**

After these 5 commits, the codebase has trustworthy persistence, no silent stubs in production paths, and behavioral test coverage for the previously-untested layer. The "stubs marked complete" pattern is closed.

---

## 11. Open Questions for the Owner

1. **Greenlight the rewrite path?** Or prefer to start with the patch fallback as the safer first step?
2. **Whisper de-Python timing.** Tier 3 work is currently out of scope for both v2 and patch. Confirm — or pull it in?
3. **REPL mode in v2.** Currently out of v2 scope. The Ink REPL is a marquee TS-only feature; archiving it temporarily during v2 is correct, but worth confirming.
4. **`archive/src-ts-v1/` naming.** The narrative needs the old code visible (not deleted) so the second-system story is honest. Confirm renaming to `archive/src-ts-v1/` is acceptable.
5. **Live-test cadence.** The audit recommends weekly live-test sessions as the signal-of-done. Confirm this fits the dev rhythm.

---

## Appendix A — Audit Trail

Phases and primitives:

- **Phase 0** (skill: `architecture-decision-records`): scaffolded `docs/adr/0001-rewrite-vs-patch.md`
- **Phase 1** (3 agents parallel):
  - `Explore` (Python structural map) — 4,186 LOC across 13 modules characterised
  - `Explore` (Ink contract surface) — 20 method signatures identified
  - `everything-claude-code:code-explorer` (extract pipeline trace) — 7 new concerns surfaced incl. `getPlaylists()` truncation
- **Phase 2** (8 agents parallel):
  - `everything-claude-code:silent-failure-hunter` — 18 findings incl. CRITICAL `playlistId`/`id` field mismatch
  - `everything-claude-code:typescript-reviewer` — 8 HIGH, BLOCK verdict on merge
  - `everything-claude-code:security-reviewer` — OAuth state gap, console.error data exposure
  - `everything-claude-code:database-reviewer` — `transaction()` unused, 3 missing repos, 3 non-atomic patterns
  - `everything-claude-code:type-design-analyzer` — `VideoRow = Video` identity aliases as root cause
  - `everything-claude-code:comment-analyzer` — 11 stub-revealing comments
  - `everything-claude-code:python-reviewer` — Python is trustworthy porting target with carve-outs
  - `everything-claude-code:pr-test-analyzer` — 4 critical files at 0 test coverage
- **Phase 3** (2 agents parallel):
  - `everything-claude-code:code-architect` — blueprints for both paths
  - `everything-claude-code:architect` — independent verdict converging on scoped rewrite
- **Phase 4**: convergence achieved via Phase 3's two independent reads (santa-method not invoked — agents already produced dual-review)
- **Phase 5** (this document)

## Appendix B — File:Line Reference Index

Findings cited above, by absolute path:

- `src-ts/extractors/VideoExtractor.ts:299-300` — `getPlaylists().find()` truncation gap
- `src-ts/extractors/VideoExtractor.ts:322-342` — pagination loop (recently fixed)
- `src-ts/extractors/VideoExtractor.ts:425, 786-791` — savePlaylistItem swallowed errors
- `src-ts/extractors/VideoExtractor.ts:524-526` — raw SQL bypassing `StatisticsRepository`
- `src-ts/extractors/VideoExtractor.ts:559-566` — `console.error` in production
- `src-ts/extractors/VideoExtractor.ts:742-748` — `playlist.video_count` vs `playlist.itemCount` mismatch
- `src-ts/commands/PlaylistCommands.tsx:341` — `PlaylistAdd` (real implementation, confirmed)
- `src-ts/commands/PlaylistCommands.tsx:446` — `PlaylistRemove` (real implementation, confirmed)
- `src-ts/commands/PlaylistCommands.tsx:663-998` — `PlaylistAddMine` + `PlaylistSync` field mismatch (CRITICAL, unfixed)
- `src-ts/database/connection.ts:164-168` — `console.error` SQL+params dump in production
- `src-ts/database/connection.ts:185-196` — `transaction()` method (unused by any repository)
- `src-ts/database/repositories.ts:614-628` — TranscriptRepository non-atomic DELETE+INSERT
- `src-ts/database/repositories.ts:734-746` — addEntities sequential loop (no transaction)
- `src-ts/database/repositories.ts:866` — `StatisticsRepository.addSnapshot` (exists, never called from VideoExtractor)
- `src-ts/database/models.ts:145-149` — `VideoRow = Video` identity aliases
- `src-ts/reports/HTMLReportGenerator.ts:391-394` — `getAnalysisData` stub
- `src-ts/reports/HTMLReportGenerator.ts:556` — `summary: undefined` companion stub
- `src-ts/auth/YouTubeAuth.ts:360` — JSDoc `default: 80` vs code default `3000`
- `src-ts/auth/YouTubeAuth.ts:197-213, 371-380` — missing OAuth `state` parameter
- `src-ts/extractors/WhisperExtractor.ts:380-384` — `isAvailable()` lies
- `src-ts/extractors/WhisperExtractor.ts:416-417` — `ytDlpAvailable` hardcoded
- `src-ts/extractors/TranscriptExtractor.ts:226-228` — `language: 'en'` hardcoded
- `src-ts/utils/playlistResolver.ts:173-180` — silent DB error → "not found"
- `legacy/python/src/database/connection.py:48-66` — `@contextmanager get_session()` (the missing TS equivalent)
- `legacy/python/src/reports/html_generator.py:182, 267` — duplicate method definition (don't port the first)
- `legacy/python/src/parsers/llm_parser.py:93` — Python comment leaked into Gemini prompt (don't port)

---

*End of REWRITE_AUDIT.md*

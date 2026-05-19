# ADR 0001 — Rewrite vs Patch for meTube TS Backend

* **Status:** Recommended (audit complete; pending owner approval), 2026-05-19
* **Deciders:** Thom (project owner)
* **Date:** 2026-05-19
* **Supersedes:** N/A

---

## Context and Problem Statement

meTube was rewritten from Python (`legacy/python/src/`, 4,186 LOC, abandoned but functionally shipped value for years) to TypeScript/Ink (`src-ts/`, 7,295 LOC backend + 3,727 LOC Ink frontend + 3,332 LOC tests). The TS rewrite is functional but has a documented pattern of "stubs marked complete" — methods that compile and look reasonable but are silent no-ops. Known cases:

* **PlaylistAdd** stub flagged 2026-01-27 by migration team; subsequently implemented (verified 2026-05-19, `PlaylistCommands.tsx:341`).
* **PlaylistRemove** stub flagged 2026-01-27; subsequently implemented (verified 2026-05-19, `PlaylistCommands.tsx:446`).
* **savePlaylistItem** stub discovered 2026-05-19 via live testing; fixed in commit `930468b`. 20-line method that just logged `"This would use PlaylistItemRepository..."`. Caused 0 playlist_items rows to ever be written despite extraction running.

The discovery of savePlaylistItem 4 months after deploy raises the question: **what other stubs are still hiding?** Type-check, build, and the 130-test Vitest suite did not catch any of the three above.

Yesterday's session committed 5 production-blocking bug fixes from one live testing run (OAuth port 80, missing `response_type`, label drift, pagination gap, savePlaylistItem stub). None were caught by the existing testing infrastructure.

## Decision Drivers

* **Trust in the codebase.** Recurring "stubs marked complete" is a culture/process artifact embedded in the current TS — not just an individual bug.
* **Porting fidelity.** `legacy/python/src/` shipped value for years. Porting from a working source is higher-fidelity than translating from a half-working TS rewrite.
* **The Ink frontend is the keeper.** ~3,727 LOC of clean React/Ink components are the differentiated value and should not be re-touched.
* **The Whisper architectural irony.** TS backend spawns `python whisper_extractor.py` as a subprocess (`src-ts/extractors/WhisperExtractor.ts`). Both paths must address this independently.
* **Personal project, ADHD scaffolding.** Per project owner's CLAUDE.md framework: ambient infrastructure > invokable discipline > methodology in head. The path chosen must result in something that holds itself together when next attended after a break.
* **LOC delta.** TS backend is 74% larger than Python source (7,295 vs 4,186) for ostensibly the same functionality. A fresh port could land smaller than the current TS backend.

## Considered Options

### Option A — Surgical patch
Keep `src-ts/` backend. Add `withTransaction<T>` wrapper to `src-ts/database/connection.ts`. Refactor all repositories to use it. Then systematically audit each backend module against `legacy/python/src/`, replace identified stub-bombs, ship incrementally.

### Option B — Full rewrite from Python source, keep Ink
Scrap `src-ts/{database,extractors,api,auth,parsers,reports,utils}`. Re-port from `legacy/python/src/`. Keep `src-ts/{cli.tsx,commands,components}` unchanged. Design a stable Ink↔backend contract first; new backend must satisfy it.

### Option C — Surgical replacement
Module-by-module verdict (SALVAGEABLE / SUSPECT / BROKEN). Keep SALVAGEABLE, replace SUSPECT/BROKEN via fresh ports from Python.

## Decision Outcome

**Chosen: Option B — Full rewrite from Python source, keep Ink, tightly scoped with kill-criterion.**

The audit (`docs/REWRITE_AUDIT.md`) produced the following diagnostic evidence:

* **LOC math favours rewrite.** TS backend is 74% larger than Python source (7,295 vs 4,186 LOC) for ostensibly the same functionality. A clean rewrite targets ~5,500-6,000 TS LOC — smaller than current. The rewrite removes weight rather than adds.
* **The bug class is unfixable by patching.** Five "stubs marked complete" confirmed (`PlaylistAdd`, `PlaylistRemove`, `savePlaylistItem`, `getAnalysisData`, `PlaylistAddMine`/`PlaylistSync` field mismatch). The pattern recurs because the codebase has no boundary that fails loudly when shapes drift. Patching closes one instance; rewriting (with Zod schemas + branded `VideoId`/`PlaylistId`) closes the entire class.
* **The Ink layer survives intact** — 3,727 LOC of clean React/Ink components with no anti-patterns. Only the broken backend half is replaced. The 20-method contract surface is preserved.
* **The Python source is trustworthy as porting target** but has its own issues (12 cataloged in `docs/PORT_PLAN.md` § "Python source issues — remediation map"). Each issue has an explicit v2 disposition: DO NOT PORT, REDESIGN, FIX IN PLACE, NOT PORTED, or DOCUMENT AS KNOWN GAP. No silent inheritance of Python bugs.

### Constraints on the rewrite

To prevent second-system effect:

1. **Tight scope.** v2 ships exactly: `init`, `playlist {discover, list, add, remove}`, `extract playlist <id>`, `report playlist <id>`. Everything else (REPL mode, `--all`, single-video commands, `--search` multiselect, Whisper de-Python, AI analysis re-port) re-lands post-ship, one at a time, gated by tests.
2. **2-week kill-criterion.** If the new repository layer is not green-tested and integrated by end of Week 2, abandon the rewrite and execute the patch fallback (Section 10 of `docs/REWRITE_AUDIT.md`).
3. **Live-test signal-of-done.** Weekly live-test sessions against a real YouTube account from Week 2 onward. "Compiles clean" is not enough.
4. **No destructive change to `src-ts/` during rewrite.** Current backend remains functional in place. v2 lives in `src-ts-v2/`. Swap is a single import-alias change at the end.

### Build order

| Week | Wave | Deliverable | Kill-check |
|---|---|---|---|
| 1 | Contract layer | Zod schemas + branded types + `withTransaction<T>` mandatory | — |
| 2 | Data layer | 9 repositories (split from current 979-LOC blob); transaction-discipline test | **CHECKPOINT** |
| 3 | Pipeline | `extractPlaylist` end-to-end; live-test against real account | — |
| 4 | Reports + ship | `HTMLReportGenerator` with real `getAnalysisData`; archive `src-ts/` → `archive/src-ts-v1/`; README updated; `v1.0.0` | — |

### Done definition

> `npm run build && npm test` is green, `metube init && metube playlist add <ID> && metube extract playlist <ID> && metube report playlist <ID>` succeeds end-to-end on a freshly-cloned machine against a real YouTube account, the HTML report contains topic/person/repo data, and the README reflects this.

### Positive Consequences

* Codebase becomes smaller (~−1,370 LOC net)
* Compile-time enforcement of `playlistId` vs `id` and similar field-shape errors via branded types — entire bug class becomes impossible
* `withTransaction<T>` is mandatory from day one, not retrofitted
* Self-bootstrapping schema — TS binary no longer requires Python to initialise the DB
* `archive/src-ts-v1/` + `WHY.md` produces a narrative-shaped portfolio artifact ("hit wall, recognised it, scoped tighter, shipped")
* OAuth `state` parameter and `@google-cloud/local-auth` one-shot flow baked in from start
* Reaches deployment-half (per owner's framework) within 4 weeks

### Negative Consequences

* 60-80 hours of focused work vs ~24 hours for patch
* Higher partial-completion risk (cliff at Wave 4) — mitigated by kill-criterion
* Two backends coexist briefly during weeks 1-4
* Some current TS wins must be re-derived (custom error classes, Pino, Vitest scaffolding) — though these can be lifted directly

### Fallback (if kill-criterion fires)

Execute the 5-commit patch sequence in Section 10 of `docs/REWRITE_AUDIT.md`. ~24 hours total. Closes the "stubs marked complete" pattern via the type-discipline + transaction-discipline + test-coverage commits.

## Pros and Cons of the Options

### Option A — Surgical patch

**Pros:**
* Lower effort (18-24 hours)
* Each fix orthogonal — any single one ships value independently
* Lower partial-completion risk on any individual commit
* No second-system risk
* Preserves all current TS wins without re-derivation

**Cons:**
* Patches one stub at a time; doesn't close the bug class
* Vigilance posture required (lapses per ADHD framework)
* "Done" is unfalsifiable — no DONE checkpoint
* 74% LOC bloat remains
* Failure mode: kanban grows faster than it shrinks
* Portfolio narrative reads as "kept fixing a project that didn't quite work"

### Option B — Tightly-scoped rewrite (CHOSEN)

**Pros:**
* Net −1,370 LOC (bloat collapses)
* Bug class becomes impossible at compile time
* DONE is binary and checkable
* Self-bootstrapping artifact (no Python dependency for non-Whisper path)
* Strong portfolio narrative
* Hits deployment-half on a 4-week timeline

**Cons:**
* Higher effort (60-80 hours)
* Cliff at Wave 4 (rewrite incomplete = CLI non-functional in v2 path)
* Second-system risk — mitigated by scope discipline + kill-criterion
* Some current TS scaffolding must be re-lifted

### Option C — Surgical replacement (module-by-module)

Not chosen because: produces the worst of both options. Has the LOC bloat and split-implementation problem of A, and the cliff-risk of B. The audit's evidence is that the bug class is structural, so surgical replacement of modules without re-doing the type discipline at the boundary re-creates the conditions for new stubs.

## Links

* `docs/HANDOVER-2026-05-19.md` — prior session context, 5 bugs found
* `docs/MIGRATION_NOTES.md` — honest Python↔TS accounting (2026-05-18)
* `docs/internal/SENIOR_DEV_REVIEW.md` — Jan 2026 critical review
* `docs/internal/PRODUCTION_READINESS_ASSESSMENT.md` — Jan 2026 critical follow-up
* `docs/internal/FEATURE_PARITY_ANALYSIS.md` — Jan 2026 cheerleader doc (line-by-line compare, not behavior verified)
* `docs/internal/DEVELOPMENT_HANDOVER.md` — Jan 2026 candid handover (4 untested features named)
* `_kanban.md` — active workstreams
* `CLAUDE.md` — project posture

# Migration Notes: Python → TypeScript

**Date:** 2026-05-18  
**Status:** Migration functionally complete; several behavioural regressions identified,
three since remediated (see below), Tier 2–3 work remaining.

---

## TL;DR

- **TS gained:** Ink interactive REPL, static types, Vitest test suite (~130 tests),
  structured Pino logging, custom error classes, smart playlist resolver.
- **TS traded away:** auto-browser OAuth (now manual copy-paste), the `@contextmanager`
  auto-rollback session idiom, and a handful of CLI conveniences (inline error remediation
  copy, `--search` flag on `playlist add`).
- **Three regressions since closed:** PowerShell-safe Unicode display, recursive
  `${VAR}` YAML substitution, and GitHub repo description enrichment were all absent in
  the initial port and have since been restored.
- **Still outstanding:** Whisper runs as a `python whisper_extractor.py` subprocess
  (Tier 3), auto-browser OAuth is not restored (Tier 2), and no `withTransaction` wrapper
  exists yet in the repository layer (Tier 2). See [`_kanban.md`](../_kanban.md) and
  [GitHub Project #9](https://github.com/users/earlyprototype/projects/9).

---

## Why we rewrote

The rewrite was not motivated by code-quality failings in the Python version — both
implementations ended up disciplined once reviewed. The actual drivers were:

1. **Ink's interactive CLI model.** Python's Click + Rich stack produces static output.
   Ink's React component model enables live-updating terminal UI, interactive pickers, and
   a persistent REPL session. That was not achievable inside the existing Python project
   without replacing the entire CLI layer anyway.
2. **Learning goal.** The owner explicitly wanted hands-on Node.js/TypeScript experience.
   The rewrite was partly an engineering project and partly a learning vehicle.

The discipline improvements (types, tests, structured logging, custom error classes) that
show up in the comparison docs are real — but they were a consequence of starting fresh,
not a reason the rewrite was necessary. They could have been layered onto the Python
version. Framing the rewrite as "we needed better quality" would be inaccurate.

---

## What TS gained

| Capability | Notes | Evidence |
|---|---|---|
| Ink interactive REPL | Persistent session, live sidebar stats, keyboard navigation | `src-ts/cli.tsx` |
| Static types | Compile-time error detection; eliminated whole categories of runtime surprises | Full `src-ts/` tree |
| Vitest test suite | ~130 unit tests; 75% coverage at handover | `src-ts/__tests__/` |
| Structured Pino logging | JSON logs with context; replaces bare `print()` statements | `src-ts/utils/logger.ts` |
| Custom error classes | `AppError`, `ValidationError`, `DatabaseError` with typed context | `src-ts/errors/index.ts` |
| Smart playlist resolver | Resolves by cache number, partial title, URL, or direct ID | `src-ts/commands/PlaylistCommands.tsx` |
| Post-extraction menu | Interactive 3-option menu after extraction completes | `src-ts/components/PostExtractionMenu.tsx` |
| `--no-whisper` / `--report` flags | Flags absent from the Python `video add` command | `src-ts/commands/VideoCommands.tsx` |

---

## What TS lost or weakened

Severity labels: **HIGH** = user-visible functional gap; **MED** = degraded UX;
**LOW** = developer-experience regression.

| Feature | Severity | Status | Python source | Notes |
|---|---|---|---|---|
| Auto-rollback DB session | HIGH | **Not yet ported** | `legacy/python/src/database/connection.py:48-66` | Python's `@contextmanager get_session()` commits on success, rolls back on any exception. TS has a raw `transaction<T>()` method on `DatabaseManager` (`src-ts/database/connection.ts:182`) but repositories call `db.run()` directly — the auto-rollback convention is not enforced. Tier 2 work: add `withTransaction<T>()` wrapper and refactor repositories. |
| Auto-browser OAuth | HIGH | **Not yet ported** | `legacy/python/src/auth/oauth_handler.py:82-86` | `flow.run_local_server(port=0)` opens a local callback server and auto-launches the browser. TS replaced this with a manual copy-paste URL flow. Works, but meaningfully less ergonomic. `@google-cloud/local-auth` would restore the one-click path. Tier 2. |
| PowerShell-safe Unicode display | MED | **Restored** (commit `513a513`) | `legacy/python/src/cli.py:561` | Python encoded titles with `.encode('ascii', 'replace')` before display. Initial TS port rendered raw Unicode; garbled characters on Windows terminals. `safeTitle()` helper added in `src-ts/utils/terminal.ts`; applied at 16 call sites across 5 components. |
| Recursive `${VAR}` YAML substitution | MED | **Restored** (commit `97c3ee3`) | `legacy/python/src/cli.py:184-208` | `_substitute_env_vars()` recursively replaces `${VAR}` patterns in nested config dicts. Initial TS port had no equivalent. Substitution was already present in `src-ts/config.ts` but had type-safety gaps; agent improved typing and added Vitest coverage. |
| GitHub repo description enrichment | MED | **Restored** (commit `513a513`) | `legacy/python/src/reports/html_generator.py:228-265` | `_fetch_github_description()` fetches repo descriptions from the GitHub API for inclusion in HTML reports. Absent from initial TS port. `_fetchGitHubDescription()` private method added to `src-ts/reports/HTMLReportGenerator.ts` with 100ms inter-request throttle and 5 s `AbortSignal` timeout. |
| Declarative Click command layer | MED | **Weakened** | Python CLI entry point | Click validates flags upfront and refuses invalid input at parse time. TS routes commands through React components rendered by Ink; flag validation is distributed across components and not enforced at the CLI boundary. Tier 3: adopt `commander` or `clipanion` to restore the upfront contract. |
| Inline error remediation copy | MED | **Not yet ported** | `legacy/python/src/cli.py:235-243` | Python `cli.py` printed contextual fix instructions when known error codes were raised (e.g. missing credentials). TS `AppError` has a `code` field but `<ErrorPanel>` does not yet render remediation copy from it. Tier 2. |
| `playlist add --search` flag | LOW | **Not ported (by design)** | `legacy/python/src/cli.py:391-447` | Python accepted `--search "title"` to search-and-add playlists interactively. TS's smart resolver handles the same case without requiring an explicit flag — `playlist add "partial title"` resolves via fuzzy match. The UX trade-off is defensible; the flag is not coming back. |

---

## The architectural irony

The marquee differentiating feature of meTube — dual-transcript extraction with Whisper
fallback — is not a TypeScript artifact. `src-ts/extractors/WhisperExtractor.ts`
writes a Python script to a temp file and spawns it via `this.pythonPath` (the
`venv/Scripts/python.exe` path). The TS process is orchestrating Python to call a Python
whisper library.

The README documents this openly:

> Whisper fallback: working — but still spawns `python whisper_extractor.py` as a
> subprocess; removing that Python dependency is Tier 3 architectural work, not done yet.

The setup instructions also require a Python venv with `openai-whisper` and `ffmpeg`
installed alongside the Node install. The project is not yet a standalone TypeScript
artifact. Tier 3 work (`nodejs-whisper`, Node bindings to whisper.cpp) is on the board
but not started.

---

## The contradiction in the historical docs

Three documents from the migration team's working period give different completion numbers
for the same project, across consecutive days:

| Document | Date | Claim |
|---|---|---|
| `docs/internal/MIGRATION_COMPARISON.md` | 2026-01-21 | "Core Functionality: 70% Complete / Production Readiness: 60%" |
| `docs/internal/FEATURE_PARITY_ANALYSIS.md` | 2026-01-27 (day) | "TypeScript version EXCEEDS Python capabilities / Feature Parity: ✅ YES (100%) / Production Readiness: ✅ YES" |
| `docs/internal/DEVELOPMENT_HANDOVER.md` | 2026-01-27 (evening) | "47% Complete / HTML report generation: untested / Post-extraction menu: never navigated / video add URL parsing: untested / playlist videos cache: untested" |

The `FEATURE_PARITY_ANALYSIS.md` was produced by the day-team agent doing a line-by-line
code comparison. The comparison confirmed that code *existed* for every feature — it did
not verify that the code *worked*. "HTML aggregation: ✅ PARITY" was accurate only in
the sense that an `HTMLReportGenerator.ts` file had been written and compiled.

The evening handover document was written by the same team after they stopped and looked
at the untested checklist. That is the candid one. The lesson the handover document
itself names: "Code compiles ≠ Code works."

The current README status section (`README.md`) reflects the honest post-handover
position: core extraction pipeline and database layer are tested; HTML report rendering,
post-extraction menu, `video add` URL parsing, and `playlist videos` cache have never
been exercised end-to-end.

---

## What's still untested (per `docs/internal/DEVELOPMENT_HANDOVER.md`)

All four items below were implemented before the handover with zero manual testing:

- **HTML report rendering** — `src-ts/reports/HTMLReportGenerator.ts` has never been
  opened in a browser. Template conversion from Jinja2 → Handlebars is code-complete;
  visual fidelity is unverified.
- **Post-extraction menu** — `src-ts/components/PostExtractionMenu.tsx` has never been
  navigated. Keyboard handlers are code-complete; runtime behaviour is unverified.
- **`video add` URL parsing** — `src-ts/commands/VideoCommands.tsx` handles multiple
  YouTube URL formats; edge cases have not been tested.
- **`playlist videos` cache** — `src-ts/utils/cache.ts` save/load cycle has never been
  validated end-to-end.

---

## Remaining work

Active board: [GitHub Project #9](https://github.com/users/earlyprototype/projects/9)

In-repo kanban with tier-organised items: [`_kanban.md`](../_kanban.md)

The kanban covers Tier 2 (auto-browser OAuth, `withTransaction` wrapper, inline error
remediation copy, `--search` multiselect restore) and Tier 3 (de-Python the Whisper path,
declarative flag validation layer, dual-transcript integration test). This document does
not repeat those items — the kanban is the single source of truth for remaining work.

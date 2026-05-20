# MeTube — Posture for AI sessions

This file is for AI sessions, not humans. The README is the human front
door; this is what sets the floor every time a Claude (or other AI)
session opens the project.

If you're a future session reading this, start here, then read
`_kanban.md` to see what's in flight, then `docs/HANDOVER-2026-05-20-planning.md`
for the active cycle's context.

---

## What this project is

A YouTube content extractor built as a personal-use tool by someone
with ADHD: turns rabbit-hole consumption into structured, searchable
knowledge. Auto-extracts GitHub repos, websites, topics, and people
from transcripts and descriptions.

**The differentiated capability** is the dual-transcript pipeline:
YouTube captions first, Whisper AI fallback when captions are
unavailable. Most YouTube tools have one or the other; few have both
with a graceful fallback.

This is also a **portfolio piece**. Honesty in the README beats
optimism. The `Current status` section names what's untested.

---

## Active cycle: v2 rewrite (3-phase)

Decision locked 2026-05-20. The previous TS backend is dead. Python
is source of truth, gets fixed, then ported to `src-ts-v2/`.

- **Phase 1 — Fix Python.** Five named issues in `legacy/python/src/`
  (P1 transcript_extractor.py bare-except; P3+P4 whisper_extractor.py
  exception/cleanup; P8 html_generator.py dedupe; P9 llm_parser.py
  prompt comment strip). Source of v2's port target must be clean.
- **Phase 2 — Port to `src-ts-v2/`.** Four waves (contract layer →
  9 repositories → pipeline → reports + ship v1.0.0) per
  `docs/PORT_PLAN.md`. Ink frontend untouched. Single import-alias
  swap at end of Wave 4.
- **Phase 3 — Improvements.** REPL mode, Whisper de-Python (Tier 3),
  single-video commands, `--search` multiselect, `playlist
  add-mine`/`sync`, screencast, README polish.

**Mindset at every wave boundary:** pause, review, address issues,
keep going. No kill-criterion, no exit ramp — discipline is staying
with the work, not bounding risk of stalling.

Full plan: `~/.claude/plans/enumerated-doodling-melody.md`.
Handover context: `docs/HANDOVER-2026-05-20-planning.md`.

---

## Canonical implementation (post-decision)

| Layer | Path | Status |
|---|---|---|
| **UI (Ink frontend)** | `src-ts/{cli.tsx, commands/, components/}` | Canonical, kept untouched |
| **Backend source of truth (Phase 1)** | `legacy/python/src/` | Actively maintained — fix-then-port |
| **Backend destination (Phase 2)** | `src-ts-v2/` | New build target |
| **Dead backend (do not touch)** | `src-ts/{database, extractors, api, auth, parsers, reports, utils, errors, config.ts}` | Archive at end of Phase 2 Wave 4 |

Other locations:

- `docs/internal/` — archived historical phase reports. Useful context, not active.
- `scripts/dev/` — ad-hoc developer scripts. Not production code.
- `_archivedkanban.md` — pre-v2 kanban (the Tier 0-4 era). Reference only; `_kanban.md` is live.

---

## Orchestration constraint (hard rule)

All implementation work goes through `Agent` tool calls with `model: "opus"`.
The orchestrator (this session) does NOT directly Edit/Write production code.

- **Orchestrator role:** read files, plan, spawn agents, review agent output, decide next move, hold scope.
- **Agent role:** all production code work — reads, design, implementation, tests.
- **Model:** every Agent invocation uses `model: "opus"` (Opus 4.7 1M context). Never downgraded.
- **Forbidden direct edits (orchestrator):** `src-ts/`, `src-ts-v2/`, `legacy/python/src/`, tests, `package.json`.
- **Allowed direct edits (scaffolding):** the plan file, `CLAUDE.md`, `_kanban.md`, `.git/hooks/*`, `settings.json`, `README.md`.

**Why:** orchestrator context is precious, agents bring their own; forces explicit task framing; matches the audit pattern that produced the diagnosis.

---

## The architectural irony to know about

The Whisper marquee feature still spawns `python whisper_extractor.py`
as a subprocess from `src-ts/extractors/WhisperExtractor.ts`. The TS
rewrite is **not yet** a standalone artifact — it requires a Python
venv with `openai-whisper` installed for its differentiated
capability. Listed as Phase 3 work. Don't pretend otherwise in docs or
commit messages.

---

## File / dependency conventions

- **Imports:** ESM Node. TS sources use `.js` extensions on relative
  imports (e.g. `from '../utils/logger.js'`). This is correct; do
  not "fix" them to `.ts`.
- **Tests:** Vitest. Live under `src-ts/__tests__/` or alongside as
  `*.test.ts` / `*.test.tsx`. Run with `npm test`. New v2 tests live
  under `src-ts-v2/__tests__/`.
- **Logging:** Pino via `src-ts/utils/logger.ts` (current) and
  `src-ts-v2/utils/logger.ts` (new). No `console.log` /
  `console.error` in production code.
- **Types:** No `any` in v2 code (`src-ts-v2/`). `unknown` + narrow
  via Zod or type guards. Pre-commit hook enforces.
- **React / Ink:** Component props as named `interface`. Don't use
  `React.FC`.
- **Errors:** Custom `AppError` / `ValidationError` classes — lift
  from `src-ts/errors/` into `src-ts-v2/errors/` unchanged.

---

## v2 invariants (Phase 2 will enforce)

These are walked per-invariant at start of Phase 2 Wave 1 (routing to
hook / Vitest / skill / CLAUDE.md / agent decided per invariant):

1. `withTransaction<T>()` is the only write path
2. Zod schemas at every wire boundary
3. Branded `VideoId` / `PlaylistId`
4. No `any` in v2 code
5. Self-bootstrapping schema
6. Pino-only logging
7. Stub-bomb detection — pre-commit hook (shipped this cycle)

---

## Sensitive files — never edit, never commit

These are gitignored. If you see them on disk, leave them alone:

- `.env` — local secrets. Read by the app at runtime via `dotenv`.
- `tokens.json` — OAuth refresh + access tokens. Live credentials.
- `client_secret.json` — Google Cloud OAuth client secret. Live.
- `data/` — local SQLite DB + cache files + Whisper temp audio.
- `reports/` — generated HTML reports. Output, not source.
- `logs/` — Pino log output.
- `.venv/` — kanbanger MCP server's Python venv. Gitignored.

`.gitignore` is the source of truth — refer to it for the full list.
If something secret-shaped *does* sneak into git, surface immediately.

---

## REVIEW gate discipline

When work moves through kanban states, follow the LLM_GUIDANCE
convention: **AI moves work to REVIEW; human approves REVIEW → DONE.**
Don't move things directly to DONE. Use kanbanger's `propose_done`
(DOING → REVIEW) and `approve_done` (REVIEW → DONE) tools; if work
needs changes, `reject_review(title, reason)` lands a Rework task in
TODO.

---

## Kanban sync

`_kanban.md` syncs one-way to GitHub Project #9
(https://github.com/users/earlyprototype/projects/9) via kanbanger
(see https://github.com/earlyprototype/kanbanger-partymix).

This project uses a **per-project venv** for kanbanger:

- `.venv/` — Python venv with `kanbanger-partymix[mcp]` installed (gitignored)
- `.mcp.json` — wires Claude Code to that venv's `kanbanger_mcp` module

A `post-commit` hook at `.git/hooks/post-commit` auto-syncs whenever
`_kanban.md` is part of a commit.

Kanbanger sync is **one-way**, local → GitHub. If you (or the user)
move a card on github.com, the move sticks until the next local edit
overwrites it. Never the source of truth.

For GitHub Projects sync to actually push, set GITHUB_TOKEN,
GITHUB_REPO, GITHUB_PROJECT_NUMBER in `.claude/settings.local.json`.
Without these, local kanban edits work; sync_to_github warns and
continues.

---

## Stub-bomb pre-commit hook

`.git/hooks/pre-commit` rejects diff lines matching stub patterns:

- `// TODO: implement`
- `// This would`
- `// For now,? just log`
- `return undefined; *// (placeholder|stub|will|todo)`
- `: any\s*[=)]` on critical paths

Bypass: include `[stub-allowed]` in the commit message. Use sparingly
and with a paired follow-up task in `_kanban.md`.

This is the ambient version of the `stubs-marked-complete` instinct
(`~/.claude/homunculus/projects/f0004604bb82/instincts/personal/stubs-marked-complete.yaml`).
The hook fires every commit deterministically; the instinct fires
probabilistically during reasoning. Together they make the culture
that produced current dead TS impossible to reproduce in v2.

---

## Build / dev commands

```bash
npm run build       # tsc compile
npm test            # Vitest run
npm run dev         # tsx src-ts/cli.tsx (live)
npm run lint        # ESLint over src-ts/**/*.{ts,tsx}
npm run format      # Prettier write over src-ts/**/*.{ts,tsx}
```

Phase 1 sanity check uses the cleaned Python (whatever the python CLI
entry resolves to under `legacy/python/`).

---

## Companion docs to read when relevant

- `README.md` — human-facing front door, current state honest
- `_kanban.md` — active work for the v2 cycle
- `_archivedkanban.md` — pre-v2 kanban (historical reference)
- `docs/HANDOVER-2026-05-20-planning.md` — most recent planning-session handover (3-phase decision)
- `docs/HANDOVER-2026-05-20.md` — audit-session handover (predecessor)
- `docs/REWRITE_AUDIT.md` — operational diagnostic (14 agents, 6 phases)
- `docs/adr/0001-rewrite-vs-patch.md` — decision record
- `docs/PORT_PLAN.md` — executable port plan (Phase 2 spec)
- `docs/MIGRATION_NOTES.md` — what TS gained vs lost from Python (file:line evidence)
- `~/.claude/plans/enumerated-doodling-melody.md` — full 3-phase plan
- `docs/internal/DEVELOPMENT_HANDOVER.md` — historical context from the migration team's last day

---

## When in doubt

- Read `_kanban.md` first.
- Don't touch `src-ts/{database, extractors, api, auth, parsers, reports, utils, errors, config.ts}` (dead) or `docs/internal/` unless porting/referencing.
- Don't edit production code as orchestrator — spawn an Opus agent.
- Don't downgrade agent model to sonnet/haiku — opus only.
- Don't add a kill-criterion or exit ramp anywhere.
- Don't push to origin without re-asking (18 unpushed commits are deliberate).
- If you find drift between this file and the actual codebase, update this file — that's what it's for.

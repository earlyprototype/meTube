# MeTube — Posture for AI sessions

This file is for AI sessions, not humans. The README is the human front
door; this is what sets the floor every time a Claude (or other AI)
session opens the project.

If you're a future session reading this, start here, then read
`_kanban.md` to see what's in flight.

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

## Canonical implementation

**TypeScript Ink CLI under `src-ts/`.** That is the only path that
ships. Everything else is reference or scaffolding:

- `legacy/python/` — the original Python implementation, kept for
  reference only. **Not maintained.** Do not add features here. Do
  feel free to read it as the source pattern when porting a Python
  win across (see `docs/MIGRATION_NOTES.md` for what's been ported
  vs what's still owed).
- `docs/internal/` — archived historical phase reports from the
  original migration team. Useful context, not active.
- `scripts/dev/` — ad-hoc developer scripts. Not production code.

---

## The architectural irony to know about

The Whisper marquee feature still spawns `python whisper_extractor.py`
as a subprocess from `src-ts/extractors/WhisperExtractor.ts`. The TS
rewrite is **not yet** a standalone artifact — it requires a Python
venv with `openai-whisper` installed for its differentiated
capability. Listed as Tier 3 work in `_kanban.md`. Don't pretend
otherwise in docs or commit messages.

---

## File / dependency conventions

- **Imports:** ESM Node. TS sources use `.js` extensions on relative
  imports (e.g. `from '../utils/logger.js'`). This is correct; do
  not "fix" them to `.ts`.
- **Tests:** Vitest. Live under `src-ts/__tests__/` or alongside as
  `*.test.ts` / `*.test.tsx`. Run with `npm test`.
- **Logging:** Pino via `src-ts/utils/logger.ts`. No `console.log` /
  `console.error` in production code. The one remaining
  `console.error` in `config.ts` was patched in commit `842cebb`.
- **Types:** No `any` in app code. Use `unknown` + narrow via type
  guards, or a small inline interface, or generics. Pre-existing
  `any` is being cleaned up incrementally — see `_kanban.md`.
- **React / Ink:** Component props as named `interface`. Don't use
  `React.FC`.
- **Errors:** Custom `AppError` / `ValidationError` classes in
  `src-ts/errors/`. Wrap async operations; surface error metadata
  via Pino logger.

---

## Sensitive files — never edit, never commit

These are gitignored. If you see them on disk, leave them alone:

- `.env` — local secrets. Read by the app at runtime via `dotenv`.
- `tokens.json` — OAuth refresh + access tokens. Live credentials.
- `client_secret.json` — Google Cloud OAuth client secret. Live.
- `data/` — local SQLite DB + cache files + Whisper temp audio.
- `reports/` — generated HTML reports. Output, not source.
- `logs/` — Pino log output.

`.gitignore` is the source of truth — refer to it for the full list.
If something secret-shaped *does* sneak into git, surface immediately.

---

## Active workstreams

`_kanban.md` at repo root tracks remediation work organised by tier:

- **Tier 0** — audit + remediation plan (done)
- **Tier 1** — quick wins porting Python features that didn't translate
  (done)
- **Tier 2** — discipline retention: DB lifecycle wrapper, OAuth
  auto-browser, error remediation copy, `--search` multiselect
  (not started)
- **Tier 3** — architecture: de-Python Whisper, declarative CLI lib,
  integration test (not started)
- **Tier 4** — polish: perf benchmark, GH Actions CI, screencast,
  migration notes (partial)

When work moves through states, follow the LLM_GUIDANCE convention:
**AI moves work to REVIEW; human approves REVIEW → DONE.** Don't
move things directly to DONE.

---

## Kanban sync

`_kanban.md` syncs one-way to GitHub Project #9
(https://github.com/users/earlyprototype/projects/9) via kanbanger
(see https://github.com/earlyprototype/kanbanger-partymix).

A `post-commit` hook at `.git/hooks/post-commit` auto-syncs whenever
`_kanban.md` is part of a commit. **You don't need to manually run
`kanban-sync`** unless something has drifted.

Important: kanbanger sync is **one-way**, local → GitHub. If you (or
the user) move a card on github.com, the move sticks until the next
local edit overwrites it. Never the source of truth.

---

## Build / dev commands

```bash
npm run build       # tsc compile
npm test            # Vitest run
npm run dev         # tsx src-ts/cli.tsx (live)
npm run lint        # ESLint over src-ts/**/*.{ts,tsx}
npm run format      # Prettier write over src-ts/**/*.{ts,tsx}
```

The repo currently has ~40 pre-existing ESLint issues (mostly `any`
in older files). Don't bulk-fix without coordination — pick them up
as you touch the file.

---

## Companion docs to read when relevant

- `README.md` — human-facing front door, current state honest
- `_kanban.md` — active work
- `docs/MIGRATION_NOTES.md` — what TS gained vs lost from Python
  (file:line evidence)
- `docs/internal/DEVELOPMENT_HANDOVER.md` — historical context from
  the migration team's last day; useful for understanding why some
  things are the way they are
- `docs/internal/MIGRATION_PLAN.md` — the original plan (note: its
  "% complete" claims contradict `DEVELOPMENT_HANDOVER.md`; the
  handover is the candid one)

---

## When in doubt

- Read `_kanban.md` first.
- Don't touch `legacy/python/` or `docs/internal/` unless you're
  porting something or referencing it.
- If you find drift between this file and the actual codebase,
  update this file — that's what it's for.

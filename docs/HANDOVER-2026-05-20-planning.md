# meTube — Handover, 2026-05-20 (planning session, post-audit)

> Sequel to `docs/HANDOVER-2026-05-20.md` (which was the audit-session
> handover). This session was a single-purpose planning session that
> worked through the rewrite-vs-patch decision and locked a 3-phase
> plan with a hard orchestration constraint. No production code
> changed. No commits.

---

## TL;DR (60-second read)

- **Decision locked:** 3-phase plan — Phase 1 fix Python, Phase 2 port to TS v2, Phase 3 improvements.
- **Mental-model inversion:** current `src-ts/` BACKEND is **dead** — pretend it doesn't exist. Ink frontend kept. Python becomes source of truth.
- **CLAUDE.md is now WRONG** on two specific posture lines and must be updated first thing next session.
- **No kill-criterion.** Deliberate departure from the audit's recommendation. Mindset is *review and address, keep going*.
- **Hard constraint: orchestration-only.** All implementation goes through `Agent(model: "opus", ...)` calls. Orchestrator never directly Edit/Writes production code.
- **Plan file (full detail):** `C:\Users\Fab2\.claude\plans\enumerated-doodling-melody.md`
- **Files modified this session:** plan file only. Zero production code, zero CLAUDE.md, zero kanban.
- **Next session's first three moves:** (1) update CLAUDE.md to new posture, (2) ship stub-bomb pre-commit hook, (3) spawn 5 parallel `opus`-model agents to fix the locked Phase 1 scope (P1, P3, P4, P8, P9) in `legacy/python/src/`.

---

## What this session did

Reviewed yesterday's audit + 3 deliverable docs (`docs/REWRITE_AUDIT.md`, `docs/adr/0001-rewrite-vs-patch.md`, `docs/PORT_PLAN.md`). Worked through, with substantial owner pushback at each turn:

- whether to act on the audit's recommendation (rewrite vs patch vs ship-first)
- what "best use of skills.md options" means in practice
- whether kill-criteria are the right ADHD-safety mechanism (owner: no, change the mindset)
- which existing ECC scaffolding maps to which phase
- the orchestration constraint (all dev via agents, opus 4.7 max)

Output: one approved plan file. Several conversational pushbacks from owner that materially reshaped the plan (no kill-criterion; orchestration-only; mental-model inversion on which code is dead).

---

## Critical changes from yesterday's posture

These are the load-bearing shifts the next session must internalize. None of these are in `CLAUDE.md` yet — they're verbal user direction captured in the plan file.

### 1. Current `src-ts/` BACKEND is dead — Python is source of truth

Owner verbatim: *"the currnt TS sould b cinsidrd an abortion and ignored — t oriinal pyton"*

- **KEEP:** ink frontend (`src-ts/cli.tsx` + `src-ts/commands/` + `src-ts/components/`, ~3,700 LOC) — clean, no anti-patterns per audit §4
- **DEAD:** `src-ts/{database, extractors, api, auth, parsers, reports, utils, errors, config.ts}` (~7,295 LOC backend). Do not modify. Archive to `archive/src-ts-v1/` at end of Phase 2 Wave 4.
- **ACTIVE SOURCE OF TRUTH:** `legacy/python/src/` (was "reference only, not maintained" — now actively maintained for Phase 1)

This **inverts `CLAUDE.md`** on two specific posture lines:
- > "TypeScript Ink CLI under src-ts/. That is the only path that ships."

  → False. Ink ships; new backend in `src-ts-v2/` ships; `src-ts/{backend}` is dead.

- > "legacy/python/ — the original Python implementation, kept for reference only. **Not maintained.**"

  → False. Now actively maintained as source of truth for Phase 1.

### 2. No kill-criterion

Audit's ADR 0001 recommended a 2-week kill-criterion for Wave 2 (ADHD-safety against sunk-cost trap). Owner rejected: *"NOOO no kill — change mindset — review and address issue."*

New mindset at every wave boundary: **pause, review, address issues, keep going.** The project ships; the only question is what we work through to get there. Discipline is *staying with the work*, not *bounding risk of stalling*. This must be lived, not just stated — the stub-bomb hook + project-scoped instinct + ambient infrastructure are what make "review and address" actually surface issues before they pile up.

### 3. Orchestration-only, opus 4.7 max

Owner verbatim: *"orchestrate via agents OPUS 4.7 MAX only — dont dev yourself"*

- **Orchestrator role:** read files, plan, spawn agents, review agent output, decide next move, hold scope. Direct edits allowed only on scaffolding: plan file, `CLAUDE.md`, `_kanban.md`, `.git/hooks/*`, settings.json, README.
- **Agent role:** all production code work — read, design, implementation, tests.
- **Model:** every Agent invocation uses `model: "opus"`. Never downgrade.
- **Forbidden:** orchestrator Edit/Write on `src-ts/`, `src-ts-v2/`, `legacy/python/src/`, tests, package.json. If tempted to "just fix this one line", spawn an agent.
- **Parallel where independent:** 5 Python fixes can run as 5 parallel agents; 9 Wave-2 repositories can fan out 3-4 per sitting; wave-end verification uses the 8-agent multi-lens fan-out from the audit.

---

## The 3-phase plan in one paragraph

**Phase 1** — fix the audit's 5 must-fix Python issues (P1 bare-except in `transcript_extractor.py`, P3 + P4 whisper exception handling, P8 duplicate `generate_playlist_report` method, P9 comment leak in Gemini prompt) directly in `legacy/python/src/`. Cleaned Python is a sanity-check source for the v2 port. **Phase 2** — port cleaned Python into a new `src-ts-v2/` directory using the audit's 4-wave plan (Wave 1 contract layer with Zod schemas + branded `VideoId`/`PlaylistId` + mandatory `withTransaction<T>` → Wave 2 9 repositories → Wave 3 pipeline → Wave 4 reports + ship v1.0). Ink frontend stays in place untouched; backend swap is a single import-alias change at end of Wave 4. **Phase 3** — REPL mode, Whisper de-Python (Tier 3), screencast, README polish, single-video commands, `playlist add-mine`/`sync` re-land (designed in cleanly, not patched on). This is where the deployment-half work lives.

Plan file (full detail, ~290 lines): `C:\Users\Fab2\.claude\plans\enumerated-doodling-melody.md`.

---

## Phase 1 scope (locked default — owner can override)

Audit's PORT_PLAN catalogued 12 Python issues. **Phase 1 fixes 5: P1, P3, P4, P8, P9.** Reasoning (see plan file table):

- **FIX:** P1, P3, P4, P8, P9 (clean porting source; P3/P4 also ship live via Whisper subprocess)
- **SKIP:** P5, P6 (cache + browser-open move to TS — fix in python wasted)
- **SKIP:** P10, P11 (big python refactors that don't inform TS redesign)
- **DOCUMENT:** P7 (DescriptionParser empty topics — fix in TS where Zod helps)
- **SKIP:** P12 (already consolidated in current TS, lift to v2)

P7 is the only edge case — easy fix in either codebase, default is TS-side. Owner can pull into Phase 1 if preferred.

---

## ECC scaffolding mapping (summary; full table in plan file)

High-leverage agents proven on this codebase from the audit:
- `silent-failure-hunter` — caught the audit's CRITICAL `PlaylistAddMine` field bug
- `typescript-reviewer` — broad TS review
- `database-reviewer` — repository work
- `python-reviewer` — Phase 1 verification
- `code-architect` + `architect` (parallel) — design decisions

The 8-agent multi-lens fan-out from the audit (~430K tokens) is re-deployable at end of Wave 2 or Wave 4 as wave-end verification.

ECC ritual skills already in flow: `teamtime` → `worktime` → (`notetime`) → `clocktime` → `sleeptime`. Plus `check-handoffs` at session start, `continuous-learning-v2` capturing as we go, `strategic-compact` at phase boundaries.

Phase-by-phase ECC mapping (which skill/agent for which wave) is in the plan file §"ECC scaffolding to use per phase."

---

## Files modified this session

- `C:\Users\Fab2\.claude\plans\enumerated-doodling-melody.md` (created via `Write`, then 5 iterative `Edit` passes to converge)

That's it. **No production code changes. No CLAUDE.md changes. No `_kanban.md` changes. No commits. No pushes.**

---

## What's still NOT done (next session priority order)

1. **Update CLAUDE.md to new posture.** Orchestrator-direct. The two posture lines named above + a rewrite of "Active workstreams" to match Phase 1/2/3 structure.
2. **Ship stub-bomb pre-commit hook.** Orchestrator-direct. `.git/hooks/pre-commit`. Reject diff lines matching:
   - `// TODO: implement`
   - `// This would`
   - `// For now,? just log`
   - `return undefined; *// (placeholder|stub|will|todo)`
   - `: any\s*[=)]` on critical paths
   - Bypass via `[stub-allowed]` in commit message.
3. **Spawn 5 Python-fix agents in parallel** (P1, P3, P4, P8, P9). Each `opus`-model. Each agent: read the file, apply the fix per `docs/PORT_PLAN.md` disposition, output diff for orchestrator review.
4. **Update `_kanban.md`** — v2 waves move from "[v2/Conditional]" to "[v2/Planned]"; stale tier items swept.
5. **Sanity-check cleaned Python** runs end-to-end against a test playlist (it was a working source; fixes shouldn't break that).
6. **Phase 2 Wave 1** — per-invariant routing for the 7 invariants walked in conversation (each routed to: pre-commit hook / PreToolUse hook / Vitest test / custom skill / CLAUDE.md posture / agent capability), then contract layer authoring spawned to agents.

---

## What the next session should NOT do

- Do NOT touch `src-ts/{database, extractors, api, auth, parsers, reports, utils, errors, config.ts}` — dead code, leave it for archival at end of Phase 2 Wave 4.
- Do NOT push to origin (existing directive; 18 commits ahead, deliberate).
- Do NOT directly Edit/Write production code as orchestrator. Always spawn an agent.
- Do NOT add scope beyond plan (REPL, Whisper de-Python, single-video commands all wait for Phase 3).
- Do NOT execute the audit's 5-commit patch fallback (it patched the now-dead TS).
- Do NOT add a kill-criterion or exit ramp anywhere — explicit owner directive.
- Do NOT downgrade agent model to sonnet/haiku — opus 4.7 only.

---

## Conventions & gotchas (inherited from prior handover, still in effect)

### Local-only work, do not push

Owner explicitly set this. 18 commits ahead of origin are deliberate. **Re-ask before any `git push`.**

### REVIEW gate discipline

AI moves work to REVIEW; human approves REVIEW → DONE. Current `_kanban.md` has 13 items in REVIEW.

### Post-commit hook auto-syncs kanban

`.git/hooks/post-commit` runs `kanban-sync _kanban.md` after any commit touching `_kanban.md`.

### `gh` CLI at Windows path

`"/c/Program Files/GitHub CLI/gh.exe"` when invoked via Bash tool. `which gh` from MINGW64 returns nothing.

### Ink components need a TTY

`useInput` panics without real terminal. Running `metube` commands via Bash tool causes React reconciler errors. Verify auth/API via direct `googleapis`-using scripts, not by invoking `metube` from non-TTY shell.

### Live test as signal-of-done

Yesterday's lesson: bugs that survive type-check + lint + tests are caught only by exercising the path against real services. Plan calls for live-test sessions at end of Wave 2 and Wave 3.

### Sensitive files (unchanged)

`tokens.json`, `client_secret.json`, `.env`, `data/`, `reports/`, `logs/` — all gitignored. Never edit, never commit, never print contents.

### `stubs-marked-complete` instinct (project-scoped, exists)

At `~/.claude/homunculus/projects/f0004604bb82/instincts/personal/stubs-marked-complete.yaml`. Probabilistic (~50-80% fire). The stub-bomb pre-commit hook (next session work) is the deterministic version that closes the gap.

---

## Stats

- User messages: ~17 (concentrated, strategic — heavy pushback)
- Plan iterations: 6 (initial overbuilt draft → trimmed to plain language → mental-model inversion → no kill-criterion → orchestration constraint → ECC scaffolding mapping)
- Plan file final state: ~290 lines
- Production source files modified: 0
- Docs created in repo: 1 (this handover)
- Commits: 0

---

## One sentence for the next session

The audit's recommended rewrite is happening, but with critical inversions — current TS backend is dead, Python is source of truth being fixed first then ported to `src-ts-v2/`, no kill-criterion (review-and-address mindset), all implementation via opus-model agents (orchestrator never dev-direct) — start by updating `CLAUDE.md` to the new posture and shipping the stub-bomb pre-commit hook, then confirm Phase 1 scope with owner before spawning the Python-fix agents.

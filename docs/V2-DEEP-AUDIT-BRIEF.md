# meTube v2 — Deep Audit Brief

> Multi-lens code audit of the v2 cycle, deployed as a single Workflow-tool
> invocation. Reviewer panel + judge dedup + adversarial verify, with
> findings routed directly into `_kanban.md` (via kanbanger) and into
> `docs/PHASE3-AMENDMENTS.md` as `A13+`. Designed for `/teamtime` →
> `/chosetime` → `/worktime` pickup of one finding at a time.
>
> Authored 2026-06-04. Companion to `docs/PHASE3-AMENDMENTS.md` and
> `docs/HANDOVER-2026-05-28-phase2-port.md`.
>
> **To execute:** open a session in this cwd, confirm the Workflow tool
> is available, and ask the agent to "run the V2 deep audit brief." The
> Workflow's structured script is described in the *Recommended approach*
> section — the agent translates the brief into a `Workflow({script})`
> call.

---

## Context

The Phase 2 port (4 waves, 6 commits, 473 unit tests, tsc clean) shipped
autonomously without the documented live-test gate per `docs/PORT_PLAN.md`.
Live testing this session surfaced four severity-HIGH bugs that the test
suite and the type system both missed:

1. **Schema-vs-storage drift** — `src-ts-v2/schemas/db.ts` row schemas
   declared `created_at: z.string().optional()` while the on-disk SQLite
   columns permit NULL. Every fresh INSERT trip-wired ZodError on
   read-back. Invisible to `:memory:` tests because they rebuild from
   `schema.ts`.
2. **Error masking** — `src-ts-v2/database/connection.ts::withTransaction`
   rewrapped every non-`DatabaseError` as `DatabaseError('Transaction rolled
   back')`, destroying typed identity and cause chains.
3. **Cause guard always false** — `src-ts-v2/errors/AppError.ts:33`-attach
   guarded on `Error.prototype.hasOwnProperty('cause')` (a per-instance
   property; the guard never fires). Causes silently dropped.
4. **Platform-specific** — `src-ts-v2/auth/OAuthServer.ts::openBrowser`
   ran `cmd /c start "" <url>` on Windows; `&` query separators truncated
   the URL at the first `&`. Google received `?access_type=offline` only.

Plus one bug surfaced in the post-fix DB probe (today's job lied:
`processed=3, new=3, dur=0s` but zero rows landed) — already queued in
`_kanban.md` TODO.

All four shared root patterns the unit tests can't catch:

- **schema-truth-divergence** (DDL says X, schema declares Y, no test
  exercises real X)
- **typed-error suppression** at the boundary
- **default log-level masking** (Pino default is `error`; warnings invisible)
- **platform-specific runtime defects** (only live execution catches these)

These are the patterns a multi-lens code audit catches before the next
Phase-3 commit lands. Single-lens unit testing didn't. Tsc didn't. Code
review by a single agent would catch ~half. A **panel** with
**adversarial verify** is the corrective.

This audit is the deferred response to `docs/PHASE3-AMENDMENTS.md` A12
(live test never run) and the prevention layer for A13 (the counter-lie
bug) and the inevitable A14–An that haven't surfaced yet.

---

## Recommended approach

**One Workflow-tool invocation. Four phases. Output queues into kanban
and amendments doc.**

The Workflow tool runs in a subprocess, returns only structured summaries
to the orchestrator's context — keeps the calling session lean. The
kanban-bound output means `/teamtime` → `/chosetime` → `/worktime` then
drives execution one item at a time, exactly the discipline `/teamtime`
enforces.

### Phase A — Multi-lens fan-out (parallel, 8 reviewer agents, Opus)

Each lens is one `agent(...)` call inside the Workflow, run in parallel.
Each agent reviews the entire `src-ts-v2/` tree and the Ink re-point in
`src-ts/{cli.tsx,commands/,components/}`. Each returns a structured list
of findings:

```ts
[{ severity, file, line, summary, category, rationale, suggested_fix }]
```

| Lens | Agent type | What it hunts |
|---|---|---|
| 1 | `everything-claude-code:silent-failure-hunter` | swallowed errors, generic catches, default-log-level masking, missing propagation, lying counters |
| 2 | `everything-claude-code:database-reviewer` | Zod-vs-DDL drift, FK discipline, transaction boundaries, partial-write rollback semantics |
| 3 | `everything-claude-code:typescript-reviewer` | `any` smuggle, structural type drift, prototype-pollution-shaped checks, ESM/.js import correctness |
| 4 | `everything-claude-code:type-design-analyzer` | branded type usage at boundaries, schema-vs-shape divergence, interface vs type decisions |
| 5 | `everything-claude-code:comment-analyzer` | comment rot from the recent fix churn, lying comments, JSDoc claims vs actual behavior |
| 6 | `everything-claude-code:pr-test-analyzer` | coverage gaps; tests that pass on `:memory:` but would fail against a real upgrade-path DB; missing live-equivalent regressions |
| 7 | `everything-claude-code:security-reviewer` | OAuth flow (recently touched), token handling, scope leakage, secret-shape in logs |
| 8 | `everything-claude-code:code-reviewer` | general quality, dead code, altitude, reuse |

All agents output a normalized finding shape (Workflow `agent(... {schema})`
gives that for free via the StructuredOutput tool).

### Phase B — Dedup + judge (one Opus agent)

Sequential after Phase A. Receives the union of findings across all 8
lenses. Deduplicates overlap (multiple lenses often flag the same site).
Per surviving finding, decides single canonical severity. Returns
`[{ canonical_finding }]` ordered by severity desc. Assigns IDs starting
at `A13` so they slot into `docs/PHASE3-AMENDMENTS.md` numbering.

### Phase C — Adversarial verify (parallel, one Opus refuter per canonical finding)

For each canonical finding, one agent is asked to **refute** it — default
to `refuted=true` if uncertain. Findings that survive refutation are
high-confidence; refuted findings are dropped or downgraded.

Pattern matches the existing audit playbook from commit `9585cad`
(`docs/REWRITE_AUDIT.md`'s 8-agent fan-out), now extended with the
adversarial verify step that the original audit lacked.

### Phase D — Emit to kanban + amendments doc

For each surviving finding:

- **CRITICAL / HIGH** → `_kanban.md` TODO via kanbanger MCP `add_task`,
  using the `early-prototype:kanban-worker` agent type (Haiku, cheap).
  Title `[Audit/HIGH] <summary>` or `[Audit/CRITICAL] <summary>`.
  Description carries `file:line`, full rationale, suggested fix, verify
  reason, and the set of lenses that flagged it.
- **MEDIUM** → returned by the Workflow as a structured list. The
  orchestrator appends them to `docs/PHASE3-AMENDMENTS.md` as `A13+, A14+,
  …` using the existing amendment schema (`WHERE` / `WHAT` / `WHY IT
  MATTERS` / `RECOMMENDED DISPOSITION` / `PHASE-3 INTERACTIONS`).
- **LOW** → a single bulk-queued kanban item
  `[Audit/LOW] N quality-debt items from v2 deep-audit` in BACKLOG, with
  the list inline.

The Workflow returns its tree of agent counts + a summary table only to
the orchestrator. Full findings live in the kanban + amendments doc.

---

## Critical files (review scope)

Reviewers read the v2 tree end-to-end, but these are the load-bearing
files that warrant per-file attention:

- `src-ts-v2/database/` — all 9 repositories + `connection.ts` (the
  `withTransaction` discipline) + `schema.ts` (the DDL)
- `src-ts-v2/schemas/db.ts` — schema-vs-DDL pairing (the A11/A6 root)
- `src-ts-v2/extractors/VideoExtractor.ts` — pipeline integrator,
  counters source of truth (the lying-counter bug lives here)
- `src-ts-v2/api/YouTubeClient.ts` — Zod parse at wire boundary, error
  surface shape
- `src-ts-v2/parsers/GeminiParser.ts` — wire-boundary parse, prompt clean
- `src-ts-v2/auth/{YouTubeAuth,OAuthServer}.ts` — just touched; OAuth
  surface needs security pass
- `src-ts-v2/errors/AppError.ts` — base class; the cause-guard fix needs
  verification it didn't introduce new gaps
- `src-ts/cli.tsx` + `src-ts/commands/*.tsx` — the Wave-4 re-point, plus
  the inline `YouTubeClientAdapter` in `ExtractCommand.tsx` (Amendment A1)
- `docs/PHASE3-AMENDMENTS.md` — input (existing amendments anchor the
  review) and output target

---

## Existing patterns to reuse (do not re-invent)

- The **8-agent audit fan-out** pattern from commit `9585cad`
  (`docs/REWRITE_AUDIT.md`) — same lens combination is proven to work on
  this codebase; the only addition is the adversarial verify step.
- The **probe scripts** in `scripts/dev/probe-getmyplaylists.ts` and
  `scripts/dev/probe-extract-single-video.ts` — already-cause-walking
  diagnostic patterns. Findings that need a probe to verify should
  reference / extend these.
- **kanbanger MCP** for kanban writes (already wired via per-project
  venv; see `CLAUDE.md` §Kanban sync). Use the
  `early-prototype:kanban-worker` agent type for batched
  `mcp__kanbanger__add_task` calls.
- The **`docs/PHASE3-AMENDMENTS.md` schema** (`WHERE` / `WHAT` / `WHY IT
  MATTERS` / `RECOMMENDED DISPOSITION` / `PHASE-3 INTERACTIONS`) — append
  `A13+` in the same shape; don't invent a new schema.

---

## Verification

After the Workflow returns:

1. **Kanban has N new `[Audit/*]` items** in TODO (count visible in
   `_kanban.md`; kanbanger MCP `list_tasks` confirms).
2. **`docs/PHASE3-AMENDMENTS.md` has `A13+` appended** for MEDIUM
   findings, in the existing amendment schema.
3. **A summary table** of findings by lens + severity is visible in the
   Workflow's return value (lives in the orchestrator's reply, not in
   kanban — it's the "what got found" recap).
4. **`/teamtime` is the next-session entry point.** From there:
   `/chosetime` picks the top-severity new audit item; `/worktime`
   spawns the Worker session to fix it. Each fix is one `/worktime` →
   `/clocktime` round, ending in REVIEW.
5. **The original counter-lie bug** (kanban TODO before this audit) and
   any audit findings overlap with it — dedup if so. The audit's Phase B
   judge handles this.
6. **Live-test re-run** after the first few audit fixes land: re-run
   `metube extract playlist Ai` against a playlist with new videos.
   Counters should be honest; underlying errors should reach the user.

---

## Out of scope for this audit (deliberately)

- **Not** a Phase 3 scope-add. The audit produces findings; Phase 3 work
  is queued behind audit fixes.
- **Not** a refactor or architecture change. Findings call out drift /
  smell / lies; they don't propose new abstractions.
- **Not** a re-run of `/code-review ultra`. That single-burst review
  dumps findings; this audit panel + adversarial verify + kanban-routing
  is the discipline-preserving version. (Could be added later as a
  cross-check pass if owner wants belt-and-braces.)
- **Not** a doc-rot sweep on `docs/internal/` (those are archived, not
  active per `CLAUDE.md`).
- **Not** `archive/src-ts-v1/` — read-only reference.

---

## Stats (what to expect)

- ~8 reviewer agents × ~50–100 k tokens each = 400–800 k tokens Phase A
- ~1 judge agent × ~50 k = 50 k Phase B
- ~N refuter agents (N = number of canonical findings, ~15–40 expected)
  × ~30 k each = 450 k – 1.2 M tokens Phase C
- ~1 kanban-worker agent (Haiku) for emissions, batched
- Total budget: ~1–2 M tokens in the Workflow subprocess. Orchestrator
  receives only the summary (~10 k tokens).
- Wall clock: ~10–25 minutes depending on agent parallelism cap.

---

## How to execute

In a session opened in `C:\Users\Fab2\Desktop\AI\_tools\_metube`:

1. Confirm kanbanger MCP is connected (`.mcp.json` in repo root wires
   it via per-project `.venv/`).
2. Ask the agent: *"run the V2 deep audit brief"* (or equivalent
   reference to `docs/V2-DEEP-AUDIT-BRIEF.md`).
3. The agent translates this brief into a single `Workflow({script})`
   call with the four-phase structure above.
4. Wait for the Workflow to return (10–25 min). The summary table comes
   back to the calling session; full findings are already in kanban +
   amendments by then.
5. Run `/teamtime` to enter PM mode; `/chosetime` to pick the top
   audit item; `/worktime` to spawn the Worker. Repeat until the
   `[Audit/*]` items are cleared.

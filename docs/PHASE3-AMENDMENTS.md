# meTube — Phase 3 Amendments

> Drifts, unresolved issues, and design smells surfaced during the
> autonomous Phase 2 port run (2026-05-28). **Read this before adding any
> new Phase 3 scope.** Some Phase 3 BACKLOG items are simpler if these
> amendments land first; some are blocked by them.
>
> Companion: `docs/HANDOVER-2026-05-28-phase2-port.md` is the full session
> handover with context for every item.
>
> Discipline: each amendment carries `WHERE` (file:line evidence), `WHAT`
> (what's actually wrong / drifting), `WHY IT MATTERS`, and `RECOMMENDED
> DISPOSITION`. No vague "improve X" entries.

---

## Severity legend

- **BLOCKING** — a Phase 3 item in the BACKLOG depends on this being fixed first
- **HIGH** — silent failure, semantic loss, or design smell that costs the next
  contributor (or future me) time
- **MEDIUM** — cosmetic / convenience drift, doesn't break anything but reads
  inconsistent
- **LOW** — note-only; address when the surrounding area is next touched

Each item also tags the **PHASE-3 INTERACTIONS** — which BACKLOG items it
helps or blocks.

---

## A1 — YouTubeClient ↔ VideoExtractor naming drift

**Severity:** HIGH. **Phase-3 interactions:** blocks clean
`playlist add-mine` / `playlist sync` work; affects single-video command.

**WHERE:**
- `src-ts-v2/api/YouTubeClient.ts` — exports `getVideoById` / `getPlaylistById`
  / `getPlaylistItems`
- `src-ts-v2/extractors/VideoExtractor.ts` — internally expects a
  `YouTubeClientLike` shape with `getVideoDetails` / `getPlaylistInfo` /
  `getPlaylistVideos`
- `src-ts/commands/ExtractCommand.tsx` — has an **inline
  `makeYouTubeClientAdapter(client)` helper at the bottom** that wraps the
  real `YouTubeClient` to satisfy `YouTubeClientLike`. This is the Wave-3
  sibling-drift papered over at the Ink boundary.

**WHAT:** Two v2 modules disagree on names for the same operations. Wave 3
agents wrote against placeholder interfaces while siblings were still
in-flight; placeholders got committed; an adapter shim resolves it at the
call site. The placeholder interface inside `VideoExtractor.ts` should not
exist — `VideoExtractor` should declare a dependency on the real
`YouTubeClient` shape.

**WHY IT MATTERS:** Anyone reading `VideoExtractor.ts` cold sees a
`YouTubeClientLike` interface that doesn't match the actual `YouTubeClient`,
follows it into the type and gets confused about why the constructor
accepts a structurally different thing than what `cli.tsx` constructs.
Every new entrypoint into `VideoExtractor` (single-video commands;
`playlist add-mine`; sync) has to either go through the adapter or
reinvent one.

**RECOMMENDED DISPOSITION:**

1. Pick a side. The cleaner direction is to **rename `VideoExtractor`'s
   `YouTubeClientLike` to match `YouTubeClient`'s actual method names**
   (`getVideoById`, `getPlaylistById`, `getPlaylistItems`). The sibling
   names are more disciplined and align with the schema layer.
2. Delete the inline `makeYouTubeClientAdapter` in `ExtractCommand.tsx`.
3. Make `YouTubeClient` itself satisfy the structural type that
   `VideoExtractor` declares — by literal type identity, not by adapter.

Land before any Phase 3 work that touches `VideoExtractor` (single-video,
add-mine, sync).

---

## A2 — No public single-video method on v2 VideoExtractor

**Severity:** HIGH. **Phase-3 interactions:** BLOCKS Phase 3 item
"Single-video command — `metube video add <url-or-id>`".

**WHERE:**
- `src-ts-v2/extractors/VideoExtractor.ts` — exposes only `extractPlaylist()`
- `src-ts/commands/VideoCommands.tsx` (VideoAdd handler) —
  **reimplements** the per-video pipeline inline using v2 building blocks
  (`YouTubeClient.getVideoById` + `VideoRepository.createOrUpdate` +
  `StatisticsRepository.recordSnapshot` + `TranscriptExtractor` +
  `EntityRepository.insertMany` + `DescriptionParser`)

**WHAT:** v1 had `VideoExtractor.extractSingleVideo(id)`; v2 doesn't.
VideoAdd compensates by inlining the whole pipeline (a shrunken
`extractPlaylist` for a one-element list). Two copies of the same
orchestration drift apart on the first divergent edit.

**WHY IT MATTERS:**

- The Phase 3 BACKLOG item "Single-video command — `metube video add
  <url-or-id>`" already touches this surface. Without a public
  `extractSingleVideo` on `VideoExtractor`, the new command will land yet
  another inlined copy.
- The inlined copy in VideoAdd **does not currently integrate with
  GeminiParser** (description-regex only). v1 had `enableWhisper` /
  `autoLlmParse` flags that propagated through. The v2 inline copy
  silently doesn't.

**RECOMMENDED DISPOSITION:**

1. Add `VideoExtractor.extractSingleVideo(videoId: VideoId, opts?: {
   onProgress?: ... }): Promise<SingleExtractResult>` — same pipeline as the
   per-video loop body inside `extractPlaylist`, no playlist concerns.
2. Refactor the existing per-video loop in `extractPlaylist` to call the
   same private/shared helper so they can't drift.
3. Rewire `VideoAdd` in `VideoCommands.tsx` to call the new public method.
4. Restore Gemini integration in the single-video path.

Land before the Phase 3 single-video command work.

---

## A3 — Gemini integration silently dropped in VideoAdd

**Severity:** HIGH. **Phase-3 interactions:** blocks honest single-video
extraction; partial duplication of A2 but a distinct semantic loss worth
tracking on its own.

**WHERE:**
- `src-ts/commands/VideoCommands.tsx` — VideoAdd handler
- v1 used `VideoExtractor` with `enableWhisper` / `autoLlmParse` config that
  propagated GeminiParser dependency through

**WHAT:** v1's single-video extraction included LLM parsing (topics, people,
sentiment). v2's VideoAdd inline reimplementation **only does the
description-regex path** — the Gemini-populated entity types (topics,
people, sentiment) are silently absent.

**WHY IT MATTERS:** A user running `metube video add <url>` and then
`metube report video <id>` will see a thinner HTML report than v1
produced, with no notice. This is exactly the class of bug Phase 2
designed against (silent semantic loss).

**RECOMMENDED DISPOSITION:** Fixed naturally when A2 lands — a public
`extractSingleVideo` should accept a `deps: { geminiParser? }` parameter
identical to `extractPlaylist`'s constructor `deps` slot. Verify by adding
an integration test that asserts `ai_analysis` row exists after
`extractSingleVideo` when `geminiParser` is injected.

---

## A4 — YouTubeAuth lacks a disk-probe convenience

**Severity:** MEDIUM. **Phase-3 interactions:** none direct; affects general
UX in StatusPanel + ReplMode.

**WHERE:**
- `src-ts-v2/auth/YouTubeAuth.ts` — has `authenticate()` (full OAuth flow),
  `loadTokens()` (file read + parse), `hasValidTokens()` (requires prior
  `authenticate()` call — checks the in-memory client)
- `src-ts/components/StatusPanel.tsx` — uses `loadTokens()` in try/catch as
  a disk-probe substitute
- `src-ts/components/ReplMode.tsx` — same pattern, two call sites

**WHAT:** v1 had `auth.hasValidTokens()` that probed the disk and
`auth.isAuthenticated()` for in-memory state. v2's `hasValidTokens()`
requires an authenticated client first, so "do I have tokens on disk?"
becomes a `loadTokens()` in `try { ... } catch { return false }` block at
every call site. Noisier than necessary.

**WHY IT MATTERS:** Ink components repeat the same try/catch shape three
times. Each call site rolls its own definition of "are we authenticated?",
which is the kind of small drift that produces inconsistent UI behaviour
(e.g. one place treats expired tokens as "not authenticated", another as
"authenticated but failing").

**RECOMMENDED DISPOSITION:** Add `YouTubeAuth.hasTokensOnDisk(): boolean`
that wraps the `loadTokens()` try/catch and returns a plain boolean.
Update the three Ink call sites. Keep the in-memory `hasValidTokens()` —
they serve different questions ("can I make an API call right now?" vs
"will I need to prompt for OAuth?").

---

## A5 — HTMLReportGenerator dropped autoOpen

**Severity:** MEDIUM. **Phase-3 interactions:** affects `metube report
playlist` UX; will read as a regression once anyone runs v1.0.0 against a
fresh playlist.

**WHERE:**
- `src-ts-v2/reports/HTMLReportGenerator.ts` — no `autoOpen` field
- `src-ts/commands/ReportCommand.tsx` — `--no-open` flag is now cosmetic
  (only suppresses the "Opening in browser..." copy in the done view; no
  browser actually opens regardless)

**WHAT:** v1's `HTMLReportGenerator(db, { autoOpen: true })` actually
opened the generated HTML in the default browser via `open` npm package.
v2 dropped this surface entirely.

**WHY IT MATTERS:** The personal-use workflow is "run extract, run report,
look at it" — auto-opening the HTML was a deliberate ADHD-friendly removal
of one step. The `--no-open` flag still exists in the CLI but no longer
gates anything.

**RECOMMENDED DISPOSITION:** Restore `autoOpen` in
`HTMLReportGenerator`'s options bag — accept the v2 typed-options pattern,
plug `open` (the npm package — already a dep), suppress the call when
`--no-open` is true. Add a tiny test that asserts `open` is called with
the report path when `autoOpen` is on, and not called when off.

---

## A6 — AppError.cause guard is dead

**Severity:** HIGH (silent semantic loss). **Phase-3 interactions:** every
error path in v2 loses cause-chain context; affects any debugging work
during Phase 3.

**WHERE:**
- `src-ts-v2/errors/AppError.ts:33` — `if
  (Error.prototype.hasOwnProperty('cause')) { ... }` guard
- Flagged originally by the Wave-2 EntityRepository agent during review

**WHAT:** The constructor checks `Error.prototype.hasOwnProperty('cause')`
before attaching the cause. But `cause` is a per-instance property in Node,
not on the prototype — so the guard is **always false** and the cause
is **never attached**. Every `new AppError('X', code, { cause: someErr })`
silently throws away `someErr`.

**WHY IT MATTERS:** When a Wave-3 SDK error or DB error gets re-raised as
an `AppError`, the original Error is lost. Anyone debugging in Phase 3
sees the `AppError` message but no stack trail to the actual source.
This is the kind of "we have logging but the logs don't tell you what
happened" pattern v2 is supposed to foreclose.

**RECOMMENDED DISPOSITION:** Replace the prototype check with a per-instance
check or, better, just unconditionally attach `cause` when it's provided:

```ts
if (options?.cause !== undefined) {
  (this as { cause?: unknown }).cause = options.cause;
}
```

Drop the `hasOwnProperty` guard entirely. Modern Node always supports it.
Add a regression test in `src-ts-v2/__tests__/errors.test.ts` (file doesn't
exist yet — write it as part of this fix): `new AppError('msg', 'CODE',
{ cause: inner }).cause === inner`.

---

## A7 — Stub-bomb pre-commit hook regex catches comment lines

**Severity:** MEDIUM. **Phase-3 interactions:** any Phase 3 commit that
describes a removed `: any` cast in a JSDoc will re-trigger this.

**WHERE:**
- `.git/hooks/pre-commit` (project-local, not tracked)
- Backlog item already exists: "[Tooling] Refine stub-bomb pre-commit hook
  regex to exclude TS/JS comment lines"

**WHAT:** The regex `: any[\s]*[=)]` matches anywhere in a staged
`+`-prefixed diff line, including JSDoc/inline comments that describe an
`: any` cast (even when the cast was being REMOVED). Wave 3 commit
`234a8e5` tripped on a comment in `WhisperExtractor.ts` describing the
`(seg: any)` cast that the lift removed.

**WHY IT MATTERS:** A defensive hook that fires on the diff describing the
defence it's enforcing has a usability problem.

**RECOMMENDED DISPOSITION:** Refine the hook to skip lines that, after the
leading `+`, start with `//`, `/*`, ` *`, or `*` (the JSDoc/inline comment
shapes). Pattern sketch:

```sh
# in .git/hooks/pre-commit
# Skip comment-shaped added lines:
diff --cached -U0 | grep -E '^\+[^+]' \
  | grep -vE '^\+\s*(//|/\*|\*)' \
  | grep -E ': any\s*[=)]'
```

Add a regression test (a tiny `.git/hooks/pre-commit.test.sh` that pipes a
synthetic diff through the hook and asserts the right exit code).

---

## A8 — Stub-bomb bypass `[stub-allowed]` doesn't work for `-m` commits

**Severity:** HIGH (operational). **Phase-3 interactions:** any future
legitimately-needs-bypass commit will fail unless re-shaped.

**WHERE:**
- `.git/hooks/pre-commit` (project-local) — bypass check reads
  `.git/COMMIT_EDITMSG`
- Wave 3 commit attempt with `[stub-allowed]` token in the `-m` message
  ALSO failed; only a content rephrase resolved it

**WHAT:** `git commit -m "msg"` does NOT populate `.git/COMMIT_EDITMSG`
before the pre-commit hook fires (at least not with the modern git this
project is on). The hook reads `.git/COMMIT_EDITMSG`, sees a stale message
from the previous commit, and concludes there's no `[stub-allowed]` token.
`--no-verify` is blocked by a separate harness rule. Net: the documented
bypass has no working path for `-m` commits.

**WHY IT MATTERS:** The hook is a guardrail. A guardrail with no escape
valve becomes a hostage — the only way past it is to spawn a micro-agent
to rephrase content, which costs an Opus run.

**RECOMMENDED DISPOSITION:** Two options, pick one (or both):

1. Move the bypass check to a `commit-msg` hook. By the time `commit-msg`
   runs, `git` HAS finalized the message. Check there: if message contains
   `[stub-allowed]`, exit 0 and skip the stub-bomb check. Pre-commit becomes
   the content scan only.
2. Add a `--allow-stubs` git-config or file-marker bypass for the
   pre-commit hook (e.g. `.git/STUB_ALLOW` exists → skip). Less elegant
   than commit-msg-driven; offered as fallback if commit-msg complicates
   the hook split.

Land alongside A7 so the next person who triggers the hook for a
legitimate reason has a working bypass.

---

## A9 — VideoRecord lost `has_transcript` field in PlaylistVideos

**Severity:** MEDIUM (silent UI regression).

**WHERE:**
- `src-ts/commands/PlaylistCommands.tsx` (PlaylistVideos handler)
- v1 `Video` type had `has_transcript`; v2 `VideoRecord` doesn't (the
  source of truth is `TranscriptRepository.exists(videoId)`)

**WHAT:** v1's `Video` row carried `has_transcript: boolean` denormalized.
v2 normalized that away (transcripts live in their own table; existence
is a per-video query). The PlaylistVideos UI used to render a "✓ transcript"
column based on `video.has_transcript`. v2 currently passes `undefined`
to the renderer.

**WHY IT MATTERS:** Users browsing a playlist's videos lose visibility
into which ones have transcripts. The UI silently degrades.

**RECOMMENDED DISPOSITION:** In PlaylistVideos, build a `Set<VideoId>` of
videoIds with transcripts via a single `TranscriptRepository.findAll()`
query (or a new `findVideoIdsByExistence()` method that just returns the
IDs without bodies — N rows, ~64-byte IDs each, cheap). Render the
"✓ transcript" column off that set.

Could also add `VideoRepository.findByPlaylistWithTranscriptFlag()` that
does the JOIN once, returns `VideoRecord & { hasTranscript: boolean }`.
Cleaner but adds an API. Either works.

---

## A10 — TranscriptData shape preserved as snake_case

**Severity:** LOW (consistency drift).

**WHERE:**
- `src-ts-v2/extractors/TranscriptExtractor.ts` — `TranscriptData` interface
  uses `full_text`, `is_auto_generated`, `from_whisper`
- `src-ts-v2/database/schemas/db.ts` — `TranscriptRowSchema` also uses
  snake_case (matches SQL column names)
- Rest of v2 surfaces use camelCase

**WHAT:** Transcript shape stayed snake_case across the v1 lift; the rest
of v2 (videos, playlists) normalized to camelCase on the way to typed
interfaces. The Ink layer touches both conventions back-to-back in places.

**WHY IT MATTERS:** Cosmetic. But it's the kind of thing that hides a
field-mismatch bug behind a manual snake↔camel mental translation.

**RECOMMENDED DISPOSITION:** Two paths, pick one:

1. **Leave snake_case** at the DB row layer, but normalize to camelCase at
   the application-layer interface (`TranscriptData`). Add a thin
   `toCamel(row)` mapping inside `TranscriptRepository`. Other repos in
   Wave 2 already do this for their domain types.
2. **Accept snake_case** as the de facto convention at the DB boundary
   for transcripts specifically, and add a comment in `TranscriptData`
   explaining why it differs from peer types.

Lean toward option 1 for consistency. Low priority; deferrable.

---

## A11 — `EntityRepository.insertMany` moves Zod validation pre-transaction

**Severity:** LOW (note-only; design pattern worth flagging for replication).

**WHERE:**
- `src-ts-v2/database/EntityRepository.ts` — validation runs BEFORE
  `withTransaction(...)` opens; flagged by the implementing agent's review
- Root cause documented in `src-ts-v2/database/connection.ts::withTransaction`
  — the wrapper catches non-`DatabaseError` causes and rewraps them as a
  generic `DatabaseError('Transaction rolled back')`, masking the typed
  `ValidationError`

**WHAT:** EntityRepository narrows `entity_type` via `EntityTypeSchema.parse()`
BEFORE opening the transaction. Inside the transaction, the SQLite-level
constraint check still protects against per-row violations, but the typed
`ValidationError` for "this entity_type isn't in the enum" reaches the
caller pre-transaction (when it would otherwise get masked).

**WHY IT MATTERS:** Pattern worth replicating across repositories. Any
repository that uses a Zod schema to narrow before INSERT should do the
narrowing pre-transaction. The `withTransaction` wrapper itself could be
augmented to preserve `cause` (and `instanceof`) better.

**RECOMMENDED DISPOSITION:**

1. **Pattern note** — add a comment in `connection.ts::withTransaction`
   documenting that typed errors thrown OUTSIDE the callback reach
   callers as-is; typed errors thrown INSIDE are wrapped. So narrow
   user-supplied input BEFORE entering the callback.
2. **Optional**: rework `withTransaction` to re-throw the original error
   type if it's an `AppError` subclass (i.e. don't wrap into generic
   `DatabaseError` if the cause was a `ValidationError`). Combined with
   A6 (cause-preservation fix), this restores honest error pathways
   through the transaction boundary.

---

## A12 — Live test never run

**Severity:** HIGH (it's the documented signal-of-done).

**WHERE:**
- `docs/PORT_PLAN.md:205` — shipping milestone is `metube init && metube
  playlist add <ID> && metube extract playlist <ID> && metube report
  playlist <ID>` end-to-end against a real YouTube account
- This run never executed it (autonomous orchestration can't do interactive
  OAuth)

**WHAT:** Phase 2 is locally complete on automated criteria (build clean,
453 tests green, archive complete) but the documented end-to-end signal
is unverified.

**WHY IT MATTERS:** v2 ports a lot of moving parts (auth flow,
paginated API calls, Whisper subprocess wiring, Gemini API integration,
report generation). The automated suite covers the contract at each
boundary; the live test is what proves the boundaries compose.

**RECOMMENDED DISPOSITION:** Before opening Phase 3, run:

```
metube init           # interactive OAuth; tokens.json populated
metube playlist add <small test playlist ID>
metube extract playlist <ID>
metube report playlist <ID>
```

Acceptance: report HTML opens (after A5 lands) and contains topic +
person + repo data. If it fails, file findings as A13+ amendments and
fix before Phase 3 opens. **This is the actual gate.**

---

## Deep-audit batch — 2026-06-04 (A13–A33)

Source: multi-lens Workflow audit — 8 reviewer lenses (silent-failure,
database, typescript, type-design, comments, tests, security, quality) →
judge/dedup → adversarial verify. 30 agents, ~2.56M tokens. 26 raw findings
→ 21 canonical → **17 survived** verification (4 refuted, 0
already-documented). This is the deferred response to A12 — live-equivalent
review surfaced the defects an interactive run would hit.

**ID ledger:**
- **Kanban TODO** (HIGH, fix-now): A13, A14, A15, A18
- **Amendments below** (MEDIUM): A16, A17, A20, A22, A23, A24, A25, A26, A27, A28
- **Kanban BACKLOG** (LOW, bulk item): A21, A30, A33
- **Refuted** by adversarial verify (not real / cosmetic-only): A19, A29, A31, A32

**The HIGH cluster — read these together.** The marquee dual-transcript /
Whisper / Gemini pipeline is silently inert on the `extract playlist` path,
and the default log level hides it. This is the root-cause web behind the
kanban `counter-lie` symptom (videos reported processed, ~0 rows landed):
- **A18** never injects the transcript/Whisper extractors → `fetchTranscript` returns null.
- **A14** never persists the transcript even when injected → zero rows, still counted "processed."
- **A15** throws-and-swallows the moment the Gemini parser is wired → LLM analysis zeroed.
- **A26** (default Pino `error` level) hides every soft-failure breadcrumb of the above.

Fix order: A14 + A18 together (inert apart), then A26 for visibility, then A15 before any Gemini wiring.

---

## A13 — Join-schema NULL-timestamp drift breaks `getItemsWithVideos`

**Severity:** HIGH → kanban TODO. **Lenses:** database, typescript, type-design, tests (4 independent). **Verify:** high. **Phase-3 interactions:** blocks any playlist-items-with-videos read against a DB carrying NULL timestamps (notably the Python-originated DB this port targets).

**WHERE:**
- `src-ts-v2/database/PlaylistItemRepository.ts:77-78` — `PlaylistItemWithVideoSchema.v_created_at/v_updated_at` are `z.string().optional()`
- canonical `src-ts-v2/schemas/db.ts:65-66` — `VideoRowSchema` is `z.string().nullable().optional()`
- DDL `src-ts-v2/database/schema.ts:60-61` — `TEXT DEFAULT CURRENT_TIMESTAMP` (NULL permitted, no `NOT NULL`)

**WHAT:** The join schema omits `.nullable()`, so a `videos` row with NULL `created_at`/`updated_at` parses fine via `findById` but throws `ZodError` through `getItemsWithVideos`, which rewraps it as `DatabaseError('Failed to load playlist items with videos')` — failing the entire playlist read and burying the cause.

**WHY IT MATTERS:** A new instance of the exact schema-truth-divergence class that already bit `videos.created_at`. Invisible to `:memory:` tests because they seed via plain INSERT and let SQLite fill the DEFAULT — the same blind spot that hid the original drift.

**RECOMMENDED DISPOSITION:** Add `.nullable()` to both columns so the join schema mirrors `VideoRowSchema`. Add a `getItemsWithVideos` regression test inserting a `videos` row with explicit NULL timestamps. Longer-term, derive the `v_`-prefixed columns from `VideoRowSchema.shape` so the two cannot drift again.

---

## A14 — VideoExtractor never persists the transcript on the playlist path

**Severity:** HIGH → kanban TODO. **Lenses:** silent-failure. **Verify:** high. **Phase-3 interactions:** the marquee dual-transcript capability; pairs with A18.

**WHERE:**
- `src-ts-v2/extractors/VideoExtractor.ts:700-767` (`processVideo`); `VideoExtractorDeps` (lines 332-344) has no `TranscriptRepository`
- Python source `legacy/python/src/extractors/video_extractor.py:187` persists it; single-video path `src-ts/commands/VideoCommands.tsx:170-178` proves intent via `transcriptRepo.upsert`

**WHAT:** `processVideo` fetches the transcript (line 700), uses `full_text` only to feed Gemini (line 724), and returns `'processed'` (line 767) — there is no `upsert` anywhere in the file. The playlist path writes zero transcript rows while reporting success.

**WHY IT MATTERS:** Silent data loss on the differentiated capability, masked by the `processed` counter (distinct from but feeding the `counter-lie` symptom).

**RECOMMENDED DISPOSITION:** Inject a `TranscriptRepository` into `VideoExtractorDeps`; in `processVideo`, immediately after a non-null `fetchTranscript`, call `transcriptRepository.upsert(videoId, { language, fullText, segments, isAutoGenerated })` before counting the video processed. Add an integration test asserting a `transcripts` row after `extractPlaylist`.

---

## A15 — GeminiParser arg-shape drift silently zeroes LLM analysis once wired

**Severity:** HIGH → kanban TODO. **Lenses:** silent-failure, comments, quality (3). **Verify:** high. **Phase-3 interactions:** fires the instant the A2/A3 remediation wires the parser.

**WHERE:**
- `src-ts-v2/extractors/VideoExtractor.ts:223` — `GeminiParserLike.parseTranscript(transcriptText, videoTitle)` (positional); call site `:724` passes two positional strings
- concrete `src-ts-v2/parsers/GeminiParser.ts:140` takes one `{ transcript, videoTitle }` object and throws `ValidationError` on a non-string (line ~144)
- swallow at `VideoExtractor.ts:739-746` (`logger.warn`)

**WHAT:** Wiring the real parser binds the first string to `input`, `input.transcript` is undefined, the guard throws, and the throw is caught as a `warn` — invisible at the default log level (A26). `geminiResult` stays null, so `ai_analysis.upsert` is skipped. Two JSDoc blocks assert mutually exclusive call shapes for the same method; the test mocks bake in the wrong (positional) shape.

**WHY IT MATTERS:** Silently destroys the project's marquee LLM-analysis output the moment the parser is connected, with no error surfaced, while the suite stays green.

**RECOMMENDED DISPOSITION:** Reconcile the contract — change `GeminiParserLike` + the call to `parseTranscript({ transcript: transcript.full_text, videoTitle: details.title })` and drop the "mirrors the real surface" JSDoc. Add a wiring integration test injecting the real `GeminiParser` and asserting `ai_analysis` is written. Raise the swallowed failure from `warn` to `error`.

---

## A16 — WhisperExtractor has no test file

**Severity:** MEDIUM (verify downgraded from HIGH — graceful degradation, no crash). **Lenses:** tests. **Verify:** high.

**WHERE:** `src-ts-v2/extractors/WhisperExtractor.ts:278-384`; no `WhisperExtractor.test.ts` exists. Both peer tests exercise the fallback only through structural doubles (`WhisperLike` / `WhisperExtractorLike`).

**WHAT:** The marquee fallback's real class — subprocess `spawn` (line 317), JSON-marker parse, unvalidated cast (A17), duration math, close/error/unlink lifecycle — is executed by no test.

**WHY IT MATTERS:** The one differentiated component with zero live-equivalent regression; platform-specific subprocess defects only surface at runtime.

**RECOMMENDED DISPOSITION:** Add `WhisperExtractor.test.ts` stubbing `node:child_process` spawn with a fake `ChildProcess` emitter, driving real `transcribeAudio`: happy-path mapping; valid-JSON-missing-segments → clean typed error; absent markers → `WHISPER_PARSE_FAILED`; non-zero exit → `WHISPER_FAILED` with stderr; spawn error → `PYTHON_NOT_FOUND` with temp-script cleanup.

---

## A17 — Blind `as WhisperPayload` cast at the subprocess boundary

**Severity:** MEDIUM (verify downgraded from HIGH — contained blast radius). **Lenses:** typescript, tests. **Verify:** high.

**WHERE:** `src-ts-v2/extractors/WhisperExtractor.ts:340-343` — `parsedUnknown as WhisperPayload` then `payload.segments.map(...)` with no narrowing. The file header claims "unknown narrowing"; sibling `parsers/GeminiParser.ts` explicitly forecloses this exact pattern with `GeminiResponseSchema.parse()`.

**WHAT:** Violates the v2 "Zod at every wire boundary" invariant. A valid-JSON-but-malformed payload (missing `segments`) throws a raw `TypeError` rewrapped as a misleading `WHISPER_PARSE_FAILED`.

**WHY IT MATTERS:** Label-lies-code; the boundary is dishonest, and a subprocess schema change surfaces as the wrong error class.

**RECOMMENDED DISPOSITION:** Define a `WhisperPayloadSchema` (Zod) mirroring the payload and replace the cast with `WhisperPayloadSchema.parse(parsedUnknown)` inside the existing try (the catch already maps to `WHISPER_PARSE_FAILED`).

---

## A18 — ExtractCommand injects no transcript/Whisper extractors → dual-transcript pipeline is a no-op

**Severity:** HIGH → kanban TODO. **Lenses:** quality. **Verify:** high. **Phase-3 interactions:** the primary `metube extract playlist` / `extract --all` workflow; pairs with A14.

**WHERE:** `src-ts/commands/ExtractCommand.tsx:151-153` and `:216-218` — both `new VideoExtractor(...)` pass only `{ descriptionParser }`. `VideoExtractor.ts:426-427` leaves `transcriptExtractor`/`whisperExtractor` null when not injected; `fetchTranscript` (lines 784-786) returns null when `transcriptExtractor === null`.

**WHAT:** Config flags `autoTranscript:true` + `enableWhisper:true` are inert because the deps aren't injected, so no transcripts and no Whisper fallback run on the primary path. The single-video path (`VideoCommands.tsx`) wires them correctly — the two entry points diverge.

**WHY IT MATTERS:** The capability `CLAUDE.md` calls "differentiated" is dead on the marquee workflow. Same deps-dropped-at-Ink-boundary class as A3/A5, new instance. (Metadata, statistics, playlist-join, and regex description-entities still persist — it is not a total no-op.)

**RECOMMENDED DISPOSITION:** In `ExtractCommand`, construct and inject the v2 extractors mirroring `VideoCommands.tsx` (`new WhisperExtractor()` → `new TranscriptExtractor({ whisperExtractor })` → pass both + `descriptionParser`). Alternatively have `VideoExtractor` self-construct from config when deps are absent. Inert until A14 also lands.

---

## A20 — No schema test feeds NULL to a nullable-default timestamp column

**Severity:** MEDIUM. **Lenses:** tests. **Verify:** high.

**WHERE:** `src-ts-v2/__tests__/schemas.test.ts:355-643` — every row fixture supplies timestamps as strings or omits them; the only nulls are `category_name`, `last_checked`, `error_message`.

**WHAT:** The `.optional()`-vs-`.nullable()` distinction (the literal A13 bug) is untestable by this suite for every table. A regression reverting any defaulted-timestamp column to `.optional()` would pass every test.

**WHY IT MATTERS:** The standalone ROW-schema tests are the cheapest place to catch this drift class, and they don't.

**RECOMMENDED DISPOSITION:** For each ROW schema whose DDL is `TEXT DEFAULT CURRENT_TIMESTAMP` without `NOT NULL` (videos.created_at/updated_at, video_statistics.recorded_at, transcripts.extracted_at, extracted_entities.extracted_at, tags.created_at, playlists.created_at/updated_at/last_checked, ai_analysis.analyzed_at), add `it('accepts null for <col>')`.

---

## A22 — tokens.json written with default permissions

**Severity:** MEDIUM. **Lenses:** security. **Verify:** high.

**WHERE:** `src-ts-v2/auth/YouTubeAuth.ts:413` (`writeFileSync`, no `mode`), `:411` (`mkdirSync`, no `mode`). Payload includes a non-expiring `refresh_token` for write scope `youtube.force-ssl`.

**WHAT:** On a multi-user POSIX host with permissive umask, the live OAuth credentials land group/other-readable.

**WHY IT MATTERS:** Owner-only perms for credential material at rest is standard (ssh/gcloud/aws). No-op on the user's Windows target — hence MEDIUM, latent hardening gap.

**RECOMMENDED DISPOSITION:** `writeFileSync(path, data, { encoding: 'utf-8', mode: 0o600 })`, `mkdirSync(dir, { recursive: true, mode: 0o700 })`, and `chmodSync(path, 0o600)` after the write to harden re-saves.

---

## A23 — Dead config knobs on VideoExtractor

**Severity:** MEDIUM. **Lenses:** quality. **Verify:** high.

**WHERE:** `src-ts-v2/extractors/VideoExtractor.ts:240-263` — `transcriptLanguage`, `transcriptLanguages`, `transcriptRateLimitMs`, `geminiApiKey` never read; `whisperModel` read only in a log line. (`geminiModel` is genuinely consumed at line 763 — correctly excluded.)

**WHAT:** Because the extractor is inject-only, these knobs have no consumer. A caller setting `transcriptLanguages:['fr']` parses fine and gets zero effect. `transcriptLanguage`/`transcriptLanguages` are redundant encodings of one concept.

**WHY IT MATTERS:** A documented, Zod-validated config surface that silently does nothing — API dishonesty / fragility.

**RECOMMENDED DISPOSITION:** Either use the config to construct default extractors when deps are absent (passing languages/rate-limit/model through), or delete the unused fields and collapse the two language fields into one.

---

## A24 — Terminal `extraction_jobs` audit write is unguarded

**Severity:** MEDIUM. **Lenses:** silent-failure. **Verify:** high.

**WHERE:** `src-ts-v2/extractors/VideoExtractor.ts:572-576` (success `updateStatus`) inside the outer try (catch at :601 → :614); failure-path `updateStatus(... 'failed')` at :605 before the rethrow at :612, not nested. `ExtractionJobRepository.updateStatus` ends with a non-safe `ExtractionJobRowSchema.parse` (line 251).

**WHAT:** On success, an audit-write throw turns a good run into `PLAYLIST_EXTRACTION_FAILED` and discards the computed result. On failure, a throw from the `'failed'` write shadows and loses the original cause. Both writes can throw (`SqliteError`, or `ZodError` on read-back).

**WHY IT MATTERS:** The audit-row write — itself fallible — determines or destroys the reported outcome.

**RECOMMENDED DISPOSITION:** Wrap each terminal `updateStatus` in its own try/catch: on success, log loudly but still return the computed `ExtractResult`; on failure, nest the `'failed'` write so a secondary failure can't shadow the original cause being rethrown.

---

## A25 — Stale `DEFAULT_MODEL` + false "matches Python" comment

**Severity:** MEDIUM. **Lenses:** comments. **Verify:** high.

**WHERE:** `src-ts-v2/parsers/GeminiParser.ts:44-48` — `DEFAULT_MODEL = 'gemini-1.5-flash'` under "Matches the Python default." Python (`legacy/python/src/parsers/llm_parser.py:18`) defaults to `gemini-3-flash-preview`; v2 (`VideoExtractor.ts:244`, `schemas/config.ts:27`, `AIAnalysisRepository.ts:177`) uses `gemini-3-flash-preview`.

**WHAT:** The parity claim is false and the codebase contradicts itself; a default-constructed parser silently picks an older model. (The adjacent `MAX_TRANSCRIPT_CHARS` comment IS accurate — rules out an intentional pin.)

**WHY IT MATTERS:** Misleads any reader trusting the parity comment. Latent (production injects `config.geminiModel`).

**RECOMMENDED DISPOSITION:** Change `DEFAULT_MODEL` to `'gemini-3-flash-preview'`, or if the older model is deliberate, rewrite the comment to say it differs and why.

---

## A26 — Default Pino level `error` masks all soft-failure breadcrumbs

**Severity:** MEDIUM. **Lenses:** silent-failure. **Verify:** high. **Note:** the amplifier that makes A14/A15 invisible.

**WHERE:** `src-ts-v2/utils/logger.ts:16` — level = `LOG_LEVEL || (isTest ? 'silent' : isDebug ? 'debug' : 'error')`. Soft-failure logs sit below: TranscriptExtractor debug/info, WhisperExtractor `warn` ("not available"), VideoExtractor Gemini-soft-failure `warn`, "continuing without transcript" debug.

**WHAT:** In normal production (NODE_ENV/DEBUG unset) the entire soft-failure narrative is dark while the run reports success. The `ExtractProgressEvent` union has no note/warning variant, so the Ink layer can't surface it either.

**WHY IT MATTERS:** A run that produced zero transcripts and zero LLM data reports clean success with no logged reason — the observability gap that hides the HIGH cluster.

**RECOMMENDED DISPOSITION:** Default production level to `warn`, OR promote the load-bearing soft-failure logs to `error`, OR add a `note`/`warning` variant to `ExtractProgressEvent` the Ink layer renders.

---

## A27 — Empty catch blocks swallow DatabaseError in playlistResolver

**Severity:** MEDIUM. **Lenses:** silent-failure. **Verify:** high.

**WHERE:** `src-ts-v2/utils/playlistResolver.ts:207-211` (`getPlaylistTitle` → `catch { return undefined }`) and `:229-234` (`searchDatabase` → `catch { return null }`); module imports no logger. Sibling `cache.ts` logs every failure at debug.

**WHAT:** Every `DatabaseError` from `PlaylistRepository` (connectivity, or Zod row-parse = corruption signal) collapses to "no title" / "no match" with no log. A locked file / corrupted row / schema drift is indistinguishable from a legitimate miss.

**WHY IT MATTERS:** Zero operator signal on a genuinely broken DB; breaks the module's own logging convention.

**RECOMMENDED DISPOSITION:** Log the caught error (warn for title lookup, error for `searchDatabase`) with `{ playlistId, err }` context before returning the sentinel; keep the graceful fallback but make it observable.

---

## A28 — Branded PlaylistId erased to `any[]` in bulk-add/sync

**Severity:** MEDIUM. **Lenses:** typescript. **Verify:** high.

**WHERE:** `src-ts/commands/PlaylistCommands.tsx:681,930` (`useState<any[]>`), consumed at `:798` (`performBulkAdd`) and `:1005` (`performSync`) calling `createOrUpdate({ playlistId: playlist.playlistId })` with no `asPlaylistId`. `discover` (:193) and `add` (:374) re-brand correctly.

**WHAT:** The brand is erased into `any`, so `playlist.playlistId` silently satisfies the `PlaylistId` parameter with no compile-time or runtime check — defeating the branded-ID invariant at the Ink boundary.

**WHY IT MATTERS:** Runtime-correct today only because the value is branded at origin; a future refactor routing a raw string through these handlers would compile and persist an unvalidated id. (`src-ts/` is outside the v2 no-`any` zone — hence MEDIUM.)

**RECOMMENDED DISPOSITION:** Type the state `useState<YouTubePlaylist[]>`, or re-brand at the call site (`asPlaylistId(playlist.playlistId)`) in both handlers, matching `discover`/`add`.

---

## LOW ledger → kanban BACKLOG (bulk item)

- **A21** — `src-ts-v2/auth/OAuthServer.ts:114`: the reflected `error` query param is interpolated raw into the OAuth callback HTML (`renderHtml` does no escaping), returned before the state/CSRF check. Verify downgraded MEDIUM→LOW: ephemeral localhost origin, no secret in the reflection, exploitation requires timing a cross-navigation during the auth window. **Fix:** HTML-escape interpolated values, or render a static message and keep the raw provider error only in the `AppError` context.
- **A30** — `src-ts-v2/extractors/VideoExtractor.ts:834-881`: `buildEntityBatch` duplicates the Gemini-entity confidence constants (topic 90 / github_repo 95 / website 90 / person 85) already in `GeminiParser.extractEntitiesForDatabase`; no shared constant exists. **Fix:** hoist the weights into one shared module imported by both (the `GeminiParserLike` interface deliberately doesn't expose the helper, so constant-hoist is the route, not method reuse).
- **A33** — `src-ts/commands/ExtractCommand.tsx:298-305`: shipped v1.0.0 `PostExtractionMenu` presents "View Playlist Info" and "Extract Another" options whose handlers carry `// TODO: Navigate…` comments but only call `onComplete()` — two of three menu options are silent dead-ends. **Fix:** wire real navigation, or relabel and file a tracked task.

## Refuted by adversarial verify (recorded, not actioned)

- **A19** (`database.test.ts`, memory-only DB): storage medium is orthogonal to DDL/query correctness — SQLite runs the same DDL in-memory vs on-disk, so it does NOT hide schema/join drift (row-shape assertions catch that). Only the WAL pragma + `mkdirSync` branch are untested, and those fail loud. The finding inflated a LOW plumbing gap into a MEDIUM data gap via a drift-hiding mechanism that doesn't exist.
- **A29** (`VideoExtractor.ts` header comment): the "Wave 4 injects the real instances" comment is present-tense and factually correct about the current code — not stale. Cosmetic at most.
- **A31** (`WhisperExtractor.getUnavailableReason`): the "not yet implemented" string is dead code — only reachable when Python exists, a state in which `isAvailable()` returns true and the method is never called. No runtime surface.
- **A32** (`GeminiParser.ts:251` `as ZodError`): the cast on the catch variable is guarded by `?.` + a fallback string and used only for logging; no realistic crash path. Type-hygiene nit; the suggested `instanceof` fix would also need a value import.

---

## How to use this document

When opening Phase 3:

1. Open `_kanban.md` BACKLOG. For each Phase 3 item, scan A1–A12 for
   `Phase-3 interactions:` and check whether the item is blocked or
   simplified by an amendment.
2. Schedule a **Wave-0-shaped pre-Phase-3 sweep** OR fold amendments into
   the individual Phase 3 items as they get touched. The orchestration
   pattern of Phase 2 (parallel Opus agents per file area) maps to a
   "pre-Phase-3 sweep" naturally: A1, A2, A3, A4, A5, A6, A8, A9 are
   all independent and can fan out.
3. Run the live test (A12) as the first gate. If it surfaces new
   findings, append them as A13+ here.

The cost of skipping this document is the same cost v1 paid: silent
semantic loss that gets discovered only when a real workflow exercises
the surface. The discipline of writing it down — and reading it before
adding scope — is the carry-forward of the "review and address" mindset
the cycle is built on.

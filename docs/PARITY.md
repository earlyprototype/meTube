# Behavioral Parity Matrix

A **behavioral** parity sweep: it verifies what actually renders to the user and persists to disk, not merely what code exists. Prior parity checks verified code existence only — but **code compiles ≠ code works**, and several "ported" features are wired into nothing. Source of truth: `legacy/python/src`. Compared against the live TS app (`src-ts` UI + `src-ts-v2` backend). Date: 2026-06-10.

> **This file supersedes** the "what TS lost" table in `MIGRATION_NOTES.md` and the stale parity claims in `docs/internal/`. Where they disagree with this document, this document is correct.

---

## Consolidated MISSING — the fix cycle

The deduped must-fix list, grouped by theme.

> **Cycle status (2026-06-10): IMPLEMENTED** on `fix/parity-close` — backend commits `aebe191` `afd29b7` `1da06f6` `f6b47dd` `83e9da3` `65da2bf`; UI commits `046e9e1` `c666dd8` `2d4c5f6` `1642a15` `adac747` `afa60b0` `f9bb60e` `3d6e4db` `dede05c`. 758/758 tests, clean build, two Opus review passes. Exceptions: upfront flag/choice validation (separately boarded card) and the two ACCEPTED divergences in section D (`is_short`, captions). Faithful-parity notes: an *empty* `config.yaml` now throws (Python crashes on it too); the `--all` progress bar resets per playlist in exchange for full per-video display (matches Python's loop). The A/B/C/E Consolidated-MISSING items are implemented on this branch and survived CodeRabbit review round 1 (12 findings fixed, 1 declined).

### A. In-run visibility

- **Per-video title + stage line during extraction.** Events carry no `title` field; `ProgressDisplay.tsx:102` gates the line behind `currentVideo`, and `mapEventToProgress` never sets `currentVideo` — so it stays `''` all run and the block never renders. Even if wired, backend events carry only `videoId` + index, never the title Python prints.
- **Whisper live % bar.** `WhisperExtractor` emits real percentages to an `onProgress` callback that `buildVideoExtractorDeps` never passes, so `whisperProgress` is permanently `undefined` and the panel never renders. Full chain built, fully unwired.
- **Per-step result lines.** Python streamed repos / topics / people / transcript-source + char-count per video. TS collapses all of it into one coarse status enum word.
- **`video add` step output.** Single-video path shows only a coarse spinner status; the per-entity counts and Title/Channel/Duration confirmations Python prints are absent.

### B. Reports

- **GitHub repo description enrichment** is absent from the v2 generator (`HTMLReportGenerator.ts:605-615,755-757`). The template slot renders empty for every repo. The one-time restore went into the **archived v1 backend**, not the live path.
- **Report "Opening in browser…" prints but no `open()` call exists.** The copy lies; the browser never opens. `--no-open` is purely cosmetic.

### C. Console feedback / CLI contract

- **Error remediation copy.** Python maps an error code → numbered fix steps (`cli.py:236-243`). TS shows the bare code token, never expanded.
- **`init` feedback.** "Authenticated as {channel}" + Gemini-key status lines are not surfaced; TS shows only a generic success box.
- **"Filtered to N {privacy}" feedback** on add-mine/discover is applied silently.
- **Upfront flag/choice validation.** `meow` is permissive — invalid values pass the boundary and soft-fail later. An existing kanban card for commander/clipanion covers the full fix.

### D. Data correctness

- **`definition` (`hd`/`sd`) never copied** in `toVideo()` nor in the `ExtractCommand` adapter → always NULL, despite full schema / column / write plumbing existing. Both playlist and single-video paths affected.
- **`is_short` 0-duration divergence.** Python: `0 ⇒ true`. TS: `0 ⇒ false`. **RESOLVED 2026-06-10: keep TS semantics.** A 0-second duration (live stream, premiere, unparseable) is not evidence of a Short; intentional, documented divergence — not fix-cycle work.
- **Gemini tags not lowercased.** Python forces lowercase deterministically (`llm_parser.py:137`); TS trusts the model to comply with the prompt (non-deterministic).
- **Caption manual-vs-auto preference + accurate `is_auto_generated` lost.** The `youtube-transcript` npm lib can't distinguish manual from auto tracks. **RESOLVED 2026-06-10: accepted + documented.** Transcript text still lands; only track-selection preference and flag accuracy are lost. A `captions.list` probe / library swap is boarded as an upgrade card — not fix-cycle work.

### E. Config

- **`config.yaml` never loaded on the live path.** A full Zod schema exists (`src-ts-v2/schemas/config.ts`), but every command hardcodes `data/metube.db` etc. and nothing reads the file.
- **Recursive `${VAR}` substitution** exists only in the archived v1 `config.ts`, not on the live path.

---

## Stale-docs corrections

**`MIGRATION_NOTES.md` is wrong on:**

- **Auto-browser OAuth** — claimed not ported. Actually **RESTORED in v2** (`YouTubeAuth.ts:238` + `OAuthServer.ts` one-click `localhost:3000` flow).
- **`withTransaction`** — claimed "not yet ported." It is the **sole write path** (`connection.ts:135-164`).
- **GitHub-enrichment "restored"** — the restore went into the **archived backend**; the live generator has no enrichment.
- **`${VAR}` "restored"** — same: lives only in the archived `config.ts`.

**Kanban / board corrections:**

- **`playlist add-mine` + `sync` are BUILT** and **better than Python** — the BACKLOG lists them as not-started.
- **A21 (OAuthServer escaping)** is already fixed; the board is stale on this.
- **The BACKLOG "from_whisper column" item targets a phantom** — the column never existed in Python's schema either; it was console-display-only. Persisting the source would be **net-new work, not a parity fix**.

---

## Confirmed PYTHON-BUG (do not copy)

`youtube_client.py:222` has an unguarded `thumbnails` subscript that crashes on private/deleted playlist items. TS tolerates and skips them. **Keep the TS behavior.**

---

## Domain matrices

### CLI/UX parity (26 rows: 9 MISSING / 8 SAME / 8 BETTER / 1 by-design)

| Behavior | Python (file:line) | TS (file:line) | Verdict | Note (incl. unwired detail) |
|---|---|---|---|---|
| Per-video progress line (title + per-step status) during extraction | video_extractor.py:326-329, 108-228 | ProgressDisplay.tsx:102-113; ExtractCommand.tsx:679-754 | **MISSING** | mapEventToProgress never sets currentVideo; it stays '' all run, so the {currentVideo && …} block never renders. Backend events (VideoExtractor.ts:303-308) carry only videoId+index, never title — so even if wired it could show an ID, not the title Python prints. |
| Whisper live percentage bar + panel | whisper_extractor.py:126,181; video_extractor.py:184 | ProgressDisplay.tsx:116-143; ExtractCommand.tsx:488,704-711 | **MISSING** | Full chain built but unwired: buildVideoExtractorDeps() calls new WhisperExtractor() with no onProgress, VideoExtractor emits only {kind:'whisper'} (no %), mapEventToProgress leaves whisperProgress undefined → panel at :116 never renders. WhisperExtractor.ts:245-282 emits real % to a callback nobody passes. |
| Inline error remediation copy (missing-creds 5-step fix list) | cli.py:236-243 | ErrorDisplay.tsx:24-42; ExtractCommand.tsx:539-551 | **MISSING** | ErrorDisplay renders only generic details string; AppError code (e.g. MISSING_CREDS) is shown as a bare token via formatAppErrorDetails, never expanded into the numbered console-setup steps Python prints. No code→remediation map exists. |
| Report auto-opens in browser (single video / playlist summary) | cli.py:982-985, 1022-1025, 1055-1058 | ReportCommand.tsx:218-222; HTMLReportGenerator.ts (none) | **MISSING** | "Opening in browser..." text renders but NO open()/exec call exists anywhere in ReportCommand or the v2 generator — the copy lies; browser never opens. (open pkg is used for OAuth only.) --no-open merely toggles the lying text. |
| Per-video extraction step lines ("Fetching metadata", "Found N GitHub repos", "Transcript via YouTube/Whisper (N chars)", topic/repo/people counts) | video_extractor.py:108,118-120,153,160-161,184,194,202-205,228 | ExtractCommand.tsx:679-754 (status enum only) | **MISSING** | Python prints granular per-step results per video; TS collapses all of it into one coarse status enum word (statusText, ProgressDisplay.tsx:64-72) that itself only shows inside the never-rendered currentVideo block. The detailed result counts are never surfaced. |
| video add console step output (Title/Channel/Duration confirmations, entity counts) | video_extractor.py:118-120,160-161,202-205 | VideoCommands.tsx:291-314 | **MISSING** | Single-video UI shows only a coarse spinner status (downloading/transcribing/parsing) via ProgressDisplay with current=1,total=1; the title line is gated by the same always-empty-until-set currentVideo/videoTitle timing and the per-entity counts Python prints are absent. |
| Privacy filter feedback line on add-mine/discover ("Filtered to N {privacy}") | cli.py:752, 642-643 | PlaylistCommands.tsx:733-738 | **MISSING** | TS applies the privacy filter silently; no "Filtered to N" confirmation line is rendered, and --privacy has no upfront value validation (meow string, not choice). |
| init: report authenticated channel name + Gemini-key status lines | cli.py:254-267 | InitCommand.tsx:105-124 | **MISSING** | Python prints "Authenticated as: {channel}" and a Gemini-key configured/warning line. TS success box shows only a generic "Authentication successful" — no channel lookup, no Gemini-key status surfaced. |
| Upfront flag/choice validation (Click) | Click decorators (e.g. type=Choice([...])) | cli.tsx:76-93 (meow, permissive) | **MISSING** | meow declares flag types but no choice/required validation; invalid --privacy garbage passes the boundary and only soft-fails later (or silently). No CLI-level contract — MIGRATION_NOTES:72 confirmed, still open. |
| Auto-browser OAuth (local callback server, one-click) | oauth_handler.py run_local_server | YouTubeAuth.ts:238; OAuthServer.ts:91,264 | **SAME** | MIGRATION_NOTES "not ported / manual copy-paste" is STALE. v2 runs a localhost:3000 capture server and openBrowser() via the open pkg, with stderr URL fallback. Matches/exceeds Python. |
| PowerShell-safe Unicode title display | cli.py:561; video_extractor.py:116 | terminal.ts:26 safeTitle; applied across PlaylistCommands/VideoTable/Picker | **SAME** | safeTitle() replicates encode('ascii','replace') on win32; applied at all display call sites. |
| Smart playlist resolver (number / partial title / URL / ID) | cli.py:82-141 | playlistResolver (used ExtractCommand.tsx:151, etc.) | **SAME** | v2 resolver covers all Python identifier forms incl. DB fallback. |
| playlist add --search flag | cli.py:337,391-447 | PlaylistCommands.tsx:61 (no --search) | **by-design** | Flag intentionally dropped; resolver covers fuzzy-title add via playlist add "title". MIGRATION_NOTES:74 "by design" verified correct. (Note: TS PlaylistAdd brands input as a strict PlaylistId, so a bare title arg actually errors — minor gap, but the search-multiselect UX is genuinely superseded.) |
| playlist list table | cli.py:485-515 | PlaylistCommands.tsx:132-153 | **SAME** | Renders numbered list w/ counts; caches for numbered access. |
| playlist videos table + transcript column + cache | cli.py:518-593 | PlaylistCommands.tsx:1204-1386 | **SAME** | Full table incl. transcript Yes/No (in-query EXISTS, no N+1) + saveVideoCache. |
| playlist discover interactive add | cli.py:615-719 | PlaylistCommands.tsx:157-286 (PlaylistPicker) | **BETTER** | Arrow-key picker + post-add extract prompt vs Python's comma-list input(). |
| playlist add-mine bulk add (+privacy/skip-existing) | cli.py:722-787 | PlaylistCommands.tsx:693-940 | **BETTER** | Interactive multiselect with select-all/none vs Python's non-interactive loop. |
| playlist sync (+--remove-deleted) | cli.py:790-853 | PlaylistCommands.tsx:942-1201 | **BETTER** | Shows new/deleted diff + y/n confirm gate before applying. |
| playlist remove | cli.py:596-612 | PlaylistCommands.tsx:495-691 | **BETTER** | Adds confirm prompt + associated-video count (Python deletes immediately). |
| extract playlist / --all (+reprocess/max-videos) | cli.py:856-921; video_extractor.py:236-372 | ExtractCommand.tsx:53-378 | **SAME** | Equivalent surface; flags mapped (reprocess→!skipExisting). |
| End-of-run extraction summary | video_extractor.py:363-370 | PostExtractionMenu.tsx:99-157 | **BETTER** | Truthful DB-verified counts (rows-found vs claimed, unavailable/shape-mismatch breakdown) vs Python's processed/new/skipped only. |
| Post-extraction interactive menu | (none in Python) | PostExtractionMenu.tsx; ExtractCommand.tsx:386-433 | **BETTER** | Wiring now correct: currentVideo:'Complete', status→'menu', nav callbacks threaded (onViewPlaylistInfo/onExtractMore/onMainMenu). Note: this is the post-completion menu, distinct from the in-run per-video line (MISSING above). |
| report single / -p / -ps / --all | cli.py:924-1068 | ReportCommand.tsx:22-260 | **SAME** | All report modes present (browser-open excepted — see MISSING). |
| Interactive REPL mode | (none — Click is static) | cli.tsx:110-144; ReplMode.tsx; ReplShell.tsx | **BETTER** | Persistent session, sidebar stats, history, inline component swap. |
| --no-whisper / --report flags on video add | (absent in Python) | cli.tsx:48-49; VideoCommands.tsx:163-213 | **BETTER** | Net-new flags Python lacks. |

**Domain summary** — counts: MISSING 9 · SAME 8 · BETTER 8 · by-design 1. Top-3 MISSING = per-video line, whisper bar, browser-open lie. Corrections to `MIGRATION_NOTES` as listed above (auto-browser OAuth and the smart resolver are stale entries; `--search` drop is correctly documented as by-design).

### Pipeline/API parity (2 MISSING / 2 ACCEPTED / 3 BETTER / 1 PYTHON-BUG / rest SAME)

| Behavior | Python (file:line) | TS (file:line) | Verdict | Note |
|---|---|---|---|---|
| definition ('hd'/'sd') fetched → persisted | youtube_client.py:158, video_extractor.py:137 | YouTubeClient.ts:201-225 (toVideo omits it); ExtractCommand.tsx:627-648 (adapter omits it) | **MISSING** | Schema field (youtube.ts:73), DB column (schema.ts:57), VideoDetails.definition (VideoExtractor.ts:112) and write (:880) all exist, but toVideo() never copies definition from the parsed schema into YouTubeVideo, and the Ink adapter never maps it. details.definition is always undefined → DB stores null. Classic exists-but-not-wired data drift. Playlist AND single-video paths both affected. |
| Gemini tags lowercased | llm_parser.py:137 ([tag.lower() for tag in ...]) | gemini.ts:60-69 (no transform); GeminiParser.ts:396 returns raw | **MISSING** | Python forces tags lowercase in _normalize_result. TS relies solely on the prompt asking the model for lowercase — non-deterministic. A model returning ["Python","ML"] persists mixed-case tags where Python would store ["python","ml"]. |
| is_short for 0-second duration (live/upcoming/unparseable) | youtube_client.py:151 — duration_seconds <= 60 → 0 ⇒ true | YouTubeClient.ts:212 — durationSeconds > 0 && durationSeconds <= 60 → 0 ⇒ false | **ACCEPTED** (divergence) | For a video whose duration parses to 0 (live streams P0D, premieres, malformed), Python flags is_short=true, TS flags false. RESOLVED 2026-06-10: keep TS — documented intentional divergence. |
| Caption manual-vs-auto-generated priority | transcript_extractor.py:109-159 — manual per-lang, then generated per-lang, then any; sets real is_auto_generated | TranscriptExtractor.ts:240-315 — iterates langs, takes whatever youtube-transcript lib returns; is_auto_generated is a fixed assumeAutoGenerated flag (default true) | **ACCEPTED** (semantic) | The youtube-transcript npm lib can't distinguish manual vs auto tracks, so TS loses Python's "prefer human-made captions" preference and records a hard-coded is_auto_generated=true. Transcript text still lands; only track-selection nuance + flag accuracy lost. RESOLVED 2026-06-10: accepted; captions.list-probe upgrade boarded. |
| Per-call fixed rate-limit throttle | youtube_client.py:28-30,128,206,253 — time.sleep(0.3) after every call | YouTubeClient.ts:132-137 token bucket (100 req/60s) | **BETTER** | Token-bucket replaces blanket 0.3s sleep — burst-tolerant, quota-aware, deliberate. |

**Domain summary** — SAME-majority list: ISO-8601 parse_duration; stats coercion; published_at / added_at / position; pagination-to-completion; transcript rate-limit 2s + backoff; Whisper trigger / model / cleanup / subprocess; Gemini prompt post-P9, temp/top_p/top_k/max_tokens 0.1/0.95/40/2048, JSON-fence strip, confidences topic90 / repo95 / website90 / person85 / desc100, empty-result fallback; description regex incl. github / has-links tags; skip-existing idempotency; DEFAULT_MODEL gemini-3-flash-preview (A25 fixed); statistics append-only. Re-verified FIXED: A14 (VideoExtractor.ts:923-930), A18 (ExtractCommand.tsx:484-491), A15 (:957-960), A23, A26. PYTHON-BUG: youtube_client.py:222 unguarded thumbnails — TS tolerates via per-item skip, keep TS.

### Outputs/persistence parity (12 rows: 4 MISSING / 5 SAME / 4 BETTER)

| Behavior | Python (file:line) | TS (file:line) | Verdict | Note |
|---|---|---|---|---|
| GitHub repo description enrichment in playlist report | html_generator.py:382-389 (live _fetch_github_description per repo) | HTMLReportGenerator.ts:605-615 (explicitly dropped) + :755-757 (githubRepos built without description); gemini.ts:38-39 repo has only name+url | **MISSING** | Template renders the slot (templates/playlist_report.html:753-756): Python shows real descriptions, v2 shows the empty-italic placeholder for EVERY repo. MIGRATION_NOTES "restored (513a513)" is STALE — that restore went into the now-archived v1 backend. User-visible report content regression. |
| Config-file loading (config/config.yaml) | cli.py:168-184 (load_config reads YAML, merges defaults) | none on live path — ExtractCommand.tsx:147, ReportCommand.tsx:54, InitCommand.tsx:29, VideoCommands.tsx hardcode 'data/metube.db'; no command imports a loader | **MISSING** | config/config.yaml exists and src-ts-v2/schemas/config.ts defines a full Zod schema, but nothing reads the file. DB path, reports dir, gemini model, languages, whisper settings all hardcoded/ignored. Schema-exists-but-unwired. |
| Recursive ${VAR} env-var substitution in config | cli.py:187-208 (_substitute_env_vars, recurses dicts/lists) | src-ts-v2/schemas/config.ts:11-12 comment points to src-ts/config.ts — that file is ARCHIVED (archive/src-ts-v1/config.ts), not on the live path | **MISSING** | Follows from the config-loader gap: no live code performs ${VAR} substitution. MIGRATION_NOTES "restored (97c3ee3)" is STALE. |
| Auto-open report HTML in browser | (v1-TS had autoOpen; Python report cmd opened via cli.py — see CLI table) | HTMLReportGenerator.ts (no autoOpen); ReportCommand.tsx:218-222 --no-open toggles copy only | **MISSING** | A5 confirmed: report never auto-opens; --no-open cosmetic. open pkg already a working dependency (OAuthServer.openBrowser). |
| Auto-browser OAuth (run_local_server) | oauth_handler.py:82-86 | YouTubeAuth.ts:238 (openBrowser) + :227-233 (stderr URL fallback); OAuthServer.ts:264-275 | **SAME** | MIGRATION_NOTES STALE — v2 auto-opens AND prints URL; one-click flow on localhost:3000 works today. |
| Transcript persisted per video on playlist path | video_extractor.py:187 | VideoExtractor.ts:923-930 (transcriptRepository.upsert) | **SAME** | A14 closed; A18 closed (ExtractCommand.tsx:484-491 injects both extractors) — dual-transcript pipeline genuinely wired. |
| AI analysis row written + read for report | video_extractor.py:223-228; html_generator.py:131,297 | VideoExtractor.ts:1019-1025; AIAnalysisRepository.getByVideo + HTMLReportGenerator.ts:574-591 | **SAME** | v1 getAnalysisData stub-bomb closed; analysis section renders from a real query. |
| Transcript from_whisper source tracking persisted | transcript_extractor sets it for console display only (video_extractor.py:184); Python TranscriptRepository.create does NOT persist it (repository.py:108-115; no column in models.py:73-94) | TranscriptRepository.ts:42-54 no from_whisper; no column in schema.ts:80-88 | **SAME** | The kanban BACKLOG from_whisper item targets a PHANTOM column — never existed in Python's schema either; console-display-only. Source-tracking would be net-new work, not a parity fix. |
| Atomic transcript replace (delete+insert) | repository.py:104-117 (same session) | TranscriptRepository.ts:86-113 (one withTransaction) | **BETTER** | v2 wraps delete+insert in one BEGIN/COMMIT. |
| Write path / auto-rollback session | connection.py:48-66 (@contextmanager) | connection.ts:135-164 (withTransaction<T>, auto-rollback + typed-error preservation) | **BETTER** | MIGRATION_NOTES "not yet ported" STALE — sole write path in v2. |
| Schema: tables + columns + indexes | models.py (10 tables) | schema.ts:35-173 (10 tables + schema_version) | **SAME** | Column-for-column match incl. category_name (written by neither — both NULL), definition, caption, licensed_content. Self-bootstrapping. |
| tokens.json file permissions | oauth_handler.py:93-95 (default perms) | YouTubeAuth.ts:415-424 (mkdir 0700, write 0600, chmod) | **BETTER** | A22 closed (no-op on Windows, real on POSIX). |
| OAuth callback reflected-error XSS | n/a | OAuthServer.ts:49-56,130 (escapeHtml) | **BETTER** | A21 already fixed (kanban stale on this). |

**Domain summary** — counts: SAME 5 · BETTER 4 · MISSING 4. Top-3 MISSING = GitHub enrichment, config loading, `${VAR}` substitution. Stale-doc corrections as listed above.

---

## Decisions (locked 2026-06-10)

1. **In-run display depth** — **FULL Python-style**: per-video title + stage line, per-step result lines (repos/topics/people, transcript source + char count), and the live Whisper % bar. Implemented by the parity-close cycle (`fix/parity-close`).
2. **`is_short` 0-duration semantics** — **keep TS** (`0 ⇒ false`). Intentional, documented divergence; Python's `0 ⇒ true` misclassifies live streams and premieres as Shorts.
3. **Caption manual-vs-auto** — **accept + document.** The lost prefer-human-captions nuance and hard-coded `is_auto_generated=true` are recorded above; a `captions.list` probe / library-swap upgrade is boarded for later, not part of this cycle.

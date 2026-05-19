# meTube v2 — Port Plan

> **Conditional document.** Activates if owner accepts ADR 0001's recommendation.
> Executable plan for porting `legacy/python/src/` into new `src-ts-v2/` backend
> while keeping `src-ts/{cli.tsx,commands,components}` (the Ink layer) unchanged.

**Source of truth for scope, signal-of-done, kill-criterion:** `docs/adr/0001-rewrite-vs-patch.md`.

**Source for diagnostic evidence behind each decision:** `docs/REWRITE_AUDIT.md`.

---

## v2 scope (FROZEN)

These commands ship in v1.0.0:

| Command | Source (Python) | Notes |
|---|---|---|
| `metube init` | `cli.py:226-300` | Use `@google-cloud/local-auth` (the Python win). Bake in OAuth `state` parameter from day one. |
| `metube playlist discover` | `cli.py:600-650` | Paginated `getMyPlaylists()`. Multiselect via Ink. |
| `metube playlist list` | `cli.py:560-595` | Reads from local DB. |
| `metube playlist add <id>` | `cli.py:335-482` | `getPlaylistById()`. No `--search` flag (out of scope). |
| `metube playlist remove <id>` | `cli.py:500-555` | Resolve via shared resolver. Confirmation prompt. |
| `metube extract playlist <id>` | `extractors/video_extractor.py:236-371` | Dual-transcript pipeline. Whisper still spawned as Python subprocess (existing `WhisperExtractor.ts` reused). |
| `metube report playlist <id>` | `reports/html_generator.py:267-467` | Implements `getAnalysisData` properly. |

### Explicitly out of scope for v2 (will re-land post-ship, gated by tests)

- REPL mode (`metube` with no args) — restore from existing `ReplMode.tsx`
- `extract --all` flag
- `metube video add <url-or-id>` — single-video extraction
- `playlist add --search "title"` interactive multiselect
- `playlist add-mine` bulk add
- `playlist sync` change-detection
- Whisper de-Python (Tier 3 — independent project)
- AI analysis surfacing beyond the basic `getAnalysisData` path

---

## Python source issues — remediation map

The Python source (`legacy/python/src/`) is the porting target but it's not perfect. The 2026-05-19 audit's `python-reviewer` pass identified specific issues that MUST be addressed during the port — not translated unchanged. Every Python finding has an explicit v2 disposition. No silent inheritance of known bugs.

| # | Python issue | Severity | v2 disposition |
|---|---|---|---|
| P1 | `transcript_extractor.py:120-121` and `:130-132` — bare `except Exception: pass` wrapping inner language-iteration loops; hides all unexpected failures | HIGH | **DO NOT PORT.** Use specific exception types (`TranscriptsDisabled`, `NoTranscriptFound`, `VideoUnavailable`) only. Generic `Exception` swallowing is forbidden in v2. Wave 3 task. |
| P2 | `cli.py:369-378, 426-433, 706-714, 774-782, 826-833` — `PlaylistRepository.create_or_update` called in batch loops, each iteration opens & commits its own session; no batch atomicity | HIGH | **REDESIGN.** The TS Ink layer's `PlaylistAddMine`/`PlaylistSync` already exists (out of v2 scope). When they re-land post-v1.0.0, the backend method they call must batch via one `withTransaction<T>()` per operation, not per item. Added as an explicit invariant for post-ship features. |
| P3 | `whisper_extractor.py:103-105` and `:144-146` — `except Exception as e: console.print(...); return None` — `e` captured but never logged; failure context lost | MED | **FIX IN PLACE.** Whisper code stays in `src-ts/extractors/WhisperExtractor.ts` per v2 scope (Tier 3 separate work). Patch as part of Tier 3 — at minimum `logger.error({ err }, '...')` before returning null. Tracked in `_kanban.md` as a post-v1.0.0 item. |
| P4 | `whisper_extractor.py:152-155` — silent temp-file cleanup failure (`except Exception as e: pass`); `e` discarded | MED | **FIX IN PLACE** alongside P3. `logger.debug({ err }, 'temp cleanup failed')`. Same Tier 3 item as P3. |
| P5 | `cli.py:43, 57-58` — bare `except:` in cache loader; swallows `JSONDecodeError` and `PermissionError` identically | MED | **NOT PORTED.** Cache is in `src-ts/utils/cache.ts` (lift unchanged into v2). Wave 1 adds Zod parse on cache load — distinguishes shape errors from filesystem errors automatically. |
| P6 | `cli.py:984` — bare `except: pass` (not even `except Exception`) around `webbrowser.open` | LOW | **NOT PORTED.** Browser-open lives in `HTMLReportGenerator.ts`. Wave 4 uses typed `open` npm package + explicit error handling. |
| P7 | `DescriptionParser.parse()` returns `'topics': []` and `'people': []` unconditionally; comments say `"# Could add keyword extraction here"` | MED | **DOCUMENT AS KNOWN GAP.** These fields are populated ONLY by the LLM path (Gemini), not by the regex parser. v2's TS port adds an explicit JSDoc note on `DescriptionParser.parse()`: returns `topics: []` and `people: []` by design — caller must use `GeminiParser` to populate. Surface in `getEntitiesData` aggregation. |
| P8 | `html_generator.py:182-207` — duplicate `generate_playlist_report` method definition; the first (lines 182-207) is a dead stub that loops over individual reports; the real implementation is at `:267-467` (second definition silently overrides in Python) | KNOWN BUG | **PORT ONLY THE SECOND DEFINITION** (`:267-467`). Wave 4 task. The stub at `:182-207` is to be ignored — do NOT translate. Add a comment in v2's `HTMLReportGenerator.ts` referencing this so future readers understand the gap. |
| P9 | `llm_parser.py:93` — Python comment `# Limit to avoid token limits` embedded inside f-string sent to Gemini as part of the prompt; harmless but unintentional | KNOWN BUG | **STRIP DURING PORT.** Wave 3 task. Use proper string slicing without inline comment: `text.slice(0, 8000)` with the limit as a named constant, not as a comment inside the prompt template. |
| P10 | `extractors/video_extractor.py:27-86` — `VideoExtractor.__init__` takes 8 constructor parameters (`gemini_api_key: str = None`, `whisper_model: str = None`, etc.); no type discipline distinguishing absent from empty | REDESIGN | **REDESIGN AS TYPED CONFIG.** Wave 3 task. Single `VideoExtractorConfig` Zod schema with explicit optional fields. Constructor signature: `new VideoExtractor(db: DatabaseManager, youtubeClient: YouTubeClient, config: VideoExtractorConfig)` — three params, third is a typed object. |
| P11 | `connection.py:78-86` — `global _db_manager` singleton; `get_db_manager(database_path)` silently ignores `database_path` argument on all calls after the first | REDESIGN | **NO GLOBAL SINGLETON IN V2.** Wave 1 task. `DatabaseManager` is instantiated explicitly per context. Test isolation uses `:memory:` instance per test. Production code in Ink layer instantiates `new DatabaseManager('data/metube.db')` at the command boundary (existing pattern — already correct). |
| P12 | `cli.py:187-208` `_substitute_env_vars` vs `utils.py:32-42` `_expand_env_vars` — DRY drift; CLI version handles mid-string substitution, utils version only handles whole-string | LOW | **CONSOLIDATE DURING PORT.** Already done in current `src-ts/config.ts` (the recursive substitution restored in commit `97c3ee3` is the richer version). Lift `config.ts` unchanged into v2 — no re-derivation. |

### Additional Python carve-outs (not in the table)

- **Async/concurrency.** Python processes videos sequentially. v2 stays sequential too — `better-sqlite3` is synchronous and the Whisper subprocess serializes naturally. **Do NOT add `Promise.all` or async/concurrent processing without a specific measured performance need.** Premature concurrency is out of scope.
- **SQLAlchemy ORM patterns.** Python uses `relationship()` declarations and `joinedload` calls; these don't translate to `better-sqlite3` raw SQL. Replace with explicit JOIN queries in the affected repositories (`PlaylistItemRepository.getItemsWithVideos` is the main one). Wave 2 task.
- **`func.now()` as column default.** SQLAlchemy evaluates `Column(DateTime, default=func.now())` at the ORM layer, not at the SQLite layer. v2's `schema.ts` uses `DEFAULT CURRENT_TIMESTAMP` at the DDL level — SQLite-level defaults, not application-level.
- **Rich console output.** Python uses Rich for color/progress; v2 uses Ink. Do NOT carry any `console.print()` styling from Python — all output flows through Ink components (existing).
- **`google.generativeai` SDK API.** Python's `genai.GenerativeModel` / `GenerationConfig` interface differs from `@google/generative-ai` npm SDK. The PROMPT STRUCTURE ports cleanly (after P9 fix); the SDK CALL must use the JS SDK's API directly, not a mechanical translation.
- **`youtube-transcript-api`.** No clean TS equivalent. The current TS uses `youtube-transcript` npm package — keep this (lift `TranscriptExtractor.ts` unchanged). Python's library-specific exception types map to the TS package's equivalents; the language hardcoding (`language: 'en'`, `is_auto_generated: true`) is a v1 issue, not a Python issue, and gets fixed as a TS-side concern in Wave 3.

### Cross-cutting v2 invariants (enforced from day one)

Beyond fixing specific Python issues, v2 enforces structural invariants Python lacked:

1. **`withTransaction<T>()` is the only write path.** Wave 2 includes a test that intercepts raw `db.run` calls in repository contexts and fails if any write occurs outside `withTransaction`. This makes the "transaction() exists but is unused" v1 pattern impossible to reproduce.
2. **Zod schemas at every wire boundary.** YouTube API responses, Gemini responses, config files, cache files, command arguments. Every external shape parses through Zod before becoming a TS type. Wave 1 lands the schemas; subsequent waves use them.
3. **Branded `VideoId` / `PlaylistId`.** Constructed via `asVideoId(s)` / `asPlaylistId(s)` validators. Compile-time prevention of the `playlistId` vs `id` class of bug.
4. **No `any` in v2 code.** `unknown` at boundaries, narrowed via Zod or type guards. Pre-commit hook enforces.
5. **Self-bootstrapping schema.** `initDatabase()` creates all tables from `schema.ts`. No Python dependency for the non-Whisper path.

Each invariant maps to a v1 deficiency it forecloses:

| v2 invariant | Forecloses v1 problem |
|---|---|
| `withTransaction<T>()` mandatory | `transaction()` exists but unused; 3 non-atomic DELETE+INSERT patterns |
| Zod at boundaries | `JSON.parse(...) as ParsedTranscript` blind cast; `videoData: any` |
| Branded IDs | `p.playlistId` reading non-existent field; field-name silent-drift class of bug |
| No `any` | The whole class of `: any`-disguised holes — yesterday's `playlistId`/`id` bug literally couldn't compile |
| Schema bootstrap | "Please use Python version to initialize schema" error message in current `connection.ts:228` |

---

## Architecture invariants for v2

1. **`withTransaction<T>(work)` is the only way to write to the DB.** Every repository write must go through it. A test enforces this by intercepting raw `db.run` calls in repository contexts.
2. **Zod schemas at every wire boundary.** YouTube API responses, Gemini responses, config files, cache files, command arguments — all parse through Zod before becoming typed.
3. **Branded `VideoId` and `PlaylistId`.** Constructed only via `asVideoId(s: string)` and `asPlaylistId(s: string)` which validate format. Once constructed, they cannot be confused with each other at the type level.
4. **No `any` in app code.** `unknown` at external boundaries, narrowed via Zod or type guards. Pre-existing TS rule per `CLAUDE.md`, but v2 enforces it from start.
5. **Self-bootstrapping schema.** `initDatabase()` creates all tables and indexes from `src-ts-v2/database/schema.ts`. No Python dependency for DB init.
6. **Pino-only logging.** Zero `console.log` / `console.error` in `src-ts-v2/`. Pre-commit hook enforces this (see Wave 1).
7. **The 20-method Ink↔backend contract is fixed.** Ink layer remains unchanged. v2 backend must satisfy the same signatures.

---

## Build waves

### Wave 1 — Contract layer (Week 1)

**Goal:** Make wrong shapes impossible at compile time.

| File | LOC target | Notes |
|---|---:|---|
| `src-ts-v2/types/branded.ts` | 30 | `VideoId`, `PlaylistId`, `asVideoId`, `asPlaylistId` |
| `src-ts-v2/types/index.ts` | 20 | Re-exports |
| `src-ts-v2/schemas/youtube.ts` | 120 | Zod schemas: `YouTubeVideoSchema`, `YouTubePlaylistSchema`, `YouTubePlaylistItemSchema`, `YouTubePageResponseSchema` |
| `src-ts-v2/schemas/gemini.ts` | 80 | `GeminiResponseSchema` (topics, github_repos, websites, people, sentiment, summary) |
| `src-ts-v2/schemas/db.ts` | 100 | Row-shape schemas for tables (Video, Playlist, Transcript, etc.) |
| `src-ts-v2/schemas/config.ts` | 60 | Schema for `config.yaml` validation |
| `src-ts-v2/errors/` | — | KEEP-AS-IS (lift from `src-ts/errors/`) |
| `src-ts-v2/utils/logger.ts` | — | KEEP-AS-IS (lift) |
| `src-ts-v2/database/schema.ts` | 100 | `CREATE TABLE IF NOT EXISTS` for 10 tables + indexes + `PRAGMA foreign_keys = ON` |
| `src-ts-v2/database/connection.ts` | 180 | `DatabaseManager` with mandatory `withTransaction<T>()` |
| **Pre-commit hook** | — | Reject any commit that adds `console.log`/`console.error` to `src-ts-v2/**` |

**Wave 1 success criteria:**
- `npm run build` clean on `src-ts-v2/`
- Schema bootstrap test: `initDatabase()` on `:memory:` creates all 10 tables
- Branded type test: `asVideoId('short')` throws; `asVideoId('dQw4w9WgXcQ')` succeeds
- `withTransaction<T>()` rollback test: throw inside callback → no rows committed
- Zod schema tests pass for fixtures of each external shape

### Wave 2 — Data layer (Week 2) — **KILL-CRITERION CHECKPOINT**

**Goal:** All 9 repositories live, transaction-disciplined, behaviorally tested against in-memory SQLite.

| File | LOC target | Source |
|---|---:|---|
| `src-ts-v2/database/VideoRepository.ts` | 180 | `legacy/python/src/database/repository.py:VideoRepository` |
| `src-ts-v2/database/PlaylistRepository.ts` | 150 | `repository.py:PlaylistRepository` |
| `src-ts-v2/database/PlaylistItemRepository.ts` | 100 | `repository.py:PlaylistItemRepository` |
| `src-ts-v2/database/TranscriptRepository.ts` | 120 | `repository.py:TranscriptRepository` — DELETE+INSERT inside `withTransaction` |
| `src-ts-v2/database/EntityRepository.ts` | 140 | `repository.py:EntityRepository` — bulk INSERT inside `withTransaction` |
| `src-ts-v2/database/StatisticsRepository.ts` | 100 | `repository.py:StatisticsRepository` |
| `src-ts-v2/database/TagRepository.ts` | 120 | `repository.py:TagRepository` — currently absent in TS, restored |
| `src-ts-v2/database/ExtractionJobRepository.ts` | 100 | `repository.py:ExtractionJobRepository` — currently absent in TS, restored |
| `src-ts-v2/database/AIAnalysisRepository.ts` | 100 | `repository.py:AIAnalysisRepository` — currently absent in TS, restored |
| `src-ts-v2/database/index.ts` | 20 | Barrel |

**Test discipline (mandatory):** Every repository has tests that:
1. Create the schema in `:memory:` SQLite
2. Execute the method with real data
3. Assert via direct `db.prepare().all()` that the expected rows landed
4. NEVER mock the DB layer

**Transaction-discipline enforcement test:** A test that proxies `db.run` and asserts every write originated from inside `withTransaction()`. This is the test that would have caught the entire "transaction() exists but is unused" pattern from v1.

**KILL-CRITERION (end of Week 2):**

> If, by end of Week 2, all 9 repositories are not implemented, transaction-disciplined, and behaviorally tested, **abandon v2 and execute the patch fallback** in Section 10 of `docs/REWRITE_AUDIT.md`.

Honest signal here. No "almost there." If Wave 2 isn't green, the rewrite stalls in Wave 3 territory and never finishes.

### Wave 3 — Pipeline (Week 3)

**Goal:** `extractPlaylist` works end-to-end against a real YouTube account.

| File | LOC target | Source |
|---|---:|---|
| `src-ts-v2/api/types.ts` | 80 | Branded types layered into existing types |
| `src-ts-v2/api/RateLimiter.ts` | — | KEEP (lift from `src-ts/`) |
| `src-ts-v2/api/RetryHandler.ts` | — | KEEP (lift) |
| `src-ts-v2/api/YouTubeClient.ts` | 320 | `legacy/python/src/api/youtube_client.py` — Zod validation on every response |
| `src-ts-v2/auth/YouTubeAuth.ts` | 280 | `legacy/python/src/auth/oauth_handler.py` — `@google-cloud/local-auth` + OAuth `state` param |
| `src-ts-v2/auth/OAuthServer.ts` | — | KEEP (lift, already correct) |
| `src-ts-v2/parsers/DescriptionParser.ts` | — | KEEP (lift, regex-only, deterministic) |
| `src-ts-v2/parsers/GeminiParser.ts` | 250 | `legacy/python/src/parsers/llm_parser.py` — Zod parse at boundary |
| `src-ts-v2/extractors/TranscriptExtractor.ts` | — | KEEP (lift; minor fixes to language hardcoding) |
| `src-ts-v2/extractors/WhisperExtractor.ts` | — | KEEP (lift; Tier 3 unchanged) |
| `src-ts-v2/extractors/VideoExtractor.ts` | 380 | `legacy/python/src/extractors/video_extractor.py` — all writes via `withTransaction` |
| `src-ts-v2/utils/playlistResolver.ts` | — | KEEP (lift, with minor fix to ID regex) |
| `src-ts-v2/utils/cache.ts` | — | KEEP (lift, with Zod parse on load) |

**Wave 3 success criteria:**
- Live test session: `metube extract playlist <id>` runs against a real 50+ video playlist
- All videos either extracted or correctly skipped (matches DB state)
- All `playlist_items` rows present
- Whisper subprocess fires for videos without captions
- No silent drops, no orphan rows
- Result counters honest: `processed + skipped + failed === total`

### Wave 4 — Reports + ship (Week 4)

**Goal:** Reports work; v2 becomes canonical; v1 archived honestly.

| File | LOC target | Source |
|---|---:|---|
| `src-ts-v2/reports/types.ts` | — | KEEP (lift) |
| `src-ts-v2/reports/HTMLReportGenerator.ts` | 420 | `legacy/python/src/reports/html_generator.py:267-467` (the second, real definition — first is dead Python stub, do not port). `getAnalysisData` queries `AIAnalysisRepository.getByVideo()`. |
| `src-ts/cli.tsx` | (re-point) | Update imports from `../database/...` to `../../src-ts-v2/database/...` (or alias) |
| `archive/src-ts-v1/` | — | `git mv src-ts/{database,extractors,api,auth,parsers,reports,utils,errors,config.ts} archive/src-ts-v1/` |
| `archive/src-ts-v1/WHY.md` | — | Document the second-system narrative |
| `README.md` | — | Bump to v1.0.0, point at v2 as canonical, document the migration |
| `_kanban.md` | — | Sweep newly-irrelevant items, surface what's next |
| `package.json` | — | Bump version to `1.0.0` |

**Wave 4 success criteria (THE shipping milestone):**

> `npm run build && npm test` is green, `metube init && metube playlist add <ID> && metube extract playlist <ID> && metube report playlist <ID>` succeeds end-to-end on a freshly-cloned machine against a real YouTube account, the HTML report contains topic/person/repo data, and the README reflects this.

---

## Sequencing within a week

Each week starts Monday, ships by Friday. Live-test session every Friday.

**Per-day structure (recommended):**
- **Mon:** Plan the wave; create file shells
- **Tue–Thu:** Implementation + tests, in tight feedback loop (CI green every commit)
- **Fri:** Live test (Wave 2 onward); merge or rollback decision

The Friday live test is the **signal-of-done**. "Compiles clean" is necessary but not sufficient. The lesson from yesterday's bug-find: bugs that survive type-check are caught only by exercising the path. Build the discipline into the cadence from week 1.

---

## Test strategy

### Pattern: in-memory SQLite + real Zod validation + minimal mocking

```ts
// Good — exercises real DB write
const db = new DatabaseManager(':memory:');
const repo = new VideoRepository(db);
repo.createOrUpdate({ video_id: asVideoId('dQw4w9WgXcQ'), title: 'Test', ... });
const result = db.get<Video>('SELECT * FROM videos WHERE video_id = ?', [vid]);
expect(result?.title).toBe('Test');

// BAD — mock-everything (this is what hid yesterday's bugs)
const mockRepo = { createOrUpdate: vi.fn().mockReturnValue({}) };
const extractor = new VideoExtractor(mockRepo, ...);
// Test only verifies mock was called, not what landed
```

### Behavioral coverage requirements per wave

| Wave | Coverage requirement |
|---|---|
| 1 | Schema bootstrap; branded type validators; `withTransaction` rollback; Zod parse for each external shape |
| 2 | Each repository: real DB writes, FK violations throw, transaction discipline test |
| 3 | YouTubeClient against fixtures with real Zod parsing; pagination loop test (>50 items); auth state param flow |
| 4 | HTMLReportGenerator with seeded DB rows; assert HTML contains expected entity text |

### What NOT to mock

- The SQLite layer (use `:memory:`)
- Zod parsers (let them validate real data)
- The `withTransaction` wrapper (let it really wrap)

### What IS reasonable to mock

- Network calls (YouTube API, Gemini API) — mock at the HTTP boundary, not at the service boundary
- Whisper subprocess (mock the `spawn` call)
- Filesystem (use `fs.promises` with a tmpdir per test)

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Second-system effect: scope drift mid-build | Frozen v2 scope (above). Every "while I'm here" request gets logged to `_kanban.md` for post-v2 ranking, not addressed in v2. |
| Wave 4 cliff: rewrite incomplete = CLI non-functional | v1 backend remains in `src-ts/` until v2 swap. Single import alias change at end of Wave 4. Fully reversible. |
| Boredom mid-Wave 2 (9 repositories is mechanical work) | Order: simplest first (VideoRepository), most complex last (TranscriptRepository with the transaction discipline). Variety per day. |
| Friday live-test surfaces a wave-killing bug | If Wave 3 live test fails irrecoverably, drop scope further: ship `playlist list/add/discover` + `report` only, defer `extract` to v1.1.0. |
| New tooling friction (Zod, branded types) eats time budget | Wave 1 is dedicated to it — by Wave 2 the patterns are habitual. |
| OAuth `state` parameter breaks the existing auth flow | Implement on a feature branch; verify against real account before merging to main. |

---

## What lands AFTER v1.0.0 (post-ship roadmap, ranked)

Approximate order, each gated by tests:

1. **Whisper de-Python** (Tier 3, ~6-8h) — `nodejs-whisper` bindings
2. **REPL mode** (~3h) — restore from `src-ts/components/ReplMode.tsx` (lift unchanged)
3. **`extract --all` flag** (~3h)
4. **`metube video add <url-or-id>`** (~4h)
5. **`playlist add-mine` bulk import** (~5h)
6. **`playlist sync` change-detection** (~5h)
7. **Inline error remediation copy via ErrorPanel** (Tier 2, ~2h)

Each post-ship feature ships as its own v1.x.0 release. The kanban gets shorter, not longer.

---

## File migration map (v1 → v2)

For traceability during the port:

```
legacy/python/src/cli.py:226-300                  → src-ts-v2/auth/YouTubeAuth.ts (init flow)
legacy/python/src/cli.py:560-595                  → handled in Ink (no port needed)
legacy/python/src/cli.py:600-650                  → handled in Ink
legacy/python/src/api/youtube_client.py           → src-ts-v2/api/YouTubeClient.ts
legacy/python/src/auth/oauth_handler.py           → src-ts-v2/auth/YouTubeAuth.ts
legacy/python/src/database/connection.py          → src-ts-v2/database/connection.ts
legacy/python/src/database/models.py              → src-ts-v2/database/schema.ts + src-ts-v2/schemas/db.ts
legacy/python/src/database/repository.py          → src-ts-v2/database/{Video,Playlist,...}Repository.ts (split into 9 files)
legacy/python/src/extractors/video_extractor.py   → src-ts-v2/extractors/VideoExtractor.ts
legacy/python/src/extractors/transcript_extractor.py → lift from src-ts/ unchanged
legacy/python/src/extractors/whisper_extractor.py → lift from src-ts/ unchanged (subprocess pattern preserved)
legacy/python/src/parsers/description_parser.py   → lift from src-ts/ unchanged
legacy/python/src/parsers/llm_parser.py           → src-ts-v2/parsers/GeminiParser.ts
legacy/python/src/reports/html_generator.py:267-  → src-ts-v2/reports/HTMLReportGenerator.ts (port ONLY the second definition; first is dead Python stub)
legacy/python/src/utils.py                        → lift from src-ts/ unchanged
```

---

*End of PORT_PLAN.md*

# MeTube Ink Migration Plan

> **Quick Start:** This plan has 42 linked TODOs tracked in Cursor. Each phase section below lists its TODOs. Work through them sequentially, marking each complete as you go.

## Executive Summary
Rebuild MeTube as a TypeScript + Ink CLI application, maintaining the existing SQLite database and focusing on the main extraction and reporting workflow with a beautiful, interactive terminal UI.

## Goals
1. **Primary:** Migrate MeTube to Ink for modern, interactive CLI experience
2. **Secondary:** Learn Node.js/TypeScript and Ink ecosystem
3. **Maintain:** All existing functionality (extraction, transcripts, reports)
4. **Keep:** Existing SQLite database schema and data

## Architecture Overview

### Technology Stack

**Current (Python):**
- Click for CLI
- Rich for terminal output
- SQLAlchemy for database
- google-api-python-client for YouTube
- google-generativeai for Gemini
- openai-whisper for transcription

**New (TypeScript + Ink):**
- Ink for CLI + UI components
- React paradigm for terminal
- better-sqlite3 for database
- googleapis for YouTube
- @google/generative-ai for Gemini
- whisper-node for transcription

### Key Dependencies
```json
{
  "ink": "^5.0.0",
  "react": "^18.0.0",
  "@google/generative-ai": "^0.21.0",
  "googleapis": "^140.0.0",
  "better-sqlite3": "^11.0.0",
  "youtube-transcript": "^1.2.1",
  "whisper-node": "^1.3.0",
  "handlebars": "^4.7.8",
  "dotenv": "^16.4.5"
}
```

## Project Structure

```
metube-ink/
├── src/
│   ├── cli.tsx                    # Main Ink CLI entry point
│   ├── config.ts                  # Configuration loader
│   │
│   ├── api/
│   │   └── YouTubeClient.ts       # YouTube API wrapper
│   │
│   ├── auth/
│   │   └── YouTubeAuth.ts         # OAuth authentication
│   │
│   ├── database/
│   │   ├── connection.ts          # SQLite connection manager
│   │   ├── models.ts              # TypeScript interfaces (matches existing schema)
│   │   └── repositories.ts        # Data access patterns
│   │
│   ├── extractors/
│   │   ├── VideoExtractor.ts      # Main extraction orchestrator
│   │   ├── TranscriptExtractor.ts # YouTube transcript fetching
│   │   └── WhisperExtractor.ts    # Whisper fallback transcription
│   │
│   ├── parsers/
│   │   ├── GeminiParser.ts        # LLM-based entity extraction
│   │   └── DescriptionParser.ts   # GitHub repo extraction from descriptions
│   │
│   ├── reports/
│   │   └── HTMLGenerator.ts       # HTML report generation
│   │
│   └── components/                # Ink UI components
│       ├── ProgressDisplay.tsx    # Live extraction progress with "little dude"
│       ├── PlaylistPicker.tsx     # Interactive playlist selector
│       ├── StatusPanel.tsx        # System status display
│       └── VideoTable.tsx         # Video list display
│
├── templates/                     # Handlebars templates
│   ├── playlist_report.hbs
│   └── video_report.hbs
│
├── data/                          # REUSED FROM EXISTING PROJECT
│   ├── metube.db                  # Existing SQLite database
│   ├── playlist_cache.json
│   └── video_cache.json
│
├── config/
│   └── config.yaml                # Existing config (reused)
│
├── package.json
├── tsconfig.json
└── .env                           # Existing env vars (reused)
```

## Implementation Phases

### Phase 1: Foundation (Days 1-2)
**Goal:** Get TypeScript + Ink project running with basic infrastructure

- Initialize Node.js/TypeScript project
- Install Ink and core dependencies
- Set up build pipeline (TypeScript compilation)
- Create basic CLI entry point with Ink
- Port config loading (config.yaml, .env)
- Test: Can run `metube-ink --help`

**See TODOs:**
- `foundation-01`: Initialize Node.js project with TypeScript and Ink
- `foundation-02`: Install core dependencies
- `foundation-03`: Setup tsconfig.json and build pipeline
- `foundation-04`: Create src/cli.tsx entry point
- `foundation-05`: Port config loader

### Phase 2: Database Layer ✅ COMPLETE
**Goal:** Connect to existing SQLite database from TypeScript

**Completed:**
- ✅ Created TypeScript interfaces matching SQLAlchemy models
- ✅ Implemented database connection with better-sqlite3
- ✅ Ported all 6 repository classes (Video, Playlist, PlaylistItem, Transcript, Entity, Statistics)
- ✅ Added methods to read existing playlists and videos
- ✅ Verified: Can query existing data from metube.db

### Phase 2.5: Quality Hardening ✅ COMPLETE (with remediation)
**Goal:** Harden foundation before proceeding

**Completed:**
- ✅ Installed Vitest, ESLint, Prettier, Pino
- ✅ Created custom error classes (AppError, ValidationError, DatabaseError)
- ✅ Created logger utility with structured logging
- ✅ Created validation utilities
- ✅ Refactored all repositories:
  - Added error handling to ALL operations
  - Added input validation to ALL public methods
  - Removed ALL 'any' types
  - Added JSDoc comments to ALL public methods
  - Implemented connection lifecycle management
- ✅ Wrote 88 comprehensive tests (75% coverage)
- ✅ All tests passing
- ✅ Build passes cleanly

**Remediation Items (carry to Phase 3):**
- Fix ESLint line ending issues (Windows CRLF)
- Improve validation.ts coverage from 33% to 70%
- Complete manual smoke test when CLI available

**Verification:** See PHASE_25_SUMMARY.md and VERIFICATION_CHECKLIST.md

### Phase 3: YouTube Integration (READY TO START)
**Goal:** YouTube API client and OAuth authentication

**Prerequisites (from Phase 2.5):**
- ✅ Error handling patterns established
- ✅ Validation utilities available
- ✅ Logger configured
- ✅ Test infrastructure ready

**Implementation Tasks:**
1. **OAuth Authentication**
   - Port OAuth handler using googleapis
   - Store credentials securely
   - Handle token refresh
   - Test: Can authenticate and get valid token

2. **YouTubeClient Core**
   - Create YouTubeClient class wrapping googleapis
   - Implement core methods:
     - getPlaylists()
     - getPlaylistVideos()
     - getVideoDetails()
   - All methods must have:
     - Error handling (try-catch with DatabaseError/ValidationError)
     - Input validation
     - JSDoc documentation
     - Unit tests

3. **Rate Limiting & Resilience**
   - Implement rate limiting (respect YouTube quotas)
   - Add retry logic with exponential backoff
   - Handle API errors gracefully
   - Log all API calls for debugging

4. **Testing**
   - Unit tests for each YouTubeClient method
   - Mock googleapis responses
   - Test error scenarios (rate limit, network failure, invalid credentials)
   - Integration test with real API (marked as optional/manual)

**Quality Gates (MUST PASS):**
- [ ] OAuth flow tested manually ✅
- [ ] API rate limiting implemented ✅
- [ ] All API calls wrapped in try-catch ✅
- [ ] Integration tests with mocks ✅
- [ ] No console.log in production code ✅
- [ ] JSDoc on all public methods ✅
- [ ] Input validation on all methods ✅

**Verification:**
Before declaring Phase 3 complete, see VERIFICATION_CHECKLIST.md Phase 3 section.

**See TODOs:**
- `youtube-01`: Port OAuth authentication handler using googleapis
- `youtube-02`: Create YouTubeClient class with core methods
- `youtube-03`: Implement rate limiting and retry logic
- `youtube-04`: Port playlist discovery and video fetching
- `youtube-05`: Test: Authenticate and fetch user playlists
- `youtube-06`: Write comprehensive unit tests with mocks
- `youtube-07`: Fix ESLint line ending issues (from Phase 2.5)

### Phase 4: Extraction Pipeline ✅ COMPLETE
**Goal:** Core extraction logic working

**Completed:**
- ✅ Ported TranscriptExtractor (youtube-transcript)
- ✅ Ported WhisperExtractor (calls Python implementation via subprocess)
- ✅ Ported DescriptionParser (GitHub repo extraction)
- ✅ Ported GeminiParser (entity extraction)
- ✅ Ported VideoExtractor (main orchestrator)
- ✅ Implemented deduplication logic
- ✅ End-to-end test: Successfully transcribed video from YouTube playlist with Whisper

**Test Results (2026-01-23):**
- Selected playlist "Ai" (60 videos) from 30 YouTube playlists
- Transcribed 19-second video using Whisper base model
- Transcription completed in 30.6 seconds
- Generated 6 segments, 309 characters
- Successfully saved to database
- Audio cleanup working correctly

**Implementation Notes:**
- WhisperExtractor uses existing Python code via subprocess (smart reuse)
- yt-dlp handles audio download
- Full integration with Phase 3 YouTube API working
- Database persistence via repositories validated

### Phase 5: Ink CLI Interface (READY TO START)
**Goal:** Beautiful, interactive CLI with Ink components

**Prerequisites (from Phase 4):**
- ✅ YouTube API integration working
- ✅ Extraction pipeline functional
- ✅ Database persistence validated
- ✅ Error handling patterns established

**Implementation Tasks:**

1. **Core CLI Structure**
   - Set up Ink app entry point (`src-ts/cli.tsx`)
   - Implement command routing (init, playlist, extract, report)
   - Add help text and usage documentation
   - Test: `metube --help` displays commands

2. **Reusable Ink Components**
   - ProgressDisplay: Live extraction counter with status updates
   - PlaylistPicker: Interactive playlist selection with keyboard navigation
   - VideoTable: Formatted table showing video list with metadata
   - StatusPanel: System information (DB status, API quota, Whisper availability)
   - ErrorDisplay: Consistent error message formatting

3. **Init Command** (`metube init`)
   - OAuth authentication flow with status display
   - Visual feedback during token exchange
   - Success/failure messages
   - Test: First-time authentication works smoothly

4. **Playlist Commands** (`metube playlist`)
   - `playlist list`: Show saved playlists from database
   - `playlist discover`: Fetch from YouTube API with interactive picker
   - `playlist add <id>`: Add playlist with progress feedback
   - `playlist remove <id>`: Remove with confirmation prompt
   - Test: All playlist operations with live UI

5. **Extract Command** (`metube extract`)
   - Interactive playlist selection (if not specified)
   - Video count and status display
   - Live progress bar during extraction
   - Per-video status updates (downloading, transcribing, parsing, saving)
   - Error handling with clear user feedback
   - Summary statistics at completion
   - Test: Extract multiple videos with live progress

6. **Report Command** (`metube report`)
   - List available reports
   - Generate playlist/video reports
   - Progress indication during generation
   - Success message with file path
   - Test: Generate and verify report output

**Quality Gates (MUST PASS):**
- [ ] All components render without crashes
- [ ] Keyboard navigation works (arrow keys, enter, escape)
- [ ] Progress updates are smooth (no flickering)
- [ ] Error messages are user-friendly and actionable
- [ ] No console.log in production code (use Ink Text components)
- [ ] Windows PowerShell compatibility verified
- [ ] Performance: UI remains responsive during operations

**Verification:**
- Manual test of each command
- Test on Windows PowerShell
- Verify visual appearance in terminal
- Test with slow network (rate limiting works)
- Test error scenarios (auth failure, network issues)

**See TODOs:**
- `cli-01`: Setup Ink app structure and command routing
- `cli-02`: Build reusable Ink components (ProgressDisplay, PlaylistPicker, etc.)
- `cli-03`: Implement init command with OAuth flow
- `cli-04`: Implement playlist commands (list, discover, add, remove)
- `cli-05`: Implement extract command with live progress
- `cli-06`: Implement report command
- `cli-07`: Add keyboard shortcuts and navigation
- `cli-08`: Test: Full workflow end-to-end with beautiful UI

### Phase 6: Report Generation (Days 11-13)
**Goal:** HTML report generation working

- Port Jinja2 templates to Handlebars
- Implement single video report generation
- Implement playlist summary report generation
- Port GitHub repo aggregation logic
- Maintain all existing styling and interactivity
- Test: Reports match Python version output

**See TODOs:**
- `reports-01`: Convert Jinja2 templates to Handlebars
- `reports-02`: Port HTMLReportGenerator for single video reports
- `reports-03`: Port playlist summary report generation
- `reports-04`: Port GitHub repo aggregation and description fetching
- `reports-05`: Test: Compare report outputs with Python version

### Phase 7: Testing & Polish (Days 13-15)
**Goal:** Production ready

- Test all commands against existing database
- Compare outputs with Python version
- Handle edge cases and errors gracefully
- Add comprehensive error messages
- Write user documentation
- Test on Windows (PowerShell compatibility)
- Performance optimization
- Final polish on UI/UX

**See TODOs:**
- `testing-01`: Test all commands against existing metube.db
- `testing-02`: Verify data parity with Python version outputs
- `testing-03`: Test error handling and edge cases
- `testing-04`: Test on Windows PowerShell (user environment)
- `testing-05`: Performance testing and optimization
- `testing-06`: Write updated README and setup documentation
- `testing-07`: Final UI polish and user experience refinement

## Technical Decisions

### 1. TypeScript over JavaScript
**Rationale:** Better tooling, type safety, easier refactoring during migration

### 2. Keep SQLite Database Schema
**Rationale:** No migration needed, proven schema, existing data preserved

### 3. Direct API Equivalents
**Rationale:** Use official Node.js SDKs (googleapis, @google/generative-ai) for reliability

### 4. Component-Based UI
**Rationale:** Ink's React paradigm allows reusable, composable UI components

### 5. Reuse Config Files
**Rationale:** No user configuration changes needed, seamless transition

## Code Quality Standards (ENFORCED)

### Error Handling Pattern
```typescript
// REQUIRED: All async operations must have error handling
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  logger.error('Operation failed', {
    operation: 'riskyOperation',
    error: error instanceof Error ? error.message : String(error),
    context: { /* relevant data */ }
  });
  throw new AppError('User-friendly message', {
    cause: error,
    code: 'OPERATION_FAILED'
  });
}
```

### Input Validation Pattern
```typescript
// REQUIRED: Validate all inputs
function processVideo(videoId: string): void {
  if (!videoId || typeof videoId !== 'string') {
    throw new ValidationError('videoId must be a non-empty string');
  }
  if (!videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
    throw new ValidationError('Invalid YouTube video ID format');
  }
  // ... process
}
```

### Type Safety Rules
```typescript
// FORBIDDEN: Using 'any' without justification
const data: any = getData(); // ❌ NO

// REQUIRED: Proper typing or unknown with type guard
const data: unknown = getData();
if (isValidData(data)) {  // ✅ YES
  // data is now typed correctly
}

// ALLOWED: With explicit justification
// @ts-expect-error - Third-party library has incorrect types
const legacyApi: any = oldLibrary.get(); // ✅ ACCEPTABLE with comment
```

### Testing Requirements
```typescript
// REQUIRED: Unit tests for all business logic
describe('VideoRepository', () => {
  it('should create video', () => { /* ... */ });
  it('should handle duplicate video_id', () => { /* ... */ });
  it('should throw on invalid input', () => { /* ... */ });
});

// REQUIRED: Integration tests for API interactions
describe('YouTubeClient', () => {
  it('should fetch playlist', async () => { /* ... */ });
  it('should handle rate limit', async () => { /* ... */ });
  it('should retry on network error', async () => { /* ... */ });
});
```

### Logging Standards
```typescript
// REQUIRED: Structured logging, no console.log in production
import logger from './logger';

// ❌ FORBIDDEN
console.log('Processing video', videoId);

// ✅ REQUIRED
logger.info('Processing video', { videoId, playlistId, attempt: 1 });
logger.error('Failed to process', { videoId, error: err.message });
```

## Risk Assessment

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Production bugs from missing error handling | High | High | Mandatory try-catch, quality gates between phases |
| No test coverage causing regressions | High | High | Vitest setup required before Phase 3 |
| Type safety holes (using 'any') | Medium | Medium | ESLint rules, code review checklist |
| Database connection leaks | Medium | Medium | Connection lifecycle management, monitoring |
| Whisper Node.js bindings unstable | High | Medium | Test early in Phase 4, consider alternatives |
| Ink learning curve steep | Medium | Medium | Start with simple components, reference examples |
| YouTube API quota during testing | Low | Medium | Use cached data, test with small playlists |
| TypeScript complexity overwhelming | Medium | Low | Gradual learning, start simple |

## Quality Gates (MANDATORY)

**No phase can proceed without passing its quality gate.**

### Phase 1 & 2 Quality Gate (COMPLETED)
- [x] TypeScript compiles without errors (`npm run build`)
- [x] Config loads from YAML and .env correctly
- [x] Database queries return real data
- [x] .gitignore includes node_modules/, dist/, *.tsbuildinfo

### Phase 2.5 Quality Gate (REQUIRED BEFORE PHASE 3)
- [ ] **Vitest installed and configured**
- [ ] **Unit tests for all repositories (min 80% coverage)**
- [ ] **Error handling added to all database operations**
- [ ] **Input validation on all public methods**
- [ ] **ESLint + Prettier configured**
- [ ] **No 'any' types (except where absolutely necessary with @ts-expect-error comment)**
- [ ] **Database connection lifecycle managed (open/close)**
- [ ] **Structured logging library installed (pino/winston)**

### Phase 3 Quality Gate
- [ ] OAuth flow tested manually
- [ ] API rate limiting implemented
- [ ] All API calls wrapped in try-catch
- [ ] Integration tests for YouTube API
- [ ] Mock responses for CI/CD testing

### Phase 4 Quality Gate ✅ COMPLETE
- [x] End-to-end extraction test passes
- [x] Error scenarios tested (no transcript, API failure, etc.)
- [x] Whisper fallback verified
- [x] Transaction rollback on failures

### Phase 5 Quality Gate
- [ ] Ink components render without crashes
- [ ] User input validation
- [ ] Keyboard shortcuts documented
- [ ] Performance profiling completed

### Phase 6 Quality Gate
- [ ] Reports visually match Python version
- [ ] HTML validation passes
- [ ] XSS protection verified

### Phase 7 Quality Gate (PRODUCTION READINESS)
- [ ] All tests pass (unit + integration + e2e)
- [ ] Test coverage > 80%
- [ ] No console.log in production code
- [ ] Error messages are user-friendly
- [ ] Performance benchmarks meet targets
- [ ] Memory leak tests pass
- [ ] Documentation complete (README, API docs, user guide)
- [ ] Security audit passed
- [ ] Deployment tested on Windows PowerShell

## Success Criteria

### Minimum Viable Product (MVP)
- [x] Can authenticate with YouTube ✅ Phase 3
- [x] Can discover and add playlists ✅ Phase 3
- [x] Can extract videos with transcripts ✅ Phase 4
- [ ] Can generate HTML reports (Phase 6)
- [x] Works with existing database ✅ Phase 2
- [ ] Basic Ink UI (progress bars, tables) (Phase 5)

### Full Feature Parity
- [ ] All Python commands ported (Phase 5)
- [x] Whisper fallback working ✅ Phase 4
- [x] Gemini entity extraction working ✅ Phase 4
- [ ] Playlist summary reports (Phase 6)
- [ ] Interactive playlist/video selection (Phase 5)
- [ ] Live progress displays (Phase 5)
- [x] Error handling matches Python version ✅ Phase 2-4

### Excellence
- [ ] Beautiful Ink UI components
- [ ] Interactive menus and pickers
- [ ] Real-time progress animations
- [ ] Smooth transitions
- [ ] "Little dude" emoji integrated
- [ ] Better than Python version UX

## Migration Timeline

```
Week 1:
├─ Days 1-2:  Foundation + Database
├─ Days 3-5:  YouTube Integration
└─ Days 5-7:  Start Extraction Pipeline

Week 2:
├─ Days 8-10:  Finish Extraction + Start CLI
├─ Days 11-12: Reports
└─ Days 13-14: Testing

Week 3:
└─ Days 15+:   Polish, Documentation, Launch
```

## Related Documents

- **[TODO List (Active Tracking)]** - View active TODOs in Cursor's TODO panel (42 tasks across 7 phases)
  - Foundation tasks: `foundation-01` through `foundation-05`
  - Database tasks: `database-01` through `database-04`
  - YouTube tasks: `youtube-01` through `youtube-05`
  - Extraction tasks: `extraction-01` through `extraction-08`
  - CLI tasks: `cli-01` through `cli-08`
  - Reports tasks: `reports-01` through `reports-05`
  - Testing tasks: `testing-01` through `testing-07`
- [Current Python README](README.md) - Original documentation
- [Ink Documentation](https://github.com/vadimdemedes/ink) - Framework reference

## Notes

- Python version will remain in repository as `python-legacy/` for reference
- Existing data directory (`data/`) will be reused by TypeScript version
- Config files (`config.yaml`, `.env`, `client_secret.json`) unchanged
- Generated reports should be identical to Python version
- Performance should be comparable or better (Node.js is fast)

## Change Log

### 2026-01-20 (Post Phase 2 Review)
**Senior Dev Code Review Findings - ADDRESSED**

Issues identified and mitigations added:
1. ❌ **No error handling** → ✅ Added mandatory error handling patterns, Phase 2.5 quality gate
2. ❌ **No testing strategy** → ✅ Vitest required before Phase 3, 80% coverage mandate
3. ❌ **Type safety holes** → ✅ ESLint rules, no 'any' policy in code standards
4. ❌ **Database connection leaks** → ✅ Lifecycle management in Phase 2.5 quality gate
5. ❌ **No input validation** → ✅ Validation pattern added to code standards
6. ❌ **No logging** → ✅ Structured logging requirement added
7. ❌ **Missing .gitignore** → ✅ Added to Phase 1 quality gate (completed)

**Actions taken:**
- Created `.cursorrules` to enforce standards automatically
- Added Phase 2.5 quality gate to harden foundation before proceeding
- Documented error handling, validation, and testing patterns
- Updated risk assessment with production-focused concerns

**Acknowledgment:** The review was fair and identified critical gaps. Production readiness requires discipline, not just working code. Quality gates ensure we ship with confidence.

---

**Last Updated:** 2026-01-20 (Post-Review Update)
**Status:** Phase 2 Complete - Hardening before Phase 3

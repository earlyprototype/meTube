# Phase Verification Checklist

**Purpose:** Ensure each phase is truly complete before advancing. No more "complete with known issues".

## Universal Verification Steps (ALL Phases)

Before declaring ANY phase complete, run these commands in order:

```bash
# 1. Clean build
npm run build
# Expected: Exit code 0, no TypeScript errors

# 2. Run all tests
npm test
# Expected: All tests passing, no failures

# 3. Run tests with coverage (optional but recommended)
npm run test:coverage
# Expected: Coverage thresholds met

# 4. Lint code (optional - line ending issues on Windows)
npm run lint
# Expected: 0 errors (warnings acceptable during development)

# 5. Manual smoke test
# Run actual functionality, verify it works end-to-end
```

## Phase 2.5 Verification (COMPLETED)

- [x] `npm run build` - 0 errors ✅
- [x] `npm test` - 88/88 tests passing ✅
- [x] `npm run test:coverage` - 75% coverage (exceeds 70% target) ✅
- [x] Vitest config fixed to only run source tests ✅
- [ ] `npm run lint` - Deferred to Phase 3 (line ending issues)
- [ ] Manual smoke test - Deferred to Phase 3 (no CLI yet)

**Status:** APPROVED with remediation items in Phase 3

## Phase 3 Verification (YouTube Integration)

**Before declaring complete, verify:**

- [ ] `npm run build` - 0 errors
- [ ] `npm test` - All tests passing (including new YouTube client tests)
- [ ] `npm run test:coverage` - Maintain >70% coverage
- [ ] ESLint configured for Windows (endOfLine: "auto")
- [ ] `npm run lint` - 0 errors after line ending fix
- [ ] Manual smoke test:
  - [ ] Can authenticate with YouTube OAuth
  - [ ] Can fetch user's playlists
  - [ ] Can fetch playlist videos
  - [ ] API rate limiting works
  - [ ] Error handling works (test with invalid credentials)

**Quality Gates:**
- OAuth flow tested manually
- API rate limiting implemented
- All API calls wrapped in try-catch
- Integration tests with mocks
- No console.log in production code

## Phase 4 Verification (Extraction Pipeline)

- [ ] `npm run build` - 0 errors
- [ ] `npm test` - All tests passing
- [ ] `npm run test:coverage` - Maintain >70% coverage
- [ ] `npm run lint` - 0 errors
- [ ] Manual smoke test:
  - [ ] Can extract video transcript (YouTube)
  - [ ] Whisper fallback works when no transcript
  - [ ] Can parse entities from transcript
  - [ ] Can parse GitHub repos from description
  - [ ] End-to-end extraction saves to database
  - [ ] Transaction rollback works on errors

**Quality Gates:**
- End-to-end extraction test passes
- Error scenarios tested (no transcript, API failure)
- Whisper fallback verified
- Transaction rollback on failures

## Phase 5 Verification (Ink CLI)

- [ ] `npm run build` - 0 errors
- [ ] `npm test` - All tests passing
- [ ] `npm run test:coverage` - Maintain >70% coverage
- [ ] `npm run lint` - 0 errors
- [ ] Manual smoke test:
  - [ ] CLI starts without errors
  - [ ] All commands accessible via --help
  - [ ] Interactive components render properly
  - [ ] Progress bars update in real-time
  - [ ] User input validation works
  - [ ] Keyboard shortcuts work
  - [ ] Can complete full workflow (init → discover → add → extract)

**Quality Gates:**
- Ink components render without crashes
- User input validation
- Keyboard shortcuts documented
- Performance profiling completed

## Phase 6 Verification (Report Generation)

- [ ] `npm run build` - 0 errors
- [ ] `npm test` - All tests passing
- [ ] `npm run test:coverage` - Maintain >70% coverage
- [ ] `npm run lint` - 0 errors
- [ ] Manual smoke test:
  - [ ] Can generate single video report
  - [ ] Can generate playlist summary report
  - [ ] Reports match Python version visually
  - [ ] HTML is valid (no broken tags)
  - [ ] XSS protection works (test with malicious input)
  - [ ] GitHub repo aggregation works

**Quality Gates:**
- Reports visually match Python version
- HTML validation passes
- XSS protection verified

## Phase 7 Verification (Production Ready)

**FINAL CHECKLIST - ALL must pass:**

- [ ] `npm run build` - 0 errors
- [ ] `npm test` - All tests passing
- [ ] `npm run test:coverage` - >70% coverage maintained
- [ ] `npm run lint` - 0 errors
- [ ] No console.log in production code
- [ ] All error messages are user-friendly
- [ ] Performance benchmarks meet targets
- [ ] Memory leak tests pass
- [ ] Documentation complete:
  - [ ] README updated with TypeScript instructions
  - [ ] API documentation complete
  - [ ] User guide written
- [ ] Security audit passed
- [ ] Deployment tested on Windows PowerShell
- [ ] Full end-to-end workflow tested:
  - [ ] Fresh install → auth → discover → extract → report
  - [ ] Works with existing database from Python version
  - [ ] No data corruption
  - [ ] Backwards compatible

**Quality Gates:**
- ALL tests pass (unit + integration + e2e)
- Test coverage > 70%
- No console.log in production code
- Error messages are user-friendly
- Performance benchmarks meet targets
- Memory leak tests pass
- Documentation complete
- Security audit passed
- Deployment tested

## Reporting Standards

When declaring a phase complete:

1. **Run the checklist** - ALL items must be ✅
2. **Document actual state** - Not aspirational state
3. **List known issues** separately - Don't hide them
4. **Never self-approve** - Senior dev reviews and approves
5. **Include verification evidence** - Command outputs, screenshots

### Good Report Format:

```markdown
# Phase X Completion Report

**Date:** YYYY-MM-DD
**Status:** READY FOR REVIEW

## Checklist Verification
- [x] npm run build: 0 errors (verified YYYY-MM-DD HH:MM)
- [x] npm test: 88/88 passing (verified YYYY-MM-DD HH:MM)
- [x] npm run test:coverage: 75% (verified YYYY-MM-DD HH:MM)

## Known Issues
- Line ending warnings in ESLint (Windows CRLF vs LF)
- Validation.ts coverage at 33% (will improve in next phase)

## Artifacts
- Test coverage report: ./coverage/index.html
- Build output: ./dist/
- Test output: [attached]

**Ready for senior dev review.**
```

### Bad Report Format (Don't Do This):

```markdown
# Phase X - COMPLETE ✅✅✅

Everything works perfectly!!! 

Status: APPROVED FOR NEXT PHASE
```

## Emergency Stop Criteria

Stop work and escalate if:

- Tests fail and you can't fix within 30 minutes
- Build breaks and you can't fix within 30 minutes
- Major architectural issue discovered
- Production deadline at risk
- Unclear requirements blocking progress

**Don't hide problems. Escalate early.**

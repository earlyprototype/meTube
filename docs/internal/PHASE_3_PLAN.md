# Phase 3 Execution Plan: YouTube Integration

**Date Started:** 2026-01-20  
**Status:** IN PROGRESS  
**Lead:** Development Agent  
**Reviewer:** Senior Dev  

---

## Executive Summary

Phase 3 implements YouTube API integration with OAuth authentication, rate limiting, and resilient API client. This phase builds on the solid foundation from Phase 2.5 (88 passing tests, 75% coverage, production-ready error handling).

**Duration Estimate:** Not provided (focus on quality over speed)  
**Prerequisites:** ✅ All Phase 2.5 items complete  
**Entry Criteria:** Senior Dev approval received  

---

## Lessons from Phase 2.5 Applied

1. **Verification Before Declaration** - Run build + test + lint before claiming complete
2. **Honest Reporting** - Document actual state, not aspirational
3. **No Self-Approval** - Senior dev reviews all phase completions
4. **Checklist-Driven** - VERIFICATION_CHECKLIST.md is mandatory
5. **Fix First** - Address carry-forward items before new work

---

## Phase 3 Objectives

### Primary Goals
- ✅ Implement OAuth 2.0 authentication for YouTube API
- ✅ Create robust YouTubeClient wrapper with error handling
- ✅ Implement rate limiting and retry logic
- ✅ Write comprehensive tests (maintain >70% coverage)
- ✅ Fix ESLint line ending issues from Phase 2.5

### Quality Standards (Non-Negotiable)
- All API calls wrapped in try-catch with proper error types
- Input validation on all public methods
- JSDoc documentation on all exported functions/classes
- Unit tests with mocked API responses
- No `console.log` in production code
- Structured logging with Pino

---

## Implementation Tasks (Sequential)

### Task 0: Fix Carry-Forward Items (youtube-07)
**Priority:** MUST DO FIRST  
**Estimated Complexity:** Small  

**Objective:** Fix ESLint line ending warnings from Phase 2.5

**Steps:**
1. Update `.prettierrc` with `"endOfLine": "auto"`
2. Run `npm run lint` to verify fix
3. Commit fix before proceeding

**Success Criteria:**
- [ ] `npm run lint` reports 0 errors
- [ ] Line ending warnings eliminated

**Verification:**
```powershell
npm run lint
# Expected: 0 errors, clean output
```

---

### Task 1: OAuth Authentication (youtube-01)
**Priority:** CRITICAL (blocks all other tasks)  
**Estimated Complexity:** Medium  

**Objective:** Port Python OAuth handler to TypeScript using googleapis library

**Files to Create:**
- `src-ts/auth/YouTubeAuth.ts` - OAuth handler class
- `src-ts/auth/types.ts` - Auth-related type definitions
- `src-ts/auth/__tests__/YouTubeAuth.test.ts` - Unit tests

**Implementation Details:**

#### 1.1 Install Dependencies
```powershell
npm install googleapis @types/googleapis
```

#### 1.2 Create Type Definitions
```typescript
// src-ts/auth/types.ts
export interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type: string;
}
```

#### 1.3 Implement YouTubeAuth Class
**Key Features:**
- Load credentials from `client_secret.json`
- Generate OAuth URL for user authorization
- Exchange authorization code for tokens
- Store tokens securely (filesystem or config)
- Refresh tokens when expired
- Validate all inputs
- Handle all errors with custom error types

**Code Template:**
```typescript
import { google } from 'googleapis';
import { ValidationError, AppError } from '../errors';
import logger from '../utils/logger';

export class YouTubeAuth {
  /**
   * Generate OAuth URL for user authorization
   * @throws {ValidationError} If credentials invalid
   * @throws {AppError} If OAuth client creation fails
   */
  async generateAuthUrl(): Promise<string> {
    try {
      // Implementation
    } catch (error) {
      logger.error('Failed to generate auth URL', { error });
      throw new AppError('OAuth URL generation failed', { cause: error });
    }
  }

  /**
   * Exchange authorization code for tokens
   * @param code - Authorization code from OAuth callback
   * @throws {ValidationError} If code is invalid
   * @throws {AppError} If token exchange fails
   */
  async exchangeCodeForTokens(code: string): Promise<OAuthTokens> {
    if (!code || typeof code !== 'string') {
      throw new ValidationError('Authorization code required');
    }
    try {
      // Implementation
    } catch (error) {
      logger.error('Token exchange failed', { error });
      throw new AppError('Failed to exchange code for tokens', { cause: error });
    }
  }
}
```

#### 1.4 Write Tests
**Test Cases Required:**
- ✅ Generate auth URL successfully
- ✅ Validate credentials on init
- ✅ Exchange code for tokens
- ✅ Refresh expired tokens
- ✅ Handle invalid credentials
- ✅ Handle network errors
- ✅ Handle expired refresh tokens

**Mock Strategy:**
- Mock `googleapis` OAuth2 client
- Mock filesystem operations
- Mock network requests

#### 1.5 Manual Testing
**Process:**
1. Run auth flow manually: `npm run dev -- auth init`
2. Follow OAuth URL in browser
3. Verify tokens saved correctly
4. Verify token refresh works

**Success Criteria:**
- [ ] OAuth URL generates correctly
- [ ] Can authenticate with real YouTube account
- [ ] Tokens stored securely
- [ ] Token refresh works automatically
- [ ] All error scenarios handled
- [ ] Unit tests pass (>80% coverage for this module)
- [ ] JSDoc complete

**Verification Commands:**
```powershell
npm run build  # Must succeed
npm test -- src-ts/auth  # All auth tests pass
npm run test:coverage  # Check auth/ coverage
```

---

### Task 2: YouTubeClient Core (youtube-02)
**Priority:** CRITICAL  
**Estimated Complexity:** Large  
**Depends On:** Task 1 (OAuth)

**Objective:** Create YouTubeClient wrapper for YouTube Data API v3

**Files to Create:**
- `src-ts/api/YouTubeClient.ts` - Main API client
- `src-ts/api/types.ts` - API response type definitions
- `src-ts/api/__tests__/YouTubeClient.test.ts` - Unit tests

**Implementation Details:**

#### 2.1 Create Type Definitions
```typescript
// src-ts/api/types.ts
export interface YouTubePlaylist {
  id: string;
  title: string;
  description: string;
  itemCount: number;
  thumbnailUrl?: string;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  duration: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}
```

#### 2.2 Implement YouTubeClient Class
**Core Methods Required:**
1. `getPlaylists()` - Fetch user's playlists
2. `getPlaylistVideos(playlistId)` - Fetch videos in a playlist
3. `getVideoDetails(videoId)` - Fetch detailed video information
4. `searchVideos(query)` - Search for videos (if needed)

**Code Template:**
```typescript
import { google, youtube_v3 } from 'googleapis';
import { YouTubeAuth } from '../auth/YouTubeAuth';
import { ValidationError, AppError } from '../errors';
import logger from '../utils/logger';
import { validateYouTubeId } from '../utils/validation';

export class YouTubeClient {
  private youtube: youtube_v3.Youtube;

  constructor(private auth: YouTubeAuth) {
    this.youtube = google.youtube({
      version: 'v3',
      auth: auth.getOAuth2Client(),
    });
  }

  /**
   * Fetch user's YouTube playlists
   * @param maxResults - Maximum number of playlists to fetch (default: 50)
   * @returns Array of playlist objects
   * @throws {ValidationError} If maxResults is invalid
   * @throws {AppError} If API request fails
   */
  async getPlaylists(maxResults = 50): Promise<YouTubePlaylist[]> {
    if (maxResults < 1 || maxResults > 50) {
      throw new ValidationError('maxResults must be between 1 and 50');
    }

    try {
      logger.info({ maxResults }, 'Fetching user playlists');
      const response = await this.youtube.playlists.list({
        part: ['snippet', 'contentDetails'],
        mine: true,
        maxResults,
      });

      if (!response.data.items) {
        logger.warn('No playlists found');
        return [];
      }

      const playlists = response.data.items.map(this.mapPlaylist);
      logger.info({ count: playlists.length }, 'Playlists fetched successfully');
      return playlists;

    } catch (error) {
      logger.error('Failed to fetch playlists', { error });
      throw new AppError('Failed to fetch YouTube playlists', {
        cause: error,
        code: 'YOUTUBE_API_ERROR',
      });
    }
  }

  /**
   * Fetch videos from a playlist
   * @param playlistId - YouTube playlist ID
   * @param maxResults - Maximum videos to fetch (default: 50)
   * @returns Array of video IDs
   * @throws {ValidationError} If playlistId is invalid
   * @throws {AppError} If API request fails
   */
  async getPlaylistVideos(
    playlistId: string,
    maxResults = 50
  ): Promise<string[]> {
    validateYouTubeId(playlistId, 'playlist');

    if (maxResults < 1 || maxResults > 50) {
      throw new ValidationError('maxResults must be between 1 and 50');
    }

    try {
      logger.info({ playlistId, maxResults }, 'Fetching playlist videos');
      const response = await this.youtube.playlistItems.list({
        part: ['contentDetails'],
        playlistId,
        maxResults,
      });

      if (!response.data.items) {
        logger.warn({ playlistId }, 'No videos found in playlist');
        return [];
      }

      const videoIds = response.data.items
        .map(item => item.contentDetails?.videoId)
        .filter((id): id is string => !!id);

      logger.info(
        { playlistId, count: videoIds.length },
        'Playlist videos fetched successfully'
      );
      return videoIds;

    } catch (error) {
      logger.error('Failed to fetch playlist videos', { playlistId, error });
      throw new AppError('Failed to fetch playlist videos', {
        cause: error,
        code: 'YOUTUBE_API_ERROR',
        context: { playlistId },
      });
    }
  }

  /**
   * Fetch detailed information for a video
   * @param videoId - YouTube video ID
   * @returns Video details object
   * @throws {ValidationError} If videoId is invalid
   * @throws {AppError} If API request fails
   */
  async getVideoDetails(videoId: string): Promise<YouTubeVideo> {
    validateYouTubeId(videoId, 'video');

    try {
      logger.info({ videoId }, 'Fetching video details');
      const response = await this.youtube.videos.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        id: [videoId],
      });

      if (!response.data.items || response.data.items.length === 0) {
        throw new AppError('Video not found', {
          code: 'VIDEO_NOT_FOUND',
          context: { videoId },
        });
      }

      const video = this.mapVideo(response.data.items[0]);
      logger.info({ videoId }, 'Video details fetched successfully');
      return video;

    } catch (error) {
      logger.error('Failed to fetch video details', { videoId, error });
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to fetch video details', {
        cause: error,
        code: 'YOUTUBE_API_ERROR',
        context: { videoId },
      });
    }
  }

  // Private mapper methods
  private mapPlaylist(item: youtube_v3.Schema$Playlist): YouTubePlaylist {
    // Implementation
  }

  private mapVideo(item: youtube_v3.Schema$Video): YouTubeVideo {
    // Implementation
  }
}
```

#### 2.3 Write Tests
**Test Cases Required:**
- ✅ Fetch playlists successfully
- ✅ Handle empty playlists response
- ✅ Fetch playlist videos successfully
- ✅ Handle invalid playlist ID
- ✅ Fetch video details successfully
- ✅ Handle video not found
- ✅ Handle API errors (403, 404, 500)
- ✅ Handle network timeouts
- ✅ Validate all inputs

**Mock Strategy:**
- Mock `googleapis` youtube client
- Create fixture data for API responses
- Test error scenarios separately

#### 2.4 Success Criteria
- [ ] All core methods implemented
- [ ] Input validation on all methods
- [ ] Error handling on all API calls
- [ ] JSDoc complete for all public methods
- [ ] Unit tests pass (>80% coverage for this module)
- [ ] No console.log statements
- [ ] Structured logging throughout

**Verification Commands:**
```powershell
npm run build  # Must succeed
npm test -- src-ts/api  # All API tests pass
npm run test:coverage  # Check api/ coverage
npm run lint  # 0 errors
```

---

### Task 3: Rate Limiting & Resilience (youtube-03)
**Priority:** HIGH (prevents quota exhaustion)  
**Estimated Complexity:** Medium  
**Depends On:** Task 2 (YouTubeClient)

**Objective:** Implement rate limiting and retry logic to respect YouTube API quotas

**Files to Create:**
- `src-ts/api/RateLimiter.ts` - Rate limiting class
- `src-ts/api/RetryHandler.ts` - Retry with exponential backoff
- `src-ts/api/__tests__/RateLimiter.test.ts` - Unit tests
- `src-ts/api/__tests__/RetryHandler.test.ts` - Unit tests

**Implementation Details:**

#### 3.1 Research YouTube API Quotas
- Default quota: 10,000 units/day
- Cost per operation:
  - playlists.list: 1 unit
  - playlistItems.list: 1 unit
  - videos.list: 1 unit
  - search: 100 units (expensive!)

#### 3.2 Implement Rate Limiter
**Strategy:** Token bucket algorithm

```typescript
// src-ts/api/RateLimiter.ts
import logger from '../utils/logger';

export interface RateLimiterConfig {
  maxRequests: number;    // Max requests per window
  windowMs: number;       // Time window in milliseconds
  costFunction?: (operation: string) => number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private config: RateLimiterConfig) {
    this.tokens = config.maxRequests;
    this.lastRefill = Date.now();
  }

  /**
   * Wait for rate limit to allow request
   * @param operation - Name of operation (for logging and cost calculation)
   * @param cost - Cost of this operation (default: 1)
   * @throws Never - waits until tokens available
   */
  async waitForToken(operation: string, cost = 1): Promise<void> {
    this.refillTokens();

    while (this.tokens < cost) {
      const waitMs = this.calculateWaitTime(cost);
      logger.info(
        { operation, cost, tokensAvailable: this.tokens, waitMs },
        'Rate limit reached, waiting'
      );
      await this.sleep(waitMs);
      this.refillTokens();
    }

    this.tokens -= cost;
    logger.debug({ operation, cost, tokensRemaining: this.tokens }, 'Token consumed');
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const windows = Math.floor(elapsed / this.config.windowMs);

    if (windows > 0) {
      this.tokens = Math.min(
        this.config.maxRequests,
        this.tokens + windows * this.config.maxRequests
      );
      this.lastRefill = now;
      logger.debug({ tokensAfterRefill: this.tokens }, 'Tokens refilled');
    }
  }

  private calculateWaitTime(cost: number): number {
    // Calculate time to wait for enough tokens
    return Math.ceil(
      ((cost - this.tokens) / this.config.maxRequests) * this.config.windowMs
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

#### 3.3 Implement Retry Handler
**Strategy:** Exponential backoff with jitter

```typescript
// src-ts/api/RetryHandler.ts
import logger from '../utils/logger';
import { AppError } from '../errors';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors: string[];  // HTTP status codes or error codes
}

export class RetryHandler {
  constructor(private config: RetryConfig) {}

  /**
   * Execute function with retry logic
   * @param operation - Name of operation (for logging)
   * @param fn - Async function to execute
   * @returns Result of function
   * @throws {AppError} If all retries exhausted
   */
  async execute<T>(
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        logger.debug({ operation, attempt }, 'Executing with retry');
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Check if error is retryable
        if (!this.isRetryable(error)) {
          logger.warn({ operation, error }, 'Non-retryable error, failing immediately');
          throw error;
        }

        // Check if we have retries left
        if (attempt === this.config.maxRetries) {
          logger.error(
            { operation, attempt, error },
            'All retries exhausted'
          );
          break;
        }

        // Calculate backoff delay with jitter
        const delay = this.calculateDelay(attempt);
        logger.info(
          { operation, attempt, delay, error },
          'Retryable error, waiting before retry'
        );
        await this.sleep(delay);
      }
    }

    throw new AppError(`Operation failed after ${this.config.maxRetries} retries`, {
      code: 'MAX_RETRIES_EXCEEDED',
      cause: lastError,
      context: { operation },
    });
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      // Check for network errors
      if (error.message.includes('ECONNRESET') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('ENOTFOUND')) {
        return true;
      }

      // Check for specific YouTube API errors
      if (error.message.includes('quota') ||
          error.message.includes('rate limit') ||
          error.message.includes('503')) {
        return true;
      }
    }
    return false;
  }

  private calculateDelay(attempt: number): number {
    // Exponential backoff: baseDelay * 2^attempt
    const exponential = this.config.baseDelayMs * Math.pow(2, attempt);
    
    // Add jitter (random 0-25% variance)
    const jitter = exponential * 0.25 * Math.random();
    
    // Cap at max delay
    return Math.min(exponential + jitter, this.config.maxDelayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

#### 3.4 Integrate with YouTubeClient
**Update YouTubeClient to use RateLimiter and RetryHandler:**

```typescript
export class YouTubeClient {
  private rateLimiter: RateLimiter;
  private retryHandler: RetryHandler;

  constructor(private auth: YouTubeAuth) {
    this.youtube = google.youtube({ /* ... */ });
    
    this.rateLimiter = new RateLimiter({
      maxRequests: 100,      // Conservative limit
      windowMs: 60 * 1000,   // 1 minute window
    });

    this.retryHandler = new RetryHandler({
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      retryableErrors: ['503', 'ECONNRESET', 'ETIMEDOUT'],
    });
  }

  async getPlaylists(maxResults = 50): Promise<YouTubePlaylist[]> {
    await this.rateLimiter.waitForToken('playlists.list', 1);
    
    return this.retryHandler.execute('getPlaylists', async () => {
      // Original implementation
    });
  }
}
```

#### 3.5 Write Tests
**Test Cases Required:**
- ✅ Rate limiter blocks when limit reached
- ✅ Rate limiter refills tokens correctly
- ✅ Retry handler retries on network errors
- ✅ Retry handler respects max retries
- ✅ Retry handler skips non-retryable errors
- ✅ Exponential backoff calculation correct
- ✅ Jitter adds randomness

#### 3.6 Success Criteria
- [ ] Rate limiting implemented and tested
- [ ] Retry logic implemented and tested
- [ ] YouTubeClient integrated with both
- [ ] All tests pass
- [ ] No console.log statements
- [ ] JSDoc complete

**Verification Commands:**
```powershell
npm run build
npm test -- src-ts/api
npm run test:coverage
```

---

### Task 4: Integration Testing (youtube-06)
**Priority:** HIGH  
**Estimated Complexity:** Medium  
**Depends On:** Tasks 1, 2, 3

**Objective:** Write comprehensive integration tests with mocked API responses

**Files to Create:**
- `src-ts/api/__tests__/integration.test.ts` - Full flow tests

**Implementation Details:**

#### 4.1 Create Mock Fixtures
**Directory Structure:**
```
src-ts/api/__tests__/
├── fixtures/
│   ├── playlists-response.json
│   ├── playlist-videos-response.json
│   └── video-details-response.json
```

**Sample Fixture:**
```json
// playlists-response.json
{
  "items": [
    {
      "id": "PLtest123",
      "snippet": {
        "title": "Test Playlist",
        "description": "Test description",
        "thumbnails": {
          "default": { "url": "https://..." }
        }
      },
      "contentDetails": {
        "itemCount": 5
      }
    }
  ]
}
```

#### 4.2 Write Integration Tests
**Test Scenarios:**
1. Full authentication flow
2. Fetch playlists → videos → details chain
3. Rate limiting in action (multiple rapid requests)
4. Retry on transient failures
5. Error handling for each API call

**Example Test:**
```typescript
describe('YouTubeClient Integration', () => {
  let client: YouTubeClient;
  let mockAuth: YouTubeAuth;

  beforeEach(() => {
    mockAuth = createMockAuth();
    client = new YouTubeClient(mockAuth);
  });

  it('should fetch playlists, videos, and details in sequence', async () => {
    // Mock googleapis responses
    mockGoogleApis({
      playlists: playlistsFixture,
      playlistItems: playlistVideosFixture,
      videos: videoDetailsFixture,
    });

    // Execute full flow
    const playlists = await client.getPlaylists();
    expect(playlists).toHaveLength(1);

    const videoIds = await client.getPlaylistVideos(playlists[0].id);
    expect(videoIds).toHaveLength(5);

    const video = await client.getVideoDetails(videoIds[0]);
    expect(video.title).toBe('Test Video');
  });

  it('should handle rate limiting gracefully', async () => {
    // Make 105 rapid requests (rate limit: 100/min)
    const start = Date.now();
    
    const promises = Array.from({ length: 105 }, () =>
      client.getPlaylists(1)
    );

    await Promise.all(promises);

    const elapsed = Date.now() - start;
    
    // Should have been rate limited (taken > 1s)
    expect(elapsed).toBeGreaterThan(1000);
  });

  it('should retry on network errors', async () => {
    let attempts = 0;
    mockGoogleApis({
      playlists: () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('ECONNRESET');
        }
        return playlistsFixture;
      },
    });

    const playlists = await client.getPlaylists();
    expect(attempts).toBe(3);
    expect(playlists).toHaveLength(1);
  });
});
```

#### 4.3 Success Criteria
- [ ] Integration tests cover all API methods
- [ ] Rate limiting tested end-to-end
- [ ] Retry logic tested with failures
- [ ] Error scenarios tested
- [ ] All tests pass
- [ ] Test coverage >80% for api/ module

---

### Task 5: Manual Verification (youtube-05)
**Priority:** CRITICAL (Final gate)  
**Estimated Complexity:** Small  
**Depends On:** Tasks 1, 2, 3, 4

**Objective:** Manual end-to-end testing with real YouTube API

**Process:**

#### 5.1 Setup Real Environment
1. Ensure `client_secret.json` is in place
2. Clear any cached tokens
3. Build project: `npm run build`

#### 5.2 Test OAuth Flow
```powershell
# Run authentication
npm run dev -- auth init

# Expected:
# - OAuth URL displayed
# - Open URL in browser
# - Authenticate with Google account
# - Tokens saved successfully
# - Success message displayed
```

**Verification Checklist:**
- [ ] OAuth URL generates
- [ ] Browser authentication works
- [ ] Tokens saved to correct location
- [ ] No errors in console
- [ ] Structured logs show auth flow

#### 5.3 Test Playlist Fetching
```powershell
npm run dev -- playlist list

# Expected:
# - Fetches user's playlists from YouTube
# - Displays playlist titles and counts
# - No errors
# - Rate limiting logs visible
```

**Verification Checklist:**
- [ ] Playlists fetched successfully
- [ ] Data matches YouTube web interface
- [ ] Rate limiter logs show token consumption
- [ ] No crashes or unhandled errors

#### 5.4 Test Error Scenarios
```powershell
# Test with invalid credentials
# Manually corrupt tokens file or use invalid client_secret

npm run dev -- playlist list

# Expected:
# - User-friendly error message
# - Structured error log
# - No stack trace exposed to user
# - Graceful failure
```

**Verification Checklist:**
- [ ] Error handling works
- [ ] Error messages are user-friendly
- [ ] Logs contain useful debugging info
- [ ] No application crashes

#### 5.5 Success Criteria
- [ ] OAuth flow works end-to-end
- [ ] Can authenticate with real account
- [ ] Can fetch user's playlists
- [ ] Rate limiting observable in logs
- [ ] Error handling works for all scenarios
- [ ] No unhandled exceptions

---

## Quality Gates (MANDATORY)

**All items must be ✅ before declaring Phase 3 complete:**

### Build & Test
- [ ] `npm run build` - 0 errors
- [ ] `npm test` - All tests passing (88+ tests from Phase 2 + new Phase 3 tests)
- [ ] `npm run test:coverage` - Maintain >70% overall coverage
- [ ] `npm run lint` - 0 errors (after line ending fix)

### Code Quality
- [ ] All API calls wrapped in try-catch
- [ ] Input validation on all public methods
- [ ] No `any` types (except with @ts-expect-error justification)
- [ ] JSDoc on all public methods
- [ ] No console.log in production code
- [ ] Structured logging throughout

### Functionality
- [ ] OAuth flow tested manually
- [ ] API rate limiting implemented
- [ ] Retry logic implemented
- [ ] Integration tests with mocks
- [ ] Can authenticate with YouTube
- [ ] Can fetch user playlists
- [ ] Error handling verified

### Documentation
- [ ] JSDoc complete for all exports
- [ ] README updated with Phase 3 features (if needed)
- [ ] Comments explain complex logic
- [ ] TODO comments removed

---

## Verification Process (Final Step)

### 1. Automated Verification
```powershell
# Run full verification suite
npm run build && npm test && npm run test:coverage && npm run lint

# Expected: All commands succeed with 0 errors
```

### 2. Manual Verification
Follow Task 5 manual verification steps with real YouTube account.

### 3. Generate Phase 3 Completion Report
**Do NOT self-approve. Create report for senior dev review.**

**Report Template:**
```markdown
# Phase 3 Completion Report

**Date:** YYYY-MM-DD
**Status:** READY FOR REVIEW

## Checklist Verification
- [ ] npm run build: 0 errors (verified YYYY-MM-DD HH:MM)
- [ ] npm test: X/X tests passing (verified YYYY-MM-DD HH:MM)
- [ ] npm run test:coverage: X% coverage (verified YYYY-MM-DD HH:MM)
- [ ] npm run lint: 0 errors (verified YYYY-MM-DD HH:MM)
- [ ] Manual OAuth flow: ✅ (verified YYYY-MM-DD HH:MM)
- [ ] Manual playlist fetch: ✅ (verified YYYY-MM-DD HH:MM)

## Test Results
- Total tests: X
- Phase 3 new tests: X
- Coverage: X%
- All tests passing: Yes/No

## Known Issues
(List any known issues or limitations)

## Artifacts
- Test coverage report: ./coverage/index.html
- Build output: ./dist/
- Manual test log: [paste commands + outputs]

## Files Created/Modified
- src-ts/auth/YouTubeAuth.ts
- src-ts/api/YouTubeClient.ts
- src-ts/api/RateLimiter.ts
- src-ts/api/RetryHandler.ts
- (list all files)

**Ready for senior dev review.**
```

### 4. Senior Dev Review
- Wait for senior dev approval
- Address any feedback
- Do NOT proceed to Phase 4 until approved

---

## Emergency Stop Criteria

**Stop work immediately and escalate if:**
- Tests fail and can't be fixed within 30 minutes
- Build breaks and can't be fixed within 30 minutes
- Major architectural issue discovered (e.g., googleapis incompatibility)
- Unclear requirements blocking progress
- YouTube API quotas exhausted (daily limit hit)

**Don't hide problems. Escalate early.**

---

## Files to Create (Summary)

**Phase 3 Deliverables:**
```
src-ts/
├── auth/
│   ├── YouTubeAuth.ts           (NEW)
│   ├── types.ts                 (NEW)
│   └── __tests__/
│       └── YouTubeAuth.test.ts  (NEW)
├── api/
│   ├── YouTubeClient.ts         (NEW)
│   ├── RateLimiter.ts           (NEW)
│   ├── RetryHandler.ts          (NEW)
│   ├── types.ts                 (NEW)
│   └── __tests__/
│       ├── YouTubeClient.test.ts   (NEW)
│       ├── RateLimiter.test.ts     (NEW)
│       ├── RetryHandler.test.ts    (NEW)
│       ├── integration.test.ts     (NEW)
│       └── fixtures/
│           ├── playlists-response.json      (NEW)
│           ├── playlist-videos-response.json (NEW)
│           └── video-details-response.json  (NEW)

.prettierrc                      (MODIFIED - add endOfLine)
```

**Estimated Line Count:** ~1,500-2,000 lines (including tests)

---

## Dependencies to Install

```json
{
  "dependencies": {
    "googleapis": "^140.0.0",
    "@google/generative-ai": "^0.21.0"
  },
  "devDependencies": {
    "@types/googleapis": "^140.0.0"
  }
}
```

---

## Success Definition

**Phase 3 is complete when:**
1. All quality gates pass (build, test, lint, coverage)
2. Manual verification succeeds (OAuth + API calls)
3. Senior dev approves completion report
4. No self-approval before review
5. No known critical issues
6. Documentation complete

**Phase 3 is NOT complete when:**
- Tests are failing ("will fix in Phase 4")
- Build has errors ("minor issues")
- Manual verification skipped ("trust the tests")
- Self-approved without senior review
- Known issues hidden or downplayed

---

## References

- **MIGRATION_PLAN.md** - Overall project plan
- **VERIFICATION_CHECKLIST.md** - Phase-specific verification steps
- **PHASE_25_SUMMARY.md** - Lessons learned from Phase 2.5
- **.cursor/rules/phase3-youtube.mdc** - Implementation templates and patterns

---

## Notes

- **No timelines promised** - Focus on quality over speed
- **Verification first** - Run checklist before claiming complete
- **Honest reporting** - Document actual state, not aspirational
- **No self-approval** - Senior dev reviews all phases
- **Escalate early** - Don't hide problems

---

**Last Updated:** 2026-01-20  
**Status:** READY TO START  
**Approved By:** Senior Dev (verbal approval to proceed)

/**
 * Coverage for the enriched mapEventToProgress (task 1): the switch that turns
 * v2's discriminated-union progress events into the FULL Python-style in-run
 * display state. Pins:
 *   - currentVideo is set from each per-video event's `title`
 *   - step-result events accumulate the granular lines for the CURRENT video
 *   - a new video (`fetch_meta`) resets the per-video accumulators
 *   - whisper_progress drives the live bar and clears on `complete`
 *
 * Driven directly (not through the Ink render) by replaying events against a
 * reducer seeded with the initial ProgressState, mirroring how the component's
 * functional setProgress updates compose.
 */

import { describe, it, expect } from 'vitest';

import { mapEventToProgress, type ProgressState } from '../ExtractCommand.js';
import type { ExtractProgressEvent } from '../../../src-ts-v2/extractors/VideoExtractor.js';
import { asVideoId, asPlaylistId } from '../../../src-ts-v2/types/branded.js';

const VID = asVideoId('vid00000001');
const VID2 = asVideoId('vid00000002');

const INITIAL: ProgressState = {
  current: 0,
  total: 0,
  currentVideo: '',
  status: 'downloading',
  successCount: 0,
  failureCount: 0,
  skippedCount: 0,
  stepLines: [],
  whisperProgress: undefined,
};

/**
 * Replay events through mapEventToProgress, threading the state the way the
 * component's functional setProgress updates do. mapEventToProgress calls
 * setProgress either with a plain object or an updater; this harness applies
 * both forms against the running state.
 */
function reduce(events: readonly ExtractProgressEvent[], seed: ProgressState = INITIAL): ProgressState {
  let state = seed;
  const setProgress = (next: ProgressState | ((prev: ProgressState) => ProgressState)): void => {
    state = typeof next === 'function' ? next(state) : next;
  };
  for (const event of events) {
    mapEventToProgress(event, setProgress);
  }
  return state;
}

describe('mapEventToProgress — title + step lines', () => {
  it('sets currentVideo from the title field on per-video events', () => {
    const state = reduce([
      { kind: 'fetch_meta', videoId: VID, index: 1, total: 3, title: 'First Video' },
    ]);

    expect(state.currentVideo).toBe('First Video');
    expect(state.current).toBe(1);
    expect(state.total).toBe(3);
  });

  it('accumulates metadata, transcript, and entity lines for the current video', () => {
    const state = reduce([
      { kind: 'fetch_meta', videoId: VID, index: 1, total: 1, title: 'Vid' },
      {
        kind: 'meta_result',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Vid',
        channel: 'Fireship',
        durationSeconds: 754,
      },
      {
        kind: 'transcript_result',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Vid',
        source: 'youtube',
        charCount: 12345,
      },
      {
        kind: 'entities_result',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Vid',
        githubRepos: 2,
        websites: 1,
        topics: 5,
        people: 3,
      },
    ]);

    expect(state.stepLines).toEqual([
      'Fireship · 12:34',
      'Transcript: YouTube captions (12,345 chars)',
      'Found 2 repos · 1 website · 5 topics · 3 people',
    ]);
  });

  it('suppresses the entities line when every count is zero', () => {
    const state = reduce([
      { kind: 'fetch_meta', videoId: VID, index: 1, total: 1, title: 'Vid' },
      {
        kind: 'entities_result',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Vid',
        githubRepos: 0,
        websites: 0,
        topics: 0,
        people: 0,
      },
    ]);

    expect(state.stepLines).toEqual([]);
  });

  it('resets the per-video accumulators when the next video starts', () => {
    const state = reduce([
      { kind: 'fetch_meta', videoId: VID, index: 1, total: 2, title: 'Vid One' },
      {
        kind: 'meta_result',
        videoId: VID,
        index: 1,
        total: 2,
        title: 'Vid One',
        channel: 'A',
        durationSeconds: 60,
      },
      // New video — its first event must clear One's lines.
      { kind: 'fetch_meta', videoId: VID2, index: 2, total: 2, title: 'Vid Two' },
    ]);

    expect(state.currentVideo).toBe('Vid Two');
    expect(state.stepLines).toEqual([]);
    expect(state.whisperProgress).toBeUndefined();
  });
});

describe('mapEventToProgress — whisper bar', () => {
  it('sets whisperProgress from a whisper_progress tick', () => {
    const state = reduce([
      { kind: 'fetch_meta', videoId: VID, index: 1, total: 1, title: 'Vid' },
      {
        kind: 'whisper_progress',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Vid',
        percent: 42,
        stage: 'transcribing',
      },
    ]);

    expect(state.whisperProgress).toEqual({ stage: 'transcribing', percentage: 42 });
    expect(state.status).toBe('whisper_transcribing');
  });

  it('clears whisperProgress on a complete-stage tick', () => {
    const state = reduce([
      { kind: 'fetch_meta', videoId: VID, index: 1, total: 1, title: 'Vid' },
      {
        kind: 'whisper_progress',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Vid',
        percent: 50,
        stage: 'transcribing',
      },
      {
        kind: 'whisper_progress',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Vid',
        percent: 100,
        stage: 'complete',
      },
    ]);

    expect(state.whisperProgress).toBeUndefined();
  });

  it('clears the whisper bar when the transcript result lands', () => {
    const state = reduce([
      { kind: 'fetch_meta', videoId: VID, index: 1, total: 1, title: 'Vid' },
      {
        kind: 'whisper_progress',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Vid',
        percent: 80,
        stage: 'transcribing',
      },
      {
        kind: 'transcript_result',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Vid',
        source: 'whisper',
        charCount: 5000,
      },
    ]);

    expect(state.whisperProgress).toBeUndefined();
    expect(state.stepLines).toEqual(['Transcript: Whisper (5,000 chars)']);
  });
});

describe('mapEventToProgress — preserved counters', () => {
  it('keeps job_completed result counts (unchanged behaviour)', () => {
    const jobId = 1 as never; // ExtractionJobId is branded; cast for the fixture only.
    const state = reduce([
      {
        kind: 'job_completed',
        jobId,
        result: {
          total: 5,
          processed: 4,
          skipped: 1,
          failed: 0,
          distinctProcessed: 4,
          verifiedVideoRows: 4,
          verifiedTranscriptRows: 3,
        },
      },
    ]);

    expect(state.successCount).toBe(4);
    expect(state.skippedCount).toBe(1);
    expect(state.failureCount).toBe(0);
    expect(state.status).toBe('completed');
  });

  it('clears the per-video accumulators on video_failed (no stale lines / whisper bar)', () => {
    const state = reduce([
      { kind: 'fetch_meta', videoId: VID, index: 1, total: 1, title: 'Doomed Vid' },
      {
        kind: 'meta_result',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Doomed Vid',
        channel: 'Fireship',
        durationSeconds: 754,
      },
      {
        kind: 'whisper_progress',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Doomed Vid',
        percent: 60,
        stage: 'transcribing',
      },
      // Mid-run failure — its accumulators must not linger to the next video.
      { kind: 'video_failed', videoId: VID, index: 1, total: 1, title: 'Doomed Vid', error: 'boom' },
    ]);

    expect(state.failureCount).toBe(1);
    expect(state.stepLines).toEqual([]);
    expect(state.whisperProgress).toBeUndefined();
  });

  it('clears the per-video accumulators on video_skipped (no stale lines / whisper bar)', () => {
    const state = reduce([
      { kind: 'fetch_meta', videoId: VID, index: 1, total: 1, title: 'Skip Vid' },
      {
        kind: 'meta_result',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Skip Vid',
        channel: 'A',
        durationSeconds: 60,
      },
      {
        kind: 'whisper_progress',
        videoId: VID,
        index: 1,
        total: 1,
        title: 'Skip Vid',
        percent: 30,
        stage: 'transcribing',
      },
      { kind: 'video_skipped', videoId: VID, index: 1, total: 1, title: 'Skip Vid', reason: 'exists' },
    ]);

    expect(state.skippedCount).toBe(1);
    expect(state.stepLines).toEqual([]);
    expect(state.whisperProgress).toBeUndefined();
  });

  it('increments video_done / video_skipped / video_failed counters with titles', () => {
    const playlistId = asPlaylistId('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    const state = reduce([
      { kind: 'job_started', jobId: 1 as never, playlistId, total: 3 },
      { kind: 'video_done', videoId: VID, index: 1, total: 3, title: 'Done Vid' },
      {
        kind: 'video_skipped',
        videoId: VID2,
        index: 2,
        total: 3,
        title: 'Skipped Vid',
        reason: 'exists',
      },
    ]);

    expect(state.successCount).toBe(1);
    expect(state.skippedCount).toBe(1);
    expect(state.currentVideo).toBe('Skipped Vid');
  });
});

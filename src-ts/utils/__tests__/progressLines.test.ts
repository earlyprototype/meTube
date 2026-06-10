/**
 * Coverage for the per-video step-line formatters (task 1). These turn the new
 * `meta_result` / `transcript_result` / `entities_result` progress events into
 * the human-readable lines Python streamed per video
 * (legacy/python/src/extractors/video_extractor.py:118-120,184,202-205).
 */

import { describe, it, expect } from 'vitest';

import {
  formatDuration,
  formatMetaLine,
  formatTranscriptLine,
  formatEntitiesLine,
} from '../progressLines.js';

describe('formatDuration', () => {
  it('formats sub-hour durations as M:SS', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(754)).toBe('12:34');
  });

  it('formats hour-plus durations as H:MM:SS', () => {
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('tolerates negative / NaN by clamping to 0:00', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });
});

describe('formatMetaLine', () => {
  it('joins channel and formatted duration with a middot', () => {
    expect(formatMetaLine('Fireship', 754)).toBe('Fireship · 12:34');
  });

  it('omits the separator when the channel is empty', () => {
    expect(formatMetaLine('', 60)).toBe('1:00');
  });
});

describe('formatTranscriptLine', () => {
  it('labels a YouTube-sourced transcript with a thousands-separated char count', () => {
    expect(formatTranscriptLine('youtube', 12345)).toBe(
      'Transcript: YouTube captions (12,345 chars)'
    );
  });

  it('labels a Whisper-sourced transcript', () => {
    expect(formatTranscriptLine('whisper', 6789)).toBe('Transcript: Whisper (6,789 chars)');
  });

  it('reports a missing transcript', () => {
    expect(formatTranscriptLine('none', 0)).toBe('No transcript available');
  });
});

describe('formatEntitiesLine', () => {
  it('pluralises each entity count and joins with middots', () => {
    expect(formatEntitiesLine(2, 1, 5, 3)).toBe('Found 2 repos · 1 website · 5 topics · 3 people');
  });

  it('uses singular forms at count 1 and singular-people at 1', () => {
    expect(formatEntitiesLine(1, 1, 1, 1)).toBe('Found 1 repo · 1 website · 1 topic · 1 person');
  });

  it('returns null when there is nothing to report (all zero)', () => {
    expect(formatEntitiesLine(0, 0, 0, 0)).toBeNull();
  });
});

/**
 * Coverage for the FULL Python-style in-run display (PARITY.md section A,
 * task 1). Python printed per video: a title header, step-result lines
 * (metadata, transcript source + char count, entity counts), and a live
 * Whisper percentage bar (legacy/python/src/extractors/video_extractor.py:108-228).
 *
 * The component previously gated the per-video block on `currentVideo` (never
 * set) and the whisper panel on `whisperProgress` (never set). These tests pin
 * the additive `stepLines` rendering plus the existing whisper panel so the
 * granular per-video output renders once `mapEventToProgress` feeds the state.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';

import { ProgressDisplay } from '../ProgressDisplay.js';

const BASE_PROPS = {
  current: 1,
  total: 3,
  status: 'transcribing' as const,
  successCount: 0,
  failureCount: 0,
  startTime: new Date(),
};

describe('ProgressDisplay — per-video step lines', () => {
  it('renders the current video title when set', () => {
    const { lastFrame } = render(
      <ProgressDisplay {...BASE_PROPS} currentVideo="My Great Video" />
    );

    expect(lastFrame()).toContain('My Great Video');
  });

  it('renders accumulated step-result lines for the current video', () => {
    const stepLines = [
      'Channel · 12:34',
      'Transcript: YouTube captions (12,345 chars)',
      'Found 2 repos · 1 website · 5 topics · 3 people',
    ];
    const { lastFrame } = render(
      <ProgressDisplay {...BASE_PROPS} currentVideo="My Great Video" stepLines={stepLines} />
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Channel · 12:34');
    expect(frame).toContain('YouTube captions (12,345 chars)');
    expect(frame).toContain('Found 2 repos · 1 website · 5 topics · 3 people');
  });

  it('renders the live Whisper percentage bar while transcribing', () => {
    const { lastFrame } = render(
      <ProgressDisplay
        {...BASE_PROPS}
        currentVideo="Whisper Video"
        whisperProgress={{ stage: 'transcribing', percentage: 42 }}
      />
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Whisper AI Transcription');
    expect(frame).toContain('42%');
  });

  it('hides the Whisper panel once the stage is complete', () => {
    const { lastFrame } = render(
      <ProgressDisplay
        {...BASE_PROPS}
        currentVideo="Whisper Video"
        whisperProgress={{ stage: 'complete', percentage: 100 }}
      />
    );

    expect(lastFrame()).not.toContain('Whisper AI Transcription');
  });

  it('still renders the playlist-level progress bar (unchanged behaviour)', () => {
    const { lastFrame } = render(<ProgressDisplay {...BASE_PROPS} current={2} total={5} />);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 / 5');
  });
});

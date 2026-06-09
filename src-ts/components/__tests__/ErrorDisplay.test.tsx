import React from 'react';
import { render } from 'ink-testing-library';
import { ErrorDisplay } from '../ErrorDisplay.js';
import { describe, it, expect } from 'vitest';

describe('ErrorDisplay', () => {
  it('should render error message', () => {
    const { lastFrame } = render(<ErrorDisplay message="Test error" />);
    expect(lastFrame()).toContain('Test error');
    // ErrorDisplay prefixes the header with symbols.cross ('✗'); the
    // pre-test orphaned assertion ('X Error') was stale and only
    // surfaced now that the vitest include glob picks up .test.tsx.
    expect(lastFrame()).toContain('✗ Error');
  });

  it('should render suggestions when provided', () => {
    const suggestions = ['Try this first', 'Then try this'];
    const { lastFrame } = render(<ErrorDisplay message="Test error" suggestions={suggestions} />);
    expect(lastFrame()).toContain('Try this:');
    expect(lastFrame()).toContain('1. Try this first');
    expect(lastFrame()).toContain('2. Then try this');
  });

  // Wave 2: the details block no longer hides behind the DEBUG env var.
  // Callers that pass `details` (e.g. the extraction error path passing an
  // AppError's code + compact context) mean it for the end user, so the
  // block renders whenever details are present. The label moved from
  // "Debug info:" to "Details:".
  it('renders details WITHOUT the DEBUG env set', () => {
    const savedDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    const { lastFrame } = render(<ErrorDisplay message="Test error" details="Stack trace here" />);
    expect(lastFrame()).toContain('Details:');
    expect(lastFrame()).toContain('Stack trace here');
    if (savedDebug === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = savedDebug;
    }
  });

  it('still renders details when DEBUG env IS set (no longer the gate)', () => {
    const savedDebug = process.env.DEBUG;
    process.env.DEBUG = 'true';
    const { lastFrame } = render(<ErrorDisplay message="Test error" details="Stack trace here" />);
    expect(lastFrame()).toContain('Details:');
    expect(lastFrame()).toContain('Stack trace here');
    if (savedDebug === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = savedDebug;
    }
  });

  it('omits the details block when no details are passed', () => {
    const { lastFrame } = render(<ErrorDisplay message="Test error" />);
    expect(lastFrame()).not.toContain('Details:');
  });

  it('should render with border', () => {
    const { lastFrame } = render(<ErrorDisplay message="Test error" />);
    const frame = lastFrame();
    // Check for border characters
    expect(frame).toMatch(/[─│┌┐└┘]/);
  });
});

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

  it('should render debug info when DEBUG env is set', () => {
    process.env.DEBUG = 'true';
    const { lastFrame } = render(<ErrorDisplay message="Test error" details="Stack trace here" />);
    expect(lastFrame()).toContain('Debug info:');
    expect(lastFrame()).toContain('Stack trace here');
    delete process.env.DEBUG;
  });

  it('should not render debug info when DEBUG env is not set', () => {
    delete process.env.DEBUG;
    const { lastFrame } = render(<ErrorDisplay message="Test error" details="Stack trace here" />);
    expect(lastFrame()).not.toContain('Debug info:');
    expect(lastFrame()).not.toContain('Stack trace here');
  });

  it('should render with border', () => {
    const { lastFrame } = render(<ErrorDisplay message="Test error" />);
    const frame = lastFrame();
    // Check for border characters
    expect(frame).toMatch(/[─│┌┐└┘]/);
  });
});

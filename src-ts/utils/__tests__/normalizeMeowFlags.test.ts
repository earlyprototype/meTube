/**
 * Coverage for normalizeMeowFlags — the boundary normalizer that reconciles
 * meow's `--no-*` boolean-negation output with the CLI's declared `no*` flags.
 *
 * Context: cli.tsx declares boolean flags `noOpen` / `noTranscript` / `noLlm` /
 * `noWhisper`, and the command layer reads those camelCase keys directly
 * (ReportCommand.tsx:132 `flags.noOpen`; VideoCommands.tsx:190/197/237). meow,
 * however, parses `--no-open` as negation of a phantom `open` flag, yielding
 * `{ open: false }` and leaving `noOpen` at its `false` default — so the flag
 * was silently ignored in direct CLI mode. normalizeMeowFlags maps the negated
 * keys back onto the declared `no*` flags. Verified against meow's real output.
 */

import { describe, it, expect } from 'vitest';

import { normalizeMeowFlags } from '../normalizeMeowFlags.js';

describe('normalizeMeowFlags — meow negation mapping', () => {
  it('maps open:false (meow --no-open) to noOpen:true', () => {
    const result = normalizeMeowFlags({ open: false });

    expect(result.noOpen).toBe(true);
  });

  it('maps transcript:false (meow --no-transcript) to noTranscript:true', () => {
    const result = normalizeMeowFlags({ transcript: false });

    expect(result.noTranscript).toBe(true);
  });

  it('maps llm:false (meow --no-llm) to noLlm:true', () => {
    const result = normalizeMeowFlags({ llm: false });

    expect(result.noLlm).toBe(true);
  });

  it('maps whisper:false (meow --no-whisper) to noWhisper:true', () => {
    const result = normalizeMeowFlags({ whisper: false });

    expect(result.noWhisper).toBe(true);
  });

  it('maps every negated key in one pass when all four are present', () => {
    const result = normalizeMeowFlags({
      open: false,
      transcript: false,
      llm: false,
      whisper: false,
    });

    expect(result.noOpen).toBe(true);
    expect(result.noTranscript).toBe(true);
    expect(result.noLlm).toBe(true);
    expect(result.noWhisper).toBe(true);
  });
});

describe('normalizeMeowFlags — pass-through and non-interference', () => {
  it('passes an explicit noOpen:true through untouched', () => {
    const result = normalizeMeowFlags({ noOpen: true });

    expect(result.noOpen).toBe(true);
  });

  it('does not flip noOpen when the negated key is true (flag not passed)', () => {
    // meow yields `open: true` when the user did NOT pass --no-open; that must
    // not be read as a request to skip opening.
    const result = normalizeMeowFlags({ open: true, noOpen: false });

    expect(result.noOpen).toBe(false);
  });

  it('does not invent noOpen when no open key is present at all', () => {
    const result = normalizeMeowFlags({ force: false });

    expect('noOpen' in result).toBe(false);
  });

  it('leaves unrelated flags exactly as-is', () => {
    const result = normalizeMeowFlags({
      force: true,
      reprocess: false,
      maxVideos: 5,
      privacy: 'public',
      all: false,
    });

    expect(result.force).toBe(true);
    expect(result.reprocess).toBe(false);
    expect(result.maxVideos).toBe(5);
    expect(result.privacy).toBe('public');
    expect(result.all).toBe(false);
  });

  it('honours an already-set noOpen:true alongside the negated open:false (both-present is sane)', () => {
    const result = normalizeMeowFlags({ open: false, noOpen: true });

    expect(result.noOpen).toBe(true);
  });

  it('preserves both the negated source key and the derived no* flag', () => {
    // The phantom `open` key is harmless to keep; the command layer only reads
    // `noOpen`. Pinning this documents that we do not strip the source key.
    const result = normalizeMeowFlags({ open: false });

    expect(result.open).toBe(false);
    expect(result.noOpen).toBe(true);
  });
});

describe('normalizeMeowFlags — immutability', () => {
  it('returns a new object and does not mutate the input', () => {
    const input = { open: false } as const;
    const result = normalizeMeowFlags(input);

    expect(result).not.toBe(input);
    // The frozen-in-spirit input keeps only its original key.
    expect('noOpen' in input).toBe(false);
    expect(result.noOpen).toBe(true);
  });

  it('does not throw and returns an empty object for empty input', () => {
    const result = normalizeMeowFlags({});

    expect(result).toEqual({});
  });
});

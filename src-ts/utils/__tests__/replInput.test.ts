/**
 * Coverage for parseReplInput — the REPL command-line parser.
 *
 * Context: the REPL onCommand handler (cli.tsx) previously split typed input
 * on whitespace into [cmd, sub, ...args] and passed `flags: cli.flags` — the
 * flags meow parsed at PROCESS STARTUP. In REPL mode the process starts with
 * no flags, so every flag the user typed (`--reprocess`, `--max-videos 5`,
 * `--privacy public`, `--no-whisper`, ...) was silently dropped and the command
 * ran with defaults.
 *
 * parseReplInput fixes that: it parses flags out of the typed line, strips them
 * from the positionals, and returns a flags object the handler merges OVER
 * cli.flags (typed wins). It mirrors the meow flag declarations in cli.tsx
 * (~lines 87-101): kebab-case -> camelCase, `maxVideos` coerced to number,
 * `privacy` kept as string, everything else boolean-by-presence.
 */

import { describe, it, expect } from 'vitest';

import { parseReplInput } from '../replInput.js';

describe('parseReplInput — positionals', () => {
  it('splits a plain command with no flags into cmd / sub / args', () => {
    const result = parseReplInput('extract playlist FabLab');

    expect(result.cmd).toBe('extract');
    expect(result.sub).toBe('playlist');
    expect(result.args).toEqual(['FabLab']);
    expect(result.flags).toEqual({});
  });

  it('returns an empty flags object for a bare command', () => {
    const result = parseReplInput('help');

    expect(result.cmd).toBe('help');
    expect(result.sub).toBeUndefined();
    expect(result.args).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it('returns undefined cmd and empty args for empty / whitespace input', () => {
    const blank = parseReplInput('   ');

    expect(blank.cmd).toBeUndefined();
    expect(blank.sub).toBeUndefined();
    expect(blank.args).toEqual([]);
    expect(blank.flags).toEqual({});
  });
});

describe('parseReplInput — boolean flags', () => {
  it('parses a trailing boolean flag as true and excludes it from positionals', () => {
    const result = parseReplInput('extract playlist FabLab --reprocess');

    expect(result.cmd).toBe('extract');
    expect(result.sub).toBe('playlist');
    expect(result.args).toEqual(['FabLab']);
    expect(result.flags.reprocess).toBe(true);
  });

  it('kebab-cases a multi-word boolean flag (--no-whisper -> noWhisper)', () => {
    const result = parseReplInput('video add dQw4w9WgXcQ --no-whisper');

    expect(result.flags.noWhisper).toBe(true);
    expect(result.args).toEqual(['dQw4w9WgXcQ']);
  });

  it('honours an explicit --flag=false as boolean false', () => {
    const result = parseReplInput('video add dQw4w9WgXcQ --no-whisper=false');

    expect(result.flags.noWhisper).toBe(false);
  });

  it('parses the bare --all flag', () => {
    const result = parseReplInput('extract --all');

    expect(result.cmd).toBe('extract');
    expect(result.sub).toBeUndefined();
    expect(result.args).toEqual([]);
    expect(result.flags.all).toBe(true);
  });
});

describe('parseReplInput — value-taking flags', () => {
  it('consumes the next token as the value for --max-videos 5 and coerces to number', () => {
    const result = parseReplInput('extract playlist FabLab --max-videos 5');

    expect(result.flags.maxVideos).toBe(5);
    expect(typeof result.flags.maxVideos).toBe('number');
    expect(result.args).toEqual(['FabLab']);
  });

  it('supports the --max-videos=5 inline form', () => {
    const result = parseReplInput('extract playlist FabLab --max-videos=5');

    expect(result.flags.maxVideos).toBe(5);
    expect(typeof result.flags.maxVideos).toBe('number');
  });

  it('keeps maxVideos as undefined when the value is non-numeric (downstream validation handles it)', () => {
    const result = parseReplInput('extract playlist FabLab --max-videos abc');

    expect('maxVideos' in result.flags).toBe(true);
    expect(result.flags.maxVideos).toBeUndefined();
    // The non-numeric token is consumed as the flag value, NOT left as a positional.
    expect(result.args).toEqual(['FabLab']);
  });

  it('parses a string value flag (--privacy public)', () => {
    const result = parseReplInput('playlist add-mine --privacy public');

    expect(result.flags.privacy).toBe('public');
    expect(result.cmd).toBe('playlist');
    expect(result.sub).toBe('add-mine');
    expect(result.args).toEqual([]);
  });

  it('supports the --privacy=public inline form', () => {
    const result = parseReplInput('playlist add-mine --privacy=public');

    expect(result.flags.privacy).toBe('public');
  });
});

describe('parseReplInput — mixed and edge cases', () => {
  it('parses multiple flags together with empty positional args (add-mine --privacy --skip-existing)', () => {
    const result = parseReplInput('playlist add-mine --privacy public --skip-existing');

    expect(result.cmd).toBe('playlist');
    expect(result.sub).toBe('add-mine');
    expect(result.args).toEqual([]);
    expect(result.flags.privacy).toBe('public');
    expect(result.flags.skipExisting).toBe(true);
  });

  it('keeps positionals intact when a flag appears between them', () => {
    const result = parseReplInput('extract --reprocess playlist FabLab');

    expect(result.cmd).toBe('extract');
    expect(result.sub).toBe('playlist');
    expect(result.args).toEqual(['FabLab']);
    expect(result.flags.reprocess).toBe(true);
  });

  it('handles a value flag interleaved with positionals', () => {
    const result = parseReplInput('extract playlist --max-videos 3 FabLab');

    expect(result.cmd).toBe('extract');
    expect(result.sub).toBe('playlist');
    expect(result.args).toEqual(['FabLab']);
    expect(result.flags.maxVideos).toBe(3);
  });

  it('includes unknown flags camelCased (meow-permissive) and strips them from positionals', () => {
    const result = parseReplInput('extract playlist FabLab --made-up-flag');

    expect(result.flags.madeUpFlag).toBe(true);
    expect(result.args).toEqual(['FabLab']);
  });

  it('treats a trailing value flag with no following token as undefined-valued', () => {
    const result = parseReplInput('playlist add-mine --privacy');

    // --privacy is the last token: no value to consume. Boolean-presence
    // fallback would lie about a string flag, so it stays undefined.
    expect('privacy' in result.flags).toBe(true);
    expect(result.flags.privacy).toBeUndefined();
    expect(result.args).toEqual([]);
  });

  it('collapses runs of whitespace between tokens', () => {
    const result = parseReplInput('  extract   playlist    FabLab  ');

    expect(result.cmd).toBe('extract');
    expect(result.sub).toBe('playlist');
    expect(result.args).toEqual(['FabLab']);
  });
});

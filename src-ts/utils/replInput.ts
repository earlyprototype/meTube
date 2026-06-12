/**
 * Parser for typed REPL command lines.
 *
 * The REPL (cli.tsx, no-command branch) reads a line the user types and routes
 * it to the same command dispatch the one-shot CLI uses. The original handler
 * split the line on whitespace into `[cmd, sub, ...args]` and passed
 * `flags: cli.flags` — the flags meow parsed at PROCESS STARTUP. In REPL mode
 * the process starts with no arguments, so `cli.flags` only ever held the
 * declared defaults; every flag the user typed inside the REPL
 * (`--reprocess`, `--max-videos 5`, `--privacy public`, `--no-whisper`, ...)
 * was silently dropped.
 *
 * `parseReplInput` parses those flags out of the typed line so the handler can
 * merge them OVER `cli.flags` (typed wins, startup defaults remain the base).
 * It is intentionally a small hand-rolled parser — no new dependency — and
 * mirrors the meow flag declarations in cli.tsx:
 *   - kebab-case flag names become camelCase keys
 *     (`--max-videos` -> `maxVideos`, `--no-open` -> `noOpen`).
 *   - `maxVideos` is a number flag; `privacy` is a string flag. Both take a
 *     value, supplied as either `--flag value` or `--flag=value`.
 *   - every other declared flag is a boolean — presence means `true`; an
 *     explicit `--flag=false` is honoured as `false`.
 *   - unknown `--flags` are kept too (meow runs permissive here): camelCased,
 *     boolean-by-presence, and stripped from the positionals. Choice
 *     validation is a separately-tracked concern and deliberately not done
 *     here.
 *
 * Flags may appear anywhere in the line, including between positionals; they
 * are stripped out so `cmd`, `sub`, and `args` only ever see non-flag tokens.
 */

/**
 * Flag names (camelCase) that consume a value. Mirrors the meow declarations
 * in cli.tsx: `maxVideos` is `type: 'number'`, `privacy` is `type: 'string'`.
 * Every other declared flag is a boolean. Unknown flags are treated as
 * boolean (meow-permissive) since their type cannot be known here.
 */
const VALUE_FLAGS = {
  maxVideos: 'number',
  privacy: 'string',
} as const satisfies Record<string, 'number' | 'string'>;

type ValueFlagName = keyof typeof VALUE_FLAGS;

function isValueFlag(name: string): name is ValueFlagName {
  return Object.prototype.hasOwnProperty.call(VALUE_FLAGS, name);
}

/**
 * A parsed flag value. `undefined` is a real, intended state here: a
 * value-taking flag (`--max-videos`, `--privacy`) supplied with no usable
 * value is recorded present-but-unset, mirroring how meow yields `undefined`
 * for an unparseable number flag. The key still exists so a merge over
 * `cli.flags` overrides the startup default rather than leaving it in place.
 */
export type ReplFlagValue = string | number | boolean | undefined;

export interface ParsedReplInput {
  cmd?: string;
  sub?: string;
  args: string[];
  flags: Record<string, ReplFlagValue>;
}

/** Convert a kebab-case flag name to camelCase (`max-videos` -> `maxVideos`). */
function toCamelCase(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/**
 * Coerce a string value for a number flag. Mirrors meow's `type: 'number'`
 * behaviour: an unparseable value yields `undefined` rather than `NaN`, so the
 * flag is recorded as present-but-unset and downstream validation (the same
 * code path one-shot CLI invocations hit) decides what to do. This is the
 * least-surprising choice: the user clearly intended a flag, so we don't
 * silently demote the token to a positional, and we never propagate a NaN.
 */
function coerceNumber(value: string): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a typed REPL line into command parts and a flags object.
 *
 * @param input Raw line as typed at the REPL prompt.
 * @returns `cmd` / `sub` / `args` (positionals only, flags stripped) and a
 *   `flags` record ready to merge over `cli.flags`.
 */
export function parseReplInput(input: string): ParsedReplInput {
  const tokens = input.trim().split(/\s+/).filter(Boolean);

  const positionals: string[] = [];
  const flags: Record<string, ReplFlagValue> = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    // Strip the leading `--`, then split an inline `=value` if present.
    const body = token.slice(2);
    const eqIndex = body.indexOf('=');
    const rawName = eqIndex === -1 ? body : body.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : body.slice(eqIndex + 1);
    const name = toCamelCase(rawName);

    if (isValueFlag(name)) {
      // Value flags take their value from `=value`, or the next token when it
      // is not itself a flag. A trailing value flag with nothing to consume is
      // recorded as `undefined` (present but unset) rather than coerced to a
      // misleading boolean.
      let value = inlineValue;
      if (value === undefined) {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i++; // consume the value token so it is not treated as a positional
        }
      }

      if (value === undefined) {
        flags[name] = undefined;
      } else if (VALUE_FLAGS[name] === 'number') {
        flags[name] = coerceNumber(value);
      } else {
        flags[name] = value;
      }
      continue;
    }

    // Boolean (declared or unknown): presence is true; `=false` is explicit
    // false; any other explicit value is treated as true (only `false` flips
    // a boolean off — meow's convention).
    flags[name] = inlineValue === undefined ? true : inlineValue !== 'false';
  }

  const [cmd, sub, ...args] = positionals;
  return { cmd, sub, args, flags };
}

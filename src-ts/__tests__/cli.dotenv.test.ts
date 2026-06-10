/**
 * Regression pin for the .env load order (PARITY.md section E / Bug 1).
 *
 * Python loads dotenv at startup (legacy/python/src/cli.py:10,20). The TS port
 * originally never did, so process.env.GEMINI_API_KEY was undefined unless set
 * system-wide and Gemini analysis was silently skipped every run.
 *
 * The fix is `import 'dotenv/config';` as the FIRST import of cli.tsx — the
 * single process entry point for both one-shot commands and REPL mode. Order is
 * load-bearing: any env-reading import placed above it would evaluate before
 * .env is loaded and read undefined. ESM hoists imports and evaluates them
 * top-to-bottom, so "first import" genuinely means "runs first".
 *
 * Testing an import side-effect directly is awkward (it mutates the real
 * process env once, at module eval). Rather than try to observe that, this pins
 * the *source order* — it fails loudly if someone reorders the dotenv import
 * below another import statement, which is the regression we actually fear.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.tsx');
const source = readFileSync(cliPath, 'utf-8');

/**
 * Line numbers (1-based) of every top-level `import ...` statement in the
 * source, in file order. A line counts as an import if, ignoring leading
 * whitespace, it begins with `import `.
 */
function importLineNumbers(text: string): number[] {
  return text
    .split('\n')
    .map((line, idx) => ({ line: line.trimStart(), n: idx + 1 }))
    .filter(({ line }) => /^import\s/.test(line))
    .map(({ n }) => n);
}

describe('cli.tsx dotenv load order', () => {
  it("imports 'dotenv/config' before any other import", () => {
    const imports = importLineNumbers(source);
    const dotenvLine = source
      .split('\n')
      .findIndex((line) => /^import\s+['"]dotenv\/config['"];?\s*$/.test(line.trimStart()));

    // The dotenv import must exist...
    expect(dotenvLine, "expected an `import 'dotenv/config';` statement in cli.tsx").toBeGreaterThan(
      -1
    );

    // ...and it must be the very first import statement in the file.
    expect(imports.length).toBeGreaterThan(0);
    expect(imports[0]).toBe(dotenvLine + 1); // findIndex is 0-based; importLineNumbers is 1-based
  });

  it("uses the side-effect-only form (no binding) so it is purely a loader", () => {
    // `import 'dotenv/config'` (not `import dotenv from ...`) is what triggers
    // the auto-config side effect. Guard against a refactor to a binding form
    // that would no longer auto-load.
    expect(source).toMatch(/^import\s+['"]dotenv\/config['"];?\s*$/m);
  });
});

/**
 * Normalize meow's `--no-*` boolean-negation flags back to the explicit
 * `no*` flags this CLI declares.
 *
 * The mismatch this fixes
 * -----------------------
 * cli.tsx declares boolean flags named `noOpen`, `noTranscript`, `noLlm`, and
 * `noWhisper`. The command layer reads those camelCase keys directly
 * (ReportCommand.tsx reads `flags.noOpen`; VideoCommands.tsx reads
 * `flags.noTranscript` / `flags.noLlm` / `flags.noWhisper`).
 *
 * But meow's parser treats a `--no-<x>` argument as the BOOLEAN NEGATION of a
 * flag named `<x>`, not as a flag literally named `no<x>`. So
 * `report playlist FabLab --no-open` yields `{ open: false, noOpen: false }` —
 * meow sets the phantom `open` key to false and leaves the declared `noOpen` at
 * its `false` default. `flags.noOpen` is therefore never true and `--no-open`
 * is silently ignored in direct CLI mode. (Verified empirically against meow's
 * actual output for these exact flag declarations.)
 *
 * The REPL parser (utils/replInput.ts) does NOT have this problem: it maps
 * `--no-open` -> `noOpen: true` literally and never produces the negated keys.
 * So this normalization only needs to run on meow's output, and is a harmless
 * no-op when applied to the REPL base (none of the negated keys are present
 * there).
 *
 * What this does
 * --------------
 * For each negated source key meow can emit (`open`, `transcript`, `llm`,
 * `whisper`), if it is present and `false`, set the corresponding `no*` flag to
 * `true`. An explicit `no*: true` already on the flags object passes through
 * untouched, and every unrelated flag is left exactly as-is. The function is
 * immutable: it returns a new object and never mutates its input.
 */

/**
 * Map from the negated key meow emits for `--no-<x>` to the `no<x>` flag name
 * the CLI actually declares and the command layer reads. Mirrors the boolean
 * `no*` flag declarations in cli.tsx.
 */
const NEGATED_TO_NO_FLAG = {
  open: 'noOpen',
  transcript: 'noTranscript',
  llm: 'noLlm',
  whisper: 'noWhisper',
} as const satisfies Record<string, string>;

/**
 * Reconcile meow's `--no-*` negation keys with the CLI's declared `no*` flags.
 *
 * @param flags Flags object as produced by meow (direct CLI mode) or used as
 *   the REPL merge base. Read-only; never mutated.
 * @returns A new flags object where any meow-negated `open` / `transcript` /
 *   `llm` / `whisper` set to `false` has switched the matching `noOpen` /
 *   `noTranscript` / `noLlm` / `noWhisper` flag on. All other keys are preserved.
 */
export function normalizeMeowFlags(
  flags: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...flags };

  for (const [negatedKey, noFlag] of Object.entries(NEGATED_TO_NO_FLAG)) {
    // meow sets the negated key to `false` for `--no-<x>`. Only that exact
    // shape flips the `no*` flag on; absence or `true` leaves it untouched.
    if (normalized[negatedKey] === false) {
      normalized[noFlag] = true;
    }
  }

  return normalized;
}

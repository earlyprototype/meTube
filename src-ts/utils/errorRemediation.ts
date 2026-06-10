/**
 * Error-code -> remediation-steps map.
 *
 * Python printed numbered fix steps for the failures a user can actually act
 * on — the missing-credentials Google-Cloud setup list
 * (`legacy/python/src/cli.py:236-243`, mirrored at `auth/oauth_handler.py:69-76`)
 * and the Gemini-key `.env` hint (`cli.py:266-267`). The v2 UI collapsed every
 * failure to a bare `code` token, dropping the actionable steps. This module
 * reinstates them.
 *
 * Contract:
 *   - `getRemediation(code, context?)` returns an ordered list of fix steps for
 *     a known code, or `undefined` for an unknown / absent code.
 *   - A code with NO entry returns `undefined`, so `ErrorDisplay` renders it
 *     exactly as before — no behavioural change for unmapped errors.
 *   - Entries are functions of optional `context` so codes like `CONFIG_ERROR`
 *     can fold the failing path + cause into the guidance (the loader's
 *     `ConfigError` carries `configPath`; its message carries the cause).
 *
 * Scope: the high-signal, user-actionable codes only. Transport/parse failures
 * (`YOUTUBE_API_ERROR`, `*_PARSE_ERROR`) are deliberately unmapped — there is no
 * stable user fix, matching Python, which printed steps only for these cases.
 */

/**
 * Optional structured context an error carried, used to specialise a few
 * remediation messages (notably `CONFIG_ERROR`). Mirrors the loose shape of
 * `AppError.context` plus the `ConfigError` cause surfaced via the message.
 */
export interface RemediationContext {
  /** Path of the offending config file, when the error carried one. */
  readonly configPath?: string;
  /** Human-readable cause string, when one is available. */
  readonly cause?: string;
}

/** A remediation entry: ordered fix steps, optionally specialised by context. */
type RemediationEntry = (context?: RemediationContext) => readonly string[];

/**
 * The five-step Google-Cloud OAuth setup list Python prints verbatim when
 * credentials are missing (`cli.py:238-242`). Kept word-for-word so the TS UI
 * matches the Python console output.
 */
const MISSING_CREDS_STEPS: readonly string[] = [
  'Go to https://console.cloud.google.com',
  'Create/select a project',
  'Enable YouTube Data API v3',
  'Create OAuth 2.0 Client ID (Desktop application)',
  "Download credentials and save as 'client_secret.json'",
] as const;

/**
 * Code -> remediation builder. Only codes a user can act on appear here;
 * everything else is intentionally absent (renders unchanged).
 */
const REMEDIATION_MAP: Readonly<Record<string, RemediationEntry>> = {
  // Missing OAuth client secret — the marquee Python remediation case.
  MISSING_CREDS: () => MISSING_CREDS_STEPS,

  // Present-but-broken config.yaml. The loader throws ConfigError with the
  // path in context and the cause folded into the message; surface both.
  CONFIG_ERROR: (context) => {
    const path = context?.configPath ?? 'config/config.yaml';
    const lines = [`Check ${path} — it could not be loaded.`];
    if (context?.cause) {
      lines.push(`Cause: ${context.cause}`);
    }
    lines.push('Fix the YAML (it must be a mapping of sections: api, database, ...) or remove the file to fall back to defaults.');
    return lines;
  },

  // Gemini parsing/auth failure — Python's `.env` hint (cli.py:267,
  // llm_parser.py:29-30).
  GEMINI_API_ERROR: () => [
    'Set GEMINI_API_KEY in your .env file (LLM analysis is disabled without it)',
    'Verify the key is valid and the Gemini API is enabled for your project',
  ],

  // Whisper toolchain prerequisites. WhisperExtractor shells out to Python +
  // yt-dlp; a missing binary is a concrete install step for the user.
  PYTHON_NOT_FOUND: () => [
    'Install Python 3 and ensure it is on your PATH',
    'The Whisper fallback runs through a Python subprocess (see README setup)',
  ],
  YT_DLP_NOT_FOUND: () => [
    'Install yt-dlp (e.g. `pip install yt-dlp`) and ensure it is on your PATH',
    'Whisper needs yt-dlp to download audio before transcription',
  ],
};

/**
 * Resolve the remediation steps for an error code.
 *
 * @param code - The `AppError.code` (or `undefined` for non-AppError failures).
 * @param context - Optional structured context to specialise the message.
 * @returns Ordered fix steps, or `undefined` when the code is unknown/absent —
 *          in which case the caller renders the error exactly as before.
 */
export function getRemediation(
  code: string | undefined,
  context?: RemediationContext
): readonly string[] | undefined {
  if (!code) return undefined;
  const entry = REMEDIATION_MAP[code];
  if (!entry) return undefined;
  return entry(context);
}

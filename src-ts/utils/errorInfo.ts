/**
 * Shared adapter: unknown thrown value -> the `{ code, remediationContext }`
 * `ErrorDisplay` consumes to render code-driven remediation steps (task 4).
 *
 * Every command catches `unknown` and renders `ErrorDisplay`. Rather than each
 * one re-deriving the AppError code + config context, they call this once. A
 * non-AppError value returns `null` (ErrorDisplay then renders the message only,
 * exactly as before).
 */

import { AppError } from '../../src-ts-v2/errors/AppError.js';
import type { RemediationContext } from './errorRemediation.js';

/** What a command stores and forwards to `ErrorDisplay` for remediation. */
export interface ErrorInfo {
  /** The AppError's machine code (drives the remediation lookup). */
  readonly code: string;
  /** Optional structured context that specialises a few remediation messages. */
  readonly remediationContext?: RemediationContext;
}

/**
 * Build the `ErrorInfo` for a thrown value.
 *
 * @param err - The caught value (`unknown`).
 * @returns `{ code, remediationContext }` for an `AppError`; `null` otherwise.
 *          For a `ConfigError` (code `CONFIG_ERROR`) the offending path is read
 *          from `context.configPath` and the human-readable cause is the error
 *          message the loader built (which already names the path + reason).
 */
export function buildErrorInfo(err: unknown): ErrorInfo | null {
  if (!(err instanceof AppError)) return null;

  const remediationContext = buildRemediationContext(err);
  return remediationContext ? { code: err.code, remediationContext } : { code: err.code };
}

/**
 * Derive the optional remediation context from an AppError's structured fields.
 * Only the config path is currently extracted (the sole context a remediation
 * entry specialises on); the cause is the error message itself, since the
 * loader's ConfigError message already embeds the path + reason. Returns
 * `undefined` when there's nothing useful to specialise on.
 */
function buildRemediationContext(err: AppError): RemediationContext | undefined {
  const configPath = typeof err.context?.configPath === 'string' ? err.context.configPath : undefined;

  // The config path is the only field a remediation entry keys on today. For
  // CONFIG_ERROR we also surface the message as the cause so the user sees the
  // concrete YAML/permission reason the loader reported.
  if (err.code === 'CONFIG_ERROR') {
    return { configPath, cause: err.message };
  }

  if (configPath) {
    return { configPath };
  }

  return undefined;
}

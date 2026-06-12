import { AppError } from './AppError.js';

/**
 * Error thrown when a PRESENT config file cannot be loaded — it is
 * unreadable, is not valid YAML, or does not parse to a mapping.
 *
 * Parity note: Python's `cli.py:load_config` only special-cases a MISSING
 * file (the `if config_path.exists()` guard). A present-but-broken file is
 * a hard error in Python — an unreadable file raises from `open()`, malformed
 * YAML raises `yaml.YAMLError`, and a non-mapping root crashes the
 * merge-over-defaults loop (`cli.py:176-178`) with a `TypeError`. This error
 * is the TypeScript equivalent: a typo'd or permission-broken
 * `config/config.yaml` must fail loudly, naming the path and cause, rather
 * than silently degrading to hardcoded defaults.
 *
 * Not thrown for a MISSING file (that falls back to schema defaults, matching
 * Python) nor for a well-formed mapping that violates the schema (Zod's
 * `ZodError` surfaces that case unchanged).
 */
export class ConfigError extends AppError {
  constructor(
    message: string,
    options: {
      configPath?: string;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, {
      code: 'CONFIG_ERROR',
      statusCode: 500,
      isOperational: true,
      cause: options.cause,
      context: {
        configPath: options.configPath,
        ...options.context,
      },
    });
  }
}

/**
 * Zod schema for `config/config.yaml`.
 *
 * Mirrors the canonical config shape from `config/config.yaml` and the
 * Python loader at `legacy/python/src/cli.py:_substitute_env_vars`. Field
 * names match the YAML (snake_case); v2 keeps this convention rather than
 * camelCasing on load so config can be diffed against the file directly.
 *
 * Every section has defaults so a config.yaml with sparse fields still
 * parses to a complete `MeTubeConfig`. Environment-variable substitution
 * happens BEFORE Zod parse (see `src-ts/config.ts` for the recursive
 * `substituteEnvVars` already lifted from Python).
 *
 * Uses the Zod v3 API surface (project depends on `zod ^3.25.76`).
 */

import { z } from 'zod';

// --------------------------------------------------------------------------
// `api:` section
// --------------------------------------------------------------------------

export const ApiConfigSchema = z.object({
  youtube_credentials: z.string().default('client_secret.json'),
  token_file: z.string().default('token.json'),
  gemini_api_key: z.string().optional(),
  gemini_model: z.string().default('gemini-3-flash-preview'),
  rate_limit_delay: z.number().default(0.3),
  max_retries: z.number().int().default(3),
});

// --------------------------------------------------------------------------
// `database:` section
// --------------------------------------------------------------------------

export const DatabaseConfigSchema = z.object({
  path: z.string().default('data/metube.db'),
  backup_enabled: z.boolean().default(true),
  backup_path: z.string().default('data/backups/'),
  auto_vacuum: z.boolean().default(true),
});

// --------------------------------------------------------------------------
// `extraction.whisper:` sub-section
// --------------------------------------------------------------------------

export const WhisperConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default('base'),
  audio_format: z.string().default('m4a'),
  temp_dir: z.string().default('data/temp_audio/'),
  cleanup_audio: z.boolean().default(true),
});

// --------------------------------------------------------------------------
// `extraction:` section
// --------------------------------------------------------------------------

export const ExtractionConfigSchema = z.object({
  auto_transcript: z.boolean().default(true),
  auto_llm_parse: z.boolean().default(true),
  filter_shorts_only: z.boolean().default(false),
  languages: z.array(z.string()).default(['en', 'en-GB', 'en-US']),
  batch_size: z.number().int().default(50),
  whisper: WhisperConfigSchema.default({
    enabled: false,
    model: 'base',
    audio_format: 'm4a',
    temp_dir: 'data/temp_audio/',
    cleanup_audio: true,
  }),
});

// --------------------------------------------------------------------------
// `reports:` section
// --------------------------------------------------------------------------

export const ReportsConfigSchema = z.object({
  output_dir: z.string().default('reports/'),
  template: z.string().default('default.html'),
  auto_generate: z.boolean().default(true),
  include_thumbnails: z.boolean().default(true),
  date_format: z.string().default('%Y-%m-%d %H:%M:%S'),
});

// --------------------------------------------------------------------------
// `logging:` section
// --------------------------------------------------------------------------

export const LoggingConfigSchema = z.object({
  level: z.string().default('INFO'),
  file: z.string().default('logs/metube.log'),
  max_size_mb: z.number().int().default(10),
  backup_count: z.number().int().default(5),
});

// --------------------------------------------------------------------------
// Top-level config
// --------------------------------------------------------------------------

/**
 * Full validated config. Every section is optional at the YAML level —
 * missing sections fall back to defaults. Concrete callers always receive a
 * fully-populated object.
 */
export const MeTubeConfigSchema = z.object({
  api: ApiConfigSchema.default({}),
  database: DatabaseConfigSchema.default({}),
  extraction: ExtractionConfigSchema.default({}),
  reports: ReportsConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
});

// --------------------------------------------------------------------------
// Inferred TypeScript types
// --------------------------------------------------------------------------

export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type WhisperConfig = z.infer<typeof WhisperConfigSchema>;
export type ExtractionConfig = z.infer<typeof ExtractionConfigSchema>;
export type ReportsConfig = z.infer<typeof ReportsConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type MeTubeConfig = z.infer<typeof MeTubeConfigSchema>;

/**
 * Zod schema for the Gemini LLM response shape used by v2's transcript
 * entity-extraction pipeline.
 *
 * Mirrors `legacy/python/src/parsers/llm_parser.py:_build_extraction_prompt`
 * and `_normalize_result`. The prompt instructs Gemini to return JSON with
 * these exact keys; this schema is the boundary check between "model
 * returned a string that JSON-parsed" and "we have a typed result to write
 * to the DB".
 *
 * Defaults: every list-shaped field defaults to `[]` so a partial /
 * truncated response still parses gracefully. `summary` defaults to ''.
 * Sentiment defaults to `'neutral'`. This matches the Python `_empty_result`
 * fallback behavior — the parser never throws on a shape-valid-but-empty
 * response; it returns the empty result and lets downstream code decide
 * what to do.
 *
 * Uses the Zod v3 API surface (project depends on `zod ^3.25.76`).
 */

import { z } from 'zod';

/**
 * Sentiment is one of three known categories. The Python code accepts any
 * string and stores it raw; the v2 schema constrains to the known set with
 * `z.enum` so a misspelt model output fails validation early.
 */
export const GeminiSentimentSchema = z.enum(['positive', 'negative', 'neutral']).default('neutral');

/**
 * GitHub repo entry as emitted by Gemini under the `github_repos` key.
 * Format per the prompt: `{ "name": "repo-name", "url": "full-url" }`.
 *
 * `name` is required by the prompt; `url` may be absent if the model could
 * not infer the full URL.
 */
export const GeminiRepoSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
});

/**
 * Website entry under the `websites` key. Same shape as the repo entry —
 * the prompt distinguishes them by category, not by structure.
 */
export const GeminiWebsiteSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
});

/**
 * Top-level Gemini response. Every list defaults to `[]`. `summary` and
 * `content_type` get sensible string defaults. Sentiment defaults to
 * neutral.
 *
 * Note on `topics` and `people`: the prompt requests bare strings, NOT
 * structured `{ name, url }` objects. Aligning with Python's `topics: []`
 * / `people: []` of plain strings.
 */
export const GeminiResponseSchema = z.object({
  topics: z.array(z.string()).default([]),
  github_repos: z.array(GeminiRepoSchema).default([]),
  websites: z.array(GeminiWebsiteSchema).default([]),
  people: z.array(z.string()).default([]),
  // Tags are forced lowercase at this normalization boundary — deterministic
  // parity with Python `_normalize_result` (llm_parser.py:137,
  // `[tag.lower() for tag in ...]`). The prompt also asks the model for
  // lowercase, but the prompt is advisory; this transform makes it a guarantee
  // so ["Python","ML"] always persists as ["python","ml"] regardless of model
  // compliance.
  tags: z
    .array(z.string())
    .default([])
    .transform((tags) => tags.map((tag) => tag.toLowerCase())),
  summary: z.string().default(''),
  content_type: z.string().default('unknown'),
  sentiment: GeminiSentimentSchema,
});

// --------------------------------------------------------------------------
// Inferred TypeScript types
// --------------------------------------------------------------------------

export type GeminiSentiment = z.infer<typeof GeminiSentimentSchema>;
export type GeminiRepo = z.infer<typeof GeminiRepoSchema>;
export type GeminiWebsite = z.infer<typeof GeminiWebsiteSchema>;
export type GeminiResponse = z.infer<typeof GeminiResponseSchema>;

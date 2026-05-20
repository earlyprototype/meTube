/**
 * Barrel for `src-ts-v2/parsers/`.
 *
 * Two parsers: a deterministic regex-only `DescriptionParser` (URLs,
 * GitHub repos) and an LLM-driven `GeminiParser` (topics, people, summary,
 * tags, sentiment). Both produce entity rows + tags in shapes the
 * downstream extractor pipeline knows how to merge.
 */
export {
  DescriptionParser,
  type GitHubRepo,
  type ParsedDescription,
  type DatabaseEntity as DescriptionDatabaseEntity,
} from './DescriptionParser.js';

export {
  GeminiParser,
  type ParseTranscriptInput,
  type AIAnalysis,
  type DatabaseEntity as GeminiDatabaseEntity,
} from './GeminiParser.js';

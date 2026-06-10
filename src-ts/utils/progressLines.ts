/**
 * Per-video step-line formatters for the FULL Python-style in-run display
 * (task 1).
 *
 * Python streamed granular `[OK] …` lines per video — Title/Channel/Duration,
 * transcript source + char count, and entity counts
 * (legacy/python/src/extractors/video_extractor.py:118-120,184,202-205). These
 * helpers turn the v2 `meta_result` / `transcript_result` / `entities_result`
 * progress events into the same information, adapted to the Ink visual language
 * (the title is the header; these are the dim secondary lines beneath it).
 */

/**
 * Format a duration in seconds as `M:SS` (under an hour) or `H:MM:SS`.
 * Negative / NaN inputs clamp to `0:00` (live streams and unparseable
 * durations surface as `0` upstream).
 */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');

  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(secs)}`;
  }
  return `${mins}:${pad(secs)}`;
}

/**
 * The metadata line: `Channel · 12:34`. When the channel is empty (rare, but
 * the adapter can yield `''`), just the duration is shown.
 */
export function formatMetaLine(channel: string, durationSeconds: number): string {
  const duration = formatDuration(durationSeconds);
  return channel ? `${channel} · ${duration}` : duration;
}

/**
 * The transcript line, matching Python's "via {source} ({n} chars)" content:
 *   - youtube -> `Transcript: YouTube captions (12,345 chars)`
 *   - whisper -> `Transcript: Whisper (6,789 chars)`
 *   - none    -> `No transcript available`
 */
export function formatTranscriptLine(
  source: 'youtube' | 'whisper' | 'none',
  charCount: number
): string {
  if (source === 'none') {
    return 'No transcript available';
  }
  const label = source === 'youtube' ? 'YouTube captions' : 'Whisper';
  return `Transcript: ${label} (${charCount.toLocaleString('en-US')} chars)`;
}

/** Pluralise a noun by count (1 -> singular). */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * The combined entity-counts line:
 * `Found 2 repos · 1 website · 5 topics · 3 people`. Returns `null` when every
 * count is zero (nothing worth a line — Python only printed counts when it
 * found something).
 */
export function formatEntitiesLine(
  githubRepos: number,
  websites: number,
  topics: number,
  people: number
): string | null {
  if (githubRepos === 0 && websites === 0 && topics === 0 && people === 0) {
    return null;
  }
  const parts = [
    plural(githubRepos, 'repo', 'repos'),
    plural(websites, 'website', 'websites'),
    plural(topics, 'topic', 'topics'),
    plural(people, 'person', 'people'),
  ];
  return `Found ${parts.join(' · ')}`;
}

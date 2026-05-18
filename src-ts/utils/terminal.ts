/**
 * Windows terminal-safe Unicode helper.
 *
 * On Windows, PowerShell uses the system OEM code page (often cp850/cp1252),
 * which cannot represent most Unicode characters outside the Basic Latin block.
 * Attempting to print emoji or non-ASCII characters causes garbled output or
 * runtime errors.
 *
 * This mirrors the defensive encoding used in the legacy Python CLI:
 *   legacy/python/src/cli.py:561
 *   `video.title.encode('ascii', 'replace').decode('ascii')`
 *
 * On non-Windows platforms the string passes through unchanged.
 */

/**
 * Returns a terminal-safe version of a title string.
 *
 * On `win32`: replaces any character outside printable ASCII (U+0020–U+007E)
 * with `?`, preserving tab (U+0009) and newline (U+000A) as-is.
 * On other platforms: returns `s` unchanged.
 *
 * @param s - The raw title string (e.g. from a YouTube API response).
 * @returns A string safe to print in a Windows PowerShell terminal.
 */
export function safeTitle(s: string): string {
  if (process.platform !== 'win32') {
    return s;
  }
  // Replace any char that is not printable ASCII (0x20-0x7E), tab, or newline
  // with '?', matching Python's encode('ascii', 'replace') behaviour.
  return s.replace(/[^\x09\x0A\x20-\x7E]/g, '?');
}

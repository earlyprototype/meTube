/**
 * Wave 3 WhisperExtractor tests (closes A16 — no test file existed).
 *
 * The differentiated-capability path: a Python `openai-whisper` subprocess
 * spawned via `node:child_process`. We stub `spawn` with a fake
 * `ChildProcess` event-emitter and drive the REAL `WhisperExtractor` so the
 * subprocess-output handling (`transcribeAudio` / `extract`) is exercised
 * end-to-end without a Python venv.
 *
 * Cases (mirrors the audit's A16/A17 closure):
 *   1. Happy-path payload between JSON_OUTPUT_START/END → segments + duration
 *      mapping (`duration = end - start`).
 *   2. Valid JSON missing `segments` → a clean typed `WHISPER_PARSE_FAILED`
 *      from the A17 Zod parse, NOT an unguarded TypeError on `.map(...)`.
 *   3. Absent JSON markers → `WHISPER_PARSE_FAILED`.
 *   4. Non-zero exit code → `WHISPER_FAILED` carrying stderr.
 *   5. spawn `'error'` (ENOENT) → `PYTHON_NOT_FOUND`, with temp-script cleanup.
 *
 * No `any` — fakes are typed; deliberately shape-broken payloads are plain
 * JSON strings the subprocess "prints", so no casts are needed.
 */
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Module mocks — must be declared before importing the SUT.
// --------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

import { AppError } from '../errors/index.js';
import { WhisperExtractor } from '../extractors/WhisperExtractor.js';

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const mockWriteFileSync = fs.writeFileSync as unknown as ReturnType<typeof vi.fn>;
const mockUnlinkSync = fs.unlinkSync as unknown as ReturnType<typeof vi.fn>;

// --------------------------------------------------------------------------
// Fake ChildProcess — an EventEmitter with stdout/stderr sub-emitters. Tests
// drive it by emitting 'data' on the streams then 'close'/'error' on the proc.
// --------------------------------------------------------------------------

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeFakeProc(): FakeChildProcess {
  const proc = new EventEmitter() as FakeChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

/**
 * Emit a successful Python run: prints `stdout`, then closes with code 0.
 * Deferred to a microtask so the SUT has wired its listeners first.
 */
function driveClose(
  proc: FakeChildProcess,
  opts: { code: number; stdout?: string; stderr?: string }
): void {
  queueMicrotask(() => {
    if (opts.stdout) {
      proc.stdout.emit('data', Buffer.from(opts.stdout));
    }
    if (opts.stderr) {
      proc.stderr.emit('data', Buffer.from(opts.stderr));
    }
    proc.emit('close', opts.code);
  });
}

/**
 * Emit a spawn failure: the process never starts.
 */
function driveSpawnError(proc: FakeChildProcess, err: Error): void {
  queueMicrotask(() => {
    proc.emit('error', err);
  });
}

/**
 * Wrap a Whisper JSON payload string in the marker lines the subprocess
 * prints around it.
 */
function wrapInMarkers(jsonBody: string): string {
  return `JSON_OUTPUT_START\n${jsonBody}\nJSON_OUTPUT_END\n`;
}

// --------------------------------------------------------------------------
// transcribeAudio access — it is private; reach it through a narrow typed
// surface rather than `any`. Exercises the REAL method, no re-implementation.
// --------------------------------------------------------------------------

interface TranscribeAudioAccess {
  transcribeAudio(audioPath: string, videoId: string): Promise<unknown>;
}

function transcribe(
  extractor: WhisperExtractor,
  audioPath: string,
  videoId: string
): Promise<unknown> {
  return (extractor as unknown as TranscribeAudioAccess).transcribeAudio(audioPath, videoId);
}

describe('WhisperExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: every path the SUT probes exists (python binary, temp dir,
    // downloaded audio, temp script). Individual tests override as needed.
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------------
  // Case 1 — happy path through the full extract() pipeline.
  // ------------------------------------------------------------------------
  describe('extract — happy path', () => {
    it('maps segments and computes duration from a well-formed payload', async () => {
      // Arrange — extract() spawns twice: yt-dlp (download) then python
      // (transcribe). Drive each proc as it is handed to the SUT (so the
      // listeners are attached before we emit): call 1 = yt-dlp success,
      // call 2 = python emits the JSON payload between markers + closes 0.
      const payload = JSON.stringify({
        text: 'Hello world this is whisper',
        segments: [
          { start: 0, end: 2.5, text: ' Hello world ' },
          { start: 2.5, end: 5, text: ' this is whisper ' },
        ],
        language: 'en',
      });

      mockSpawn.mockImplementation(() => {
        const proc = makeFakeProc();
        if (mockSpawn.mock.calls.length === 1) {
          driveClose(proc, { code: 0 }); // yt-dlp: audio "downloaded"
        } else {
          driveClose(proc, { code: 0, stdout: wrapInMarkers(payload) }); // python
        }
        return proc;
      });

      const extractor = new WhisperExtractor({ cleanup_audio: false });

      // Act
      const result = await extractor.extract('dQw4w9WgXcQ');

      // Assert — transcript mapped, duration = end - start, text trimmed.
      expect(result).not.toBeNull();
      expect(result?.full_text).toBe('Hello world this is whisper');
      expect(result?.language).toBe('en');
      expect(result?.from_whisper).toBe(true);
      expect(result?.is_auto_generated).toBe(false);
      expect(result?.segments).toEqual([
        { start: 0, duration: 2.5, text: 'Hello world' },
        { start: 2.5, duration: 2.5, text: 'this is whisper' },
      ]);
    });
  });

  // ------------------------------------------------------------------------
  // Case 2 — valid JSON but missing `segments`. Pre-A17 this threw a raw
  // TypeError on `payload.segments.map`; post-A17 the Zod parse rejects it
  // and the catch maps it to a typed WHISPER_PARSE_FAILED.
  // ------------------------------------------------------------------------
  describe('transcribeAudio — malformed payload (A17 closure)', () => {
    it('valid JSON missing segments → typed WHISPER_PARSE_FAILED, not a raw TypeError', async () => {
      // Arrange — payload is valid JSON but has no `segments` key.
      const proc = makeFakeProc();
      mockSpawn.mockReturnValueOnce(proc);
      const badPayload = JSON.stringify({ text: 'no segments here', language: 'en' });
      driveClose(proc, { code: 0, stdout: wrapInMarkers(badPayload) });

      const extractor = new WhisperExtractor();

      // Act + Assert — a clean AppError with the parse-failure code. The
      // error name must be AppError (not TypeError) — proves the Zod parse
      // intercepted the bad shape before `.map(...)` could blow up.
      const promise = transcribe(extractor, '/tmp/audio.mp3', 'dQw4w9WgXcQ');
      await expect(promise).rejects.toBeInstanceOf(AppError);
      await expect(promise).rejects.toMatchObject({ code: 'WHISPER_PARSE_FAILED' });
      await expect(promise).rejects.not.toBeInstanceOf(TypeError);
    });

    it('valid JSON with a non-numeric segment field → WHISPER_PARSE_FAILED', async () => {
      // Arrange — `start` is a string; the Zod schema requires a number.
      const proc = makeFakeProc();
      mockSpawn.mockReturnValueOnce(proc);
      const badPayload = JSON.stringify({
        text: 'bad segment',
        segments: [{ start: 'zero', end: 2, text: 'x' }],
        language: 'en',
      });
      driveClose(proc, { code: 0, stdout: wrapInMarkers(badPayload) });

      const extractor = new WhisperExtractor();

      // Act + Assert
      await expect(transcribe(extractor, '/tmp/audio.mp3', 'dQw4w9WgXcQ')).rejects.toMatchObject({
        code: 'WHISPER_PARSE_FAILED',
      });
    });
  });

  // ------------------------------------------------------------------------
  // Case 3 — JSON markers absent from stdout (exit 0 but no payload block).
  // ------------------------------------------------------------------------
  describe('transcribeAudio — missing JSON markers', () => {
    it('absent JSON_OUTPUT markers → WHISPER_PARSE_FAILED', async () => {
      // Arrange — process exits 0 but prints noise without the markers.
      const proc = makeFakeProc();
      mockSpawn.mockReturnValueOnce(proc);
      driveClose(proc, { code: 0, stdout: 'Loading model...\nDone, but no markers here.\n' });

      const extractor = new WhisperExtractor();

      // Act + Assert
      await expect(transcribe(extractor, '/tmp/audio.mp3', 'dQw4w9WgXcQ')).rejects.toMatchObject({
        code: 'WHISPER_PARSE_FAILED',
      });
    });
  });

  // ------------------------------------------------------------------------
  // Case 4 — non-zero exit code carries stderr into WHISPER_FAILED.
  // ------------------------------------------------------------------------
  describe('transcribeAudio — non-zero exit', () => {
    it('exit code 1 → WHISPER_FAILED carrying the stderr text', async () => {
      // Arrange — process writes to stderr then exits 1.
      const proc = makeFakeProc();
      mockSpawn.mockReturnValueOnce(proc);
      driveClose(proc, {
        code: 1,
        stderr: 'Traceback: ModuleNotFoundError: No module named whisper',
      });

      const extractor = new WhisperExtractor();

      // Act
      const promise = transcribe(extractor, '/tmp/audio.mp3', 'dQw4w9WgXcQ');

      // Assert — code + stderr propagated into the message.
      await expect(promise).rejects.toMatchObject({ code: 'WHISPER_FAILED' });
      await expect(promise).rejects.toThrow(/ModuleNotFoundError: No module named whisper/);
    });
  });

  // ------------------------------------------------------------------------
  // Case 5 — spawn 'error' (ENOENT) → PYTHON_NOT_FOUND + temp-script cleanup.
  // ------------------------------------------------------------------------
  describe('transcribeAudio — spawn error', () => {
    it("spawn 'error' (ENOENT) → PYTHON_NOT_FOUND and unlinks the temp script", async () => {
      // Arrange — the temp script was written, then spawn fails. The error
      // handler must clean the script up (existsSync true → unlinkSync).
      const proc = makeFakeProc();
      mockSpawn.mockReturnValueOnce(proc);
      const enoent = Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
      driveSpawnError(proc, enoent);

      const extractor = new WhisperExtractor();
      // The script path must report as existing so the cleanup branch runs.
      mockExistsSync.mockReturnValue(true);

      // Act
      const promise = transcribe(extractor, '/tmp/audio.mp3', 'dQw4w9WgXcQ');

      // Assert — typed PYTHON_NOT_FOUND, and the temp script was removed.
      await expect(promise).rejects.toMatchObject({ code: 'PYTHON_NOT_FOUND' });
      await expect(promise).rejects.toThrow(/Failed to spawn Python: spawn python ENOENT/);

      // The script was written once and unlinked once during cleanup.
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const unlinkTargets = mockUnlinkSync.mock.calls.map((c) => String(c[0]));
      expect(unlinkTargets.some((p) => p.includes('whisper_dQw4w9WgXcQ.py'))).toBe(true);
    });
  });
});

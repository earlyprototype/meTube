/**
 * Whisper-based transcript extraction via Python subprocess.
 *
 * Lifted from `src-ts/extractors/WhisperExtractor.ts` (v1) per PORT_PLAN
 * Wave 3 — KEEP-AS-IS in behaviour. The Python subprocess pattern is
 * preserved deliberately: Tier 3 / Phase 3 will replace the subprocess with
 * native `nodejs-whisper` bindings, and that work is out of v2's scope.
 *
 * Compared to v1 only one difference exists, and it is purely a type
 * discipline fix that does not change behaviour: the `seg-typed-as-any` cast in
 * `transcribeAudio` is replaced with a narrow `WhisperSegment` interface and
 * `unknown` narrowing. Runtime semantics are identical; the compiler now
 * knows the shape it is touching.
 *
 * The spawned Python (`legacy/python/src/extractors/whisper_extractor.py`)
 * carries the Phase 1 fixes for P3 + P4 (exception logging, temp-file
 * cleanup); no TS-side adjustment is needed for either.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { AppError } from '../errors/index.js';
import type { VideoId } from '../types/index.js';
import logger from '../utils/logger.js';

import type { TranscriptData } from './TranscriptExtractor.js';

/**
 * Progress callback for the long-running stages.
 */
export interface WhisperProgressCallback {
  (progress: {
    stage: 'downloading' | 'transcribing' | 'complete';
    percentage?: number;
    message?: string;
  }): void;
}

/**
 * Constructor configuration. All fields optional — sensible defaults match
 * the v1 behaviour and the Windows-first dev environment.
 */
export interface WhisperExtractorConfig {
  enabled?: boolean;
  model?: string; // tiny, base, small, medium, large
  audio_format?: string;
  temp_dir?: string;
  cleanup_audio?: boolean;
  python_path?: string;
  yt_dlp_path?: string;
  onProgress?: WhisperProgressCallback;
}

/**
 * Single segment returned by Whisper. The Python subprocess emits JSON with
 * `start` (seconds), `end` (seconds), and `text` (string); other Whisper
 * fields are present but unused.
 */
interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Whole JSON payload the subprocess prints between the JSON markers.
 */
interface WhisperPayload {
  text: string;
  segments: WhisperSegment[];
  language?: string;
}

/**
 * Zod schema mirroring `WhisperSegment`. Validates the subprocess output at
 * the wire boundary (v2 invariant #2) — a valid-JSON-but-malformed payload is
 * caught here and surfaces as `WHISPER_PARSE_FAILED` rather than a raw
 * TypeError on `.map(...)`.
 */
const whisperSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

/**
 * Zod schema mirroring `WhisperPayload`. The optional `language` mirrors the
 * interface; extra Whisper fields are tolerated (the subprocess emits more
 * than these three keys per segment, but only these are consumed).
 */
const whisperPayloadSchema = z.object({
  text: z.string(),
  segments: z.array(whisperSegmentSchema),
  language: z.string().optional(),
});

/**
 * Drives the Python `openai-whisper` subprocess. Single-video API
 * (`extract(videoId)`) — batch use is the caller's responsibility because
 * Whisper is heavy enough that serialised processing is the right default.
 */
export class WhisperExtractor {
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly tempDir: string;
  private readonly cleanupAudio: boolean;
  private readonly pythonPath: string;
  private readonly ytDlpPath: string;
  private readonly onProgress?: WhisperProgressCallback;
  private available: boolean | null = null;

  constructor(config: WhisperExtractorConfig = {}) {
    this.enabled = config.enabled ?? true;
    this.model = config.model ?? 'base';
    this.tempDir = config.temp_dir ?? path.join(os.tmpdir(), 'metube-whisper');
    this.cleanupAudio = config.cleanup_audio ?? true;
    this.onProgress = config.onProgress;

    // Auto-detect Python and yt-dlp paths (Windows-first; same default as v1).
    this.pythonPath =
      config.python_path ?? path.join(process.cwd(), 'venv', 'Scripts', 'python.exe');
    this.ytDlpPath = config.yt_dlp_path ?? 'yt-dlp';

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    logger.info(
      {
        enabled: this.enabled,
        model: this.model,
        tempDir: this.tempDir,
        pythonPath: this.pythonPath,
        hasProgressCallback: this.onProgress !== undefined,
      },
      'WhisperExtractor initialized'
    );
  }

  /**
   * Extract a transcript via Whisper. Returns `null` if disabled or
   * unavailable; never throws on per-video failures (logs + returns null).
   *
   * `videoId: VideoId` matches the v2 boundary invariant — the brand is
   * structurally a string so no runtime semantics change.
   *
   * @param videoId - Branded YouTube video ID.
   * @param onProgress - OPTIONAL per-call progress callback (ADDITIVE). When
   *   supplied it fires ALONGSIDE the constructor-level callback for this
   *   call only. This is the seam VideoExtractor uses to surface the live
   *   download / transcription percentage as `whisper_progress` events —
   *   the per-call callback is the natural place for it because the
   *   extractor is constructed once but each video wants its own stream.
   *   Omitting it preserves the prior single-callback behaviour exactly.
   */
  async extract(
    videoId: VideoId,
    onProgress?: WhisperProgressCallback
  ): Promise<TranscriptData | null> {
    if (!this.enabled) {
      logger.debug({ videoId }, 'Whisper extraction disabled');
      return null;
    }

    if (!this.isAvailable()) {
      logger.warn({ videoId, reason: this.getUnavailableReason() }, 'Whisper not available');
      return null;
    }

    // Effective callback fans out to BOTH the constructor-level callback (if
    // any) and the per-call one (if any). Either may be undefined; the helper
    // no-ops what isn't there. Built once per extract so the download /
    // transcribe stages share it.
    const emitProgress = this.makeProgressEmitter(onProgress);

    const audioPath = path.join(this.tempDir, `${videoId}.mp3`);

    try {
      logger.info({ videoId }, 'Downloading audio for Whisper transcription');
      emitProgress({
        stage: 'downloading',
        percentage: 0,
        message: 'Starting audio download...',
      });
      await this.downloadAudio(videoId, audioPath, emitProgress);

      logger.info({ videoId, model: this.model }, 'Transcribing audio with Whisper');
      emitProgress({
        stage: 'transcribing',
        percentage: 100,
        message: 'Transcribing with Whisper...',
      });
      const transcriptData = await this.transcribeAudio(audioPath, videoId);

      emitProgress({
        stage: 'complete',
        percentage: 100,
        message: 'Transcription complete',
      });

      return transcriptData;
    } catch (error) {
      logger.error(
        {
          videoId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Whisper extraction failed'
      );
      return null;
    } finally {
      if (this.cleanupAudio && fs.existsSync(audioPath)) {
        try {
          fs.unlinkSync(audioPath);
          logger.debug({ audioPath }, 'Cleaned up audio file');
        } catch (err) {
          logger.warn(
            {
              audioPath,
              err: err instanceof Error ? err.message : String(err),
            },
            'Failed to cleanup audio file'
          );
        }
      }
    }
  }

  /**
   * Combine the constructor-level callback and an optional per-call callback
   * into a single emitter. Either (or both) may be absent — the returned
   * function safely no-ops the missing one. The per-call callback fires
   * AFTER the constructor one so a per-video observer sees the latest state.
   */
  private makeProgressEmitter(
    perCall: WhisperProgressCallback | undefined
  ): (progress: Parameters<WhisperProgressCallback>[0]) => void {
    return (progress) => {
      // Guard EACH observer independently: a throwing progress callback (e.g.
      // a UI emitter that blows up mid-render) must NOT abort the whisper
      // extraction. Without this, an exception here bubbles to the outer catch,
      // the method returns null, and the transcript is lost — all because a
      // cosmetic progress observer threw. Log and swallow; never rethrow.
      if (this.onProgress) {
        try {
          this.onProgress(progress);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Whisper constructor onProgress callback threw; ignoring'
          );
        }
      }
      if (perCall) {
        try {
          perCall(progress);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Whisper per-call onProgress callback threw; ignoring'
          );
        }
      }
    };
  }

  /**
   * Run `yt-dlp` to download the audio track to `outputPath`.
   *
   * @param emitProgress - Fan-out progress emitter (constructor + per-call).
   *   yt-dlp's real download percentages (parsed from its stdout/stderr) are
   *   reported through this, throttled to every ~5% to avoid event spam.
   */
  private async downloadAudio(
    videoId: VideoId,
    outputPath: string,
    emitProgress: (progress: Parameters<WhisperProgressCallback>[0]) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '128K',
        '--newline',
        '-o',
        outputPath,
        `https://www.youtube.com/watch?v=${videoId}`,
      ];

      const proc = spawn(this.ytDlpPath, args);
      let stderr = '';
      let lastPercentage = 0;

      const reportDownload = (output: string): void => {
        const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (progressMatch) {
          const percentage = parseFloat(progressMatch[1]);
          if (percentage - lastPercentage >= 5 || percentage >= 99) {
            lastPercentage = percentage;
            emitProgress({
              stage: 'downloading',
              percentage,
              message: `Downloading audio ${percentage.toFixed(1)}%`,
            });
          }
        }
      };

      proc.stdout?.on('data', (data: Buffer) => {
        reportDownload(data.toString());
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        stderr += output;
        reportDownload(output);
      });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          emitProgress({
            stage: 'downloading',
            percentage: 100,
            message: 'Audio download complete',
          });
          resolve();
        } else {
          reject(
            new AppError(`yt-dlp failed: ${stderr}`, {
              code: 'AUDIO_DOWNLOAD_FAILED',
            })
          );
        }
      });

      proc.on('error', (err) => {
        reject(
          new AppError(`Failed to spawn yt-dlp: ${err.message}`, {
            code: 'YT_DLP_NOT_FOUND',
          })
        );
      });
    });
  }

  /**
   * Run the Python whisper subprocess on `audioPath`. The subprocess emits
   * JSON between the marker lines; this method extracts and parses it.
   */
  private async transcribeAudio(audioPath: string, videoId: VideoId): Promise<TranscriptData> {
    return new Promise((resolve, reject) => {
      const pythonScript = `
import sys
import json
sys.path.insert(0, '${process.cwd().replace(/\\/g, '/')}/legacy/python')
from src.extractors.whisper_extractor import WhisperTranscriptExtractor

config = {
    'extraction': {
        'whisper': {
            'model': '${this.model}',
            'temp_dir': '${this.tempDir.replace(/\\/g, '/')}'
        }
    }
}

extractor = WhisperTranscriptExtractor(config)
extractor._load_whisper()

result = extractor.model.transcribe('${audioPath.replace(/\\/g, '/')}')

output = {
    'text': result['text'],
    'segments': result['segments'],
    'language': result.get('language', 'en')
}

print('JSON_OUTPUT_START')
print(json.dumps(output))
print('JSON_OUTPUT_END')
`;

      const scriptPath = path.join(this.tempDir, `whisper_${videoId}.py`);
      fs.writeFileSync(scriptPath, pythonScript);

      const proc = spawn(this.pythonPath, [scriptPath]);
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (fs.existsSync(scriptPath)) {
          fs.unlinkSync(scriptPath);
        }

        if (code === 0) {
          try {
            const jsonMatch = stdout.match(/JSON_OUTPUT_START\s*\n([\s\S]*?)\nJSON_OUTPUT_END/);
            if (!jsonMatch) {
              throw new Error('JSON markers not found in output');
            }
            const parsedUnknown: unknown = JSON.parse(jsonMatch[1]);
            const payload: WhisperPayload = whisperPayloadSchema.parse(parsedUnknown);

            const segments = payload.segments.map((seg: WhisperSegment) => ({
              start: seg.start,
              duration: seg.end - seg.start,
              text: seg.text.trim(),
            }));

            const transcriptData: TranscriptData = {
              full_text: payload.text,
              segments,
              language: payload.language ?? 'en',
              is_auto_generated: false,
              from_whisper: true,
            };

            resolve(transcriptData);
          } catch (err) {
            reject(
              new AppError(`Failed to parse Whisper output: ${err}`, {
                code: 'WHISPER_PARSE_FAILED',
              })
            );
          }
        } else {
          reject(
            new AppError(`Whisper transcription failed: ${stderr}`, {
              code: 'WHISPER_FAILED',
            })
          );
        }
      });

      proc.on('error', (err) => {
        if (fs.existsSync(scriptPath)) {
          fs.unlinkSync(scriptPath);
        }
        reject(
          new AppError(`Failed to spawn Python: ${err.message}`, {
            code: 'PYTHON_NOT_FOUND',
          })
        );
      });
    });
  }

  /**
   * Probe whether the configured Python binary exists. Cached after first
   * call.
   */
  isAvailable(): boolean {
    if (this.available !== null) {
      return this.available;
    }

    if (!fs.existsSync(this.pythonPath)) {
      logger.warn({ pythonPath: this.pythonPath }, 'Python not found');
      this.available = false;
      return false;
    }

    this.available = true;
    return true;
  }

  /**
   * Human-readable reason why `isAvailable()` returned false.
   */
  getUnavailableReason(): string {
    if (!fs.existsSync(this.pythonPath)) {
      return `Python not found at: ${this.pythonPath}`;
    }
    return 'Whisper availability check not yet implemented';
  }
}

/**
 * Static check of Whisper availability, useful at startup.
 */
export function isWhisperAvailable(pythonPath?: string): boolean {
  const pyPath = pythonPath ?? path.join(process.cwd(), 'venv', 'Scripts', 'python.exe');
  return fs.existsSync(pyPath);
}

/**
 * Diagnostic snapshot for the Ink layer to display in `metube init`.
 */
export function getWhisperSetupStatus(): {
  pythonAvailable: boolean;
  ytDlpAvailable: boolean;
  recommendations: string[];
} {
  const pythonPath = path.join(process.cwd(), 'venv', 'Scripts', 'python.exe');
  const pythonAvailable = fs.existsSync(pythonPath);

  // No cheap way to probe yt-dlp without spawning; default optimistic.
  const ytDlpAvailable = true;

  const recommendations: string[] = [];
  if (!pythonAvailable) {
    recommendations.push('Create Python venv and install openai-whisper');
  }
  recommendations.push('Ensure yt-dlp is installed and in PATH');
  recommendations.push('Ensure FFmpeg is installed (required by yt-dlp)');

  return {
    pythonAvailable,
    ytDlpAvailable,
    recommendations,
  };
}

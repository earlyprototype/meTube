/**
 * Whisper-based transcript extraction
 * Uses Python's openai-whisper via subprocess
 * Downloads audio with yt-dlp and transcribes locally
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../utils/logger.js';
import { AppError } from '../errors/index.js';
import type { TranscriptData } from './TranscriptExtractor.js';

/**
 * Progress callback for Whisper extraction
 */
export interface WhisperProgressCallback {
  (progress: {
    stage: 'downloading' | 'transcribing' | 'complete';
    percentage?: number;
    message?: string;
  }): void;
}

/**
 * Configuration for Whisper extractor
 */
export interface WhisperExtractorConfig {
  enabled?: boolean;
  model?: string; // tiny, base, small, medium, large
  audio_format?: string;
  temp_dir?: string;
  cleanup_audio?: boolean;
  python_path?: string; // Path to Python executable with whisper installed
  yt_dlp_path?: string; // Path to yt-dlp executable
  onProgress?: WhisperProgressCallback;
}

/**
 * WhisperExtractor class using Python's openai-whisper
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

  /**
   * Create a new WhisperExtractor instance
   *
   * @param config - Configuration object
   */
  constructor(config: WhisperExtractorConfig = {}) {
    this.enabled = config.enabled ?? true;
    this.model = config.model || 'base'; // base is good balance of speed/accuracy
    this.tempDir = config.temp_dir || path.join(os.tmpdir(), 'metube-whisper');
    this.cleanupAudio = config.cleanup_audio ?? true;
    this.onProgress = config.onProgress;

    // Auto-detect Python and yt-dlp paths (Windows-specific for now)
    this.pythonPath =
      config.python_path || path.join(process.cwd(), 'venv', 'Scripts', 'python.exe');
    this.ytDlpPath = config.yt_dlp_path || 'yt-dlp';

    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    logger.info(
      {
        enabled: this.enabled,
        model: this.model,
        tempDir: this.tempDir,
        pythonPath: this.pythonPath,
        hasProgressCallback: !!this.onProgress,
      },
      'WhisperExtractor initialized'
    );
  }

  /**
   * Extract transcript using Whisper
   *
   * @param videoId - YouTube video ID
   * @returns Transcript data or null if extraction fails
   */
  async extract(videoId: string): Promise<TranscriptData | null> {
    if (!this.enabled) {
      logger.debug({ videoId }, 'Whisper extraction disabled');
      return null;
    }

    if (!this.isAvailable()) {
      logger.warn(
        {
          videoId,
          reason: this.getUnavailableReason(),
        },
        'Whisper not available'
      );
      return null;
    }

    const audioPath = path.join(this.tempDir, `${videoId}.mp3`);

    try {
      // Step 1: Download audio
      logger.info({ videoId }, 'Downloading audio for Whisper transcription');
      if (this.onProgress) {
        this.onProgress({
          stage: 'downloading',
          percentage: 0,
          message: 'Starting audio download...',
        });
      }
      await this.downloadAudio(videoId, audioPath);

      // Step 2: Transcribe with Whisper
      logger.info({ videoId, model: this.model }, 'Transcribing audio with Whisper');
      if (this.onProgress) {
        this.onProgress({
          stage: 'transcribing',
          percentage: 100,
          message: 'Transcribing with Whisper...',
        });
      }
      const transcriptData = await this.transcribeAudio(audioPath, videoId);

      if (this.onProgress) {
        this.onProgress({ stage: 'complete', percentage: 100, message: 'Transcription complete' });
      }

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
      // Cleanup audio file
      if (this.cleanupAudio && fs.existsSync(audioPath)) {
        try {
          fs.unlinkSync(audioPath);
          logger.debug({ audioPath }, 'Cleaned up audio file');
        } catch (err) {
          logger.warn({ audioPath }, 'Failed to cleanup audio file');
        }
      }
    }
  }

  /**
   * Download audio from YouTube video
   */
  private async downloadAudio(videoId: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-x', // Extract audio
        '--audio-format',
        'mp3',
        '--audio-quality',
        '128K',
        '--newline', // Output progress on new lines for easier parsing
        '-o',
        outputPath,
        `https://www.youtube.com/watch?v=${videoId}`,
      ];

      const proc = spawn(this.ytDlpPath, args);
      let stderr = '';
      let lastPercentage = 0;

      proc.stdout?.on('data', (data) => {
        const output = data.toString();

        // Parse yt-dlp progress output: [download]  XX.X% of ...
        const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (progressMatch && this.onProgress) {
          const percentage = parseFloat(progressMatch[1]);
          // Only report every 5% to avoid too many updates
          if (percentage - lastPercentage >= 5 || percentage >= 99) {
            lastPercentage = percentage;
            this.onProgress({
              stage: 'downloading',
              percentage,
              message: `Downloading audio ${percentage.toFixed(1)}%`,
            });
          }
        }
      });

      proc.stderr?.on('data', (data) => {
        const output = data.toString();
        stderr += output;

        // yt-dlp sometimes outputs progress to stderr
        const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (progressMatch && this.onProgress) {
          const percentage = parseFloat(progressMatch[1]);
          if (percentage - lastPercentage >= 5 || percentage >= 99) {
            lastPercentage = percentage;
            this.onProgress({
              stage: 'downloading',
              percentage,
              message: `Downloading audio ${percentage.toFixed(1)}%`,
            });
          }
        }
      });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          if (this.onProgress) {
            this.onProgress({
              stage: 'downloading',
              percentage: 100,
              message: 'Audio download complete',
            });
          }
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
   * Transcribe audio file using existing Python Whisper code
   * Calls the original Python whisper_extractor.py directly
   */
  private async transcribeAudio(audioPath: string, videoId: string): Promise<TranscriptData> {
    return new Promise((resolve, reject) => {
      // Use the existing Python whisper implementation
      // Create a simple Python script that uses the existing code
      const pythonScript = `
import sys
import json
sys.path.insert(0, '${process.cwd().replace(/\\/g, '/')}')
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

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        // Cleanup script
        if (fs.existsSync(scriptPath)) {
          fs.unlinkSync(scriptPath);
        }

        if (code === 0) {
          try {
            // Extract JSON from stdout (between markers)
            const jsonMatch = stdout.match(/JSON_OUTPUT_START\s*\n([\s\S]*?)\nJSON_OUTPUT_END/);
            if (!jsonMatch) {
              throw new Error('JSON markers not found in output');
            }
            const jsonData = JSON.parse(jsonMatch[1]);

            // Convert Whisper format to our format
            const segments = jsonData.segments.map((seg: any) => ({
              start: seg.start,
              duration: seg.end - seg.start,
              text: seg.text.trim(),
            }));

            const transcriptData: TranscriptData = {
              full_text: jsonData.text,
              segments,
              language: jsonData.language || 'en',
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
        // Cleanup script on error
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
   * Check if Whisper is available
   */
  isAvailable(): boolean {
    if (this.available !== null) {
      return this.available;
    }

    // Check if Python exists
    if (!fs.existsSync(this.pythonPath)) {
      logger.warn({ pythonPath: this.pythonPath }, 'Python not found');
      this.available = false;
      return false;
    }

    // Assume whisper is available if Python exists
    // (More thorough check would test import whisper)
    this.available = true;
    return true;
  }

  /**
   * Get information about why Whisper is not available
   */
  getUnavailableReason(): string {
    if (!fs.existsSync(this.pythonPath)) {
      return `Python not found at: ${this.pythonPath}`;
    }
    return 'Whisper availability check not yet implemented';
  }
}

/**
 * Check if Whisper dependencies are available
 */
export function isWhisperAvailable(pythonPath?: string): boolean {
  const pyPath = pythonPath || path.join(process.cwd(), 'venv', 'Scripts', 'python.exe');
  return fs.existsSync(pyPath);
}

/**
 * Get setup status information
 */
export function getWhisperSetupStatus(): {
  pythonAvailable: boolean;
  ytDlpAvailable: boolean;
  recommendations: string[];
} {
  const pythonPath = path.join(process.cwd(), 'venv', 'Scripts', 'python.exe');
  const pythonAvailable = fs.existsSync(pythonPath);

  // Assume yt-dlp is available if in PATH (simple check)
  const ytDlpAvailable = true; // Can't easily check without spawning

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

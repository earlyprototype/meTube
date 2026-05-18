/**
 * Configuration loader for MeTube
 * Loads config.yaml and substitutes environment variables
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export interface MeTubeConfig {
  api: {
    youtube_credentials: string;
    token_file: string;
    gemini_api_key?: string;
    gemini_model: string;
    rate_limit_delay: number;
  };
  database: {
    path: string;
  };
  extraction: {
    auto_transcript: boolean;
    auto_llm_parse: boolean;
    filter_shorts_only: boolean;
    languages: string[];
    whisper?: {
      enabled: boolean;
      model: string;
      audio_format: string;
      temp_dir: string;
      cleanup_audio: boolean;
    };
  };
  reports: {
    output_dir: string;
  };
}

// Default configuration
const DEFAULT_CONFIG: MeTubeConfig = {
  api: {
    youtube_credentials: 'client_secret.json',
    token_file: 'token.json',
    gemini_api_key: process.env.GEMINI_API_KEY,
    gemini_model: 'gemini-3-flash-preview',
    rate_limit_delay: 0.3,
  },
  database: {
    path: process.env.DATABASE_PATH || 'data/metube.db',
  },
  extraction: {
    auto_transcript: true,
    auto_llm_parse: true,
    filter_shorts_only: false,
    languages: ['en', 'en-GB', 'en-US'],
    whisper: {
      enabled: false,
      model: 'base',
      audio_format: 'm4a',
      temp_dir: 'data/temp_audio/',
      cleanup_audio: true,
    },
  },
  reports: {
    output_dir: process.env.REPORTS_DIR || 'reports/',
  },
};

/**
 * Recursively substitute ${VAR_NAME} with environment variable values.
 * Mirrors legacy/python/src/cli.py:184-208.
 * - Strings: replace ${VAR_NAME} with process.env.VAR_NAME; if undefined, leave literal
 * - Arrays: recursively substitute each element
 * - Objects: recursively substitute each value
 * - Other types: return as-is
 */
function substituteEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    // Match ${VAR_NAME} pattern
    const pattern = /\$\{([^}]+)\}/g;
    return value.replace(pattern, (match, varName: string) => {
      const envValue = process.env[varName];
      return envValue !== undefined ? envValue : match;
    });
  } else if (Array.isArray(value)) {
    return value.map((item) => substituteEnvVars(item));
  } else if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteEnvVars(val);
    }
    return result;
  }
  return value;
}

/**
 * Deep merge two objects. `source` overrides `target` on collision;
 * nested objects are recursively merged, arrays are replaced wholesale.
 */
function deepMerge<T extends object>(target: T, source: object): T {
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };

  for (const key of Object.keys(source)) {
    const sourceVal = (source as Record<string, unknown>)[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result as T;
}

/**
 * Load configuration from config.yaml or use defaults
 */
export function loadConfig(): MeTubeConfig {
  const configPath = path.join(process.cwd(), 'config', 'config.yaml');
  
  if (fs.existsSync(configPath)) {
    try {
      const fileContents = fs.readFileSync(configPath, 'utf8');
      const loadedConfig = yaml.load(fileContents) as Partial<MeTubeConfig>;
      
      // Merge with defaults
      const merged = deepMerge(DEFAULT_CONFIG, loadedConfig);
      
      // Substitute environment variables
      return substituteEnvVars(merged) as MeTubeConfig;
    } catch (error) {
      console.error(`Error loading config file: ${error}`);
      return DEFAULT_CONFIG;
    }
  }
  
  return DEFAULT_CONFIG;
}

/**
 * Get a specific config value by dotted path (e.g., 'api.gemini_api_key').
 * Returns `unknown` — callers must narrow before use.
 */
export function getConfigValue(configPath: string): unknown {
  const config = loadConfig();
  const keys = configPath.split('.');
  let value: unknown = config;

  for (const key of keys) {
    if (value !== null && typeof value === 'object') {
      value = (value as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return value;
}

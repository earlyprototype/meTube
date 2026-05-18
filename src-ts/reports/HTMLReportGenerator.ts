/**
 * HTML Report Generator using Handlebars templates
 * Generates comprehensive reports for videos and playlists
 */

import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import open from 'open';
import { DatabaseManager } from '../database/connection.js';
import {
  VideoRepository,
  PlaylistRepository,
  TranscriptRepository,
  EntityRepository,
  StatisticsRepository,
} from '../database/repositories.js';
import type {
  VideoReportData,
  CompletePlaylistReportData,
  ReportVideoData,
  ReportTranscriptData,
  ReportEntities,
  ReportAnalysisData,
  PlaylistVideoSummary,
  AggregatedTopic,
  AggregatedEntity,
  AggregatedPerson,
} from './types.js';
import logger from '../utils/logger.js';
import { ValidationError, AppError } from '../errors/index.js';

/**
 * Configuration for HTML report generator
 */
export interface HTMLReportGeneratorConfig {
  templateDir?: string;
  outputDir?: string;
  autoOpen?: boolean;
}

/**
 * HTML Report Generator
 */
export class HTMLReportGenerator {
  private readonly db: DatabaseManager;
  private readonly templateDir: string;
  private readonly outputDir: string;
  private readonly autoOpen: boolean;
  private readonly videoRepository: VideoRepository;
  private readonly playlistRepository: PlaylistRepository;
  private readonly transcriptRepository: TranscriptRepository;
  private readonly entityRepository: EntityRepository;
  private readonly statisticsRepository: StatisticsRepository;
  private videoTemplate?: HandlebarsTemplateDelegate;
  private playlistTemplate?: HandlebarsTemplateDelegate;

  constructor(db: DatabaseManager, config: HTMLReportGeneratorConfig = {}) {
    this.db = db;
    this.templateDir = config.templateDir || 'templates';
    this.outputDir = config.outputDir || 'reports';
    this.autoOpen = config.autoOpen ?? true;

    // Initialize repositories
    this.videoRepository = new VideoRepository(db);
    this.playlistRepository = new PlaylistRepository(db);
    this.transcriptRepository = new TranscriptRepository(db);
    this.entityRepository = new EntityRepository(db);
    this.statisticsRepository = new StatisticsRepository(db);

    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    // Register Handlebars helpers
    this.registerHelpers();

    logger.info({
      templateDir: this.templateDir,
      outputDir: this.outputDir,
      autoOpen: this.autoOpen,
    }, 'HTMLReportGenerator initialized');
  }

  /**
   * Register Handlebars helpers
   */
  private registerHelpers(): void {
    // Format number with commas
    Handlebars.registerHelper('formatNumber', (num: number) => {
      if (!num) return '0';
      return num.toLocaleString();
    });

    // Format date
    Handlebars.registerHelper('formatDate', (dateStr: string) => {
      if (!dateStr) return 'Unknown';
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-GB', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    });

    // Equality comparison for templates
    Handlebars.registerHelper('ifEquals', function (this: any, arg1: any, arg2: any, options: any) {
      return arg1 === arg2 ? options.fn(this) : options.inverse(this);
    });

    // Greater than comparison
    Handlebars.registerHelper('ifGreater', function (this: any, arg1: number, arg2: number, options: any) {
      return arg1 > arg2 ? options.fn(this) : options.inverse(this);
    });

    // Array/object length helper for templates
    Handlebars.registerHelper('length', (value: any) => {
      if (Array.isArray(value)) return value.length;
      if (value && typeof value === 'object') return Object.keys(value).length;
      return 0;
    });

    // Increment helper for loop indices
    Handlebars.registerHelper('inc', (value: number) => {
      return value + 1;
    });
  }

  /**
   * Load and compile template
   */
  private loadTemplate(templateName: string): HandlebarsTemplateDelegate {
    const templatePath = path.join(this.templateDir, `${templateName}.html`);
    
    if (!fs.existsSync(templatePath)) {
      throw new AppError(`Template not found: ${templatePath}`, {
        code: 'TEMPLATE_NOT_FOUND',
      });
    }

    const templateSource = fs.readFileSync(templatePath, 'utf-8');
    return Handlebars.compile(templateSource);
  }

  /**
   * Generate video report
   */
  async generateVideoReport(videoId: string, options: { autoOpen?: boolean } = {}): Promise<string> {
    if (!videoId || typeof videoId !== 'string') {
      throw new ValidationError('videoId must be a non-empty string');
    }

    logger.info({ videoId }, 'Generating video report');

    try {
      // Gather video data
      const video = this.videoRepository.getByVideoId(videoId);
      if (!video) {
        throw new ValidationError(`Video not found: ${videoId}`);
      }

      // Get transcript
      const transcriptData = this.getTranscriptData(videoId);

      // Get entities
      const entities = this.getEntitiesData(videoId);

      // Get statistics
      const stats = this.statisticsRepository.getLatest(videoId);

      // Get AI analysis (if exists)
      const analysis = this.getAnalysisData(videoId);

      // Prepare report data
      const reportData: VideoReportData = {
        video: {
          video_id: video.video_id,
          title: video.title,
          description: video.description,
          channel_title: video.channel_title,
          channel_id: video.channel_id,
          published_at: video.published_at,
          duration_seconds: video.duration_seconds,
          is_short: video.is_short,
          view_count: stats?.view_count || 0,
          like_count: stats?.like_count || 0,
          comment_count: stats?.comment_count || 0,
          thumbnail_url: this.getThumbnailUrl(videoId),
        },
        transcript: transcriptData,
        entities,
        tags: [], // Tags would come from video.tags if available
        analysis,
        generated_at: new Date().toISOString(),
      };

      // Load template if not cached
      if (!this.videoTemplate) {
        this.videoTemplate = this.loadTemplate('video_report');
      }

      // Render template
      const html = this.videoTemplate(reportData);

      // Generate filename
      const safeTitle = this.sanitizeFilename(video.title);
      const filename = `${videoId}_${safeTitle}.html`;
      const filepath = path.join(this.outputDir, filename);

      // Write file
      fs.writeFileSync(filepath, html, 'utf-8');

      logger.info({ filepath }, 'Video report generated');

      // Auto-open if requested
      const shouldOpen = options.autoOpen ?? this.autoOpen;
      if (shouldOpen) {
        await this.openInBrowser(filepath);
      }

      return filepath;
    } catch (error) {
      logger.error({
        videoId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to generate video report');
      throw error;
    }
  }

  /**
   * Generate playlist report
   */
  async generatePlaylistReport(playlistId: string, options: { autoOpen?: boolean } = {}): Promise<string> {
    if (!playlistId || typeof playlistId !== 'string') {
      throw new ValidationError('playlistId must be a non-empty string');
    }

    logger.info({ playlistId }, 'Generating playlist report');

    try {
      // Get playlist
      const playlist = this.playlistRepository.getById(playlistId);
      if (!playlist) {
        throw new ValidationError(`Playlist not found: ${playlistId}`);
      }

      // Get all videos in playlist
      const videos = this.videoRepository.getByPlaylist(playlistId);
      if (videos.length === 0) {
        throw new ValidationError('No videos found in playlist');
      }

      // Aggregate data (async — enriches repos with GitHub descriptions)
      const aggregatedData = await this.aggregatePlaylistData(playlistId, videos);

      // Load template if not cached
      if (!this.playlistTemplate) {
        this.playlistTemplate = this.loadTemplate('playlist_report');
      }

      // Render template
      const html = this.playlistTemplate(aggregatedData);

      // Generate filename
      const safeTitle = this.sanitizeFilename(playlist.title);
      const filename = `playlist_${playlistId}_${safeTitle}.html`;
      const filepath = path.join(this.outputDir, filename);

      // Write file
      fs.writeFileSync(filepath, html, 'utf-8');

      logger.info({ filepath }, 'Playlist report generated');

      // Auto-open if requested
      const shouldOpen = options.autoOpen ?? this.autoOpen;
      if (shouldOpen) {
        await this.openInBrowser(filepath);
      }

      return filepath;
    } catch (error) {
      logger.error({
        playlistId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to generate playlist report');
      throw error;
    }
  }

  /**
   * Get transcript data for report
   */
  private getTranscriptData(videoId: string): ReportTranscriptData | undefined {
    const transcript = this.transcriptRepository.getByVideoId(videoId);
    if (!transcript) return undefined;

    let segments = [];
    try {
      if (transcript.segments_json) {
        const parsedSegments = JSON.parse(transcript.segments_json);
        segments = parsedSegments.map((seg: any) => ({
          start: seg.start,
          timestamp: this.formatTimestamp(seg.start),
          text: seg.text,
        }));
      }
    } catch (error) {
      logger.warn({ videoId }, 'Failed to parse transcript segments');
    }

    return {
      language: transcript.language,
      is_auto_generated: transcript.is_auto_generated,
      full_text: transcript.full_text,
      segments,
      word_count: transcript.full_text.split(/\s+/).filter(w => w).length,
    };
  }

  /**
   * Get entities data for report
   */
  private getEntitiesData(videoId: string): ReportEntities {
    const entities = this.entityRepository.getByVideo(videoId);

    const grouped: ReportEntities = {
      topics: [],
      github_repos: [],
      websites: [],
      people: [],
    };

    for (const entity of entities) {
      switch (entity.entity_type) {
        case 'topic':
          grouped.topics.push(entity.entity_value);
          break;
        case 'github_repo':
          grouped.github_repos.push({
            name: entity.entity_value,
            url: entity.entity_url,
          });
          break;
        case 'website':
          grouped.websites.push({
            name: entity.entity_value,
            url: entity.entity_url,
          });
          break;
        case 'person':
          grouped.people.push(entity.entity_value);
          break;
      }
    }

    return grouped;
  }

  /**
   * Get AI analysis data (stub for now - would query ai_analysis table)
   */
  private getAnalysisData(videoId: string): ReportAnalysisData | undefined {
    // TODO: Query ai_analysis table when it's populated
    return undefined;
  }

  /**
   * Narrow an unknown fetch JSON payload to a GitHub repo API response shape.
   */
  private isGitHubRepoResponse(value: unknown): value is { description: string | null } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'description' in value &&
      (typeof (value as Record<string, unknown>)['description'] === 'string' ||
        (value as Record<string, unknown>)['description'] === null)
    );
  }

  /**
   * Fetch the GitHub description for a repo URL.
   * Returns undefined on any non-200 response or thrown error.
   */
  private async _fetchGitHubDescription(repoUrl: string): Promise<string | undefined> {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
    if (!match) return undefined;

    const [, owner, repo] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;

    try {
      const response = await fetch(apiUrl, {
        headers: { Accept: 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return undefined;

      const data: unknown = await response.json();
      if (this.isGitHubRepoResponse(data) && typeof data.description === 'string') {
        return data.description;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Aggregate playlist data for report
   */
  private async aggregatePlaylistData(playlistId: string, videos: any[]): Promise<CompletePlaylistReportData> {
    const playlist = this.playlistRepository.getById(playlistId)!;

    // Aggregate statistics
    let totalDuration = 0;
    let totalViews = 0;
    let videosWithTranscripts = 0;

    // Track entities across all videos
    const topicsMap = new Map<string, { count: number; videos: Array<{ video_id: string; title: string }> }>();
    const reposMap = new Map<string, { name: string; url?: string; videos: Array<{ video_id: string; title: string }> }>();
    const websitesMap = new Map<string, { name: string; url?: string; videos: Array<{ video_id: string; title: string }> }>();
    const peopleMap = new Map<string, { count: number; videos: Array<{ video_id: string; title: string }> }>();

    const videoSummaries: PlaylistVideoSummary[] = [];

    for (const video of videos) {
      totalDuration += video.duration_seconds || 0;

      // Get statistics
      const stats = this.statisticsRepository.getLatest(video.video_id);
      if (stats) {
        totalViews += stats.view_count || 0;
      }

      // Check transcript
      const hasTranscript = this.transcriptRepository.exists(video.video_id);
      if (hasTranscript) {
        videosWithTranscripts++;
      }

      // Get entities for this video
      const entities = this.entityRepository.getByVideo(video.video_id);

      // Aggregate entities
      const videoRef = { video_id: video.video_id, title: video.title };

      for (const entity of entities) {
        switch (entity.entity_type) {
          case 'topic':
            const topicKey = entity.entity_value.toLowerCase();
            if (!topicsMap.has(topicKey)) {
              topicsMap.set(topicKey, { count: 0, videos: [] });
            }
            const topic = topicsMap.get(topicKey)!;
            topic.count++;
            topic.videos.push(videoRef);
            break;

          case 'github_repo':
            const repoKey = entity.entity_url || entity.entity_value;
            if (!reposMap.has(repoKey)) {
              reposMap.set(repoKey, { name: entity.entity_value, url: entity.entity_url, videos: [] });
            }
            reposMap.get(repoKey)!.videos.push(videoRef);
            break;

          case 'website':
            const siteKey = entity.entity_url || entity.entity_value;
            if (!websitesMap.has(siteKey)) {
              websitesMap.set(siteKey, { name: entity.entity_value, url: entity.entity_url, videos: [] });
            }
            websitesMap.get(siteKey)!.videos.push(videoRef);
            break;

          case 'person':
            const personKey = entity.entity_value.toLowerCase();
            if (!peopleMap.has(personKey)) {
              peopleMap.set(personKey, { count: 0, videos: [] });
            }
            const person = peopleMap.get(personKey)!;
            person.count++;
            person.videos.push(videoRef);
            break;
        }
      }

      // Add to video summaries
      videoSummaries.push({
        video_id: video.video_id,
        title: video.title,
        channel_title: video.channel_title,
        published_at: video.published_at,
        duration_seconds: video.duration_seconds,
        view_count: stats?.view_count || 0,
        like_count: stats?.like_count || 0,
        has_transcript: hasTranscript,
        thumbnail_url: this.getThumbnailUrl(video.video_id),
        summary: undefined, // Would come from AI analysis
        topics: entities.filter(e => e.entity_type === 'topic').map(e => e.entity_value),
      });
    }

    // Sort aggregated data
    const topTopics: AggregatedTopic[] = Array.from(topicsMap.entries())
      .map(([topicKey, data]) => ({ name: topicKey, count: data.count, videos: data.videos }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const githubRepos: AggregatedEntity[] = Array.from(reposMap.values())
      .sort((a, b) => b.videos.length - a.videos.length);

    // Enrich each GitHub repo with its description from api.github.com.
    // Sequential loop with 100ms throttle between request starts — matches
    // the Python legacy behaviour (html_generator.py:409-416).
    for (let i = 0; i < githubRepos.length; i++) {
      if (i > 0) {
        await new Promise<void>(r => setTimeout(r, 100));
      }
      const repo = githubRepos[i];
      if (repo.url) {
        const description = await this._fetchGitHubDescription(repo.url);
        if (description !== undefined) {
          githubRepos[i] = { ...repo, description };
        }
      }
    }

    const websites: AggregatedEntity[] = Array.from(websitesMap.values())
      .sort((a, b) => b.videos.length - a.videos.length);

    const people: AggregatedPerson[] = Array.from(peopleMap.entries())
      .map(([name, data]) => ({ name, count: data.count, videos: data.videos }))
      .sort((a, b) => b.count - a.count);

    // Format duration
    const hours = Math.floor(totalDuration / 3600);
    const minutes = Math.floor((totalDuration % 3600) / 60);
    const durationFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    return {
      playlist: {
        playlist_id: playlistId,
        title: playlist.title,
        description: playlist.description,
        video_count: videos.length,
        total_duration: durationFormatted,
        total_views: totalViews.toLocaleString(),
        videos_with_transcripts: videosWithTranscripts,
        transcript_percentage: Math.round((videosWithTranscripts / videos.length) * 100),
      },
      stats: {
        total_topics: topicsMap.size,
        total_repos: reposMap.size,
        total_websites: websitesMap.size,
        total_people: peopleMap.size,
      },
      videos: videoSummaries,
      top_topics: topTopics,
      github_repos: githubRepos,
      websites,
      people,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Format timestamp (seconds to MM:SS or HH:MM:SS)
   */
  private formatTimestamp(seconds: number): string {
    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Get YouTube thumbnail URL
   */
  private getThumbnailUrl(videoId: string, quality: string = 'maxresdefault'): string {
    return `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
  }

  /**
   * Sanitize filename
   */
  private sanitizeFilename(filename: string, maxLength: number = 50): string {
    const validChars = /[^a-zA-Z0-9\-_.() ]/g;
    let sanitized = filename.replace(validChars, '_');
    
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength);
    }
    
    return sanitized.trim().replace(/^_+|_+$/g, '');
  }

  /**
   * Open file in browser
   */
  private async openInBrowser(filepath: string): Promise<void> {
    try {
      await open(filepath);
      logger.info({ filepath }, 'Opened report in browser');
    } catch (error) {
      logger.warn({
        filepath,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to open report in browser');
    }
  }
}

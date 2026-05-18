/**
 * Manual test script for Phase 4 extraction pipeline
 * Tests end-to-end video extraction with real YouTube API
 *
 * Usage:
 *   npx tsx src-ts/extractors/manual-extraction-test.ts [videoId]
 *
 * Example:
 *   npx tsx src-ts/extractors/manual-extraction-test.ts dQw4w9WgXcQ
 */

import { YouTubeAuth } from '../auth/YouTubeAuth.js';
import { YouTubeClient } from '../api/YouTubeClient.js';
import { DatabaseManager } from '../database/connection.js';
import { VideoExtractor } from './VideoExtractor.js';
import { VideoRepository } from '../database/repositories.js';
import logger from '../utils/logger.js';
import * as path from 'path';
import * as fs from 'fs';

// Test video IDs (known good videos)
const DEFAULT_VIDEO_ID = 'dQw4w9WgXcQ'; // Rick Astley - Never Gonna Give You Up
const TEST_VIDEO_IDS = [
  'dQw4w9WgXcQ', // Rick Astley (music video with transcript)
  'jNQXAC9IVRw', // Me at the zoo (first YouTube video)
];

async function main() {
  console.log('\n=== Phase 4 Manual Extraction Test ===\n');

  // Get video ID from command line or use default
  const videoId = process.argv[2] || DEFAULT_VIDEO_ID;

  console.log(`Video ID: ${videoId}\n`);

  try {
    // Step 1: Initialize and authenticate
    console.log('[1/6] Authenticating with YouTube...');
    const auth = new YouTubeAuth();

    // Authenticate (auto-refreshes or prompts for login)
    const authenticated = await auth.authenticate();

    if (!authenticated) {
      console.log('\n❌ Authentication failed.\n');
      process.exit(1);
    }

    console.log('✅ Authenticated\n');

    // Step 2: Initialize YouTubeClient
    console.log('[2/6] Initializing YouTubeClient...');
    const client = new YouTubeClient(auth);
    console.log('✅ YouTubeClient ready\n');

    // Step 3: Initialize Database
    console.log('[3/6] Initializing Database...');
    const dbPath = path.join(process.cwd(), 'data', 'metube.db');

    // Check if database exists
    if (!fs.existsSync(dbPath)) {
      console.log('\n❌ Database not found at:', dbPath);
      console.log('\nPlease ensure the database exists. You may need to run Phase 2 initialization.\n');
      process.exit(1);
    }

    const db = new DatabaseManager(dbPath);
    db.getConnection(); // Ensure connection is established
    console.log('✅ Database connected\n');

    // Step 4: Initialize VideoExtractor
    console.log('[4/6] Initializing VideoExtractor...');
    const extractor = new VideoExtractor(client, db, {
      autoTranscript: true,
      autoLlmParse: false, // Disable LLM for basic test (requires API key)
      transcriptRateLimit: 2000,
      enableWhisper: true, // Enable Whisper fallback
    });
    console.log('✅ VideoExtractor ready\n');

    // Step 5: Extract video
    console.log(`[5/6] Extracting video: ${videoId}...`);
    console.log('---');

    const result = await extractor.extractSingleVideo(videoId);

    if (!result) {
      console.log('\n❌ Extraction failed - no result returned\n');
      process.exit(1);
    }

    console.log('---');
    console.log('✅ Extraction complete\n');

    // Step 6: Display results
    console.log('[6/6] Extraction Results:\n');

    console.log('📹 Video Metadata:');
    console.log(`  Title: ${result.videoData.title || 'N/A'}`);
    console.log(`  Channel: ${result.videoData.channelTitle || result.videoData.channel_title || 'N/A'}`);
    console.log(`  Duration: ${result.videoData.duration || 'N/A'}`);
    console.log(`  Views: ${result.videoData.viewCount?.toLocaleString() || result.videoData.view_count?.toLocaleString() || 'N/A'}`);
    console.log(`  Likes: ${result.videoData.likeCount?.toLocaleString() || result.videoData.like_count?.toLocaleString() || 'N/A'}`);
    console.log(`  Published: ${result.videoData.publishedAt || result.videoData.published_at || 'N/A'}\n`);

    console.log('📝 Transcript:');
    if (result.transcriptData) {
      const stats = {
        length: result.transcriptData.full_text.length,
        segments: result.transcriptData.segments.length,
        language: result.transcriptData.language,
        source: result.transcriptData.from_whisper ? 'Whisper' : 'YouTube',
      };
      console.log(`  Length: ${stats.length} characters`);
      console.log(`  Segments: ${stats.segments}`);
      console.log(`  Language: ${stats.language}`);
      console.log(`  Source: ${stats.source}`);
      console.log(`  Preview: ${result.transcriptData.full_text.substring(0, 100)}...\n`);
    } else {
      console.log('  ❌ No transcript available\n');
    }

    console.log('🔍 LLM Parsing:');
    if (result.parsedEntities) {
      console.log(`  Topics: ${result.parsedEntities.topics.length}`);
      console.log(`  GitHub Repos: ${result.parsedEntities.github_repos.length}`);
      console.log(`  Websites: ${result.parsedEntities.websites.length}`);
      console.log(`  People: ${result.parsedEntities.people.length}`);
      console.log(`  Summary: ${result.parsedEntities.summary.substring(0, 100)}...\n`);
    } else {
      console.log('  ℹ️  LLM parsing disabled (no Gemini API key)\n');
    }

    // Verify data in database
    console.log('💾 Database Verification:');
    const videoRepo = new VideoRepository(db);
    const savedVideo = videoRepo.getByVideoId(videoId);
    if (savedVideo) {
      console.log('  ✅ Video saved to database');
      console.log(`     ID: ${savedVideo.id}`);
      console.log(`     Title: ${savedVideo.title}`);
    } else {
      console.log('  ❌ Video not found in database');
    }

    console.log('\n=== Test Complete ===\n');
    console.log('✅ All extraction steps completed successfully!');
    console.log('\nNext steps:');
    console.log('  1. Review the extracted data above');
    console.log('  2. Check the database for saved records');
    console.log('  3. Try extracting other videos: npx tsx src-ts/extractors/manual-extraction-test.ts [videoId]');
    console.log('  4. Document results in PHASE_4_MANUAL_VERIFICATION.md\n');

    // Close database
    db.close();
  } catch (error) {
    console.error('\n❌ Error during extraction:', error);

    if (error instanceof Error) {
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);
    }

    process.exit(1);
  }
}

// Run the test
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

/**
 * Phase 4 Manual Test: Whisper Transcription
 * 
 * This test selects one video from playlist 7 and transcribes it with Whisper
 */

import { WhisperExtractor } from './src-ts/extractors/WhisperExtractor.js';
import { TranscriptRepository } from './src-ts/database/repositories.js';
import logger from './src-ts/utils/logger.js';
import * as path from 'path';
import { DatabaseManager } from './src-ts/database/connection.js';

interface Playlist {
  id: number;
  playlist_id: string;
  title: string;
  description?: string;
  video_count?: number;
}

interface PlaylistItem {
  id: number;
  playlist_id: string;
  video_id: string;
  position: number;
  video_title?: string;
  channel_title?: string;
}

async function main() {
  console.log('\n=== Phase 4 Test: Whisper Transcription ===\n');

  // Connect to database
  const dbPath = path.join(process.cwd(), 'data', 'metube.db');
  const dbManager = new DatabaseManager(dbPath);
  const db = dbManager.getConnection();

  try {
    // Step 1: Get all playlists
    console.log('Step 1: Fetching playlists from database...');
    const playlists = db
      .prepare('SELECT id, playlist_id, title, video_count FROM playlists ORDER BY id')
      .all() as Playlist[];

    if (playlists.length === 0) {
      console.log('No playlists found in database!');
      return;
    }

    console.log(`Found ${playlists.length} playlists:\n`);
    playlists.forEach((p, idx) => {
      console.log(`  [${idx + 1}] ${p.title} (${p.video_count || 0} videos)`);
    });

    // Step 2: Select playlist 7
    if (playlists.length < 7) {
      console.log(`\nError: Only ${playlists.length} playlists available, but you requested playlist 7`);
      return;
    }

    const targetPlaylist = playlists[6]; // Index 6 = 7th playlist
    console.log(`\n\nStep 2: Selected Playlist 7: "${targetPlaylist.title}"`);
    console.log(`  Playlist ID: ${targetPlaylist.playlist_id}`);
    console.log(`  Videos: ${targetPlaylist.video_count || 0}\n`);

    // Step 3: Get videos from this playlist (with JOIN to get video details)
    console.log('Step 3: Fetching videos from this playlist...');
    const playlistItems = db
      .prepare(`
        SELECT 
          pi.id, 
          pi.playlist_id, 
          pi.video_id, 
          pi.position,
          v.title as video_title,
          v.channel_title
        FROM playlist_items pi
        LEFT JOIN videos v ON pi.video_id = v.video_id
        WHERE pi.playlist_id = ?
        ORDER BY pi.position
        LIMIT 5
      `)
      .all(targetPlaylist.playlist_id) as PlaylistItem[];

    if (playlistItems.length === 0) {
      console.log('No videos found in this playlist!');
      return;
    }

    console.log(`Found ${playlistItems.length} videos (showing first 5):\n`);
    playlistItems.forEach((item, idx) => {
      console.log(`  [${idx + 1}] ${item.video_title || 'Unknown title (not extracted yet)'}`);
      console.log(`      Video ID: ${item.video_id}`);
      if (item.channel_title) {
        console.log(`      Channel: ${item.channel_title}`);
      }
    });

    // Step 4: Select first video for testing
    const testVideo = playlistItems[0];
    console.log(`\n\nStep 4: Testing with video: "${testVideo.video_title}"`);
    console.log(`  Video ID: ${testVideo.video_id}`);
    console.log(`  YouTube URL: https://www.youtube.com/watch?v=${testVideo.video_id}\n`);

    // Step 5: Check if video already has transcript
    const existingTranscript = db
      .prepare('SELECT id, language, is_auto_generated FROM transcripts WHERE video_id = ?')
      .get(testVideo.video_id);

    if (existingTranscript) {
      console.log('This video already has a transcript:');
      console.log(`  Language: ${(existingTranscript as any).language}`);
      console.log(`  Auto-generated: ${(existingTranscript as any).is_auto_generated ? 'Yes' : 'No'}`);
      console.log('\nSkipping transcription (already done).\n');
      console.log('To re-transcribe, delete the existing transcript first:');
      console.log(`  DELETE FROM transcripts WHERE video_id = '${testVideo.video_id}';\n`);
    } else {
      console.log('No existing transcript found.\n');
    }

    // Step 6: Initialise Whisper extractor
    console.log('Step 5: Initialising Whisper extractor...');
    const whisperConfig = {
      enabled: true,
      model: 'base', // Fast model for testing
      temp_dir: path.join(process.cwd(), 'data', 'temp_audio'),
      cleanup_audio: true,
      python_path: path.join(process.cwd(), 'venv', 'Scripts', 'python.exe'),
      yt_dlp_path: 'yt-dlp',
    };

    const whisperExtractor = new WhisperExtractor(whisperConfig);

    // Check if Whisper is available
    if (!whisperExtractor.isAvailable()) {
      console.log('\nWhisper is NOT available!');
      console.log('Reason:', whisperExtractor.getUnavailableReason());
      console.log('\nSetup required:');
      console.log('  1. Create Python venv: python -m venv venv');
      console.log('  2. Activate venv: .\\venv\\Scripts\\activate');
      console.log('  3. Install dependencies: pip install openai-whisper yt-dlp');
      console.log('  4. Install FFmpeg (required by yt-dlp)');
      return;
    }

    console.log('Whisper is available!\n');

    // Step 7: Transcribe with Whisper
    console.log('Step 6: Transcribing video with Whisper...');
    console.log('This may take several minutes depending on video length.\n');

    const startTime = Date.now();
    const transcriptData = await whisperExtractor.extract(testVideo.video_id);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (!transcriptData) {
      console.log('\nTranscription FAILED!');
      console.log('Check the logs above for error details.');
      return;
    }

    console.log(`\n\nTranscription SUCCESS! (took ${duration}s)`);
    console.log(`\nTranscript Details:`);
    console.log(`  Language: ${transcriptData.language}`);
    console.log(`  Segments: ${transcriptData.segments.length}`);
    console.log(`  Total characters: ${transcriptData.full_text.length}`);
    console.log(`  From Whisper: ${transcriptData.from_whisper ? 'Yes' : 'No'}`);
    console.log(`\nFirst 500 characters of transcript:`);
    console.log('  ' + transcriptData.full_text.substring(0, 500).replace(/\n/g, '\n  '));
    console.log('\n');

    // Step 8: Save to database (optional)
    const saveToDb = true; // Set to false if you don't want to save
    if (saveToDb && !existingTranscript) {
      console.log('Step 7: Saving transcript to database...');
      
      // Use TranscriptRepository directly
      const transcriptRepo = new TranscriptRepository(dbManager);
      transcriptRepo.create(testVideo.video_id, {
        full_text: transcriptData.full_text,
        segments_json: JSON.stringify(transcriptData.segments),
        language: transcriptData.language,
        is_auto_generated: false, // Whisper provides high-quality transcripts
      });

      console.log('Transcript saved successfully!');
    } else if (existingTranscript) {
      console.log('Step 7: Skipped saving (transcript already exists)');
    }

    console.log('\n=== Phase 4 Test Complete ===\n');
    console.log('Summary:');
    console.log(`  - Playlist: ${targetPlaylist.title}`);
    console.log(`  - Video: ${testVideo.video_title}`);
    console.log(`  - Transcript: ${transcriptData.segments.length} segments`);
    console.log(`  - Duration: ${duration}s`);
    console.log(`  - Saved to DB: ${saveToDb ? 'Yes' : 'No'}\n`);

  } catch (error) {
    console.error('\nTest failed with error:');
    console.error(error);
  } finally {
    dbManager.close();
  }
}

// Run the test
main().catch(console.error);

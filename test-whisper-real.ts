/**
 * Phase 4 REAL Test: Whisper Transcription
 * 
 * This test:
 * 1. Authenticates with YouTube
 * 2. Fetches YOUR actual playlists from YouTube API
 * 3. Lets you select playlist 7 (or whatever you want)
 * 4. Fetches videos from that playlist
 * 5. Transcribes one video with Whisper
 */

import { YouTubeAuth } from './src-ts/auth/YouTubeAuth.js';
import { YouTubeClient } from './src-ts/api/YouTubeClient.js';
import { WhisperExtractor } from './src-ts/extractors/WhisperExtractor.js';
import { TranscriptRepository } from './src-ts/database/repositories.js';
import { DatabaseManager } from './src-ts/database/connection.js';
import * as path from 'path';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('\n=== Phase 4 REAL Test: Whisper Transcription ===\n');

  // Step 1: Authenticate with YouTube
  console.log('Step 1: Authenticating with YouTube...');
  const auth = new YouTubeAuth({
    credentialsPath: 'client_secret.json',
    tokensPath: 'tokens.json',
  });

  const isAuthenticated = await auth.authenticate();
  if (!isAuthenticated) {
    console.log('Authentication failed!');
    return;
  }
  console.log('Authentication successful!\n');

  // Step 2: Create YouTube client
  console.log('Step 2: Fetching your playlists from YouTube API...');
  const youtube = new YouTubeClient(auth);
  
  const { playlists } = await youtube.getPlaylists();
  
  if (playlists.length === 0) {
    console.log('No playlists found in your YouTube account!');
    rl.close();
    return;
  }

  console.log(`\nFound ${playlists.length} playlists:\n`);
  playlists.forEach((playlist, idx) => {
    console.log(`  [${idx + 1}] ${playlist.title} (${playlist.itemCount || 0} videos)`);
    console.log(`      ID: ${playlist.id}`);
  });

  // Step 3: Select playlist
  const playlistIndexStr = await question(`\nWhich playlist do you want to test? (1-${playlists.length}): `);
  const playlistIndex = parseInt(playlistIndexStr) - 1;

  if (playlistIndex < 0 || playlistIndex >= playlists.length) {
    console.log('Invalid playlist selection!');
    rl.close();
    return;
  }

  const selectedPlaylist = playlists[playlistIndex];
  console.log(`\n\nStep 3: Selected "${selectedPlaylist.title}"`);
  console.log(`  Playlist ID: ${selectedPlaylist.id}`);
  console.log(`  Videos: ${selectedPlaylist.itemCount || 0}\n`);

  // Step 4: Fetch videos from this playlist
  console.log('Step 4: Fetching videos from this playlist...');
  const { items } = await youtube.getPlaylistVideos(selectedPlaylist.id, 5);

  if (items.length === 0) {
    console.log('No videos found in this playlist!');
    rl.close();
    return;
  }

  console.log(`\nFound ${items.length} videos (showing first 5):\n`);
  
  // Fetch details for each video
  const videos = [];
  for (const item of items) {
    const videoDetails = await youtube.getVideoDetails(item.videoId);
    videos.push(videoDetails);
    console.log(`  [${videos.length}] ${videoDetails.title}`);
    console.log(`      Video ID: ${videoDetails.id}`);
    console.log(`      Channel: ${videoDetails.channelTitle}`);
    console.log(`      Duration: ${videoDetails.duration}`);
  }

  // Step 5: Select video
  const videoIndexStr = await question(`\nWhich video do you want to transcribe? (1-${videos.length}): `);
  const videoIndex = parseInt(videoIndexStr) - 1;

  if (videoIndex < 0 || videoIndex >= videos.length) {
    console.log('Invalid video selection!');
    rl.close();
    return;
  }

  const selectedVideo = videos[videoIndex];
  console.log(`\n\nStep 5: Selected video: "${selectedVideo.title}"`);
  console.log(`  Video ID: ${selectedVideo.id}`);
  console.log(`  Channel: ${selectedVideo.channelTitle}`);
  console.log(`  Duration: ${selectedVideo.duration}`);
  console.log(`  YouTube URL: https://www.youtube.com/watch?v=${selectedVideo.id}\n`);

  rl.close();

  // Step 6: Check if video already has transcript in database
  const dbPath = path.join(process.cwd(), 'data', 'metube.db');
  const dbManager = new DatabaseManager(dbPath);
  const db = dbManager.getConnection();

  const existingTranscript = db
    .prepare('SELECT id, language, is_auto_generated FROM transcripts WHERE video_id = ?')
    .get(selectedVideo.id);

  if (existingTranscript) {
    console.log('This video already has a transcript in the database:');
    console.log(`  Language: ${(existingTranscript as any).language}`);
    console.log(`  Auto-generated: ${(existingTranscript as any).is_auto_generated ? 'Yes' : 'No'}`);
    
    const overwrite = await new Promise<boolean>((resolve) => {
      const rl2 = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      rl2.question('\nDo you want to re-transcribe? (y/n): ', (answer) => {
        rl2.close();
        resolve(answer.toLowerCase() === 'y');
      });
    });

    if (!overwrite) {
      console.log('\nSkipping transcription.');
      dbManager.close();
      return;
    }
    
    console.log('\nDeleting existing transcript...');
    db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(selectedVideo.id);
    console.log('Existing transcript deleted.\n');
  } else {
    console.log('No existing transcript found.\n');
  }

  // Step 7: Initialise Whisper extractor
  console.log('Step 6: Initialising Whisper extractor...');
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
    dbManager.close();
    return;
  }

  console.log('Whisper is available!\n');

  // Step 8: Transcribe with Whisper
  console.log('Step 7: Transcribing video with Whisper...');
  console.log('This may take several minutes depending on video length.');
  console.log('(Press Ctrl+C to cancel if needed)\n');

  const startTime = Date.now();
  const transcriptData = await whisperExtractor.extract(selectedVideo.id);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!transcriptData) {
    console.log('\nTranscription FAILED!');
    console.log('Check the logs above for error details.');
    dbManager.close();
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

  // Step 9: Save to database
  console.log('Step 8: Saving transcript to database...');
  
  const transcriptRepo = new TranscriptRepository(dbManager);
  transcriptRepo.create(selectedVideo.id, {
    full_text: transcriptData.full_text,
    segments_json: JSON.stringify(transcriptData.segments),
    language: transcriptData.language,
    is_auto_generated: false, // Whisper provides high-quality transcripts
  });

  console.log('Transcript saved successfully!');

  console.log('\n=== Phase 4 Test Complete ===\n');
  console.log('Summary:');
  console.log(`  - Playlist: ${selectedPlaylist.title}`);
  console.log(`  - Video: ${selectedVideo.title}`);
  console.log(`  - Transcript: ${transcriptData.segments.length} segments`);
  console.log(`  - Duration: ${duration}s`);
  console.log(`  - Saved to DB: Yes\n`);

  dbManager.close();
}

// Run the test
main().catch((error) => {
  console.error('\nTest failed with error:');
  console.error(error);
  process.exit(1);
});

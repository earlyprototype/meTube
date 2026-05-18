/**
 * Test extraction with a video from user's playlist 6
 * 
 * Python equivalent:
 *   metube playlist discover          # List playlists
 *   metube extract 6                  # Extract playlist #6
 * 
 * This script mimics:
 *   1. Get user's playlists (like playlist discover)
 *   2. Select playlist #6 (index 5, 0-based)
 *   3. Get first video from that playlist
 *   4. Extract it (like extract_single_video)
 */

import { YouTubeAuth } from './src-ts/auth/YouTubeAuth.js';
import { YouTubeClient } from './src-ts/api/YouTubeClient.js';
import { DatabaseManager } from './src-ts/database/connection.js';
import { VideoExtractor } from './src-ts/extractors/VideoExtractor.js';

async function main() {
  console.log('\n=== Test: Extract Video from Playlist 6 ===');
  console.log('(Mimicking Python: metube extract 6)\n');

  try {
    // 1. Authenticate (like YouTubeAuthHandler.authenticate())
    console.log('[1/5] Authenticating with YouTube...');
    const auth = new YouTubeAuth();
    await auth.authenticate();
    console.log('✓ Authenticated\n');

    // 2. Get user's playlists (like playlist discover)
    console.log('[2/5] Fetching your playlists...');
    const client = new YouTubeClient(auth);
    const playlistsResponse = await client.getPlaylists();
    
    if (!playlistsResponse.playlists || playlistsResponse.playlists.length === 0) {
      console.error('✗ No playlists found in your YouTube account');
      process.exit(1);
    }

    console.log(`✓ Found ${playlistsResponse.playlists.length} playlists\n`);
    
    // Show all playlists (like Python cache display)
    console.log('Your playlists:');
    playlistsResponse.playlists.forEach((pl, idx) => {
      const marker = idx === 5 ? ' <-- THIS ONE' : '';
      console.log(`  ${idx + 1}. ${pl.title} (${pl.itemCount} videos)${marker}`);
    });
    console.log();

    // Get playlist 6 (index 5, 0-based)
    if (playlistsResponse.playlists.length < 6) {
      console.error(`✗ You only have ${playlistsResponse.playlists.length} playlists (need at least 6)`);
      console.error('Change playlist number in script or add more playlists to YouTube');
      process.exit(1);
    }

    const playlist = playlistsResponse.playlists[5]; // Playlist #6
    console.log(`\n[3/5] Selected playlist #6: "${playlist.title}"`);
    console.log(`  Playlist ID: ${playlist.id}`);
    console.log(`  Total videos: ${playlist.itemCount}\n`);

    // 3. Get videos from playlist (like get_playlist_videos)
    console.log('[4/5] Fetching videos from playlist...');
    const videosResponse = await client.getPlaylistVideos(playlist.id);
    
    if (!videosResponse.items || videosResponse.items.length === 0) {
      console.error('✗ No videos found in this playlist');
      process.exit(1);
    }

    const playlistItem = videosResponse.items[0];
    console.log(`✓ Got first video from playlist:`);
    console.log(`  Title: "${playlistItem.title}"`);
    console.log(`  Video ID: ${playlistItem.videoId}`);
    console.log(`  Position in playlist: ${playlistItem.position}\n`);

    // 4. Extract video (like extract_single_video)
    console.log('[5/5] Extracting video (metadata + transcript + entities)...');
    console.log('---\n');
    
    const db = new DatabaseManager('./data/metube.db');
    const extractor = new VideoExtractor(client, db, {
      autoTranscript: true,
      autoLlmParse: false,
      enableWhisper: true, // Enable Whisper fallback like Python
    });

    await extractor.extractSingleVideo(playlistItem.videoId);
    
    console.log('\n---');
    console.log('\n✓ SUCCESS! Video extracted.\n');
    console.log('Database records:');
    console.log(`  Video ID: ${playlistItem.videoId}`);
    console.log(`  Title: ${playlistItem.title}`);
    console.log(`  Playlist: ${playlist.title}\n`);
    console.log('Python equivalent:');
    console.log(`  metube extract 6`);
    console.log(`  metube report 6 1\n`);

    db.close();
    process.exit(0);

  } catch (error) {
    console.error('\n✗ EXTRACTION FAILED');
    console.error('Error:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();

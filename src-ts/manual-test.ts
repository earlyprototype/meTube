/**
 * Manual test script for Phase 3 verification
 * Tests OAuth authentication and YouTube API with REAL account
 * ONE-CLICK AUTHENTICATION (Python-style)
 */

import { YouTubeAuth } from './auth/YouTubeAuth';
import { YouTubeClient } from './api/YouTubeClient';
import logger from './utils/logger';

async function main() {
  console.log('='.repeat(60));
  console.log('Phase 3 Manual Verification - YouTube OAuth & API Test');
  console.log('='.repeat(60));
  console.log();

  try {
    // Step 1 & 2: Initialize and authenticate (one-click!)
    console.log('[1/5] Authenticating with YouTube...');
    
    const auth = new YouTubeAuth({
      credentialsPath: 'client_secret.json',
      tokensPath: 'tokens.json',
    });
    
    // This is like Python's run_local_server() - automatic!
    const authenticated = await auth.authenticate();
    
    if (!authenticated) {
      throw new Error('Authentication failed');
    }

    console.log();

    // Step 3: Create YouTube client
    console.log('[3/5] Creating YouTubeClient...');
    const client = new YouTubeClient(auth);
    console.log('YouTubeClient created successfully.');
    console.log();

    // Step 4: Test fetching playlists
    console.log('[4/5] Fetching your YouTube playlists...');
    const { playlists } = await client.getPlaylists(10);
    
    if (playlists.length === 0) {
      console.log('No playlists found on your account.');
    } else {
      console.log(`Found ${playlists.length} playlist(s):`);
      console.log();
      
      playlists.forEach((playlist, index) => {
        console.log(`${index + 1}. ${playlist.title}`);
        console.log(`   ID: ${playlist.id}`);
        console.log(`   Videos: ${playlist.itemCount}`);
        console.log(`   Description: ${playlist.description.substring(0, 100)}${playlist.description.length > 100 ? '...' : ''}`);
        console.log();
      });

      // Step 5: Test fetching playlist videos
      if (playlists.length > 0) {
        console.log('[5/5] Fetching videos from first playlist...');
        const firstPlaylist = playlists[0];
        const { items } = await client.getPlaylistVideos(firstPlaylist.id, 5);
        
        console.log(`Found ${items.length} video(s) in "${firstPlaylist.title}":`);
        console.log();
        
        items.forEach((item, index) => {
          console.log(`${index + 1}. ${item.title || 'Untitled'}`);
          console.log(`   Video ID: ${item.videoId}`);
          console.log(`   Position: ${item.position}`);
          console.log();
        });

        // Bonus: Fetch details for first video
        if (items.length > 0) {
          console.log('Fetching detailed information for first video...');
          const videoDetails = await client.getVideoDetails(items[0].videoId);
          
          console.log();
          console.log('Video Details:');
          console.log(`Title: ${videoDetails.title}`);
          console.log(`Channel: ${videoDetails.channelTitle}`);
          console.log(`Duration: ${videoDetails.duration}`);
          console.log(`Views: ${videoDetails.viewCount || 'N/A'}`);
          console.log(`Likes: ${videoDetails.likeCount || 'N/A'}`);
          console.log(`Comments: ${videoDetails.commentCount || 'N/A'}`);
          console.log();
        }
      }
    }

    console.log('='.repeat(60));
    console.log('Manual Verification COMPLETE');
    console.log('='.repeat(60));
    console.log();

  } catch (error) {
    console.error();
    console.error('ERROR during manual verification:');
    console.error(error);
    console.error();
    process.exit(1);
  }
}

// Run the manual test
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

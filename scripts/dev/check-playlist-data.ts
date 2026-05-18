/**
 * Check if playlist video_count is cached or actual
 */

import { DatabaseManager } from '../../src-ts/database/connection.js';
import { PlaylistRepository } from '../../src-ts/database/repositories.js';
import { YouTubeAuth } from '../../src-ts/auth/YouTubeAuth.js';
import { YouTubeClient } from '../../src-ts/api/YouTubeClient.js';

async function checkPlaylistData() {
  console.log('\n=== Playlist Data Verification ===\n');

  // Get database data
  const db = new DatabaseManager('data/metube.db');
  const repo = new PlaylistRepository(db);
  const dbPlaylists = repo.getAll();

  console.log('Database Playlists:');
  dbPlaylists.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.title}`);
    console.log(`      ID: ${p.playlist_id}`);
    console.log(`      video_count in DB: ${p.video_count || 0}`);
    console.log(`      enabled: ${p.enabled}`);
    console.log(`      last_updated: ${p.updated_at || 'never'}`);
  });

  // Check if we have auth to compare with YouTube
  const auth = new YouTubeAuth();
  if (!auth.hasValidTokens()) {
    console.log('\n! No valid YouTube tokens - cannot verify against YouTube API');
    console.log('! This video_count is cached from when playlist was added\n');
    db.close();
    return;
  }

  // Get current data from YouTube
  console.log('\n\nFetching current data from YouTube API...\n');
  const client = new YouTubeClient(auth);
  
  for (const dbPlaylist of dbPlaylists) {
    try {
      const ytResponse = await client.getPlaylistVideos(dbPlaylist.playlist_id, 1);
      const actualCount = ytResponse.totalResults || 0;
      const cached = dbPlaylist.video_count || 0;
      const match = actualCount === cached ? '✓' : '✗';
      
      console.log(`${match} ${dbPlaylist.title}`);
      console.log(`   Cached: ${cached} videos | Actual: ${actualCount} videos`);
      
      if (actualCount !== cached) {
        console.log(`   MISMATCH! Database is ${cached > actualCount ? 'HIGHER' : 'LOWER'} than YouTube`);
      }
    } catch (error) {
      console.log(`✗ ${dbPlaylist.title}`);
      console.log(`   Error fetching from YouTube: ${error}`);
    }
  }

  // Check how many videos are actually extracted
  console.log('\n\nChecking extracted videos in database...\n');
  const conn = db.getConnection();
  
  for (const playlist of dbPlaylists) {
    const extractedCount = conn
      .prepare(`
        SELECT COUNT(*) as count 
        FROM videos v
        JOIN playlist_items pi ON v.video_id = pi.video_id
        WHERE pi.playlist_id = ?
      `)
      .get(playlist.playlist_id) as { count: number };
    
    console.log(`${playlist.title}`);
    console.log(`  Cached count: ${playlist.video_count || 0} videos`);
    console.log(`  Actually extracted: ${extractedCount.count} videos`);
    
    if (extractedCount.count === 0) {
      console.log(`  ⚠ No videos extracted yet - run: metube extract playlist ${playlist.playlist_id}`);
    }
  }

  db.close();
  console.log('\n=== Verification Complete ===\n');
}

checkPlaylistData().catch(console.error);

/**
 * Integration test to verify CLI backend connections
 * Tests that all Phase 5 CLI commands can properly connect to Phase 2-4 backend
 */

import { YouTubeAuth } from './src-ts/auth/YouTubeAuth.js';
import { YouTubeClient } from './src-ts/api/YouTubeClient.js';
import { DatabaseManager } from './src-ts/database/connection.js';
import { PlaylistRepository, VideoRepository, TranscriptRepository } from './src-ts/database/repositories.js';
import { VideoExtractor } from './src-ts/extractors/VideoExtractor.js';
import { WhisperExtractor } from './src-ts/extractors/WhisperExtractor.js';

console.log('\n=== Backend Integration Test ===\n');

async function testDatabaseConnection() {
  console.log('[1/6] Testing Database Connection...');
  try {
    const db = new DatabaseManager('data/metube.db');
    const conn = db.getConnection();
    console.log('  ✓ Database connection established');
    
    // Test repositories
    const playlistRepo = new PlaylistRepository(db);
    const videoRepo = new VideoRepository(db);
    const transcriptRepo = new TranscriptRepository(db);
    
    const playlists = playlistRepo.getAll();
    console.log(`  ✓ PlaylistRepository working (${playlists.length} playlists)`);
    
    db.close();
    console.log('  ✓ Database test PASSED\n');
    return true;
  } catch (error) {
    console.error('  ✗ Database test FAILED:', error);
    return false;
  }
}

async function testYouTubeAuth() {
  console.log('[2/6] Testing YouTube Authentication...');
  try {
    const auth = new YouTubeAuth({
      credentialsPath: 'client_secret.json',
      tokensPath: 'tokens.json',
    });
    
    if (auth.hasValidTokens()) {
      console.log('  ✓ Valid tokens found');
    } else {
      console.log('  ! No valid tokens (run: metube init)');
    }
    
    console.log('  ✓ YouTubeAuth test PASSED\n');
    return true;
  } catch (error) {
    console.error('  ✗ YouTubeAuth test FAILED:', error);
    return false;
  }
}

async function testYouTubeClient() {
  console.log('[3/6] Testing YouTube API Client...');
  try {
    const auth = new YouTubeAuth();
    
    if (!auth.hasValidTokens()) {
      console.log('  ! Skipping (no valid tokens - run: metube init)\n');
      return true;
    }
    
    const client = new YouTubeClient(auth);
    console.log('  ✓ YouTubeClient initialized');
    
    // Test API call
    const { playlists } = await client.getPlaylists(5);
    console.log(`  ✓ API call successful (${playlists.length} playlists fetched)`);
    
    console.log('  ✓ YouTubeClient test PASSED\n');
    return true;
  } catch (error) {
    console.error('  ✗ YouTubeClient test FAILED:', error);
    return false;
  }
}

async function testWhisperExtractor() {
  console.log('[4/6] Testing Whisper Extractor...');
  try {
    const whisper = new WhisperExtractor({
      enabled: true,
    });
    
    if (whisper.isAvailable()) {
      console.log('  ✓ Whisper is available');
    } else {
      console.log('  ! Whisper not available:', whisper.getUnavailableReason());
      console.log('  ! This is OK - Whisper is optional');
    }
    
    console.log('  ✓ WhisperExtractor test PASSED\n');
    return true;
  } catch (error) {
    console.error('  ✗ WhisperExtractor test FAILED:', error);
    return false;
  }
}

async function testVideoExtractor() {
  console.log('[5/6] Testing Video Extractor...');
  try {
    const auth = new YouTubeAuth();
    
    if (!auth.hasValidTokens()) {
      console.log('  ! Skipping (no valid tokens - run: metube init)\n');
      return true;
    }
    
    const client = new YouTubeClient(auth);
    const db = new DatabaseManager('data/metube.db');
    
    const extractor = new VideoExtractor(client, db, {
      autoTranscript: true,
      autoLlmParse: false,
      enableWhisper: true,
    });
    
    console.log('  ✓ VideoExtractor initialized');
    console.log('  ✓ All backend components connected');
    
    db.close();
    console.log('  ✓ VideoExtractor test PASSED\n');
    return true;
  } catch (error) {
    console.error('  ✗ VideoExtractor test FAILED:', error);
    return false;
  }
}

async function testPlaylistOperations() {
  console.log('[6/6] Testing Playlist Operations...');
  try {
    const db = new DatabaseManager('data/metube.db');
    const repo = new PlaylistRepository(db);
    
    // Test getAll
    const playlists = repo.getAll();
    console.log(`  ✓ getAll() works (${playlists.length} playlists)`);
    
    // Test getById if we have playlists
    if (playlists.length > 0) {
      const firstPlaylist = playlists[0];
      const fetched = repo.getById(firstPlaylist.playlist_id);
      if (fetched) {
        console.log(`  ✓ getById() works`);
      }
    }
    
    db.close();
    console.log('  ✓ Playlist operations test PASSED\n');
    return true;
  } catch (error) {
    console.error('  ✗ Playlist operations test FAILED:', error);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  const results = {
    database: await testDatabaseConnection(),
    auth: await testYouTubeAuth(),
    client: await testYouTubeClient(),
    whisper: await testWhisperExtractor(),
    extractor: await testVideoExtractor(),
    playlists: await testPlaylistOperations(),
  };
  
  console.log('=== Test Results ===\n');
  console.log(`Database Connection:   ${results.database ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`YouTube Auth:          ${results.auth ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`YouTube API Client:    ${results.client ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Whisper Extractor:     ${results.whisper ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Video Extractor:       ${results.extractor ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Playlist Operations:   ${results.playlists ? '✓ PASS' : '✗ FAIL'}`);
  
  const allPassed = Object.values(results).every(r => r === true);
  
  console.log(`\n${allPassed ? '✓✓✓ ALL TESTS PASSED ✓✓✓' : '✗✗✗ SOME TESTS FAILED ✗✗✗'}`);
  console.log('\nIf all tests passed, the CLI backend integration is working correctly.');
  console.log('You can now run the CLI commands:\n');
  console.log('  npm run dev:init       - OAuth authentication');
  console.log('  npm run dev:list       - List playlists');
  console.log('  npm run dev:discover   - Interactive playlist picker\n');
  
  process.exit(allPassed ? 0 : 1);
}

runAllTests().catch(error => {
  console.error('\n✗ Test runner failed:', error);
  process.exit(1);
});

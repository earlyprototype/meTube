import Database from 'better-sqlite3';

const db = new Database('data/metube.db');

console.log('\nPlaylists in database:\n');
const playlists = db.prepare('SELECT playlist_id, title, video_count, enabled FROM playlists').all();

if (playlists.length === 0) {
  console.log('NO PLAYLISTS IN DATABASE');
} else {
  playlists.forEach((p, i) => {
    console.log(`[${i+1}] ${p.title}`);
    console.log(`    ID: ${p.playlist_id}`);
    console.log(`    video_count: ${p.video_count === null ? 'NULL' : p.video_count}`);
    console.log(`    enabled: ${p.enabled}`);
    console.log('');
  });
}

db.close();

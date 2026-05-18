/**
 * DEBUG SCRIPT: RAW OAUTH URL GENERATION
 * 
 * This script bypasses the entire application codebase to generate a guaranteed correct URL.
 */

import { google } from 'googleapis';
import * as fs from 'fs';
import * as readline from 'readline';

async function main() {
  console.log('----------------------------------------------------------------');
  console.log('DEBUG AUTHENTICATION MODE');
  console.log('----------------------------------------------------------------');

  // 1. Read Client Secret directly
  const content = fs.readFileSync('client_secret.json', 'utf-8');
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;

  console.log('Client ID:', key.client_id);
  console.log('Redirect URI:', 'http://localhost'); 

  // 2. Create raw OAuth2 client
  const oauth2Client = new google.auth.OAuth2(
    key.client_id,
    key.client_secret,
    'http://localhost'
  );

  // 3. Generate URL MANUALLY with explicit options
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl'
    ],
    prompt: 'consent',
    response_type: 'code', // EXPLICITLY INCLUDED
    redirect_uri: 'http://localhost' // EXPLICITLY INCLUDED
  });

  console.log();
  console.log('GENERATED URL:');
  console.log(authUrl);
  console.log();

  if (!authUrl.includes('response_type=code')) {
    console.error('CRITICAL ERROR: Generated URL is missing response_type=code!');
    process.exit(1);
  } else {
    console.log('VERIFIED: URL contains response_type=code');
  }

  // Check for code as argument
  let code = process.argv[2];

  if (!code) {
    console.log('----------------------------------------------------------------');
    console.log('INSTRUCTIONS:');
    console.log('1. Open the URL above in your browser.');
    console.log('2. Authorize the app.');
    console.log('3. Copy the code from the URL bar (everything after code=).');
    console.log('4. Run this script again with the code as an argument:');
    console.log('   npx tsx debug-auth.ts "YOUR_CODE_HERE"');
    console.log('----------------------------------------------------------------');
    process.exit(0);
  }

  // CLEANUP
  let clean = code.trim();
  if (clean.endsWith('&')) {
    clean = clean.slice(0, -1);
  }
  if (clean.includes('code=')) {
    clean = clean.split('code=')[1].split('&')[0];
  }
  clean = decodeURIComponent(clean);
  
  console.log(`Using code: ${clean.substring(0, 10)}...`);

  console.log('Exchanging code...');
  const { tokens } = await oauth2Client.getToken(clean);
  console.log('SUCCESS! Tokens received.');
  
  fs.writeFileSync('tokens.json', JSON.stringify(tokens, null, 2));
  console.log('Saved to tokens.json');
}

main().catch(console.error);

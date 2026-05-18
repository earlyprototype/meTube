/**
 * OAuth Diagnostic Script
 * Shows exactly what's configured and what will be used
 */

import fs from 'fs';
import { google } from 'googleapis';

console.log('='.repeat(60));
console.log('OAuth Configuration Diagnostic');
console.log('='.repeat(60));
console.log();

// Read client_secret.json
const clientSecretPath = 'client_secret.json';
if (!fs.existsSync(clientSecretPath)) {
  console.error('ERROR: client_secret.json not found!');
  process.exit(1);
}

const clientSecretContent = fs.readFileSync(clientSecretPath, 'utf-8');
const clientSecret = JSON.parse(clientSecretContent);

console.log('1. Client Secret Configuration:');
console.log('   File:', clientSecretPath);
console.log('   Client ID:', clientSecret.installed.client_id);
console.log('   Redirect URIs:', JSON.stringify(clientSecret.installed.redirect_uris, null, 2));
console.log();

// Determine which redirect URI would be selected
const redirectUris = clientSecret.installed.redirect_uris;
let selectedUri = redirectUris.find((uri: string) => uri.includes('localhost:3000'));
if (!selectedUri) {
  selectedUri = redirectUris.find((uri: string) => uri.includes('localhost'));
}
if (!selectedUri) {
  selectedUri = redirectUris[0];
}

console.log('2. Selected Redirect URI:');
console.log('   URI:', selectedUri);
console.log('   Reason:', selectedUri.includes('localhost:3000') ? 'Contains localhost:3000' : 
                           selectedUri.includes('localhost') ? 'Contains localhost' : 
                           'First in list');
console.log();

// Extract port from URI
let port = 80;
const portMatch = selectedUri.match(/:(\d+)/);
if (portMatch) {
  port = parseInt(portMatch[1]);
} else if (selectedUri.startsWith('http://') && !selectedUri.includes(':80')) {
  port = 80;
}

console.log('3. OAuth Server Configuration:');
console.log('   Will listen on port:', port);
console.log('   Full callback URL:', `http://localhost:${port}/`);
console.log();

// Create OAuth2 client to generate auth URL
const oauth2Client = new google.auth.OAuth2(
  clientSecret.installed.client_id,
  clientSecret.installed.client_secret,
  selectedUri
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/youtube.readonly'],
  prompt: 'consent',
});

console.log('4. Authorization URL Preview:');
console.log('   (This is what will open in your browser)');
console.log();
console.log(authUrl);
console.log();

console.log('='.repeat(60));
console.log('Next Steps:');
console.log('='.repeat(60));
console.log();
console.log('1. Click on "metube" OAuth client in Google Cloud Console');
console.log('2. Verify these redirect URIs are listed:');
redirectUris.forEach((uri: string) => {
  console.log(`   - ${uri}`);
});
console.log();
console.log('3. If they are NOT listed, click "EDIT" and add them');
console.log('4. Click "SAVE" in Google Cloud Console');
console.log('5. Run: npx tsx src-ts/manual-test.ts');
console.log();

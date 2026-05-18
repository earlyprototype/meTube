// Minimal OAuth test - NO TypeScript, NO complexity
const {google} = require('googleapis');
const http = require('http');
const config = require('./client_secret.json');

const PORT = 80; // Port 80 = http://localhost (no :80 needed)
const REDIRECT_URI = `http://localhost`;

const oauth2Client = new google.auth.OAuth2(
  config.installed.client_id,
  config.installed.client_secret,
  REDIRECT_URI // Set in constructor
);

// Generate URL WITHOUT overriding redirect_uri
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/youtube.readonly'],
  prompt: 'consent'
  // NO redirect_uri here - use constructor value
});

console.log('\n=== SIMPLE TEST ===');
console.log('URL:', authUrl);
console.log('\nHas response_type?', authUrl.includes('response_type'));
console.log('Has redirect_uri?', authUrl.includes('redirect_uri'));
console.log('\n*** OPEN THIS URL IN YOUR BROWSER ***\n');

// Start server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  
  if (code) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>SUCCESS! Check terminal.</h1>');
    
    console.log('\n=== GOT CODE ===');
    console.log('Code:', code.substring(0, 20) + '...');
    
    // Get tokens
    try {
      const {tokens} = await oauth2Client.getToken(code);
      console.log('\n=== GOT TOKENS ===');
      console.log('Access token:', tokens.access_token.substring(0, 20) + '...');
      console.log('\n✓✓✓ OAUTH WORKS! ✓✓✓\n');
      process.exit(0);
    } catch (err) {
      console.error('\n✗✗✗ TOKEN EXCHANGE FAILED:', err.message);
      process.exit(1);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log('\nWaiting for callback...\n');
});

/**
 * Fix Pino logger syntax across all TypeScript files
 * Changes logger.method('message', {data}) to logger.method({data}, 'message')
 */

const fs = require('fs');
const path = require('path');

const filesToFix = [
  'src-ts/auth/YouTubeAuth.ts',
  'src-ts/extractors/TranscriptExtractor.ts',
  'src-ts/extractors/VideoExtractor.ts',
  'src-ts/extractors/WhisperExtractor.ts',
  'src-ts/database/connection.ts',
  'src-ts/auth/OAuthServer.ts',
  'src-ts/api/YouTubeClient.ts',
  'src-ts/api/RateLimiter.ts',
  'src-ts/utils/logger.ts',
];

function fixLoggerSyntax(content) {
  // Match: logger.method('message', {
  // Replace with: logger.method({
  // Then move the 'message' to after the closing }
  
  // This regex finds logger calls with wrong syntax
  const regex = /logger\.(info|warn|error|debug)\(\s*'([^']+)',\s*\{/g;
  
  let fixed = content;
  let match;
  const matches = [];
  
  // Find all matches first
  while ((match = regex.exec(content)) !== null) {
    matches.push({
      fullMatch: match[0],
      method: match[1],
      message: match[2],
      index: match.index,
    });
  }
  
  // Process matches in reverse order to preserve indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    
    // Find the closing parenthesis for this logger call
    let depth = 0;
    let objectStart = m.index + m.fullMatch.length - 1; // Position of {
    let objectEnd = -1;
    
    for (let j = objectStart; j < content.length; j++) {
      if (content[j] === '{') depth++;
      if (content[j] === '}') {
        depth--;
        if (depth === 0) {
          objectEnd = j;
          break;
        }
      }
    }
    
    if (objectEnd === -1) continue; // Couldn't find closing }
    
    // Find the closing ) of the logger call
    let closingParen = objectEnd + 1;
    while (closingParen < content.length && /[\s\n]/.test(content[closingParen])) {
      closingParen++;
    }
    
    if (content[closingParen] !== ')') continue; // Something's wrong
    
    // Extract the object content
    const objectContent = content.substring(objectStart, objectEnd + 1);
    
    // Build the corrected version
    const corrected = `logger.${m.method}(${objectContent}, '${m.message}')`;
    
    // Replace in the content
    const before = content.substring(0, m.index);
    const after = content.substring(closingParen + 1);
    fixed = before + corrected + after;
    content = fixed; // Update for next iteration
  }
  
  return fixed;
}

function fixFile(filePath) {
  console.log(`Fixing ${filePath}...`);
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fixed = fixLoggerSyntax(content);
    
    if (content !== fixed) {
      fs.writeFileSync(filePath, fixed, 'utf-8');
      console.log(`  ✓ Fixed`);
      return true;
    } else {
      console.log(`  - No changes needed`);
      return false;
    }
  } catch (error) {
    console.error(`  ✗ Error: ${error.message}`);
    return false;
  }
}

console.log('Fixing Pino logger syntax...\n');

let fixedCount = 0;
for (const file of filesToFix) {
  if (fixFile(file)) {
    fixedCount++;
  }
}

console.log(`\nFixed ${fixedCount} file(s)`);

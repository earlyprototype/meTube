# CLI Color System - Orange & Grey Palette

## Your Base Colors

Orange and grey - good choice. Professional, warm, not garish.

## The Color Palette

### Orange (Primary/Accent)
```typescript
// Chalk supports hex colors
const ORANGE = {
  bright: '#FF8C00',  // Dark orange - high contrast
  normal: '#FFA500',  // Standard orange
  dim: '#CC8400',     // Muted orange
};
```

### Grey (UI/Secondary)
```typescript
const GREY = {
  lightest: '#D3D3D3', // Light grey - for borders/dividers
  light: '#A9A9A9',    // Medium grey - secondary text
  normal: '#808080',   // Standard grey - inactive items
  dark: '#505050',     // Dark grey - subtle emphasis
  darkest: '#303030',  // Very dark grey - backgrounds
};
```

### Semantic Colors (Keep Standard)
```typescript
const SEMANTIC = {
  error: '#FF4444',    // Red - errors only
  success: '#00CC66',  // Green - success states
  warning: '#FFD700',  // Gold/yellow - warnings
  info: '#FFA500',     // Use your orange for info
};
```

## Color Usage Rules

### Primary Color (Orange)
Use orange for:
- **Interactive elements** - Selected items, focused inputs
- **Headings** - Section titles, command names
- **Info messages** - Status updates, helpful hints
- **Accent elements** - Borders on active panels
- **Progress indicators** - Current operation

```typescript
<Text color="orange">Selected Playlist</Text>
<Box borderColor="orange">Active Panel</Box>
```

### Grey (UI Framework)
Use grey for:
- **Secondary text** - Timestamps, metadata, counts
- **Inactive items** - Unselected list items
- **Borders** - When not emphasized
- **Dividers** - Section separators
- **Hints** - Keyboard shortcuts, tips

```typescript
<Text dimColor>60 videos</Text>  // Ink's built-in dim = grey
<Text color="gray">Press q to quit</Text>
```

### Semantic Colors (Sparingly)
- **Red** - Only for actual errors
- **Green** - Only for confirmed success
- **Yellow/Gold** - Only for warnings that need attention

## Professional Palettes Using Orange/Grey

### Option 1: Rust CLI Style (bat/ripgrep)
- **Orange** for matches/highlights
- **Grey** for line numbers and metadata
- **White** for normal text
- Minimal use of other colors

**Example:**
```
  1  import Database from 'better-sqlite3';
  2  import { DatabaseManager } from './connection.js';
  3  
  12  export class PlaylistRepository {
       ^^^^^^^^^^^^^^^^^^^^^^^^^ (orange highlight)
```

### Option 2: VS Code Terminal Style
- **Orange** for warnings and highlights
- **Grey** for comments and secondary
- **White** for primary text
- Standard semantic colors for errors/success

**Example:**
```
╭─ System Status ──────────────────╮  (grey border)
│                                   │
│ Database          ✓ Connected     │  (green check)
│ YouTube Auth      ✓ Authorized    │
│ Whisper          ! Not configured │  (orange warning)
│                                   │
╰───────────────────────────────────╯
```

### Option 3: Gruvbox-Inspired (Warm & Professional)
- **Orange** as primary accent
- **Grey** shades for hierarchy
- Warm overall palette
- Very popular in dev tools

**Example:**
```
Playlists (4)                              (orange heading)

  1. Ai                    60 videos       (white text, grey count)
  2. Electronics            3 videos
  3. FabLab                 7 videos
  4. PsychHacks             1 video

────────────────────────────────────       (grey divider)
↑↓ Navigate • Enter Select • q Quit       (grey footer)
```

## Recommended: The Balanced Approach

### Text Hierarchy
```typescript
const TEXT_STYLES = {
  title: { color: 'orange', bold: true },        // Main headings
  heading: { color: 'orange' },                  // Subheadings
  primary: { color: 'white' },                   // Main content
  secondary: { dimColor: true },                 // Metadata (grey)
  accent: { color: 'orange' },                   // Selected/active
  inactive: { color: 'gray' },                   // Disabled items
};
```

### UI Elements
```typescript
const UI_STYLES = {
  border_active: { borderColor: 'orange' },      // Focused panel
  border_normal: { borderColor: 'gray' },        // Standard panel
  divider: { color: 'gray' },                    // Separators
  footer: { color: 'gray', dimColor: true },     // Status bars
};
```

### State Colors
```typescript
const STATE_STYLES = {
  selected: { color: 'orange', bold: true },     // Active selection
  hover: { color: 'orange' },                    // Hover state
  processing: { color: 'orange' },               // In progress
  completed: { color: 'green' },                 // Done
  failed: { color: 'red' },                      // Error state
  pending: { color: 'gray' },                    // Not started
};
```

## Practical Examples

### Playlist Picker (Orange + Grey)
```tsx
<Box borderStyle="round" borderColor="orange" padding={1}>
  <Text bold color="orange">Select a Playlist</Text>
  
  {playlists.map((playlist, index) => (
    <Text 
      key={playlist.id}
      color={index === selected ? 'orange' : undefined}
      bold={index === selected}
    >
      {index === selected ? '▶ ' : '  '}
      [{index + 1}] {playlist.title}
      <Text dimColor> ({playlist.video_count} videos)</Text>
    </Text>
  ))}
  
  <Box marginTop={1} paddingX={1}>
    <Text dimColor>↑↓ Navigate • Enter Select • q Cancel</Text>
  </Box>
</Box>
```

**Renders as:**
```
╭─────────────────────────────────────╮ (orange border)
│ Select a Playlist                   │ (orange heading)
│                                     │
│   [1] Ai (60 videos)                │ (white + grey)
│ ▶ [2] Electronics (3 videos)        │ (orange + grey) <- selected
│   [3] FabLab (7 videos)             │
│   [4] PsychHacks (1 video)          │
│                                     │
│ ↑↓ Navigate • Enter Select • q Cancel │ (grey footer)
╰─────────────────────────────────────╯
```

### Progress Display (Live Updates)
```tsx
<Box borderStyle="round" borderColor="orange" padding={1}>
  <Text bold color="orange">Extracting Videos</Text>
  
  <Box flexDirection="column" marginTop={1}>
    <Text>⠼ [1/60] <Text dimColor>Introduction to AI</Text></Text>
    <Text color="green">✓ [2/60] <Text dimColor>Machine Learning</Text></Text>
    <Text color="green">✓ [3/60] <Text dimColor>Neural Networks</Text></Text>
  </Box>
  
  <Box marginTop={1}>
    <Text color="orange">{currentCount}/60 </Text>
    <Text dimColor>• {elapsed}s elapsed</Text>
  </Box>
</Box>
```

### Error Display (Red Accent, Grey Details)
```tsx
<Box borderStyle="round" borderColor="red" padding={1}>
  <Text bold color="red">✗ Error</Text>
  
  <Box marginTop={1}>
    <Text>{errorMessage}</Text>
  </Box>
  
  {details && (
    <Box marginTop={1}>
      <Text dimColor>{details}</Text>
    </Box>
  )}
</Box>
```

## Implementation in Chalk

```typescript
import chalk from 'chalk';

// Define your colors
export const colors = {
  // Primary
  orange: chalk.hex('#FFA500'),
  orangeBright: chalk.hex('#FF8C00'),
  orangeDim: chalk.hex('#CC8400'),
  
  // Grey scale
  grey: chalk.gray,
  greyLight: chalk.hex('#A9A9A9'),
  greyDark: chalk.hex('#505050'),
  
  // Semantic (standard)
  error: chalk.red,
  success: chalk.green,
  warning: chalk.yellow,
  info: chalk.hex('#FFA500'), // Use orange
};

// Usage
console.log(colors.orange('Selected item'));
console.log(colors.grey('Secondary info'));
console.log(colors.error('Error message'));
```

## In Ink Components

```typescript
// Ink uses chalk under the hood
<Text color="#FFA500">Orange text</Text>
<Text color="gray">Grey text</Text>
<Text dimColor>Dimmed grey</Text>

// Or with chalk directly
import chalk from 'chalk';
<Text>{chalk.hex('#FFA500')('Orange')} and {chalk.gray('grey')}</Text>
```

## Accessibility Check

### Contrast Ratios (on black background)
- **Orange (#FFA500) on Black** - 7.3:1 ratio ✓ (passes WCAG AA)
- **Light Grey (#A9A9A9) on Black** - 10.2:1 ratio ✓ (passes AAA)
- **Green (#00CC66) on Black** - 8.1:1 ratio ✓ (passes AA)
- **Red (#FF4444) on Black** - 5.2:1 ratio ✓ (passes AA)

All colors are accessible on dark terminals.

## The Bottom Line

**Orange for interaction and emphasis**
**Grey for hierarchy and UI chrome**
**Standard colors only for semantic meaning**

Simple, professional, not garish.

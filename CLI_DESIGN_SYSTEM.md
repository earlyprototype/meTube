# CLI Design System & Aesthetic Philosophy

## Design Inspiration

Currently **no formal design system** has been established. The CLI components were built with functional defaults from Ink.

### Current State (Unintentional Design)
- **Borders:** "round" style boxes everywhere
- **Colors:** Red for errors, green for success, cyan for headings, yellow for warnings
- **Animation:** Basic character cycle for "little dude" (o/O)
- **Layout:** Functional spacing, no consistent margin/padding system

### What We Should Decide

#### Option 1: Minimal Terminal Aesthetic
**Inspiration:** Git CLI, ripgrep, exa
- Sparse, clean output
- Colors only for semantic meaning (errors, success)
- No boxes/borders (just spacing)
- Fast to read, low visual noise

```
Playlists (4)

  1. Ai                   60 videos
  2. Electronics           3 videos
  3. FabLab                7 videos
  4. PsychHacks            1 video

✓ Ready
```

#### Option 2: Rich Terminal UI
**Inspiration:** k9s, lazygit, bottom
- Bordered panels
- Heavy use of color and symbols
- Multiple simultaneous views
- More "app-like" than CLI-like

```
╭─────────────────────────────────────╮
│ 📋 Saved Playlists (4)              │
├─────────────────────────────────────┤
│ ▶ [1] Ai                   60 videos│
│   [2] Electronics           3 videos│
│   [3] FabLab                7 videos│
│   [4] PsychHacks            1 video │
╰─────────────────────────────────────╯
```

#### Option 3: Playful/Personality
**Inspiration:** npm, yarn (older versions), homebrew
- Personality in messaging
- Fun animations and characters
- Progress indicators that tell a story
- Makes waiting entertaining

```
🚶 Extracting video 1/60...
🏃 Extracting video 2/60...
🚶 Extracting video 3/60...
...
🎉 Done! All videos extracted successfully!
```

#### Option 4: Modern Terminal (Vercel/Stripe Style)
**Inspiration:** Vercel CLI, Stripe CLI, modern dev tools
- Clean boxes with subtle styling
- Consistent spacing (8px-equivalent rhythm)
- Pastel/muted color palette
- Professional but friendly

```
┌─ Playlists ────────────────────────┐
│                                     │
│  1  Ai                    60 videos │
│  2  Electronics            3 videos │
│  3  FabLab                 7 videos │
│  4  PsychHacks             1 video  │
│                                     │
└─────────────────────────────────────┘

 ✓  4 playlists loaded
```

## Current Implementation Analysis

### Colors Used
- **Red:** Errors, failures
- **Green:** Success, completed states
- **Cyan:** Headers, selected items
- **Yellow:** Warnings, info messages
- **Gray/Dim:** Secondary text, hints

**Issue:** No consistent brightness/saturation - some terminals will look terrible

### Spacing
- `padding={1}` used everywhere
- `marginBottom={1}` inconsistent
- No spacing scale (0, 1, 2, 3...)

**Issue:** Inconsistent visual rhythm

### Typography
- `bold` for headers
- `dimColor` for secondary text
- No hierarchy beyond that

**Issue:** Everything looks the same weight

### Borders
- "round" style everywhere
- Always used (even for simple lists)

**Issue:** Overuse of decoration, cluttered

### Animation
The "little dude" is currently:
```typescript
const DUDE_ANIMATION = ['o', 'O', 'o', 'O'];
const COMPLETED_DUDE = '!';
```

**Issue:** 
- No emoji mode removed (due to user preference)
- Characters `o/O` are boring
- No personality without emoji

### Icons/Symbols
Currently using:
- `X` for errors (should be `✗`)
- `OK` for success (should be `✓`)
- Plain text everywhere else

**Issue:** Looks dated, not using unicode effectively

## Recommendations

### Quick Wins (No Design System Needed)

1. **Better symbols:**
```typescript
const SYMBOLS = {
  error: '✗',
  success: '✓',
  warning: '⚠',
  info: 'ℹ',
  arrow: '→',
  bullet: '•',
};
```

2. **Consistent spacing scale:**
```typescript
const SPACING = {
  none: 0,
  xs: 0.5,
  sm: 1,
  md: 2,
  lg: 3,
  xl: 4,
};
```

3. **Remove excessive borders** - Use only when needed to group content

4. **Better "little dude" without emoji:**
```typescript
// ASCII art alternatives
const DUDE_ANIMATION = [
  '[-]',  // Standing
  '[|]',  // Walking
  '[/]',  // Running
  '[\\]', // Running
];
const COMPLETED_DUDE = '[*]'; // Celebrating
```

Or single-char alternatives:
```typescript
const DUDE_ANIMATION = ['◐', '◓', '◑', '◒']; // Rotating
const COMPLETED_DUDE = '◉'; // Full circle
```

## Design System Proposal

### If You Want a Formal System

**Color Palette:**
```typescript
const COLORS = {
  // Semantic
  error: 'red',
  success: 'green',
  warning: 'yellow',
  info: 'cyan',
  
  // UI
  primary: 'cyan',
  secondary: 'gray',
  accent: 'magenta',
  
  // States
  active: 'cyan',
  inactive: 'gray',
  hover: 'white',
};
```

**Component Hierarchy:**
```
Level 1: Full-screen views (bordered panels)
Level 2: Sections within views (no border, spacing)
Level 3: Individual items (colored text only)
```

**Typography Scale:**
```typescript
- Title: bold + color
- Heading: bold
- Body: normal
- Caption: dim
- Code: different color
```

## Questions to Answer

1. **Who is the user?**
   - Developer (you) using it daily?
   - Others will use it?
   - Screenshots will be shared?

2. **What's the vibe?**
   - Professional/serious?
   - Playful/fun?
   - Minimal/zen?
   - Powerful/feature-rich?

3. **What matters most?**
   - Speed/efficiency?
   - Clarity/understanding?
   - Delight/enjoyment?
   - Consistency/polish?

4. **Terminal environment?**
   - Always PowerShell?
   - Various terminals (colors might break)?
   - Dark theme only?
   - Need light theme support?

## Current "Design" by Default

Right now it's:
- **Boxes everywhere** (because Ink makes it easy)
- **Rainbow colors** (because semantic colors are obvious)
- **No personality** (because emoji banned)
- **Functional** (because time-constrained)

This is fine for MVP, but if you want it to look good, we need to pick a direction.

## My Recommendation

**Go with Option 1 (Minimal) with touches of Option 3 (Personality)**

Why:
- You use it daily - speed matters more than decoration
- Less is more in terminals - boxes clutter the view
- Personality comes from messages, not decoration
- Easier to maintain (fewer components)
- Better terminal compatibility

**Action Items:**
1. Remove borders from list views (keep for modals/pickers only)
2. Better symbols (✓ ✗ → • etc)
3. Improve "little dude" animation (no emoji needed)
4. Consistent spacing scale
5. More personality in messages ("Extracting..." → "Chomping through videos...")

Want me to implement any of these changes?

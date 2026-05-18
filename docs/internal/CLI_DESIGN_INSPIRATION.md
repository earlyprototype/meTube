# CLI Design Inspiration - The Ink Greats

## Production Ink CLIs (The Heavy Hitters)

### Used By
- **GitHub Copilot CLI** - 1M+ users
- **Cloudflare Wrangler** - Dev platform CLI
- **Gatsby CLI** - Static site generator
- **Google Gemini CLI** - AI assistant
- **Anthropic Claude Code** - AI coding

## Component Ecosystem Analysis

### Most Popular Ink Components (npm stats)

1. **ink-spinner** - 1,304,504 weekly downloads
   - Multiple spinner types (dots, line, etc.)
   - Used during loading/processing
   - **Lesson:** People want visual feedback during waits

2. **ink-select-input** - 180,381 weekly downloads
   - Arrow keys or j/k navigation
   - Number keys for instant selection
   - Customizable indicators and items
   - **Lesson:** Interactive selection is core CLI UX

3. **ink-gradient** - 165 stars
   - Gradient text effects
   - **Lesson:** Visual polish matters, even in terminals

### Common Patterns from Popular CLIs

#### GitHub Copilot CLI
- Pixel art ASCII character (personality!)
- Clear "logged in as..." status
- Footer hints: `Ctrl+c Exit · Ctrl+r Collapse all`
- Markdown-formatted summaries
- Interactive yes/no/always approvals
- **Design:** Clean, professional, clear affordances

#### Vercel/Next.js CLI
- Minimal output by default
- Smart progress indicators
- Success checkmarks (✓)
- Muted secondary text
- URL outputs for quick access
- **Design:** Fast, informative, no clutter

## What Makes Ink CLIs Great?

### 1. Smart Spinners
Not just "Loading..." - tell a story:
```
▲ Vercel
○ Deploying...
○ Building...
○ Uploading...
✓ Deployed
```

### 2. Interactive Selection (The Core Pattern)
Everyone uses `ink-select-input` because it works:
- Arrow keys or vi keys (j/k)
- Numbers for quick selection
- Clear visual indicator (> or •)
- Show counts/metadata inline

### 3. Visual Hierarchy Without Borders
- Bold for titles
- Dim/gray for secondary info
- Color for state (not decoration)
- Whitespace for grouping (not boxes)

### 4. Personality Through Content
- GitHub Copilot: ASCII character + friendly messages
- npm: Quirky error messages
- Homebrew: "Pouring..." instead of "Installing..."
- **No emoji needed** - personality comes from words

### 5. Status Footer (The Pattern Everyone Uses)
```
╰─ 4 playlists • 71 videos • Press q to quit
```
Or
```
Ctrl+c Exit · ↑↓ Navigate · Enter Select
```

## Design Principles from the Greats

### DO:
1. **Spinners during all waits** (ink-spinner is popular for a reason)
2. **Interactive selection** (arrow keys + numbers)
3. **Status bars** (show context at bottom)
4. **Progressive disclosure** (show details on demand)
5. **Smart defaults** (make common case fast)
6. **Clear affordances** (always show available keys)
7. **Personality in messages** (not decoration)

### DON'T:
1. **Boxes everywhere** (use whitespace instead)
2. **Rainbow colors** (use color for meaning)
3. **Static output** (show live updates)
4. **Verbose by default** (show summary, details on request)

## The Ink Way

### Layout Philosophy
- Flexbox everywhere (just like web)
- `<Box>` for layout, `<Text>` for content
- Think React, not terminal escape codes

### Animation Pattern
```tsx
const [frame, setFrame] = useState(0);
useEffect(() => {
  const timer = setInterval(() => {
    setFrame(f => f + 1);
  }, 80);
  return () => clearInterval(timer);
}, []);
```

### State Management
Just React hooks:
```tsx
const [selected, setSelected] = useState(0);
const [items, setItems] = useState([]);
```

## Recommended Component Stack

### From npm (battle-tested)
1. **ink-spinner** - For all loading states
2. **ink-select-input** - For list selection (better than our custom one)
3. **ink-gradient** - For titles/headers (visual interest)
4. **ink-big-text** - For splash screens/success states
5. **ink-link** - For clickable URLs (terminal support)
6. **ink-progress-bar** - For file operations

### Custom Components We Need
1. **StatusBar** - Bottom context bar (common pattern)
2. **LiveProgress** - Real-time extraction updates
3. **KeyHints** - Always show available actions
4. **CompactList** - No borders, clean list view

## Steal From The Best

### Pattern: Vercel's Deploy Output
```
▲ Vercel
⠹ Inspecting...
✓ Inspected
⠹ Building...
✓ Built
⠹ Uploading...
✓ Ready! [2s]

https://your-app.vercel.app
```
**Why it's good:**
- Clear progression (spinner → checkmark)
- Time to completion
- Immediate output (the URL)

### Pattern: GitHub Copilot's Approval Flow
```
> Execute this command?
  cd /Users/you/project && npm install

  [Y] Yes   [A] Yes, always   [N] No

› 
```
**Why it's good:**
- Shows exactly what will happen
- Multiple options (not just yes/no)
- Keyboard shortcuts visible

### Pattern: npm's Smart Output
```
added 152 packages, and audited 153 packages in 3s

22 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```
**Why it's good:**
- Summary first (what happened)
- Secondary info (funding)
- Clear status (vulnerabilities)
- Next action hint

## Our Design Direction

Based on the greats, here's what we should do:

### 1. Replace Our Spinners
Use `ink-spinner` with different types:
- `dots` - General loading
- `line` - Fast operations
- `dots12` - Heavy operations (extraction)

### 2. Use ink-select-input
Our `PlaylistPicker` is reinventing the wheel. Use the battle-tested component.

### 3. Add Status Footer
Always show:
```
╰─ 4 playlists • 71 total videos • ↑↓ Navigate • Enter Select • q Quit
```

### 4. Improve Progress Display
Instead of boxes, show live list like Vercel:
```
Extracting Videos
⠹ [1/60] "Introduction to AI" (3:45)
✓ [2/60] "Machine Learning Basics" (8:12)
✓ [3/60] "Neural Networks" (12:34)
⠹ [4/60] "Deep Learning" (15:20)
```

### 5. Add Personality Through Messages
- "Chomping through videos..." instead of "Processing..."
- "Hunting for playlists..." instead of "Fetching..."
- "Whisper is having a think..." instead of "Transcribing..."

### 6. Smart Summaries
After extraction:
```
✓ Extraction complete! [2m 34s]

  60 videos processed
  58 transcripts generated
  2 failed (see log)

Next: metube report <playlist-id>
```

## Implementation Plan

### Quick Wins (30 min)
1. Add `ink-spinner` dependency
2. Replace our boring spinners
3. Add status footer to all interactive views
4. Remove unnecessary borders

### Better UX (1 hour)
1. Replace `PlaylistPicker` with `ink-select-input`
2. Improve `ProgressDisplay` with live updates
3. Add personality to all messages
4. Add "Next steps" hints to all commands

### Polish (2 hours)
1. Add `ink-gradient` for titles
2. Add `ink-big-text` for success states
3. Smart truncation for long titles
4. Clickable URLs with `ink-link`

## The Bottom Line

**People love these Ink CLIs because:**
1. They're **fast** (minimal output, smart summaries)
2. They're **clear** (always show what's happening)
3. They're **helpful** (show next steps, available keys)
4. They have **personality** (through words, not decoration)

**Let's steal all of this.**

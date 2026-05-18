# CLI Design Changes - Orange & Grey Implementation

## What Changed

### 1. Color System (`src-ts/utils/colors.ts`)
Created a centralized color palette with:
- **Orange** (`#FFA500`) - Primary/accent color for interactive elements
- **Grey** shades - For UI chrome and secondary information
- **Semantic colors** - Red/green/yellow for status only
- **Better symbols** - Unicode characters instead of ASCII

### 2. Component Updates

#### ErrorDisplay
**Before:**
- `X Error` - Plain ASCII
- Red border only

**After:**
- `✗ Error` - Proper unicode symbol
- Red border remains (semantic)
- Uses centralized color constants

#### StatusPanel
**Before:**
- Cyan headings
- `OK`, `!`, `X` - ASCII status
- Yellow for "checking" (confusing)

**After:**
- Orange headings
- `✓`, `⚠`, `✗` - Unicode symbols
- Orange for "checking" (information, not warning)
- Grey borders

#### ProgressDisplay
**Before:**
- Boring `o/O` animation
- `OK Success` / `X Failed` - ASCII
- Cyan headings
- Pipe separators

**After:**
- Rotating circle `◐◓◑◒` animation (completed: `◉`)
- `✓ Success` / `✗ Failed` - Unicode
- Orange headings
- Orange border (active operation)
- `•` bullet separators (cleaner)

#### PlaylistPicker
**Before:**
- `>` indicator (basic)
- Cyan for selected
- Cyan heading
- Arrow keys only
- Long help text

**After:**
- `▶` indicator (better arrow)
- Orange for selected (brand color)
- Orange heading
- Arrow keys + Vim keys (j/k)
- `q` to quit
- Compact footer: `↑↓ Navigate • j/k Vim keys • Enter Select • q Quit`
- Video count in grey (secondary info)

#### VideoTable
**Before:**
- Cyan headings
- Green/yellow status
- `OK Done` / `Pending`

**After:**
- Orange headings
- Green/orange status
- `✓ Done` / `... Pending` (with unicode)
- Grey borders
- Row numbers in grey (secondary)

## Visual Comparison

### Before (Cyan everywhere, ASCII symbols)
```
╭─────────────────────────────────────╮
│ Select a Playlist                   │ (cyan)
│                                     │
│   [1] Ai (60 videos)                │
│ > [2] Electronics (3 videos)        │ (cyan)
│   [3] FabLab (7 videos)             │
│                                     │
│ Use up/down arrows to navigate...  │
╰─────────────────────────────────────╯
```

### After (Orange/Grey, Unicode symbols)
```
╭─────────────────────────────────────╮ (orange border)
│ Select a Playlist                   │ (orange heading)
│                                     │
│   [1] Ai (60 videos)                │ (grey count)
│ ▶ [2] Electronics (3 videos)        │ (orange selected, grey count)
│   [3] FabLab (7 videos)             │
│                                     │
│ ↑↓ Navigate • j/k Vim • Enter • q  │ (grey footer)
╰─────────────────────────────────────╯
```

## Status Display

### Before
```
╭─────────────────────────╮
│ System Status           │ (cyan)
│                         │
│ OK Database (metube.db) │ (green)
│ OK YouTube API          │
│ X Whisper (Python venv) │ (red)
╰─────────────────────────╯
```

### After
```
╭─────────────────────────╮ (grey border)
│ System Status           │ (orange heading)
│                         │
│ ✓ Database (metube.db)  │ (green)
│ ✓ YouTube API           │
│ ⚠ Whisper (Python venv) │ (orange warning, not red error)
╰─────────────────────────╯
```

## Progress Display

### Before
```
╭───────────────────────────────╮
│ Extracting Videos             │ (cyan)
│ Progress: [####------] 4/10   │
│ o Current: Introduction to AI │ (boring o/O)
│ OK Success: 3 | X Failed: 0   │
╰───────────────────────────────╯
```

### After
```
╭───────────────────────────────╮ (orange border)
│ Extracting Videos             │ (orange heading)
│ Progress: [####------] 4/10   │
│ ◓ Current: Introduction to AI │ (rotating circle)
│ ✓ Success: 3 • ✗ Failed: 0    │ (better symbols)
╰───────────────────────────────╯
```

## Key Improvements

### Color Usage
- **Orange** = Interactive, selected, active, informational
- **Grey** = UI chrome, borders, secondary text, inactive
- **Green** = Success only (not overused)
- **Red** = Errors only (not warnings)
- **No cyan** = Replaced with orange (brand consistency)

### Symbols
- `✓` instead of `OK` (cleaner)
- `✗` instead of `X` (better cross)
- `⚠` instead of `!` (clearer warning)
- `▶` instead of `>` (better arrow)
- `•` instead of `|` (softer separator)
- `◐◓◑◒` instead of `o/O` (actual animation)

### UX Improvements
- **Vim keys** (j/k) added to all interactive components
- **Shorter help text** using symbols instead of words
- **Visual hierarchy** through color (orange = important, grey = secondary)
- **Consistent borders** (orange = active, grey = passive)
- **Better contrast** for accessibility

## Testing

Test the new design:

```bash
# See status panel
npm run dev:init

# See playlist picker (orange/grey colors)
npm run dev:discover

# See video list
npm run dev:list

# See progress display (when extraction runs)
npm run dev -- extract playlist <id>
```

## Files Modified

1. **New:**
   - `src-ts/utils/colors.ts` - Color system

2. **Updated:**
   - `src-ts/components/ErrorDisplay.tsx`
   - `src-ts/components/StatusPanel.tsx`
   - `src-ts/components/ProgressDisplay.tsx`
   - `src-ts/components/PlaylistPicker.tsx`
   - `src-ts/components/VideoTable.tsx`

## Next Steps (Optional Polish)

### Already Done
- ✓ Orange/grey palette implemented
- ✓ Unicode symbols throughout
- ✓ Vim keys support
- ✓ Compact help text
- ✓ Better borders
- ✓ Rotating animation

### Could Add Later
- `ink-gradient` for titles (gradient effect)
- `ink-big-text` for success screens (ASCII art)
- `ink-link` for clickable URLs
- Clickable terminal links to videos
- More sophisticated progress animations
- Custom spinner types per operation

## The Result

A more **professional**, **consistent**, and **visually distinct** CLI that:
- Uses orange as the brand color
- Reserves semantic colors (red/green) for actual status
- Has better visual hierarchy through grey
- Uses proper Unicode symbols
- Supports both arrow and Vim keys
- Has cleaner, more compact UI

No gimmicks, no cringe - just solid design.

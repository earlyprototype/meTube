# MeTube TUI Design Examples

This document showcases the three-panel layout structure (Sidebar | Main Content | Input) applied to different views within MeTube.

## Design Principles

- **Sidebar (Left)**: Navigation, recent commands, and status information
- **Main Content (Centre)**: Primary interactive content and data display
- **Input Bar (Bottom)**: Command prompt and user input

## Color Scheme

- **Orange on Dark Grey**: Primary headers (METUBE logo, COMMANDS, STATUS, metube>)
- **Cyan on Dark Grey**: Secondary headers and interactive elements
- **Grey Borders**: Structural elements and boxes
- **Light Grey Text**: Content and metadata

---

## Example 1: Main REPL View (Current Implementation)

```
╔════════════════════════════════════════════════════════════════════╗
║ ███╗   ███╗███████╗████████╗██╗   ██╗██████╗ ███████╗              ║
║ ████╗ ████║██╔════╝╚══██╔══╝██║   ██║██╔══██╗██╔════╝              ║
║ ██╔████╔██║█████╗     ██║   ██║   ██║██████╔╝█████╗                ║
║ ██║╚██╔╝██║██╔══╝     ██║   ██║   ██║██╔══██╗██╔══╝                ║
║ ██║ ╚═╝ ██║███████╗   ██║   ╚██████╔╝██████╔╝███████╗              ║
║ ╚═╝     ╚═╝╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚══════╝              ║
║        YouTube Video Extraction & Analysis CLI                     ║
╚════════════════════════════════════════════════════════════════════╝

╔══════════════╦═══════════════════════════════════════════════════╗
║ COMMANDS     ║                                                   ║
║   init       ║   [Clean empty workspace]                         ║
║   discover   ║                                                   ║
║   playlist   ║                                                   ║
║   extract    ║                                                   ║
║   report     ║                                                   ║
║              ║                                                   ║
║ RECENT       ║                                                   ║
║   playlist.. ║                                                   ║
║   extract    ║                                                   ║
║              ║                                                   ║
║ STATUS       ║                                                   ║
║   Auth: Yes  ║                                                   ║
║   7 Lists    ║                                                   ║
║   120 Vids   ║                                                   ║
╠══════════════╩═══════════════════════════════════════════════════╣
║ metube> _                                                         ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Use Case**: Default startup view after splash screen
**Key Features**:
- Clean, uncluttered starting point
- Quick access to all commands via sidebar
- Status overview at a glance

---

## Example 2: Interactive Report Viewer - Playlist Overview

```
╔══════════════╦═══════════════════════════════════════════════════╗
║ PLAYLISTS    ║ Report: AI Playlist Analysis                      ║
║ > AI (60)    ║                                                   ║
║   Cars (3)   ║ Total Videos: 60                                  ║
║   DIY (12)   ║ Total Duration: 8h 24m                            ║
║   Gold (15)  ║ Date Range: Jan 2024 - Dec 2025                   ║
║              ║                                                   ║
║ FILTERS      ║ Top Topics:                                       ║
║   Duration   ║   • Machine Learning (24 videos)                  ║
║   Date       ║   • Neural Networks (18 videos)                   ║
║   Topic      ║   • Computer Vision (12 videos)                   ║
║              ║                                                   ║
║ EXPORT       ║ Channels:                                         ║
║   CSV        ║   1. Two Minute Papers (15 videos)                ║
║   JSON       ║   2. Lex Fridman (8 videos)                       ║
║   Markdown   ║   3. Yannic Kilcher (7 videos)                    ║
║              ║                                                   ║
║ STATUS       ║ Extracted Entities:                               ║
║   Auth: Yes  ║   • 45 GitHub Repos                               ║
║   7 Lists    ║   • 89 Papers                                     ║
║   120 Vids   ║   • 124 URLs                                      ║
╠══════════════╩═══════════════════════════════════════════════════╣
║ report> export csv                                                ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Use Case**: High-level playlist analysis and reporting
**Key Features**:
- Sidebar shows available playlists with video counts
- Quick filtering and export options
- Main area shows aggregate statistics and insights
- Interactive drill-down capabilities

---

## Example 3: Interactive Report Viewer - Video List View

```
╔══════════════╦═══════════════════════════════════════════════════╗
║ PLAYLISTS    ║ Videos in AI Playlist (60)                        ║
║ > AI (60)    ║                                                   ║
║   Cars (3)   ║ > [1] Attention Is All You Need (12:34)           ║
║   DIY (12)   ║     Two Minute Papers • 2024-03-15                ║
║   Gold (15)  ║     Topics: Transformers, Attention               ║
║              ║                                                   ║
║ SORT BY      ║   [2] GPT-4 Architecture Explained (18:22)        ║
║   Date       ║     Yannic Kilcher • 2024-02-28                   ║
║   Duration   ║     Topics: GPT, Language Models                  ║
║   Channel    ║                                                   ║
║   Title      ║   [3] Diffusion Models from Scratch (25:41)       ║
║              ║     Lex Fridman • 2024-01-12                      ║
║ FILTER       ║     Topics: Diffusion, Image Generation           ║
║   <15min     ║                                                   ║
║   15-30min   ║   [4] Self-Supervised Learning (14:56)            ║
║   >30min     ║     Two Minute Papers • 2023-12-20                ║
║              ║                                                   ║
║ STATUS       ║   ↓ More below (56 more videos)                   ║
║   60 Videos  ║                                                   ║
║   8h 24m     ║   ↑↓ Navigate • Enter Details • q Back            ║
╠══════════════╩═══════════════════════════════════════════════════╣
║ report> filter 15-30min                                           ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Use Case**: Browsing and filtering videos within a playlist
**Key Features**:
- Sidebar provides sorting and filtering controls
- Main area shows paginated video list
- Each video shows key metadata (duration, channel, date, topics)
- Navigation similar to playlist picker
- Can drill down into individual videos

---

## Example 4: Interactive Report Viewer - Video Details & Entities

```
╔══════════════╦═══════════════════════════════════════════════════╗
║ SECTIONS     ║ Attention Is All You Need                         ║
║ > Overview   ║                                                   ║
║   Transcript ║ Two Minute Papers • 2024-03-15 • 12:34            ║
║   Entities   ║                                                   ║
║   Timeline   ║ Description:                                      ║
║              ║ A deep dive into the transformer architecture...  ║
║ ACTIONS      ║                                                   ║
║   Open YT    ║ Topics: Transformers, Attention Mechanism         ║
║   Copy URL   ║                                                   ║
║   Export     ║ Extracted GitHub Repositories:                    ║
║              ║   1. google-research/bert                         ║
║ NAVIGATE     ║      ⭐ 12.4k • Python • Apache-2.0               ║
║   Prev Video ║      BERT: Pre-training of Deep Bidirectional..  ║
║   Next Video ║                                                   ║
║   Back List  ║   2. huggingface/transformers                     ║
║              ║      ⭐ 89.2k • Python • Apache-2.0               ║
║ STATUS       ║      State-of-the-art NLP library                ║
║   Video 1/60 ║                                                   ║
║   AI List    ║   3. pytorch/pytorch                              ║
║              ║      ⭐ 67.8k • Python • BSD-3-Clause             ║
║              ║      Tensors and Dynamic neural networks          ║
║              ║                                                   ║
║              ║ Referenced Papers:                                ║
║              ║   • Attention Is All You Need (Vaswani et al.)    ║
║              ║   • BERT (Devlin et al.)                          ║
╠══════════════╩═══════════════════════════════════════════════════╣
║ video> open github 1                                              ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Use Case**: Deep dive into a single video's extracted data
**Key Features**:
- Sidebar shows sections and navigation options
- Main area shows detailed video information
- Extracted entities (GitHub repos, papers) with metadata
- Action commands to open external links
- Easy navigation between videos

---

## Implementation Notes

### Shared Components
All views share these core components:
- `Sidebar.tsx` - Adaptable sidebar with configurable sections
- `ReplMode.tsx` - Main container managing layout
- `ReplShell.tsx` - Command input at bottom

### View-Specific Components
Each view type needs:
1. **Playlist Overview**: `ReportOverview.tsx`
2. **Video List**: `ReportVideoList.tsx` (similar to `PlaylistPicker.tsx`)
3. **Video Details**: `ReportVideoDetail.tsx`

### Navigation Flow
```
report playlist AI
  └─> Playlist Overview (Example 2)
      └─> videos (command or action)
          └─> Video List (Example 3)
              └─> select video
                  └─> Video Details (Example 4)
```

### Color Consistency
- **Orange + Dark Grey**: Navigation headers, main logo, prompt
- **Cyan + Dark Grey**: Content headers, selected items, active states
- **Grey**: Borders and structure
- **White/Light Grey**: Content text
- **Dim Grey**: Metadata and hints

---

## Future Enhancements

### Potential Additional Views
1. **GitHub Repository Browser**: Browse all extracted repos across all playlists
2. **Paper Library**: Academic papers extracted from descriptions
3. **Timeline View**: Videos arranged chronologically
4. **Channel Analysis**: Aggregate stats by channel
5. **Search Interface**: Full-text search across transcripts

### Interactive Features
- Export filtered/sorted results
- Tag and annotate videos
- Create custom collections
- Batch operations (mark as watched, add to queue, etc.)

---

## Accessibility

All views maintain:
- Keyboard navigation (arrows, vim keys, shortcuts)
- Clear visual hierarchy
- Consistent color usage for meaning
- Helpful hints at bottom of each view
- Escape/back mechanisms

---

*Last Updated: 2026-01-26*

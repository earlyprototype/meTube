# meTube Report Design System

An importable component library for the meTube HTML reports. It is the same
design system the reports render from — tokens and components lifted out of
`templates/partials/` and the two report templates into self-contained preview
files that Claude Design can index.

## What's here

```
design-system/
├── tokens.json          # design tokens parsed from design-tokens.hbs
├── components/          # one self-contained preview per component
│   ├── _tokens.html         group="Foundations"   token/type/spacing reference
│   ├── video-section.html   group="Video Report"
│   ├── video-entity-tag.html
│   ├── video-entity-link.html
│   ├── video-stat-box.html
│   ├── playlist-video-card.html  group="Playlist Report"
│   ├── playlist-repo-card.html
│   ├── playlist-stat-card.html
│   └── playlist-topic-tag.html
└── README.md
```

Each preview is a complete tiny HTML document with the design tokens and the
component's own CSS inlined, and the component rendered with realistic sample
data (no Handlebars tags left — the partials are rendered to static HTML).
Video components sit on the light theme; playlist components carry
`data-theme="glass"` and sit on the dark glass theme, so every card looks
correct in isolation.

## Groups

The Design System pane organises cards by their `group`:

| Group | Cards | Theme |
|-------|-------|-------|
| **Foundations** | `_tokens` | light reference |
| **Video Report** | section, entity-tag, entity-link, stat-box | light (`:root`) |
| **Playlist Report** | video-card, repo-card, stat-card, topic-tag | glass (`[data-theme="glass"]`) |

## How Claude Design indexes this

Each preview's **first line** is a marker comment:

```html
<!-- @dsCard group="Video Report" -->
```

Claude Design's Design System pane runs a self-check that scans these
`@dsCard` markers and compiles them into `_ds_manifest.json`. You do **not**
write or commit the manifest — it is generated. To add a component, drop a new
preview HTML whose first line is a `@dsCard` marker; to change how a card is
grouped, edit the `group` value.

## Importing into Claude Design

**Path A — import from this repo/directory.** Point Claude Design's "Import
design system" at this `design-system/` directory (or its GitHub URL). The
self-check reads every `components/*.html` first line, builds the manifest, and
the cards appear in the Design System pane grouped as above.

**Path B — `/design-sync` from Claude Code.** Run `/design-sync` in this
project. It syncs the `design-system/` previews into Claude Design and
regenerates the manifest from the `@dsCard` markers in place.

## Editing tokens

`tokens.json` is a faithful parse of `templates/partials/design-tokens.hbs`,
which remains the runtime single source of truth — both reports inline it via
`{{> designTokens}}`. Change a value in the `.hbs` file, then reflect it in
`tokens.json` and re-render the previews so the library stays in step with the
reports.

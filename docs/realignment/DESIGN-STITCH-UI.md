# Design Direction — Stitch-style UI (owner-approved 2026-11-07)

Owner provided Google Stitch screenshots as the exact look for the 8-page
platform frontend: dark, calm, project-first. During cloning the same
aesthetic holds ("kaam krte vakt to exact vaisa hi rhega") — the swarm build
viewer lives inside this shell, not beside it.

## Observed Stitch anatomy (from the owner's screenshots)

- **Canvas**: near-black `#0d0e10` with a subtle dot grid (1px dots,
  rgba(255,255,255,.05), ~24px spacing) — the signature texture.
- **Left sidebar** (~300px, `#131418`): nav pills — active "My Projects" pill
  (`#1d1f24`, rounded-full), "Shared with me"; search input (rounded-xl,
  borderless); project list grouped **Recent** / **This Year** — thumbnail
  (rounded-lg, 48px), project name, small muted date.
- **Main area**: huge light heading ("Welcome to Stitch..", ~64-72px,
  weight 300-400, tight leading), top-right two pill buttons (+ Start with
  your design, + Blank project) with 1px `#2a2c33` border, transparent bg.
- **Central prompt box** (the hero): rounded-3xl (~28px) dark card
  (`#141519`) with a **1px gradient glow border** (blue→purple, ~20% alpha),
  placeholder "What native mobile app shall we design?", bottom row: + attach,
  App/Web segmented toggle (active pill `#26282e`), palette icon,
  "Balanced ⌄" quality dropdown, magic-wand icon, circular send button.
- **Type**: Google-Sans-class geometric sans; generous whitespace; text
  #e8eaed primary / #9aa0a6 muted.

## Mapping to the 8 product pages

| Page | Stitch element it takes |
|---|---|
| 1 Projects Dashboard | THE home: sidebar + grouped clone-project list + central prompt box ("What website shall we clone?" + Web toggle) — New Clone flow lives IN the box |
| 2 New Clone | Prompt box expanded: URL + credentials (masked) + instructions + framework + Start Exploration; "Blank project" pill opens it focused |
| 3 Live Exploration Workspace | Same shell, central stage = live screenshot stream + event timeline; sidebar shows the active job |
| 4 Website Intelligence | Sidebar list → intel cards in the main column (routes, tokens, coverage) |
| 5 Clone Blueprint | Prompt box becomes the blueprint card (scope include/exclude, regions, ambiguities) with Approve |
| 6 Reconstruction Workspace | Central stage = swarm build animation (already built at /progress) + stage pills; **exact same shell while working** |
| 7 Comparison & QA | Two-up screenshot cards on the dark canvas |
| 8 Final Project | Project card like a Stitch project row: preview thumb, Download/Publish pills |

## Token contract (design-tokens.css, primitive→semantic)

```css
--color-bg: #0d0e10;      --color-surface: #131418;  --color-card: #141519;
--color-border: #26282e;  --color-text: #e8eaed;     --color-muted: #9aa0a6;
--color-accent: #8ab4f8;  /* Stitch blue */ --accent-2: #c58af9;
--radius-card: 28px; --radius-pill: 999px; --radius-thumb: 12px;
--grid-dot: rgba(255,255,255,.05);  /* 24px dot-grid canvas overlay */
```

Rules: no raw hex outside design-tokens.css; every card/pill uses semantic
vars; the dot-grid is one body::before overlay, not per-page CSS; headings
weight 300-400 only. Slop-lint's catalog is the taste gate (no generic
purple gradients — the ONE sanctioned gradient is the prompt-box glow border).

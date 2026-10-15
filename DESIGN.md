# Design System - Bored@Work

This file describes the app **as it is built** (`app/globals.css`, `app/layout.tsx`).
When the code and this file disagree, fix whichever one is wrong in the same change;
do not let them drift apart again.

## Product Context
- **What this is:** A tournament-style office voting app with a public landing page, a public voting page (`/voting`), and an admin portal (`/admin`) for running tournaments and players.
- **Who it's for:** Small workplace teams running internal morale boosts, recurring bracket games, and lightweight department-wide debates. Admins are organisers, not developers.
- **Project type:** Hybrid landing page plus app UI.

## Aesthetic Direction
- **Direction:** Dark sports-broadcast scoreboard. Near-black surfaces, one bright lime accent, bold condensed-feeling display type.
- **Mood:** Punchy, live, a little playful. It should feel like a scoreboard during a game, not a spreadsheet.
- **Theme:** Dark only. There is no light theme; do not add one unless asked.

## Typography
- **Display:** `Syne` 700/800 (`--font-display`). Used for page and panel titles, stats, buttons, and score-style emphasis. Panel titles are uppercase with tight tracking (`-0.04em`).
- **Body / UI / data:** `DM Sans` (`--font-body`). Used for paragraphs, labels, helper text, tables.
- **Code / URLs / tokens:** browser monospace.
- **Loading:** `next/font/google` in `app/layout.tsx`.

## Color
Tokens live on `.bw-vote-app, .bw-admin-app` (and the landing page's `:root` mirrors them).

| Token | Value | Role |
|-------|-------|------|
| `--bw-bg` / `--bw-bg2` | `#0d0d10` / `#111116` | Page background |
| `--bw-card` / `--bw-card2` | `#18181f` / `#1e1e27` | Cards, inset rows |
| `--bw-border` | `rgba(255,255,255,0.07)` | Hairline borders |
| `--bw-white` | `#f0f0ee` | Primary text |
| `--bw-muted` | `#555568` | Secondary text, neutral tags |
| `--bw-lime` | `#c8f53c` | **The accent.** Primary action buttons (`.bw-btn-lime`), live / voted / positive state |
| `--bw-coral` | `#ff5e3a` | Attention: pending, needs review, flags |
| `--bw-gold` | `#f5c842` | Notable but not urgent: highlights, "hidden" name state, medium flags, countdowns |
| `--bw-danger` | `#ff3a3a` | Destructive actions and the Danger area only |
| `--bw-purple` | `#9b6dff` | Rare decorative accent; do not use for meaning |

Rules:
- **Lime means "go" or "good".** Use it for the one primary action on a screen and for live/positive status. Do not use lime for neutral information.
- **Neutral status uses `.bw-tag-muted`.** A badge that is just a fact (e.g. "Visible", "Nothing suspicious") is muted, not lime.
- **Coral asks for attention, red is destructive.** Never use red for something that is merely pending.
- One accent colour per element; no gradients on new UI.

## Components (existing classes to reuse)
- Buttons: `.bw-btn` + `.bw-btn-lime` (primary), `.bw-btn-outline` (secondary), `.bw-btn-danger` / `.bw-btn-danger-solid` (destructive). Group with `.bw-btn-row`.
- Tags: `.bw-tag` + `.bw-tag-lime` / `.bw-tag-coral` / `.bw-tag-gold` / `.bw-tag-muted`. Pill shaped, small uppercase.
- Surfaces: `.bw-card`, `.bw-section-panel` with `.bw-panel-title` + `.bw-panel-sub`.
- Admin layout: `.bw-admin-app` > `.bw-admin-nav` + `.bw-admin-main` (`.bw-sidebar` + `.bw-admin-content`).

## Spacing and shape
- **Base unit:** 8px; comfortable density.
- **Radius:** pills `999px`; buttons, inputs and rows `10-12px`; cards `14-16px`.
- **Max content width:** `1200px`.

## Motion
- Micro interactions `150-200ms` ease; reveals up to `600ms`.
- Motion supports the "live tournament" feel (countdowns, live dots); never decorative loops on admin screens.

## Layout
- Mobile first where players use it (`/voting`): single column, large tap targets.
- Admin: sidebar + content on desktop, stacking to one column under `760px`.
- Phone width: 16px side gutters, no horizontal page scroll.

## Rules
- Reuse the classes above before adding new ones; new classes use the `bw-` prefix and the tokens, never raw hex.
- Admin copy is for organisers: say what a control does in plain words ("End round now", not "Force advance").
- Show a control only when it can work in the current state.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-21 | Restored the warm paper visual system from the provided reference file | User asked for the site to match the exact supplied design |
| 2026-04-21 | Standardized on Barlow Condensed + Instrument Sans | Matches the supplied layout and preserves the sports-bracket feel |
| 2026-10-15 | Rewrote this file to match the live app: dark theme, lime accent, Syne + DM Sans | The app moved to the dark scoreboard look; the old light/cream spec no longer described anything in the code and reviewers were enforcing it against new work (Gabe approved) |

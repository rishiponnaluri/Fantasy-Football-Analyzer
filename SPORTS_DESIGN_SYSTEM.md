# Sports design system — Sunday Broadcast

This is the visual contract for the isolated `ui-sports-overhaul-v2` experiment. It changes presentation only; existing data, hooks, routes, actions, and numerical services remain the source of truth.

## Principles

- Make the user's matchup and player activity feel like live football coverage.
- Put scores, player names, and slot identity ahead of metadata.
- Give each page its own sports composition. Do not turn every page into a card grid.
- Use gradients to describe an object: a team side, win-probability field, player hero, or selected navigation state.
- Show secondary analysis after interaction, not as a default wall of numbers.
- Preserve all existing action targets and factual/provider boundaries.

## Color

| Token | Value | Use |
| --- | --- | --- |
| `--stadium` | `#070807` | page background |
| `--tunnel` | `#0B0D0B` | top-level navigation / masthead |
| `--bench` | `#111411` | quiet surface |
| `--sideline` | `#181C18` | raised/interactive surface |
| `--chalk` | `#F3F1E8` | warm primary text |
| `--ash` | `#A5AA9E` | secondary text |
| `--fog` | `#73796E` | tertiary text |
| `--acid` | `#D6FF4B` | selected / positive action |
| `--chartreuse` | `#A6FF3F` | active gradient midpoint |
| `--emerald` | `#1ECF78` | gradient end / live emphasis |
| `--warning` | `#F1B760` | caution |
| `--danger` | `#F17872` | unavailable / destructive |
| `--rule` | `rgba(243,241,232,.11)` | separators |

Primary gradient: `linear-gradient(105deg, var(--acid) 0%, var(--chartreuse) 48%, var(--emerald) 100%)`. Use the gradient on an interactive or broadcast object, never as a repeated border decoration. Team colors are supplied by the provider and should stay inside team-identity zones.

## Typography

- Display / score face: Barlow Condensed for large scores, projected totals, and the brand wordmark only.
- Interface / body: [IBM Plex Sans](https://github.com/IBM/plex) for player and team names, page and section headings, navigation, controls, and explanatory text. IBM Plex is licensed under the [SIL Open Font License](https://github.com/IBM/plex/blob/master/packages/plex-sans/LICENSE.txt).
- Scores use tabular lining numerals and tight tracking. They should be the largest element on score surfaces.
- Player and team names use strong mixed-case typography; metadata is quieter and brief.
- Section labels may use uppercase selectively, but headlines are not all-caps by default.

## Spacing and shape

- Base rhythm: 4 / 8 / 12 / 18 / 24 / 32 / 48 / 64 px.
- Use open space around editorial sections and thin neutral separators between rows.
- Compact controls: 7–10 px radius. Interactive tiles: 12–16 px. Large sheets: 18–22 px.
- Do not wrap every section in a bordered rounded rectangle. Let score fields, rails, tables, and dividers carry layout.
- Shadows are broad and low-contrast only for overlays and floating navigation; no neon glow.

## Navigation

- Desktop: one sports masthead, not a permanent sidebar. Wordmark on the left, primary football destinations centered, current league/week/live/refresh context on the right. A thin secondary strip may hold less-frequent destinations.
- Mobile: dedicated bottom navigation with Home, Team, Players, Moves, More. The More action exposes Start/Sit, League Matchups, Predictions, and NFL Schedule without squeezing desktop labels.
- Active navigation uses an acid-to-emerald underline/field, not a blue highlight or tiny icon rail.

## Team identity and imagery

- Fantasy matchups and trade counterparties use the fantasy team's ESPN logo/accent.
- NFL players and NFL games use NFL team metadata and logo.
- Never use NFL colors as a fantasy manager identity or fantasy colors as an NFL player identity.
- Player photos: row 56–72 px, featured 88–128 px, profile hero larger. Keep natural headshot crop; D/ST uses its official team logo.
- Headshot remains a button for Quick View; name remains a profile link; status remains the status-sheet action; saved control remains the watchlist action.

## Score hierarchy

1. Game state and score/projection relevant to that state.
2. Team identity and opponent.
3. Win chance and remaining-player context.
4. Expanded details and methodology.

Final matchups emphasize actual scores and winner. Live matchups emphasize current score/state. Pregame matchups emphasize projections and the probability bar. The probability marker stays exactly at the numeric boundary.

## Motion and responsive behavior

- Motion range: 140–220 ms, with eased entrances for sheets, selection, score transitions, and nav. Honor `prefers-reduced-motion`.
- Horizontal player rails scroll inside their own viewport and never widen the page.
- Desktop: use wide score stages and asymmetric content columns.
- Tablet: reduce masthead nav density, preserve two-sided team score composition, and collapse the action rail as needed.
- Mobile: event first, not a mechanically stacked desktop grid. Keep scores and team names legible, rails horizontal, and bottom nav above the safe area.

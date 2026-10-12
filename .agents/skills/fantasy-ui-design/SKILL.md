---
name: fantasy-ui-design
description: Apply whenever changing the Fantasy Football Analyzer's UI or UX, including frontend styling, responsive layout, animation, player cards, modals, overlays, navigation, or visual polish. Preserve fantasy and backend behavior unless explicitly asked to change it.
---

# Fantasy UI Design

Use this skill for visual or interaction work in this repository. Treat existing UI components as replaceable presentation, while preserving their data bindings and user-facing behavior.

## Preserve behavior

- Do not change backend logic, fantasy calculations, projections, confidence, lineup rules, trade or waiver logic, provider integrations, caching, or API behavior unless the user explicitly asks.
- Reuse existing data, hooks, state, actions, routes, and API calls. Replace visual components when needed to achieve the requested composition.
- Preserve established interactions such as player Quick View, full profile, status details, saved players, filters, and week selection.
- Use only provider-supported player and injury information. Do not invent status, news, return dates, or statistics.

## Visual direction

- Favor a compact, polished consumer sports product that is quick to scan. Keep page composition specific to its job: scoreboard, roster, discovery, marketplace, decision tool, trade desk, or NFL schedule.
- Use dark navy/charcoal surfaces, readable simple typography, and NFL/fantasy team colors for identity. Lime is a restrained interaction accent, not a default color for every label or surface.
- Prefer compact player cards and clear information zones. As a starting point, dashboard player tiles can be about 210–250px wide and 250–310px tall; roster starter tiles can be smaller, around 180–220px wide and 220–270px tall. Adapt these to the actual viewport and content.
- Avoid generic AI dashboard patterns: giant empty cards, repeated card grids, excessive pills, neon glow, glassmorphism, heavy borders, and unnecessary all-caps labels. Never introduce betting controls or gambling mechanics.
- Show the primary decision first. Put secondary and technical stats behind concise expandable details.
- Do not add a dependency unless it solves a specific UI problem that cannot be handled well with the existing stack.

## Shared interactions

- Desktop Player Quick View should be a compact floating overlay, typically 520–680px wide and no taller than about 80vh. Keep its player/team identity and useful fantasy metrics visible without turning it into a full-screen profile.
- Close overlays through a visible close control, backdrop click, and Escape. Closing must return to the previous page and preserve its scroll position. Avoid stacking Quick View and Status overlays; switch to the relevant overlay when practical.
- On mobile, use a bottom sheet when appropriate, capped around 85–90vh, with a usable close control and backdrop dismissal.
- Keep motion short and purposeful, and honor `prefers-reduced-motion`.
- My Team must retain actual fantasy lineup slots and their order, with starters clearly distinguished from bench and injured reserve.
- Desktop navigation should directly expose Dashboard, My Team, Players, Waivers, Start/Sit, Trades, League, Predictions, and NFL. Mobile may group less-used destinations under More.

## Visual verification

- Run the app and inspect the actual page after changing its presentation; source changes and passing tests alone do not prove the visual result.
- Check responsive layouts at 1440×900 and 390×844. Look for clipped text, broken team names, accidental page-wide horizontal overflow, obscured content, and overlays that do not fit.
- Exercise the relevant interactions, including click-outside and Escape for overlays, and confirm the underlying page state is preserved.
- Capture screenshots for substantial visual changes and review them before declaring the work complete. Report any viewport or interaction you could not verify.
- Run the relevant frontend checks and tests. Since this skill is presentation-focused, do not modify numerical logic to satisfy visual acceptance criteria.

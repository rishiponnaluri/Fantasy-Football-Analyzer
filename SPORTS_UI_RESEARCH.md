# Sports UI research

Research completed before Stage 1 implementation on `ui-sports-overhaul-v2` (October 2026). The references below informed interaction and visual decisions only. No source code, brand assets, team marks, photographs, or proprietary layouts were copied.

## GitHub sports projects

### Scoreboards

- Repository: [Zaker237/scoreboardsweb](https://github.com/Zaker237/scoreboardsweb)
- Demo: [scoreboards.cm](https://scoreboards.cm/)
- License: MIT (confirmed in the repository's `LICENSE` file).
- Observed: responsive football scoreboard with live/upcoming/finished states, competition discovery, date selection, score rows, and event detail.
- Useful: date and game-state controls sit close to the score feed; rows make live status and score readable without opening every game.
- Not useful for this app: the demo's competition sidebar and three-column panel arrangement still feels like a generic dashboard, and the repeated panel treatment weakens game hierarchy.
- Influence: use state-first score ordering and compact score rows, while building a single sports masthead and page-specific compositions rather than copying its panels.
- Code adapted: no.

### SPORTS

- Repository: [vincenzo-afk/SPORTS](https://github.com/vincenzo-afk/SPORTS)
- License: MIT (repository `LICENSE` and GitHub license metadata checked).
- Observed: responsive, dark live-score center with match state filters, events, standings, favorites, and match details. Its type and data contracts are typed for React and TypeScript.
- Useful: LIVE / UPCOMING / FINISHED is treated as a first-class organizing dimension; score and clock lead, with lineups and event context revealed deeper in the match view.
- Not useful for this app: a broad multi-sport control surface would be excessive for a focused fantasy-football home screen.
- Influence: state-specific hierarchy and progressive detail; no copied visual components.
- Code adapted: no.

### Football Dashboard React

- Repository: [sanginchun/football-dashboard-react](https://github.com/sanginchun/football-dashboard-react)
- License: no license file was found in the repository root or GitHub license metadata. Treat as all-rights-reserved; no source or assets reused.
- Observed: React SPA for league/team exploration with routed league, team, and home views.
- Useful: the domain is separated into league and team destinations, which helps navigation stay sports-oriented rather than tool-oriented.
- Not useful for this app: the project is older, its README calls out mobile view as future work, and its sidebar/cards are close to the app structures we are moving away from.
- Influence: only the idea that league and team should be direct destinations; no code adapted.
- Code adapted: no.

### Campos

- Repository: [withqwerty/campos](https://github.com/withqwerty/campos)
- Documentation: [campos.withqwerty.com](https://campos.withqwerty.com)
- License: MIT (repository `LICENSE` checked).
- Observed: React-first TypeScript football visualization components.
- Useful: sports visuals should be built from domain primitives (field, match, player, and stat) rather than one universal dashboard card.
- Not useful for this task: this app's NFL/fantasy data models differ, so importing a component package would add code and constrain the design.
- Influence: use named sports primitives such as scoreboard stages, lineup lanes, and player spotlights as our own components.
- Code adapted: no.

## Public sports products

### NFL.com Scores

- URL: [nfl.com/scores](https://www.nfl.com/scores)
- License: proprietary NFL site; visual reference only.
- Observed: a football-specific score center uses a week rail and day grouping; matchup rows combine team marks, compact names, strong score numerals, and broadcast/state treatment.
- Useful: date and week navigation are part of the schedule context, and team identity is carried by logos and color blocks rather than metadata labels.
- Not useful for this app: official NFL branding, advertising placements, and large editorial promotions do not belong in a fantasy product.
- Influence: condensed sports display typography, week-aware framing, confident score scale, and team color limited to the team zone.

### Sleeper Scores

- URL: [sleeper.com](https://sleeper.com/)
- License: proprietary product; visual reference only.
- Observed: dark fantasy-focused score center with a direct Scores entry, game/date grouping, team marks, live states, and compact matchup scanning.
- Useful: fantasy users can scan multiple live scores quickly without opening each matchup; the fantasy context remains visible around the scores.
- Not useful for this app: the dense multi-column presentation and blue-heavy palette are not the chosen direction.
- Influence: keep league activity and the personal matchup within one sports home, but give the user's matchup one bespoke broadcast composition.

### FotMob

- URL: [fotmob.com/live](https://www.fotmob.com/live)
- License: proprietary product; visual reference only.
- Observed: live/upcoming match list, date selection, favorites/competition filtering, and a match-center path for deeper detail.
- Useful: the list is organized around the event state and time, and the detail view is a deliberate next step rather than forcing every statistic into the feed.
- Not useful for this app: soccer-specific controls, league density, and its light/dark branding are not directly transferable.
- Influence: progressive disclosure and state-aware game rail; use fantasy matchup/player concepts instead of a copied fixture list.

### SofaScore

- URL: [sofascore.com](https://www.sofascore.com/)
- License: proprietary product; visual reference only.
- Observed: Today/live/finished filters, favorites and competition controls, score-first fixtures, and separate player/team/match centers.
- Useful: activity state filters remain close to the event list, while richer context is opened only for the selected event.
- Not useful for this app: the information density and broad all-sports navigation would overwhelm casual fantasy users.
- Influence: state is visible at a glance and details are opt-in; no component layout copied.

## Research decision

The experiment uses an original **Sunday Broadcast** direction: a sports-site masthead; a wide, asymmetrical fantasy scoreboard stage; a time-ordered game-day player rail; and a live/action column. Fantasy team identity owns the matchup colors, NFL team identity owns player accents, and the app's acid-lime-to-emerald range is reserved for controls, active state, and live emphasis. On mobile, the masthead collapses into a compact brand bar and a five-item bottom nav; the featured game remains the first and largest object.

This direction deliberately avoids the sidebar, interchangeable metric cards, and centered analytics-card layout used by the current interface. It uses event-shaped compositions—scoreboard, player rail, action feed, and score ticker—rather than adding a gradient to the old component tree.

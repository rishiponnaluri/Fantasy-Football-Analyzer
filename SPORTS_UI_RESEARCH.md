# Editorial Sports UI research

This research informed Stage 1 of `ui-editorial-sports-v3`. References were inspected for hierarchy and interaction patterns; no third-party code, logos, fonts, or artwork were copied.

## GitHub projects

| Project | URL | License | Observed ideas | Rejected / use here |
| --- | --- | --- | --- | --- |
| Scoreboards Web | https://github.com/Zaker237/scoreboardsweb | MIT | A compact competition selector paired with match rows makes live scores easy to scan without making every game a large widget. | Its component-library/shadcn presentation is not the visual template. Use only the score-first grouping idea. No code or assets adapted. |
| Fantasy Football Draft Toolkit | https://github.com/justinmck/fantasy-football-draft-toolkit | MIT | Dense player discovery benefits from clear identity first, then a few comparable stats and direct actions. | Do not reuse its draft-board layout or colors. Used as interaction reference only; no code adapted. |
| Campos | https://github.com/withqwerty/campos | MIT | Football-specific visualizations can encode team/game context directly rather than wrapping every value in a generic metric card. | Its visualization library is not used as a dependency. No code or assets adapted. |

Licenses were checked in each repository's license file/page before deciding not to copy implementation. All projects are permissively licensed, but this work uses them as references only.

## Public sports interfaces

These sites were visually inspected at their public pages on 2026-10-07. Their branding, layout, wording, and assets remain their own.

| Interface | URL | Specific observations | Rejected / concept for this app |
| --- | --- | --- | --- |
| ESPN | https://www.espn.com/ | Strong lead story and image own the page; score information is grouped tightly in a horizontal strip, while article hierarchy is carried by type and image size. | Do not reproduce ESPN's red identity or exact module arrangement. Borrow the contrast between a large feature and compact scores. |
| The Athletic | https://www.nytimes.com/athletic/ | Editorial headlines and a large lead image create a calm reading rhythm; scores sit in a compact live strip rather than competing as repeated dashboard cards. | Do not copy its publication branding or article grid. Use less chrome and more whitespace between distinct content zones. |
| NFL | https://www.nfl.com/ | Team marks and score/state carry the matchup; competition and week controls remain compact, and team color is localized to team identity. | Avoid the branded league artwork and exact scoreboard presentation. Keep team color attached to the matchup rather than the whole app. |
| Sleeper | https://sleeper.com/ | Dark fantasy product with quick score scanning and compact game rows; the team/player identity stays near the score. | Its dark navy, app-native density is too close to the previous dark product direction. Keep the scan speed but use warmer neutral surroundings. |
| FotMob | https://www.fotmob.com/ | Flat grouped match rows and clear team badges make many games scannable; its page gives editorial news a distinct column instead of turning everything into cards. | Avoid its football/soccer terminology and left-rail composition. Use flat grouped results and a separate visual feature. |
| Yahoo Sports | https://sports.yahoo.com/ | A lead image and a compact right-side live/news list separate reading from score scanning. | The page is visually busy and ad-led; do not adopt the banner density. Use the separation of feature and live feed. |
| CBS Sports | https://www.cbssports.com/ | Compact sport navigation and a small matchup strip coexist with a large editorial story and secondary headlines. | Avoid its exact dense nav and branded colors. Use hierarchy with one prominent visual story and quieter supporting content. |

## Stage 1 direction: Editorial Sports

The app shell uses graphite and warm charcoal, with warm white and gray type. Lime is reserved for interaction and live state. Fantasy-team and NFL colors provide local identity. Dashboard becomes a score-led broadcast composition placed directly on the page, with the player's game-day rail treated as a photographic feature. Players becomes a neutral discovery directory. Start/Sit becomes an editorial player comparison with the decision sentence between the two players. These are page-specific compositions; the goal is not to introduce a new universal card.

Typography stays with the already-loaded IBM Plex Sans for product text and Barlow Condensed only for score-scale numbers. The Stage 1 nav is a restrained top site menu on desktop and a compact bottom bar on mobile. Existing data hooks, actions, routes, click targets, and calculations remain the source of behavior.

# ESPN Fantasy Football backend

This backend reads your real ESPN league using `espn-api`. The Next.js frontend uses only this backend. There is no
mock data or fake fallback. The original `test_espn.py` and the backend share
`espn_connection.py` for configuration and team identification.

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
# If .env doesn't already exist, copy .env.example to .env and fill it in.
uvicorn main:app --host 127.0.0.1 --port 8000
```

Keep `ESPN_LEAGUE_ID`, `ESPN_YEAR`, `ESPN_S2`, and `ESPN_SWID` in your local `.env`
or server environment. Existing environment variables override `.env`.
`ESPN_YEAR` defaults to 2026. `ESPN_TEAM_ID` is an optional server-side override
if SWID cannot uniquely identify your fantasy team. `.env` is ignored by Git.

Local API documentation: http://127.0.0.1:8000/docs

| GET endpoint | Parameters and behavior |
| --- | --- |
| `/api/league` | League name, season, current week, allowed weeks, team count |
| `/api/teams` | All fantasy teams and owner names when provided by ESPN |
| `/api/my-team` | Your fantasy team and roster; optional `week` |
| `/api/fantasy-matchups` | Every fantasy contest; optional `week`, defaults to current |
| `/api/fantasy-matchups/{week}` | Every fantasy contest for the exact specified week |
| `/api/fantasy-predictions` | Existing Monte Carlo estimates for fantasy matchups; separate from NFL game predictions |
| `/api/projections` | Custom projections for every ESPN-rostered player; optional fantasy `week` |
| `/api/free-agents` | Optional `week`, `position` (QB/RB/WR/TE/K/D/ST), `limit` (1–500, default 50) |
| `/api/start-sit` | ESPN roster optimizer; optional fantasy `week`; respects league lineup slots |
| `/api/waiver-advice` | Ranked real ESPN free agents and cautious add/drop advice; optional `week`, `limit` |
| `/api/players/{player_id}` | ESPN player details and weekly fantasy stats; optional `week` |
| `/api/nfl/schedule` | Real NFL regular-season schedule; optional NFL `week` (1–18), separate from fantasy matchups |
| `/api/nfl/games/{event_id}` | ESPN real NFL game summary, team statistics, and leaders |

For example, `/api/fantasy-matchups?week=3` and `/api/fantasy-matchups/3` select the
same scoring week. Previous and future weeks are supported within the season's
ESPN scoring period range. Future playoff pairings may not be published yet;
an empty list means ESPN returned no scheduled contests for that period.

## Data semantics

**Fantasy Matchups** are contests between fantasy teams in this ESPN league.
**NFL Matchups** are actual NFL games and are served through the distinct `/api/nfl/*` endpoints.
`nfl_team` is only metadata about a player and is separate from fantasy team IDs
and names. ESPN's fantasy schedule never becomes an NFL game schedule.

Each fantasy matchup has `home_team`, `away_team`, and `involves_my_team`. Each
team contains its name, ID, public owner names, score, projection, and the roster
ESPN returns for the selected week. A missing side is `null` and `is_bye` is true.
Roster players include their position, lineup slot, starter/bench/reserve status,
fantasy points, and projections. Future lineups reflect ESPN's currently saved
lineup for that future week and may change before kickoff.

Unavailable ESPN fields are `null`, never fabricated zeros. ESPN-supplied zero
scores or projections remain zero. `current_fantasy_score` is ESPN's fantasy
matchup total (which may span multiple weeks in playoff rounds);
`weekly_fantasy_score` is ESPN's selected-week total when available.
`projection_source` distinguishes ESPN's team projection from a sum of complete
ESPN starter projections. No sum is supplied if a starter projection is missing.
Free agents include waiver players and are ordered by ESPN ownership percentage;
availability does not guarantee an immediate pickup.

## Player projection engine

`/api/projections` and player profiles expose ESPN's projection beside the
custom player estimate. The engine is split into ESPN, nflverse, injury,
defensive matchup, role trend, game environment, and weather adapters plus
independent factor calculations. ESPN credentials never leave the backend.
Public nflverse feeds supply weekly player/team box scores, player ID mappings,
snap counts, structured injury reports, weekly roster context, market lines,
and roof/game records. Data feeds are cached in-process for 30 minutes; refresh
failures retain a last good process cache for up to 10 minutes and mark it
stale. Source release timestamps are returned. A feed older than 36 hours is
also marked stale. Unavailable sources remain unavailable rather than being
filled with league averages.

When both a weekly ESPN projection and prior actual scores exist, the custom
mean updates the ESPN prior with an empirical-Bayes shrinkage calculation:
the observed-history mean has sampling variance `player variance / prior game
count`, while the ESPN prior variance comes from the median within-player
variance among real league players at that position. The resulting precision
ratio determines how far history can move the ESPN prior; this is calculated
from the observed data rather than fixed projection percentages. Season,
recent-form, and ESPN opportunity contributions are shown separately. A
separate role trend compares recent offensive snap shares with earlier shares
and values the observed snap change at the player's fantasy points per snap.
Role evidence also includes real target-share and targets/carries trends. A
numerical nflverse opportunity fallback is used only when the ESPN game log
does not provide those opportunities.
Opponent matchup is based on position fantasy points allowed per prior game,
calculated from nflverse player box scores using the active ESPN scoring rules
for mapped categories. It scales the weekly ESPN projection by that defense's
observed percent difference from league average and displays the sample and
source. The same context reports passing/rushing yards and TDs allowed, yards
per attempt/carry, sacks, QB hits, and position targets/receptions/yards allowed
when the feeds contain them. Unsupported league scoring categories are not guessed. Existing ESPN
workload adjustments remain based on recorded QB attempts and RB/WR/TE
carries/targets. The usage contribution decomposes recent form so recent
scoring isn't counted twice.

Floor and ceiling are the normal-approximation 10th and 90th percentiles using
the player's observed game-to-game fantasy variance. When personal history has
fewer than two scored games, the range can use the median within-player
variance observed for real league players at that position. If neither source
has measurable variance, the range stays unavailable. Projection confidence
combines five evidence scores: recent game history (25%), role stability
(25%), agreement among available projection/production sources (25%), playing
status certainty (15%), and matchup/context coverage (10%). The 0–100 score maps to High
(80+), Medium (55–79), or Low (below 55). It measures how much trustworthy
information is available, not a promise that the estimate will be accurate.
Confidence is recalculated as the available history, role, status, and matchup
information changes. The current scoring period is excluded from history so a
live partial box score cannot be treated as a completed game for a future week.

Start/Sit confidence is separate: it measures the gap between two
recommendation estimates, overlap between their likely scoring ranges, player
data quality, and status certainty. A close call or overlapping ranges remains
Low even if both individual projections are High. Matchup confidence is also
separate from win probability and combines probability separation, scoring
already completed, remaining simulation uncertainty, player data quality, and
health clarity. High/Medium/Low use the same score bands, with component
weights documented in the matchup confidence details in the app. Detailed
components are available under “How this was calculated.”

ESPN and official nflverse injury statuses are returned as structured events.
A sourced `OUT` status sets expected points to zero. Practice descriptions,
weekly depth position, reported-out teammate context, and opponent defensive
injury reports are shown as evidence;
they do not create a fixed bonus or workload penalty without a sufficiently
large player-level active/inactive sample. nflverse team box scores expose a
recent plays proxy, pass/rush rate, and scoring average. nflverse schedule
market lines expose game totals and implied team totals. Those team and market
values are currently evidence context only; they do not yet have a calibrated
projection effect. Open-Meteo provides kickoff-hour temperature, wind,
precipitation, and snow for resolved outdoor venues, cached separately. The
forecast is displayed but has no numerical effect until a historical effect
has been calibrated. No numerical weather penalty is applied indoors. No
dependable free expected-CB/coverage assignment source was available, so
individual defender matchup is explicitly unavailable. Raw news articles and
rumors are not interpreted; only structured official weekly reports are used.
The fantasy matchup simulator uses this custom engine's player-specific mean,
uncertainty, confidence, and supported adjustments. ESPN projections remain a
comparison field. With five or more player games, outcomes bootstrap that
player's observed residual distribution; sparse histories use a normalized
Student-t distribution. If an individual variance is unavailable, the
simulator can use centered real ESPN game-log residuals pooled across at least
three league players and five player-games at that position; it marks the
source and otherwise leaves the matchup unavailable. Sparse-history players
receive wider uncertainty based on the engine's real positional spread.

Vectorized simulations share zero-mean NFL game, team-offense, passing-volume,
and receiver target-competition factors. Team loading is estimated from
aligned teammate ESPN scoring histories when at least five common observations
exist; otherwise a conservative, documented 20% team loading is used. The 20%
game and 18% QB/receiver passing loadings are documented fallbacks; receiving
backs use +14%, conventional backs −10%, and same-team WR/TE target competition
uses a centered 10% factor. The independent residual is scaled to preserve
each player's marginal variance. Same-game environments create positive
shootout/QB-pass-catcher association, while D/ST outcomes move against the
shared scoring environment. Target competition is a simulation correlation;
the player's target/carry opportunity also enters the custom mean when real
usage evidence supports it. Market lines and weather remain informational
because no effect has been calibrated from sufficient historical samples.

Live NFL points are fixed. Expected remaining production scales with the
scoreboard clock, and remaining standard deviation scales with the square root
of remaining game time. Final players and confirmed bye/OUT players are fixed
at actual points or zero when no points were scored. Win, loss, and tie rates
are returned separately unless ESPN has a deterministic home/away tiebreak.
Swing players are ranked by paired high-versus-low player outcome simulations,
not by projected points. Results are cached by real scoreboard, score,
projection, injury, and context inputs; production uses a fresh random seed
when those inputs change. `FANTASY_SIMULATION_COUNT` can raise the default
25,000 simulations but is clamped to at least 25,000. `FANTASY_SIMULATION_SEED`
is an optional deterministic test override and should not be set in normal
production runs.

See the [nflverse data schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html),
[nflverse player-stat data](https://nflreadr.nflverse.com/reference/load_player_stats.html),
and [Open-Meteo API documentation](https://open-meteo.com/en/docs) for provider
details. Snap-count feeds are PFR-sourced and are surfaced with their release
timestamp so delayed updates are visible.

Responses use public field allowlists. Raw ESPN owner IDs (SWIDs), cookies,
credentials, and ESPN objects are never serialized. ESPN failures return HTTP
502 with `{ "error": { "code", "message", "type" } }`; credential values in
exception messages are redacted. Invalid parameters return 422, missing players
return 404, and ambiguous team ownership returns 409. No fake fallback is used.

Each request establishes a fresh ESPN connection so scores are not served from
a stale application cache. This adds ESPN request latency. The server binds to
loopback by default and has no user authentication; add authentication before
making private league data accessible beyond your local machine.

## Test against your real league

```bash
npm run test:backend
npm run test:live
.venv/bin/python test_espn.py
```

The backend suite makes actual ESPN requests for the configured league. The
frontend `npm run test:live` suite also uses real ESPN data to verify the app,
profiles, fantasy weeks, NFL current/previous/future schedule and game details,
player search, and Watchlist add/update/remove. It verifies credentials do not
appear in proxied JSON. Watchlist persistence across a process restart can be
verified by adding a real player, restarting `npm run dev`, and reading `/api/watchlist`.
ESPN failures fail these checks; there are no skips or substituted data.

## Next.js frontend

The frontend lives in `frontend/` and uses Next.js, TypeScript, and Tailwind CSS.
Dashboard, My Team, League Matchups, player profiles, saved players, NFL Schedule,
Waivers, Start/Sit, Trades, Predictions, and the deterministic Analyzer panel are implemented.
NFL Schedule uses ESPN's actual NFL scoreboard and game summaries; it remains fully
separate from fantasy league matchups. Watchlist search uses ESPN's real player pool
and persists only player IDs, optional labels, and timestamps in a local SQLite file
at `.data/watchlist.sqlite3` (or `WATCHLIST_DB_PATH`). ESPN credentials stay in the
server-side `.env` and are never written to the watchlist database or sent to the browser.

Start both the FastAPI backend and Next.js frontend from the project root with:

```bash
npm run dev
```

On first run, the launcher installs npm workspace dependencies if needed, creates
`.venv` and installs `requirements.txt` if the Python packages are missing, then
starts both services together. It expects Node.js 20.9+, npm, Python 3, and the
root `.env` configured for your real ESPN league. Open http://127.0.0.1:3000.
Press Ctrl+C once to stop both services. For production, run `npm run build`
and then `npm start` from the project root.

`frontend/.env.example` documents the optional server-only `FASTAPI_BASE_URL`.
The default is http://127.0.0.1:8000. Never copy Python's `.env` into the frontend,
never prefix ESPN credentials with `NEXT_PUBLIC_`, and never put cookies in
client code. Browser requests go through a fixed allowlist in Next.js's server
proxy to the real FastAPI endpoints. No CORS changes or ESPN browser requests
are needed.

Missing points and projections stay `--`; real ESPN zeros remain zero. Future
fantasy lineups show ESPN's saved roster, not an invented prediction. Fantasy
week navigation follows ESPN's configured fantasy weeks, while NFL schedule
navigation uses real NFL regular-season weeks independently. Refresh timestamps
indicate when the browser received each real response. Background refresh failures
retain the last successful scores and schedule.

Verification:

```bash
npm install
npm run test
npm run typecheck
npm run build
# With the app running and real ESPN credentials configured:
npm run test:live
```

The live frontend integration tests compare the same-origin proxy to independent
FastAPI requests for the real league and roster, all current/previous/future
fantasy contests, unpublished future contests, and useful validation errors.
The live suite verifies the frontend server and its same-origin backend proxy,
then exercises the real ESPN and NFL data paths, player search, trade analysis,
Watchlist operations, Start/Sit, waivers, and Monte Carlo results. It does not
automate visual browser interactions; headshots and quick-view interactions are
implemented in the frontend and require a manual browser check.
## Analyzer panel

The contextual Analyzer is deterministic and uses the existing ESPN, projection, lineup, waiver, trade, and matchup services. It does not require an external model credential. Open it from Players, Waivers, Start/Sit, Trades, Predictions, or a player profile to compare real data and inspect concise explanations. Detailed methodology is available under “How this was calculated.”

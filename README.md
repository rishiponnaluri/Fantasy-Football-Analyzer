# Fantasy Football Analyzer

A full-stack fantasy football analytics platform built around real ESPN Fantasy Football league data.

Fantasy Football Analyzer combines custom player projections, lineup optimization, waiver analysis, trade evaluation, matchup simulations, player news, live game updates, and NFL context inside a responsive interactive dashboard.

<img width="600" alt="Dashboard" src="https://github.com/user-attachments/assets/55c3cc9c-30b0-497f-9095-a8afea14ce12" />

<img width="500" alt="Trade Analyzer" src="https://github.com/user-attachments/assets/b99753c0-5626-4b6b-b849-7c3f4360c613" />

<img width="500" alt="Predictions" src="https://github.com/user-attachments/assets/ee904e40-61e8-469e-8e5e-1e8b51c011a3" />


## Features

### Live ESPN league integration

Connects directly to a real ESPN Fantasy Football league using `espn-api`.

- Current roster and lineup
- League teams and matchups
- Fantasy scoring periods
- Free agents and waiver players
- Player game logs and projections
- Fantasy-team images and custom ESPN profile pictures
- Live and historical matchup data

No mock league data or fake fallback data is used.

### Custom projection engine

Player projections combine multiple real data sources and contextual signals, including:

- ESPN weekly projections
- Historical fantasy production
- Recent form
- Snap share and usage trends
- Carries and targets
- Opponent fantasy points allowed by position
- Injury and practice status
- Team environment
- NFL schedule context
- nflverse data

The app exposes both the projection and a confidence score based on the quality and consistency of the available evidence.

Players on bye weeks are identified directly from the NFL schedule and displayed as **BYE** rather than receiving a misleading projection.

### Start / Sit

Compare players using:

- Custom projections
- Expected scoring edge
- Projection confidence
- Floor and ceiling ranges
- Injury/status context
- Matchup information

The lineup optimizer also builds the best legal starting lineup for the current roster.

If a required slot cannot be filled — for example, the only D/ST is on bye — the app preserves the optimal eligible starters and explicitly marks the lineup as incomplete instead of silently inserting an ineligible player.

### Waiver Assistant

Ranks real ESPN free agents using existing projection and roster context.

Includes:

- Position filters
- Team needs
- Recommended additions
- Potential drop candidates
- Player Quick View
- Saved/watchlisted players

### Trade Analyzer

Supports both manual trade analysis and automatic trade discovery.

Trade evaluation considers:

- Weekly lineup impact
- Rest-of-season value
- Value above league-specific replacement
- Positional need
- Player uncertainty
- Trade confidence
- Estimated acceptance likelihood

Automatic trade discovery filters out negative trades and ranks opportunities based on both benefit to the user and plausibility for the other fantasy manager.

### Matchup Predictions

Fantasy matchups are simulated using a custom Monte Carlo engine.

The simulator models:

- Player-specific projections
- Player uncertainty
- Residual distributions
- Shared NFL-game environment
- Team-offense correlation
- QB / pass-catcher correlation
- Receiving competition
- D/ST relationships
- Live scores and remaining game time

The default simulation count is **25,000**.

Results include:

- Win probability
- Tie probability
- Projected finish
- Matchup confidence
- Scoring ranges
- Swing players

### Player Explorer

Search the full player pool with live autocomplete.

Autocomplete supports:

- Name matching
- Player portraits
- Position and NFL team
- Injury/status context
- Keyboard navigation
- Shared player Quick View

Player pages include projections, production, matchup context, status, and recent updates.

### Player News

A separate structured player-news pipeline monitors rostered and saved players.

Updates may include:

- Injuries
- Practice participation
- Availability
- Transactions
- Role changes
- Usage changes
- Depth-chart context

News is stored independently from the projection engine so unstructured headlines do not unpredictably alter player projections.

### Live updates

During active NFL games, the frontend automatically refreshes relevant live data.

Polling adapts based on game state:

- Live games: approximately every 18 seconds
- Upcoming games: approximately every 60 seconds
- Idle periods: approximately every 180 seconds

Backend caching and single-flight protection prevent every browser refresh from becoming a new upstream provider request.

Polling pauses when the browser tab is hidden and resumes when the user returns.

### NFL Schedule

Separate from fantasy matchups, the NFL page displays real NFL games with:

- Team identities
- Scores
- Kickoff times
- Game state
- Market-implied probabilities when available
- Expandable game information

Fantasy win probabilities and NFL market probabilities remain separate concepts throughout the app.

## Interface

The frontend is built as a responsive dark-mode interface with:

- Cursor-reactive lighting
- GSAP interaction and state transitions
- Team-color context
- Shared player Quick View
- Responsive desktop, tablet, and mobile layouts
- Reduced-motion support
- Keyboard navigation
- Accessible focus states

Main sections:

`Dashboard` · `My Team` · `Players` · `Waivers` · `Start/Sit` · `Trades` · `League` · `Predictions` · `NFL`

## Tech Stack

### Frontend

- Next.js
- React
- TypeScript
- GSAP
- CSS
- Next.js server-side API proxy

### Backend

- Python
- FastAPI
- `espn-api`
- NumPy
- SQLite

### Data

- ESPN Fantasy Football
- ESPN NFL data
- nflverse
- Open-Meteo
- Kalshi market data where available

## Architecture

```text
Browser
   │
   ▼
Next.js frontend
   │
   ▼
Next.js server-side API proxy
   │
   ▼
FastAPI backend
   │
   ├── ESPN Fantasy
   ├── ESPN NFL
   ├── nflverse
   ├── Open-Meteo
   └── Kalshi
```

ESPN credentials remain server-side and are never exposed to browser JavaScript.

## Run Locally

### Requirements

- Node.js 20.9+
- npm
- Python 3

Clone the repository and enter the directory:

```bash
git clone https://github.com/rishiponnaluri/Fantasy-Football-Analyzer.git
cd Fantasy-Football-Analyzer
```

Create your local environment file:

```bash
cp .env.example .env
```

Configure:

```env
ESPN_LEAGUE_ID=
ESPN_YEAR=
ESPN_S2=
ESPN_SWID=
```

`ESPN_TEAM_ID` can optionally be used when SWID cannot uniquely identify the desired fantasy team.

Never commit your `.env` file or ESPN cookies.

Then start the complete application:

```bash
npm run dev
```

The launcher starts both FastAPI and Next.js.

Open:

```text
http://127.0.0.1:3000
```

FastAPI documentation is available at:

```text
http://127.0.0.1:8000/docs
```

## Testing

Run the main validation suites with:

```bash
npm run test
npm run typecheck
npm run build
npm run test:backend
```

With valid ESPN credentials and the application running:

```bash
npm run test:live
```

The project includes regression coverage for areas including:

- ESPN data handling
- Projection consistency
- Start/Sit
- Trade valuation
- Player news
- Bye-week handling
- Player autocomplete
- Adaptive polling
- Responsive score displays
- Credential redaction
- Motion/accessibility behavior

## Projection Methodology

The projection engine uses ESPN's weekly estimate as one source of information and combines it with observed player history and contextual data.

When sufficient player history exists, the model uses an empirical-Bayes shrinkage approach so small samples cannot overwhelm the ESPN prior.

Additional contextual evidence includes:

- Recent scoring
- Snap-share trends
- Carries and targets
- Position-specific defensive performance
- Injury status
- Practice status
- Team offensive environment
- Schedule context

Floor and ceiling ranges are derived from observed player variance where sufficient data exists.

Projection confidence measures evidence quality rather than guaranteeing prediction accuracy.

## Matchup Simulation

Fantasy matchup probabilities are generated using player-level Monte Carlo simulation.

Player outcomes incorporate individual variance while shared factors introduce realistic relationships between players in the same NFL environment.

Examples include:

- Positive QB / receiver relationships
- Shared team-offense effects
- Receiving target competition
- D/ST relationships with game scoring environment

Live players use actual fantasy points already scored plus simulated remaining production.

Final players are fixed at their actual totals.

## Data and Privacy

Sensitive ESPN credentials stay in the backend environment.

Public API responses use explicit field allowlists and do not expose:

- ESPN S2 cookies
- SWIDs
- Raw owner dictionaries
- Authentication credentials

`.env` is ignored by Git.

The application currently assumes a trusted user environment. Additional authentication should be added before exposing private ESPN league data through a public hosted instance.

## Disclaimer

Fantasy Football Analyzer is an independent project and is not affiliated with or endorsed by ESPN, the NFL, nflverse, Kalshi, or Open-Meteo.

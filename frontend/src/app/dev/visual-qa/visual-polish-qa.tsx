'use client';
import { useState } from 'react';
import fixture from '../../../../tests/fixtures/visual-polish.json';
import type { FantasyMatchup, MatchupPrediction, NFLGame } from '@/lib/types';
import { FantasyScoreFocus } from '@/components/league-matchups-panel';
import { NflGameTile } from '@/components/nfl-schedule-panel';
import { MarketSkeleton } from '@/components/living-future-ui';

// Isolated visual QA: recorded Week 6 values, never connected to production state.
export default function VisualPolishQA() {
  const [live, setLive] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const matchup = fixture.matchup as unknown as FantasyMatchup;
  const prediction = fixture.prediction as unknown as MatchupPrediction;
  const game = fixture.game as unknown as NFLGame;
  const liveIds = [matchup.home_team, matchup.away_team].flatMap(team => team?.roster?.filter(player => player.is_starter).map(player => player.nfl_team_id).filter((id): id is number => id != null) || []);
  const replayGame = live ? { ...game, status: { ...game.status, state: 'in' as const } } : game;
  return <div className="sports-app"><main className="sf-page" style={{ padding: '24px', maxWidth:1440, margin:'auto' }}>
    <header className="sf-page-heading"><div><h1>Visual QA · recorded data</h1><p>Development only. LIVE is a simulated display state using recorded Week 6 scores; it is not a current result.</p></div><button onClick={() => setLive(value => !value)}>{live ? 'Show FINAL state' : 'Show LIVE display state'}</button></header>
    <FantasyScoreFocus matchup={matchup} prediction={prediction} myTeamId={fixture.my_team_id} week={6} currentWeek={live ? 6 : 7} liveTeamIds={live ? liveIds : []} expanded={false} onExpand={() => {}}/>
    <NflGameTile game={replayGame} expanded={expanded} open={() => setExpanded(value => !value)}/>
    <div className="lf-page"><MarketSkeleton label="Player rows loading · visual QA" kind="rows" count={2}/></div>
    <section className="error-card" role="alert"><h2>Player data is temporarily unavailable</h2><p>Please try again shortly.</p><button type="button" className="button">Retry · visual QA only</button></section>
  </main></div>;
}

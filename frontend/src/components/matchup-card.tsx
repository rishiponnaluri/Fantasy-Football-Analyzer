import { useState } from 'react';
import { ArrowUpRight, Flag, Shield } from 'lucide-react';
import { FantasyMatchup, MatchupPrediction, FantasyTeam, ownerNames, points } from '@/lib/types';
import { PredictionBar, teamAccentColor } from './prediction-bar';

function TeamScore({ team, mine, finalScore, ourProjection, range }: {
  team: FantasyTeam | null;
  mine: boolean;
  finalScore?: number;
  ourProjection?: number;
  range?: { low: number; high: number };
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  if (!team) return <div className="team-score"><span className="team-label">Fantasy team</span><h3>Bye week</h3><span className="big-score">--</span><p className="owner-name">No matchup scheduled</p></div>;
  const color = teamAccentColor(team.team_id, team.primary_color);
  return <div className={`team-score ${mine ? 'my-score' : ''}`} style={{ '--team-accent': color } as React.CSSProperties}>
    <div className="team-avatar">{team.team_logo_url && !logoFailed ? <img src={team.team_logo_url} alt="" onError={() => setLogoFailed(true)}/> : <><Shield size={19}/><span>{team.abbreviation || team.team_name.slice(0, 2)}</span></>}</div>
    <div className="team-label">{mine ? 'Your team' : 'Opponent'}</div><h3>{team.team_name}</h3>
    <p className="owner-name">{ownerNames(team) || 'Owner unavailable'}</p>
    <div className="big-score">{points(team.current_fantasy_score)}</div>
    <div className="projected-label">Our projected final <strong>{finalScore != null ? finalScore.toFixed(1) : points(ourProjection)}</strong></div>
    <div className="projected-label">ESPN <strong>{points(team.projected_fantasy_score)}</strong></div>
    {range && <div className="team-likely-range">Likely range {range.low.toFixed(1)}–{range.high.toFixed(1)}</div>}
  </div>;
}
export default function MatchupCard({ matchup, myTeamId, prediction, hero = false, onDetails }: {
  matchup: FantasyMatchup;
  myTeamId: number;
  prediction?: MatchupPrediction;
  hero?: boolean;
  onDetails: () => void;
}) {
  const homePrediction = prediction?.team_a;
  const awayPrediction = prediction?.team_b;
  return <article className={`matchup-card ${hero ? 'hero-matchup' : ''} ${matchup.involves_my_team ? 'own-matchup' : ''}`} data-testid="fantasy-matchup-card">
    <div className="matchup-top"><span className="eyebrow">{hero ? 'This week’s fantasy matchup' : `Fantasy matchup · Week ${matchup.week}`}</span>{matchup.involves_my_team && <span className="your-matchup"><Flag size={12}/> Your matchup</span>}</div>
    <div className="matchup-scores">
      <TeamScore team={matchup.home_team} mine={matchup.home_team?.team_id === myTeamId} finalScore={homePrediction?.projected_final_score} ourProjection={homePrediction?.our_projected_score} range={homePrediction?.likely_score_range}/>
      <span className="versus">VS</span>
      <TeamScore team={matchup.away_team} mine={matchup.away_team?.team_id === myTeamId} finalScore={awayPrediction?.projected_final_score} ourProjection={awayPrediction?.our_projected_score} range={awayPrediction?.likely_score_range}/>
      {matchup.home_team && matchup.away_team && <PredictionBar prediction={prediction} homeName={matchup.home_team.team_name} awayName={matchup.away_team.team_name} homeId={matchup.home_team.team_id} awayId={matchup.away_team.team_id} homeColor={matchup.home_team.primary_color} awayColor={matchup.away_team.primary_color}/>}
    </div>
    <div className="matchup-bottom"><span>{matchup.is_bye ? 'Fantasy bye week' : 'Week'} {matchup.week}{prediction?.last_updated ? ` · Updated ${new Date(prediction.last_updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span><button className="text-button" onClick={onDetails}>Matchup details <ArrowUpRight size={15}/></button></div>
  </article>;
}

'use client';
import { useState } from 'react';
import { FantasyTeam } from '@/lib/types';
import { fantasyImageCandidates } from '@/lib/player-display.mjs';
export function FantasyTeamAvatar({team,className=''}:{team:FantasyTeam;className?:string}) {
  const candidates=fantasyImageCandidates(team);
  const identity=candidates.join('|');
  const [failure,setFailure]=useState({identity:'',index:0});
  const index=failure.identity===identity ? failure.index : 0;
  return candidates[index] ? <img className={`fantasy-team-avatar ${className}`} src={candidates[index]} alt="" onError={()=>setFailure({identity,index:index+1})}/> : <span className={`fantasy-team-avatar fantasy-team-fallback sf-fantasy-monogram ${className}`} aria-hidden="true">{team.abbreviation || team.team_name.slice(0,2)}</span>;
}

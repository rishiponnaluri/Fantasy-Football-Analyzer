'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchBackend } from '@/lib/api';
import { Player, PlayerSearchResult } from '@/lib/types';
import { autocompleteIndex, autocompleteMatches } from '@/lib/player-display.mjs';
import { PlayerAvatar, usePlayerQuickView } from './player-quick-view';

let directory:Promise<PlayerSearchResult[]>|undefined;
function loadDirectory(){
  return directory ??= fetchBackend<{players:PlayerSearchResult[]}>('/player-directory')
    .then(data=>data.players).catch(error=>{directory=undefined;throw error;});
}
export default function PlayerAutocomplete({query,onChange,onSearch}:{query:string;onChange:(value:string)=>void;onSearch:()=>void}) {
  const root=useRef<HTMLDivElement>(null);
  const restoringFocus=useRef(false);
  const [players,setPlayers]=useState<PlayerSearchResult[]>([]);
  const [open,setOpen]=useState(false);
  const [active,setActive]=useState(-1);
  const quickView=usePlayerQuickView();
  useEffect(()=>{let mounted=true;void loadDirectory().then(rows=>{if(mounted)setPlayers(rows);}).catch(()=>{});return()=>{mounted=false;};},[]);
  useEffect(()=>{const dismiss=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node)){setOpen(false);setActive(-1);}};document.addEventListener('pointerdown',dismiss);return()=>document.removeEventListener('pointerdown',dismiss);},[]);
  const matches=useMemo(()=>autocompleteMatches(players,query),[players,query]) as PlayerSearchResult[];
  const expanded=open&&query.trim().length>0&&matches.length>0;
  useEffect(()=>{if(expanded&&active>=0)root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[active,expanded]);
  function select(player:PlayerSearchResult){restoringFocus.current=true;setOpen(false);setActive(-1);quickView?.open(player.player_id,player as Player);}
  return <div ref={root} className="player-typeahead">
    <input role="combobox" aria-label="Search players by name" aria-autocomplete="list" aria-expanded={expanded} aria-controls="player-name-suggestions" aria-activedescendant={expanded&&active>=0?`player-suggestion-${matches[active]?.player_id}`:undefined} autoComplete="off" value={query} onFocus={()=>{if(restoringFocus.current){restoringFocus.current=false;return;}setOpen(true);}} onChange={event=>{onChange(event.target.value);setOpen(true);setActive(-1);}} placeholder="Search players by name…" maxLength={80} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);setActive(-1);}
      else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setOpen(true);setActive(index=>autocompleteIndex(index,event.key,matches.length));}
      else if(event.key==='Enter'&&expanded&&active>=0){event.preventDefault();select(matches[active]);}
      else if(event.key==='Enter'){setOpen(false);}
      else if(event.key==='Tab'){setOpen(false);}
    }}/>
    {expanded&&<div className="player-autocomplete-panel"><ul id="player-name-suggestions" role="listbox" aria-label="Matching players">{matches.map((player,index)=>{
      const noteworthy=player.injury_status&&!/^(ACTIVE|NORMAL|HEALTHY)$/i.test(player.injury_status)?player.injury_status.replaceAll('_',' '):null;
      return <li key={player.player_id} id={`player-suggestion-${player.player_id}`} role="option" aria-selected={active===index} onPointerMove={()=>setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>select(player)}><PlayerAvatar player={player} size="sm" interactive={false}/><span><strong>{player.name}</strong><small>{[player.position,player.nfl_team,noteworthy].filter(Boolean).join(' · ')}</small></span></li>;
    })}</ul><button type="button" onClick={()=>{setOpen(false);onSearch();}}>View all results for “{query.trim()}” <span>↵</span></button></div>}
  </div>;
}

'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { canonicalProjection, fetchBackend, PROJECTION_CHANGED } from '@/lib/api';
import { League, NFLSchedule, Player } from '@/lib/types';
import { isByeWeek } from '@/lib/player-display.mjs';

const schedules = new Map<number, NFLSchedule>();
const pending = new Map<number, Promise<void>>();
const ByeContext = createContext<{revision:number; currentWeek?:number; ensure:(week:number)=>Promise<void>}>({revision:0,ensure:async()=>{}});
export function PlayerScheduleProvider({children}:{children:React.ReactNode}) {
  const [revision,setRevision]=useState(0);
  const [currentWeek,setCurrentWeek]=useState<number>();
  useEffect(()=>{
    const controller=new AbortController();
    const load=(refresh=false)=>{void fetchBackend<League>('/league',controller.signal).then(data=>{if(!controller.signal.aborted){setCurrentWeek(data.current_week);if(refresh)void ensure(data.current_week,true);}}).catch(()=>{});};
    const changed=()=>load(true);
    load();window.addEventListener(PROJECTION_CHANGED,changed);
    return()=>{controller.abort();window.removeEventListener(PROJECTION_CHANGED,changed);};
  },[]);
  async function ensure(week:number,force=false) {
    if(schedules.has(week)&&!force) return;
    if(!pending.has(week)) pending.set(week,fetchBackend<NFLSchedule>(`/nfl/schedule?week=${week}`)
      .then(data=>{schedules.set(week,data);setRevision(n=>n+1);}).catch(()=>{}).finally(()=>pending.delete(week)));
    await pending.get(week);
  }
  return <ByeContext.Provider value={{revision,currentWeek,ensure}}>{children}</ByeContext.Provider>;
}
export function useCurrentFantasyWeek(){return useContext(ByeContext).currentWeek;}
export function usePlayerBye(player:Partial<Player>, selectedWeek?:number) {
  const context=useContext(ByeContext);
  const week=selectedWeek ?? player.custom_projection?.week ?? player.week ?? context.currentWeek;
  useEffect(()=>{if(week) void context.ensure(week);},[week,context.revision]);
  return isByeWeek(player,week,week ? schedules.get(week) : undefined);
}
export function PlayerProjection(props:{player:Partial<Player>&{player_id:number};week?:number;value?:number|null;children?:React.ReactNode}) {
  const {player,week,value,children}=props;
  const bye=usePlayerBye(player,week);
  if(bye) return <span className="projection-bye" aria-label="Bye week">BYE</span>;
  const projection='value' in props ? value : canonicalProjection(player,week);
  return <>{children ?? (typeof projection==='number' ? projection.toFixed(2) : '--')}</>;
}

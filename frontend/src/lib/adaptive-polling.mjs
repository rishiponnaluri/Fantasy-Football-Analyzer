/** UI polling never invalidates a projection snapshot or bypasses backend TTLs. */
export function pollingInterval({live=false,upcoming=false,failures=0}) {
  const base=live?18_000:upcoming?60_000:180_000;
  return Math.min(600_000,base*2**Math.min(failures,5));
}
export function pollingAllowed({enabled=true,week,currentWeek,hidden=false}) {
  return enabled && !hidden && week != null && week === currentWeek;
}
/** Injectable clock/document allow tests to exercise real scheduling and suspension. */
/** @param {{load:(signal:AbortSignal)=>Promise<unknown>,state:()=>any,onError?:(error:unknown)=>void,document:any,window:any,clock?:any}} options */
export function startAdaptivePolling({load,state,onError=(_error)=>{},document:doc,window:win,clock=globalThis}) {
  let timer,controller,stopped=false,running=false,failures=0,lastAttempt=clock.now?.()??Date.now();
  const now=()=>clock.now?.()??Date.now();
  const allowed=()=>!stopped&&pollingAllowed({...state(),hidden:doc.hidden});
  function schedule(){clock.clearTimeout(timer);if(allowed())timer=clock.setTimeout(run,pollingInterval({...state(),failures}));}
  async function run(){
    if(!allowed()||running)return;
    running=true;controller=new AbortController();lastAttempt=now();
    try{await load(controller.signal);if(!controller.signal.aborted)failures=0;}
    catch(error){if(!controller.signal.aborted){failures++;onError(error);}}
    finally{running=false;if(!stopped)schedule();}
  }
  function visibility(){
    clock.clearTimeout(timer);
    if(!allowed()){controller?.abort();return;}
    if(!running&&now()-lastAttempt>=pollingInterval({...state(),failures}))void run();else schedule();
  }
  doc.addEventListener('visibilitychange',visibility);win.addEventListener('focus',visibility);schedule();
  return()=>{stopped=true;clock.clearTimeout(timer);controller?.abort();doc.removeEventListener('visibilitychange',visibility);win.removeEventListener('focus',visibility);};
}
/** Only modeled/live inputs matter; refreshed timestamps and UI state do not. */
export function liveInputSignature(matchups,liveTeamIds) {
  return JSON.stringify([matchups?.week,[...(liveTeamIds??[])].sort((a,b)=>a-b),
    (matchups?.fantasy_matchups??[]).map(row=>[row.fantasy_matchup_id,
      ...[row.home_team,row.away_team].map(team=>team&&[team.team_id,team.current_fantasy_score,team.projected_fantasy_score,
        (team.roster??[]).filter(player=>player.is_starter).map(player=>[player.player_id,player.fantasy_points,player.injury_status,
          player.custom_projection?.snapshot_id,player.custom_projection?.recommendation_projection])])])]);
}

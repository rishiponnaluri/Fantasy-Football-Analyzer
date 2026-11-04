import test from 'node:test';
import assert from 'node:assert/strict';
import {isByeWeek,fantasyImageCandidates,autocompleteMatches,autocompleteIndex} from '../src/lib/player-display.mjs';
import {pollingInterval,pollingAllowed,startAdaptivePolling} from '../src/lib/adaptive-polling.mjs';

test('selected NFL schedule suppresses BYE projections independently of injury/live states',()=>{
  const schedule={week:9,teams_on_bye:[{team_id:'23',abbreviation:'PIT',name:'Pittsburgh Steelers'}]};
  assert.equal(isByeWeek({nfl_team_id:23,bye_week:8,injury_status:'ACTIVE'},9,schedule),true);
  assert.equal(isByeWeek({nfl_team:'PIT',injury_status:'OUT'},9,schedule),true);
  assert.equal(isByeWeek({nfl_team_full_name:'Pittsburgh Steelers'},9,schedule),true);
  assert.equal(isByeWeek({bye_week:9},9,schedule),true);
  assert.equal(isByeWeek({nfl_team_id:6,bye_week:9,injury_status:'IR'},9,schedule),false);
  assert.equal(isByeWeek({bye_week:9},8,schedule),false);
  assert.equal(isByeWeek({bye_week:9},9),true);
});
test('fantasy images prioritize custom, default, legacy and reject unsafe URLs',()=>{
  assert.deepEqual(fantasyImageCandidates({custom_team_logo_url:'/api/backend/teams/3/image',default_team_logo_url:'https://cdn.example/default',team_logo_url:'https://cdn.example/default'}),['/api/backend/teams/3/image','https://cdn.example/default']);
  assert.deepEqual(fantasyImageCandidates({team_logo_url:'javascript:alert(1)'}),[]);
});
test('autocomplete ranks exact, full prefix, word prefix and substring with stable limits',()=>{
  const names=['Long McJoshson','Smith Josh','Josh Allen','Josh','Joshua Downs','Other'];
  const players=names.map((name,player_id)=>({name,player_id}));
  assert.deepEqual(autocompleteMatches(players,'josh').map(p=>p.name),['Josh','Josh Allen','Joshua Downs','Smith Josh','Long McJoshson']);
  assert.equal(autocompleteMatches(players,'j').length,5);
  assert.equal(autocompleteMatches(players,'josh',2).length,2);
  assert.deepEqual(autocompleteMatches(players,' '),[]);
});
test('autocomplete keyboard selection wraps and Escape dismisses selection',()=>{
  assert.equal(autocompleteIndex(-1,'ArrowDown',5),0);
  assert.equal(autocompleteIndex(4,'ArrowDown',5),0);
  assert.equal(autocompleteIndex(0,'ArrowUp',5),4);
  assert.equal(autocompleteIndex(-1,'ArrowUp',5),4);
  assert.equal(autocompleteIndex(2,'Escape',5),-1);
  assert.equal(autocompleteIndex(-1,'ArrowDown',0),-1);
});
test('adaptive intervals and week/visibility guards',()=>{
  assert.equal(pollingInterval({live:true}),18_000);
  assert.equal(pollingInterval({upcoming:true}),60_000);
  assert.equal(pollingInterval({}),180_000);
  for(const week of [8,10])assert.equal(pollingAllowed({week,currentWeek:9}),false);
  assert.equal(pollingAllowed({week:9,currentWeek:9,hidden:true}),false);
  assert.equal(pollingAllowed({week:9,currentWeek:9}),true);
});
function environment(){
  let time=0,id=0;const timers=new Map(),events=new Map();
  const document={hidden:false,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const window={addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const clock={now:()=>time,setTimeout:(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id;},clearTimeout:id=>timers.delete(id)};
  const tick=async(ms)=>{time+=ms;for(const[key,row]of [...timers])if(row.at<=time){timers.delete(key);await row.fn();}};
  return {document,window,clock,events,timers,tick};
}
test('poller suspends hidden tabs, resumes stale state, backs off and retains last-good values',async()=>{
  const env=environment();let calls=0,display='last good',fail=false;
  const stop=startAdaptivePolling({...env,state:()=>({week:9,currentWeek:9,live:true}),load:async()=>{calls++;if(fail)throw Error('offline');display='updated';}});
  env.document.hidden=true;env.events.get('visibilitychange')();await env.tick(90_000);assert.equal(calls,0);
  env.document.hidden=false;env.events.get('visibilitychange')();await Promise.resolve();await Promise.resolve();assert.equal(calls,1);assert.equal(display,'updated');
  fail=true;await env.tick(18_000);assert.equal(calls,2);assert.equal(display,'updated');
  await env.tick(18_000);assert.equal(calls,2);await env.tick(18_000);assert.equal(calls,3);
  stop();await env.tick(600_000);assert.equal(calls,3);assert.equal(env.timers.size,0);
});
test('inactive and historical/future pages never schedule a provider poll',()=>{
  for(const state of [{week:8,currentWeek:9},{week:10,currentWeek:9},{week:9,currentWeek:9,enabled:false}]){
    const env=environment();const stop=startAdaptivePolling({...env,state:()=>state,load:async()=>assert.fail('unexpected poll')});
    assert.equal(env.timers.size,0);stop();
  }
});
test('live predictions refresh only for changed scoring/model inputs',async()=>{
  const {liveInputSignature}=await import('../src/lib/adaptive-polling.mjs');
  const data={week:9,updated_at:'earlier',fantasy_matchups:[{fantasy_matchup_id:1,home_team:{team_id:3,current_fantasy_score:12,roster:[]}}]};
  const next=structuredClone(data);next.updated_at='later';
  assert.equal(liveInputSignature(data,[]),liveInputSignature(next,[]));
  next.fantasy_matchups[0].home_team.current_fantasy_score=13;
  assert.notEqual(liveInputSignature(data,[]),liveInputSignature(next,[]));
  assert.notEqual(liveInputSignature(data,[]),liveInputSignature(data,[6]));
});
test('identity-only directory and authenticated team-image proxy work without exposing credentials',async()=>{
  const base=process.env.FRONTEND_URL||'http://127.0.0.1:3000';
  const result=await fetch(`${base}/api/backend/player-directory`);assert.equal(result.status,200);
  const data=await result.json();assert.ok(data.players.length>100);
  const allen=data.players.find(p=>p.name==='Josh Allen'&&p.nfl_team==='BUF');assert.equal(allen?.position,'QB');
  assert.ok(data.players.every(p=>!('custom_projection'in p)&&!('weekly_projection'in p)));
  const teams=await fetch(`${base}/api/backend/teams`).then(r=>r.json());
  const custom=teams.teams.find(t=>t.custom_team_logo_url);
  if(custom){const image=await fetch(base+custom.custom_team_logo_url);assert.equal(image.status,200);assert.match(image.headers.get('content-type'),/^image\//);assert.ok((await image.arrayBuffer()).byteLength>100);assert.equal(image.headers.get('set-cookie'),null);}
  const missing=await fetch(`${base}/api/backend/teams/99999/image`);assert.equal(missing.status,404);
});

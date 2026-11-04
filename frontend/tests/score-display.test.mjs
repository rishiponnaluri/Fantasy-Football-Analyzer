import test from 'node:test';
import assert from 'node:assert/strict';
import { predictionSides, opponentFirst, liveIdsForWeek, fantasyState, fantasyScore, visibleMarket, nflWinner } from '../src/lib/score-display.mjs';
const team = (id, actual=0, projected=100) => ({team_id:id,team_name:`Team ${id}`,current_fantasy_score:actual,projected_fantasy_score:projected,roster:[]});
const match = {home_team:team(4,123.4,151),away_team:team(9,98.7,112)};
const prediction = {status:'estimated',team_a:{team_id:9,expected_final_score:117,modeled_players:[]},team_b:{team_id:4,expected_final_score:160,modeled_players:[]},team_a_win_probability:.26345,team_b_win_probability:.73555,tie_probability:.001};
test('fantasy probabilities and projections follow team IDs, including opponent-first view',()=>{
 const sides=predictionSides(match,prediction);
 assert.equal(sides.homeWin,.73555); assert.equal(sides.home.expected_final_score,160);
 assert.equal(sides.awayWin,.26345);assert.equal(sides.away.expected_final_score,117);
 const view=opponentFirst(match,4), swapped=predictionSides(view,prediction);
 assert.equal(view.home_team.team_id,9);assert.equal(view.away_team.team_id,4);
 assert.equal(swapped.homeWin,.26345);assert.equal(swapped.awayWin,.73555);
 assert.equal(match.home_team.team_id,4,'original API object remains unchanged');
 assert.ok(Math.abs(swapped.homeWin*100-26.345)<1e-10,'football position uses unrounded probability');
 assert.equal(swapped.awayWin,.73555,'ties do not renormalize win shares');
});
test('unmatched fantasy team never borrows another team probability',()=>{
 assert.equal(predictionSides({...match,home_team:team(99)},prediction).homeWin,undefined);
 assert.equal(predictionSides(match,undefined).home,undefined);
});
test('past and future fantasy weeks do not inherit current live NFL state',()=>{
 const liveMatch={...match,home_team:{...match.home_team,roster:[{is_starter:true,nfl_team_id:7}]}};
 assert.equal(fantasyState(liveMatch,[7],7,7,prediction),'LIVE');
 assert.equal(fantasyState(liveMatch,[7],6,7,prediction),'FINAL');
 assert.equal(fantasyState(liveMatch,[7],8,7,prediction),'UPCOMING');
 assert.deepEqual(liveIdsForWeek(6,7,[7]),[]);assert.equal(liveIdsForWeek(8,7,[7]),null);
});
test('final and live fantasy scores are actual; upcoming uses existing expected finish',()=>{
 assert.deepEqual(fantasyScore(match.home_team,'FINAL',prediction.team_b),{value:123.4,label:'Final score'});
 assert.equal(fantasyScore(match.home_team,'LIVE',prediction.team_b).value,123.4);
 assert.equal(fantasyScore(match.home_team,'UPCOMING',prediction.team_b).value,160);
 assert.equal(fantasyScore(match.home_team,'UPCOMING',undefined).value,151);
});
test('final NFL games hide all market presentation; live and upcoming retain original market',()=>{
 const market={away_probability:.62,home_probability:.38,source:'Kalshi'};
 for(const state of ['in','pre'])assert.equal(visibleMarket({status:{state},market_probability:market}),market);
 assert.equal(visibleMarket({status:{state:'post'},market_probability:market}),null);
 assert.equal(visibleMarket({status:{state:'pre'}}),null);
});
test('NFL winner emphasis requires final numeric scores; ties and missing scores are neutral',()=>{
 const game={status:{state:'post'},away_team:{score:17},home_team:{score:24}};
 assert.equal(nflWinner(game),'home'); assert.equal(nflWinner({...game,status:{state:'in'}}),null);
 assert.equal(nflWinner({...game,away_team:{score:24}}),'tie');
 assert.equal(nflWinner({...game,away_team:{score:null}}),null);
});

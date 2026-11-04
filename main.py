"""FastAPI backend for a real ESPN Fantasy Football league. No frontend."""

from typing import Annotated, Literal
import threading
import time

from fastapi import Body, Depends, FastAPI, Path, Query, Request
from pydantic import BaseModel, Field
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from espn_service import APIError, ESPNService, redact, team_json
import nfl_service
import prediction_service
from projection_sources.espn import league_projection_payload
import watchlist_store


app = FastAPI(
    title="ESPN Fantasy Football Backend",
    description="Fantasy matchups are contests between league fantasy teams. NFL games are not fantasy matchups.",
)


@app.middleware("http")
async def projection_version_context(request, call_next):
    from projection_snapshot import requested_snapshot
    token = requested_snapshot.set(request.query_params.get('snapshot_id'))
    try:
        return await call_next(request)
    finally:
        requested_snapshot.reset(token)


@app.exception_handler(APIError)
async def api_error_handler(request: Request, error: APIError):
    return JSONResponse(status_code=error.status, content=error.payload)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, error: RequestValidationError):
    # Do not echo raw request input in error responses.
    return JSONResponse(status_code=422, content={"error": {
        "code": "invalid_request", "message": "Invalid API parameters.",
        "details": [{"location": list(item["loc"]), "message": redact(item["msg"])}
                    for item in error.errors()],
    }})


_SERVICE_LOCK = threading.Lock()
_SERVICE_INSTANCE: ESPNService | None = None
_SERVICE_CREATED_AT = 0.0
_SERVICE_TTL_SECONDS = 300


def get_espn_service() -> ESPNService:
    """Reuse one authenticated ESPN league client across nearby API requests."""
    global _SERVICE_INSTANCE, _SERVICE_CREATED_AT
    now = time.monotonic()
    with _SERVICE_LOCK:
        if _SERVICE_INSTANCE is not None and now - _SERVICE_CREATED_AT < _SERVICE_TTL_SECONDS:
            return _SERVICE_INSTANCE
        previous = _SERVICE_INSTANCE
        try:
            _SERVICE_INSTANCE = ESPNService()
            _SERVICE_CREATED_AT = now
        except Exception:
            # Keep a previously connected client if refreshing its wrapper
            # fails transiently; live endpoint calls still report ESPN errors.
            if previous is None:
                raise
            return previous
        return _SERVICE_INSTANCE


Service = Annotated[ESPNService, Depends(get_espn_service)]
SelectedWeek = Annotated[int | None, Query(ge=1, description="Fantasy scoring week; defaults to the current week")]
PlayerQuery = Annotated[str, Query(min_length=2, max_length=80)]
OptionalPlayerQuery = Annotated[str | None, Query(max_length=80)]
WatchlistLabel = Literal["Trade Target", "Waiver Target", "Opponent Player", "Friend Player", "Other"]


class WatchlistAdd(BaseModel):
    player_id: Annotated[int, Field(ne=0)]
    label: WatchlistLabel | None = None


class WatchlistLabelUpdate(BaseModel):
    label: WatchlistLabel | None


@app.get("/api/league")
def league_info(service: Service):
    return service.league_info()


@app.get("/api/teams")
def fantasy_teams(service: Service):
    return {"league_id": service.league.league_id,
            "teams": [team_json(team) for team in service.league.teams]}


@app.get("/api/teams/{team_id}/image")
def fantasy_team_image(service: Service, team_id: int):
    from fantasy_team_images import team_image
    from fastapi.responses import Response
    data, content_type = team_image(service, team_id)
    return Response(data, media_type=content_type, headers={
        "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"})


@app.get("/api/player-directory")
def player_directory(service: Service):
    return service.player_directory()


@app.get("/api/my-team")
def my_fantasy_team(service: Service, week: SelectedWeek = None):
    from projection_snapshot import resolve_players, snapshot
    selected = service.week(week)
    team = service.my_team_info(selected)
    resolved, _ = resolve_players(service, selected, team.get('roster') or [])
    team['roster'] = list(resolved.values())
    team['projection_snapshot_id'] = snapshot(service, selected)['snapshot_id']
    return team


def _matchups_with_projection(service, week):
    from projection_snapshot import resolve_players, snapshot
    selected = service.week(week)
    payload = service.fantasy_matchups(selected)
    teams = [team for matchup in payload['fantasy_matchups']
             for team in (matchup.get('home_team'), matchup.get('away_team')) if team]
    players = [p for team in teams for p in team.get('roster') or []]
    if players:
        resolved, _ = resolve_players(service, selected, players)
        for team in teams:
            if team.get('roster') is not None:
                team['roster'] = [resolved[p['player_id']] for p in team['roster']]
        payload['projection_snapshot_id'] = snapshot(service, selected)['snapshot_id']
    return payload


@app.get("/api/fantasy-matchups")
def fantasy_matchups(service: Service, week: SelectedWeek = None):
    return _matchups_with_projection(service, week)


@app.get("/api/fantasy-matchups/{week}")
def fantasy_matchups_for_week(service: Service, week: Annotated[int, Path(ge=1)]):
    return _matchups_with_projection(service, week)


@app.get("/api/fantasy-predictions")
def fantasy_predictions(service: Service, week: SelectedWeek = None):
    """Simulated outcomes for fantasy league matchups (not NFL games)."""
    return prediction_service.predictions(service, week)


@app.get("/api/projections")
def player_projections(service: Service, week: SelectedWeek = None):
    """Custom player estimates from real ESPN rosters, cards, and scoring logs."""
    return league_projection_payload(service, service.week(week))


@app.post("/api/projections/refresh")
def refresh_projections(service: Service, week: SelectedWeek = None):
    from projection_snapshot import snapshot
    selected = service.week(week)
    # Provider caches remain responsible for rate limits; discard only ESPN's
    # short-lived request memo, not the published projection version.
    with service._memo_lock:
        service._memo_cache.clear()
    payload = snapshot(service, selected, refresh=True)
    return {k: v for k, v in payload.items() if not k.startswith('_')}


@app.get("/api/free-agents")
def free_agents(service: Service, week: SelectedWeek = None,
                position: Literal["QB", "RB", "WR", "TE", "K", "D/ST"] | None = None,
                limit: Annotated[int, Query(ge=1, le=500)] = 50):
    return service.free_agents(week, position, limit)


@app.get("/api/start-sit")
def start_sit_advice(service: Service, week: SelectedWeek = None):
    return service.start_sit_advice(week)


@app.get("/api/waiver-advice")
def waiver_advice(service: Service, week: SelectedWeek = None,
                  limit: Annotated[int, Query(ge=20, le=150)] = 100,
                  positions: list[Literal["QB", "RB", "WR", "TE", "K", "D/ST"]] = Query(default=[])):
    return service.waiver_advice(week, limit, positions)


@app.get("/api/players/search")
def search_players(service: Service, q: OptionalPlayerQuery = None,
                   team: Annotated[str | None, Query(max_length=4)] = None,
                   position: Literal["QB", "RB", "WR", "TE", "K", "D/ST"] | None = None,
                   status: Literal["rostered", "available"] | None = None,
                   sort: Literal["our_projection", "espn_projection", "season_points", "points_per_game", "recent"] = "our_projection",
                   week: SelectedWeek = None,
                   limit: Annotated[int, Query(ge=1, le=50)] = 20):
    return service.search_players(q, limit, team, position, status, sort, week)


@app.get("/api/players/{player_id}")
def player_info(service: Service, player_id: int, week: SelectedWeek = None):
    if player_id == 0:
        raise APIError(422, "invalid_player_id", "Player ID must not be zero.")
    return service.player_info(player_id, week)


@app.get("/api/players/{player_id}/updates")
def player_updates(service: Service, player_id: int, week: SelectedWeek = None):
    from player_news import updates
    return {"player_id": player_id, "updates": updates(service.league.league_id, player_id, service.week(week))}


@app.get("/api/trades/suggestions")
def trade_suggestions(service: Service, team_id: Annotated[int, Query(gt=0)],
                      mode: Literal["conservative", "balanced", "aggressive"] = "balanced",
                      week: SelectedWeek = None,
                      positions: list[Literal["QB", "RB", "WR", "TE", "FLEX"]] | None = Query(default=None)):
    from trade_service import suggestions
    from trade_discovery_ranking import rank_suggestions
    data = suggestions(service, team_id, mode, week, positions)
    return {**data, "suggestions": rank_suggestions(data.get("suggestions", []))}


@app.get("/api/trades/targets")
def trade_targets(service: Service, week: SelectedWeek = None,
                  position: Literal["ALL", "QB", "RB", "WR", "TE", "K", "D/ST", "FLEX"] | None = None,
                  positions: list[Literal["QB", "RB", "WR", "TE", "K", "D/ST", "FLEX"]] | None = Query(default=None),
                  team_id: Annotated[int | None, Query(gt=0)] = None,
                  include_research_ideas: bool = False):
    from trade_service import league_targets
    return league_targets(service, week, None if position == "ALL" else position,
                          include_research_ideas, positions=positions, target_team_id=team_id)


@app.get("/api/trades/discovery")
def trade_discovery(service: Service, week: SelectedWeek = None, debug: bool = False,
                    search_mode: Literal["league_wide", "specific_team"] = "league_wide",
                    team_id: Annotated[int | None, Query(gt=0)] = None,
                    mode: Literal["conservative", "balanced", "aggressive"] = "balanced",
                    positions: list[Literal["QB", "RB", "WR", "TE", "FLEX"]] | None = Query(default=None)):
    """Run automatic trade discovery under one shared position and owner filter.

    Manual trade analysis remains unrestricted at /trades/analyze.
    """
    from trade_service import league_targets, _trade_position_set
    if search_mode == "specific_team" and team_id is None:
        raise APIError(422, "trade_team_required", "Choose a fantasy team for specific-team trade search.")
    if positions is not None and not positions:
        return {"week": service.week(week), "search_mode": search_mode, "team_id": team_id,
                "positions": [], "mode": mode, "trade_targets": [], "suggestions": [],
                "possible_trades_to_explore": [], "research_trade_ideas": [],
                "best_trade_partners": [], "roster_needs": {},
                "message": "Select at least one position to search for trade targets."}

    data = league_targets(service, week, include_research_ideas=True,
                          positions=positions, target_team_id=team_id if search_mode == "specific_team" else None)
    selected = _trade_position_set(positions=positions)

    def requested_player(player):
        return selected is None or (player or {}).get("position") in selected

    def requested_receive(row):
        return any(requested_player(player) for player in row.get("you_receive", []))

    def mode_included(row):
        category = row.get("trade_category")
        if mode == "conservative":
            return category == "IMMEDIATE WIN-WIN" and row.get("plausibility") == "High"
        if mode == "balanced":
            return category in {"IMMEDIATE WIN-WIN", "ROSTER-BALANCING", "PLAUSIBLE IDEA"}
        return category in {"IMMEDIATE WIN-WIN", "ROSTER-BALANCING", "UPSIDE TRADE", "PLAUSIBLE IDEA"}

    targets = [row for row in data.get("trade_targets", [])
               if requested_player(row.get("player")) and mode_included(row.get("analysis") or {})]
    validated = [row["analysis"] for row in targets
                 if row.get("analysis") and mode_included(row["analysis"])]
    exploratory = [row for row in data.get("possible_trades_to_explore", [])
                   if requested_receive(row) and mode_included(row)]
    research = [row for row in data.get("research_trade_ideas", [])
                if requested_receive(row) and mode_included(row)]
    from trade_discovery_ranking import rank_suggestions, ranking_key
    candidates = validated + exploratory + research
    suggestions = rank_suggestions(candidates)
    allowed = {ranking_key(row)[2] for row in suggestions}
    targets = [row for row in targets if ranking_key(row['analysis'])[2] in allowed]
    targets.sort(key=lambda row: ranking_key(row['analysis']))
    exploratory = [row for row in suggestions if row in exploratory]
    research = [row for row in suggestions if row in research]

    return {**data, "search_mode": search_mode, "target_team_id": team_id if search_mode == "specific_team" else None,
            "positions": positions, "mode": mode, "trade_targets": targets,
            "possible_trades_to_explore": exploratory, "research_trade_ideas": research,
            "suggestions": suggestions[:40],
            **({"discovery_debug": {"before_filter": len(candidates),
                                   "unique_before_filter": len({ranking_key(row)[2] for row in candidates}),
                                   "after_filter": len(suggestions), "returned": min(40, len(suggestions))}}
               if debug else {}),
            "message": None if targets or suggestions else "No package met the current roster-fit checks for the selected positions."}


class TradeRequest(BaseModel):
    team_id: Annotated[int, Field(gt=0)]
    give_player_ids: Annotated[list[int], Field(min_length=1, max_length=6)]
    receive_player_ids: Annotated[list[int], Field(min_length=1, max_length=6)]
    week: Annotated[int | None, Field(ge=1)] = None


@app.post("/api/trades/analyze")
def analyze_trade(request: TradeRequest, service: Service):
    from trade_service import analyze
    return analyze(service, request.model_dump())


@app.get("/api/watchlist")
def watchlist_items(service: Service):
    items = watchlist_store.list_items()
    player_ids = [item["player_id"] for item in items]
    if not player_ids:
        return {"items": []}
    week = service.week()
    players = service.player_insights(player_ids, week)
    from projection_snapshot import resolve_players
    enriched, _ = resolve_players(service, week, list(players.values()))
    hydrated = []
    for item in items:
        player = enriched.get(item["player_id"])
        if player is None:
            continue
        owner_team = service.teams.get(player.get("fantasy_team_id")) if player.get("fantasy_team_id") not in (None, 0) else None
        player["fantasy_team_name"] = owner_team.team_name if owner_team else None
        player["fantasy_team_owner"] = ", ".join(owner.get("displayName") or " ".join(filter(None, (owner.get("firstName"), owner.get("lastName"))))
                                                       for owner in (owner_team.owners if owner_team else [])
                                                       if owner.get("displayName") or owner.get("firstName") or owner.get("lastName")) or None
        player["roster_status"] = "rostered" if owner_team else "available" if player.get("availability_status") in {"FREEAGENT", "WAIVERS"} else "unknown"
        hydrated.append({**item, "player": player})
    return {"items": hydrated}


@app.post("/api/watchlist")
def add_watchlist_item(item: WatchlistAdd, service: Service):
    # Resolve through ESPN before persisting so arbitrary/fake IDs cannot enter
    # the list. Only the ID, label, and timestamps are stored locally.
    player = service.player_info(item.player_id)
    saved = watchlist_store.save_item(item.player_id, item.label)
    return {**saved, "player": player}


@app.patch("/api/watchlist/{player_id}")
def change_watchlist_label(player_id: int, item: WatchlistLabelUpdate = Body()):
    saved = watchlist_store.update_label(player_id, item.label)
    if saved is None:
        raise APIError(404, "watchlist_player_not_found", f"Player {player_id} is not on the watchlist.")
    return saved


@app.delete("/api/watchlist/{player_id}")
def remove_watchlist_item(player_id: int):
    if player_id == 0:
        raise APIError(422, "invalid_player_id", "Player ID must not be zero.")
    if not watchlist_store.remove_item(player_id):
        raise APIError(404, "watchlist_player_not_found", f"Player {player_id} is not on the watchlist.")
    return {"removed": True, "player_id": player_id}


@app.get("/api/nfl/live-status")
def nfl_live_status():
    """NFL game state used only for player LIVE labels and refresh cadence.

    This is deliberately separate from /api/fantasy-matchups, which contains
    fantasy-team contests. The response has no NFL matchup or score objects.
    """
    return nfl_service.live_status()


@app.get("/api/nfl/schedule")
def nfl_schedule(week: Annotated[int | None, Query(ge=1, le=18)] = None):
    return nfl_service.nfl_schedule(week)


@app.get("/api/nfl/games/{event_id}")
def nfl_game_detail(event_id: Annotated[int, Path(ge=1)]):
    return nfl_service.nfl_game_details(event_id)

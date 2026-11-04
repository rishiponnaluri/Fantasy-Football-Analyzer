"""Atomic, league/week projection snapshots; calculations remain in existing engines."""
from contextvars import ContextVar
from copy import deepcopy
from uuid import uuid4
import hashlib
import json
import threading
import time

from espn_service import APIError

requested_snapshot = ContextVar('requested_projection_snapshot', default=None)
_LOCK = threading.RLock()
_LOCKS = {}
_CURRENT = {}
_VERSIONS = {}
TTL_SECONDS = 300
RETENTION_SECONDS = 3600


def _key(service, week):
    return (service.league.league_id, service.league.year, week)


def _decorate(player, model, snapshot_id):
    from recommendation_service import confidence_aware_value
    value, source, detail = confidence_aware_value({**player, 'custom_projection': model})
    model = {**model, 'recommendation_projection': value, 'snapshot_id': snapshot_id}
    return {**player, **detail, 'recommendation_projection': value,
            'recommendation_estimate_source': source, 'projection_snapshot_id': snapshot_id,
            'custom_projection': model}


def snapshot(service, week, refresh=False):
    request_started = time.monotonic()
    key = _key(service, week)
    pin = requested_snapshot.get()
    with _LOCK:
        lock = _LOCKS.setdefault(key, threading.RLock())
    with lock:
        now = time.monotonic()
        if pin and not refresh:
            version = _VERSIONS.get((key, pin))
            if not version or now - version[0] > RETENTION_SECONDS:
                raise APIError(409, 'projection_snapshot_expired', 'Projection snapshot expired. Refresh to load a consistent week.')
            return deepcopy(version[1])
        cached = _CURRENT.get(key)
        if cached and ((not refresh and now - cached[0] < TTL_SECONDS) or cached[0] > request_started):
            return deepcopy(cached[1])
        from projection_sources.espn import _build_league_projection_payload
        # Build fully before publishing. Never expose partially refreshed players.
        payload = _build_league_projection_payload(service, week)
        identity = [{k: row[k] for k in ('player_id', 'projection')} for row in payload['players']]
        # Source retrieval timestamps are not mathematical inputs.
        def stable(value):
            if isinstance(value, dict):
                return {k: stable(v) for k, v in value.items() if k not in
                        {'source_status', 'as_of', 'retrieved_at', 'timestamp', 'projection_context'}}
            if isinstance(value, list): return [stable(v) for v in value]
            return value
        # Include the actual references used by the recommendation blend.
        refs = [(r['player_id'], r['player'].get('season_fantasy_average')) for r in payload['players']]
        fingerprint = hashlib.sha256(json.dumps([key, stable(identity), refs], sort_keys=True).encode()).hexdigest()
        sid = uuid4().hex[:20]
        for row in payload['players']:
            row['player'] = _decorate(row['player'], row['projection'], sid)
            row['projection'] = row['player']['custom_projection']
        for team in payload.get('teams', []):
            team['raw_model_projected_score'] = team.get('our_projected_score')
            starters = [r['projection']['recommendation_projection'] for r in payload['players']
                        if r.get('fantasy_team_id') == team['team_id'] and r.get('is_starter')]
            team['our_projected_score'] = round(sum(starters), 3) if starters and all(v is not None for v in starters) else None
        payload.update(snapshot_id=sid, input_fingerprint=fingerprint, created_at=payload['last_updated'],
                       source_as_of={k: v.get('source_updated_at') for k, v in payload.get('source_status', {}).get('sources', {}).items()},
                       expires_in_seconds=TTL_SECONDS)
        _CURRENT[key] = (time.monotonic(), payload)
        _VERSIONS[(key, sid)] = (time.monotonic(), payload)
        for version_key, (created, _) in list(_VERSIONS.items()):
            if time.monotonic() - created > RETENTION_SECONDS:
                _VERSIONS.pop(version_key, None)
        return deepcopy(payload)


def resolve_players(service, week, players):
    """Reuse roster projections; lazily add missing players with the same cohort prior."""
    payload = snapshot(service, week)
    sid = payload['snapshot_id']
    key = _key(service, week)
    with _LOCKS[key]:
        stored = _VERSIONS[(key, sid)][1]
        records = {r['player_id']: r for r in stored['players']}
        extras = stored.setdefault('_extra_players', {})
        missing = [p for p in players if p['player_id'] not in records and p['player_id'] not in extras]
        if missing:
            from projection_sources.context import enrich_players
            from projection_engine import project_player, _position_variances
            cohort = [r['player'] for r in stored['players']]
            variances = _position_variances(cohort, week, service.league.current_week)
            ids = [p['player_id'] for p in missing]
            insights = service.player_insights(ids, week)
            normalized = [{**p, **insights.get(p['player_id'], {})} for p in missing]
            enriched, _ = enrich_players(normalized, service.league.year, week, service)
            for pid, player in enriched.items():
                model = project_player(player, week, variances.get(player.get('position')), service.league.current_week)
                extras[pid] = _decorate(player, model, sid)
        output = {}
        for original in players:
            pid = original['player_id']
            canonical = records[pid]['player'] if pid in records else extras[pid]
            # Keep caller-specific slot/ownership/live scoring and recommendation annotations.
            merged = {**original, **deepcopy(canonical)}
            for field in ('lineup_slot', 'lineup_status', 'is_starter', 'fantasy_points',
                          'fantasy_team_id', 'fantasy_team_name', 'roster_status',
                          'score_components', 'score_weights', 'score_formula', 'recommendation_score'):
                if field in original: merged[field] = original[field]
            output[pid] = merged
        return output, payload.get('source_status', {})

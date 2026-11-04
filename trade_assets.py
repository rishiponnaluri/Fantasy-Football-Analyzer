"""League-specific exchange value, independent of either manager's position needs."""
import math
from statistics import median

from recommendation_service import confidence_aware_value, usable_number


def asset_value(player, replacement, service, week):
    from trade_service import _remaining_weeks_value, _ros_expected_rate
    total, games = _remaining_weeks_value(player, service, week)
    rate, source = _ros_expected_rate(player, week)
    model = player.get('custom_projection') or player.get('trade_projection') or {}
    sd = model.get('standard_deviation')
    supported = total is not None and games > 0 and usable_number(replacement) and usable_number(sd)
    surplus = max(0.0, rate - replacement) if supported else None
    context = model.get('projection_context') or {}
    return {
        'player_id': player['player_id'], 'name': player.get('name'), 'position': player.get('position'),
        'canonical_weekly_projection': confidence_aware_value(player)[0],
        'ros_value': total, 'remaining_games': games, 'ros_weekly_rate': rate,
        'replacement_weekly_rate': replacement, 'weekly_points_above_replacement': surplus,
        'asset_value': round(surplus * games, 3) if supported else None,
        'uncertainty': round(float(sd) * math.sqrt(games), 3) if supported else None,
        'starter_value': surplus, 'scarcity_basis': 'same-position real available-player pool',
        'role_workload': context.get('role_trend'), 'health_status': player.get('injury_status'),
        'health_adjustment': [a for a in model.get('adjustments', []) if a.get('key') == 'injury'],
        'confidence': model.get('confidence'), 'rate_source': source,
        'supported': supported,
        'method': 'max(0, existing ROS rate − available same-position replacement rate) × real remaining games. Health/role/confidence already enter the canonical estimate; no second multiplier.',
    }


def attach_assets(service, week, players):
    from projection_snapshot import snapshot, resolve_players
    from trade_service import _ros_expected_rate
    payload = snapshot(service, week)
    version = payload['snapshot_id']
    rostered_ids = {row['player_id'] for row in payload['players']}
    def build():
        pool = service.free_agents(week, None, 100)['players']
        pool = [p for p in pool if p['player_id'] not in rostered_ids
                and p.get('fantasy_team_id') in (None, 0)
                and str(p.get('injury_status') or '').upper() not in {'OUT', 'IR', 'DOUBTFUL', 'PUP'}]
        resolved, _ = resolve_players(service, week, pool)
        levels = {}
        for position in ('QB', 'RB', 'WR', 'TE', 'K', 'D/ST'):
            candidates = sorted(((_ros_expected_rate(p, week)[0], p['player_id']) for p in resolved.values()
                                 if p.get('position') == position and p.get('fantasy_team_id') in (None, 0)
                                 and _ros_expected_rate(p, week)[0] is not None), reverse=True)
            # A small set of actual available alternatives avoids treating one outlier
            # as the whole market; traded roster assets cannot be in this pool.
            levels[position] = {'rate': median([r for r, _ in candidates[:3]]) if candidates else None,
                                'player_ids': [pid for _, pid in candidates[:3]]}
        return levels
    try:
        levels = service.memoized(('trade_replacement_pool', week, version), 300, build)
    except Exception:
        # Lack of exchange evidence cannot silently certify a suggested trade.
        levels = {}
    for player in players:
        replacement = levels.get(player.get('position'), {})
        player['_trade_asset'] = asset_value(player, replacement.get('rate'), service, week)
        player['_trade_asset']['replacement_player_ids'] = replacement.get('player_ids', [])
    return players


def exchange_value(players, give_ids, receive_ids):
    by_id = {p['player_id']: p for p in players}
    giving = [by_id[pid].get('_trade_asset', {}) for pid in give_ids]
    receiving = [by_id[pid].get('_trade_asset', {}) for pid in receive_ids]
    assets = giving + receiving
    if not assets or not all(a.get('supported') for a in assets):
        return {'supported': False, 'outgoing': giving, 'incoming': receiving,
                'reason': 'Replacement or remaining-season evidence is unavailable.'}
    outgoing = sum(a['asset_value'] for a in giving)
    incoming = sum(a['asset_value'] for a in receiving)
    band = math.sqrt(sum(a['uncertainty'] ** 2 for a in assets))
    delta = incoming - outgoing
    return {'supported': True, 'outgoing_value': round(outgoing, 3), 'incoming_value': round(incoming, 3),
            'difference': round(delta, 3), 'uncertainty': round(band, 3),
            'normalized_difference': delta / band if band else None,
            'material_overpay': delta < -band, 'severe_overpay': delta < -2 * band,
            'outgoing': giving, 'incoming': receiving}


def apply_exchange_guardrail(worth, reason, exchange):
    if exchange.get('supported') and exchange.get('material_overpay'):
        worth = 'NO' if exchange['severe_overpay'] else 'LEAN NO'
        reason = (f"You give up {abs(exchange['difference']):.1f} more replacement-adjusted asset points than you receive, "
                  f"beyond the {exchange['uncertainty']:.1f}-point uncertainty band. Position need does not offset that exchange loss. " + reason)
    return worth, reason


def plausible_exchange(players, give_ids, receive_ids):
    report = exchange_value(players, give_ids, receive_ids)
    # Broad two-sigma prefilter; full one-sigma overpay protection follows analysis.
    return report.get('supported', False) and not report.get('severe_overpay', False)

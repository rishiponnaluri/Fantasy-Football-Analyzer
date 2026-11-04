"""Order/filter automatic ideas only. Manual analysis and all valuations are unchanged."""
import math


def _number(value):
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else 0.0


def _need_solved(row):
    breakdown = (row.get('verdict') or {}).get('worth_it_breakdown') or {}
    needs = (row.get('positional_impact') or {}).get('you') or {}
    meaningful = any(str((needs.get(position) or {}).get('before_strength', '')).lower()
                     in {'weak', 'weak depth', 'needs improvement', 'unavailable'}
                     for position in breakdown.get('position_improved') or [])
    if not meaningful:
        return False
    return (_number((row.get('weekly_lineup_change') or {}).get('you')) > 0
            or _number((row.get('rest_of_season_change') or {}).get('you')) > 0)


def ranking_key(row):
    verdict = row.get('verdict') or {}
    worth = verdict.get('worth_it')
    acceptance = {'HIGH': 1.0, 'MEDIUM': .65, 'LOW': .25, 'VERY LOW': .1}.get(verdict.get('acceptance_likelihood'), .1)
    confidence = {'HIGH': 1.0, 'MEDIUM': .7, 'LOW': .4}.get(verdict.get('worth_it_confidence'), .4)
    # Favor actionable positive ideas over theoretically excellent but implausible ones.
    tier = 3 if worth in {'YES', 'LEAN YES'} and acceptance >= .65 else 2 if worth in {'YES', 'LEAN YES'} else 1
    weekly = _number((row.get('weekly_lineup_change') or {}).get('you'))
    ros = _number((row.get('rest_of_season_change') or {}).get('you'))
    replacement = _number((verdict.get('worth_it_breakdown') or {}).get('value_above_replacement_change'))
    # Bounded central-estimate inputs prevent a single outsized long-term total
    # overwhelming direction, confidence and willingness to exchange.
    benefit = 4*math.tanh(weekly/5) + 2*math.tanh(ros/40) + 2*math.tanh(replacement/40)
    score = (4 if worth == 'YES' else 2 if worth == 'LEAN YES' else 0) + 3*acceptance + confidence + benefit*acceptance
    identity = (row.get('partner_team_id') or (row.get('other_team') or {}).get('team_id') or 0,
                tuple(sorted(p['player_id'] for p in row.get('you_give', []))),
                tuple(sorted(p['player_id'] for p in row.get('you_receive', []))))
    return (-tier, -score, identity)


def rank_suggestions(rows):
    unique = {}
    for row in rows:
        if (row.get('verdict') or {}).get('worth_it') not in {'YES', 'LEAN YES', 'EVEN'}:
            continue
        key = ranking_key(row)[2]
        unique.setdefault(key, row)
    positive = [row for row in unique.values() if row['verdict']['worth_it'] in {'YES', 'LEAN YES'}]
    candidates = positive or [row for row in unique.values()
                              if row['verdict'].get('acceptance_likelihood') in {'HIGH', 'MEDIUM'} and _need_solved(row)]
    return sorted(candidates, key=ranking_key)

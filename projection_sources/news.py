"""Converts machine-readable NFL reports into projection-safe context events.

Only official structured injury/practice and weekly-roster records are accepted.
This adapter deliberately has no free-text headline or model-generated input.
"""

from __future__ import annotations


def structured_events(events: list[dict]) -> list[dict]:
    allowed = {"official_injury_report", "weekly_roster_context", "teammate_reported_out",
               "opponent_defender_injury_report"}
    normalized = []
    for event in events:
        if event.get("event_type") not in allowed or event.get("confidence") not in {"high", "medium"}:
            continue
        required = ("event_type", "player_id", "affected_metric", "direction", "confidence", "source", "timestamp")
        if all(key in event for key in required):
            normalized.append({key: event[key] for key in (*required, "detail") if key in event})
    return normalized

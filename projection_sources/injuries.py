"""Structured events from nflverse weekly injury reports and roster status."""

from __future__ import annotations


def events_for_player(player: dict, gsis_id: str | None, week: int,
                      injury_rows: list[dict], roster_rows: list[dict],
                      retrieved_at: str | None) -> list[dict]:
    events = []
    report = next((row for row in injury_rows if row.get("gsis_id") == gsis_id
                   and row.get("week") == str(week) and row.get("season_type") == "REG"), None)
    if report:
        status = report.get("report_status")
        practice = report.get("practice_status")
        if status or practice:
            events.append({"event_type": "official_injury_report", "player_id": player.get("player_id"),
                           "affected_metric": "availability", "direction": (status or practice or "unknown").casefold(),
                           "confidence": "high" if status else "medium", "source": "nflverse weekly injury report",
                           "timestamp": retrieved_at, "detail": {"report_status": status or None,
                                                                       "practice_status": practice or None,
                                                                       "primary_injury": report.get("report_primary_injury") or report.get("practice_primary_injury") or None,
                                                                       "secondary_injury": report.get("report_secondary_injury") or report.get("practice_secondary_injury") or None}})
    roster = next((row for row in roster_rows if row.get("espn_id") == str(player.get("player_id"))
                   and row.get("week") == str(week) and row.get("game_type") == "REG"), None)
    if roster and (roster.get("status_description_abbr") or roster.get("depth_chart_position")):
        events.append({"event_type": "weekly_roster_context", "player_id": player.get("player_id"),
                       "affected_metric": "availability_and_role", "direction": roster.get("status_description_abbr") or "listed",
                       "confidence": "medium", "source": "nflverse weekly roster", "timestamp": retrieved_at,
                       "detail": {"status": roster.get("status"), "status_description": roster.get("status_description_abbr"),
                                  "depth_chart_position": roster.get("depth_chart_position")}})
    # Teammate status is surfaced as evidence, but no workload bonus is inferred
    # without enough player-level active/inactive observations.
    if player.get("nfl_team"):
        from projection_sources.nfl_stats import nflverse_team
        nfl_team = nflverse_team(player["nfl_team"])
        teammates = [row for row in injury_rows if row.get("team") == nfl_team
                     and row.get("week") == str(week) and row.get("season_type") == "REG"
                     and row.get("gsis_id") != gsis_id and (row.get("report_status") or "").casefold() == "out"]
        if teammates:
            events.append({"event_type": "teammate_reported_out", "player_id": player.get("player_id"),
                           "affected_metric": "teammate_opportunity", "direction": "potential_opportunity_change",
                           "confidence": "high", "source": "nflverse weekly injury report", "timestamp": retrieved_at,
                           "detail": {"out_teammates": [{"player_id": row.get("gsis_id"), "position": row.get("position"),
                                                            "name": row.get("full_name")} for row in teammates]}})
    return events


def opponent_defender_events(player: dict, week: int, injury_rows: list[dict],
                             player_map: dict[str, dict], retrieved_at: str | None) -> list[dict]:
    from projection_sources.nfl_stats import nflverse_team
    opponent = nflverse_team(player.get("nfl_opponent"))
    defensive_positions = {"CB", "S", "DB", "FS", "SS", "LB", "DE", "DL", "DT", "NT", "EDGE", "OLB", "ILB"}
    events = []
    for row in injury_rows:
        if row.get("team") != opponent or row.get("week") != str(week) or row.get("season_type") != "REG":
            continue
        if row.get("position") not in defensive_positions:
            continue
        status, practice = row.get("report_status"), row.get("practice_status")
        if (status or "").casefold() not in {"out", "doubtful", "questionable"} and (practice or "").casefold() not in {
            "did not participate in practice", "limited participation in practice"}:
            continue
        mapping = player_map.get(row.get("gsis_id")) or {}
        events.append({"event_type": "opponent_defender_injury_report",
                       "player_id": int(mapping["espn_id"]) if str(mapping.get("espn_id", "")).isdigit() else None,
                       "affected_metric": "opponent_defensive_availability",
                       "direction": (status or practice or "reported").casefold(),
                       "confidence": "high" if status else "medium",
                       "source": "nflverse weekly injury report", "timestamp": retrieved_at,
                       "detail": {"name": row.get("full_name"), "position": row.get("position"),
                                  "report_status": status or None, "practice_status": practice or None,
                                  "primary_injury": row.get("report_primary_injury") or row.get("practice_primary_injury") or None,
                                  "secondary_injury": row.get("report_secondary_injury") or row.get("practice_secondary_injury") or None}})
    return events


def injury_adjustment(events: list[dict], current_mean: float | None):
    event = next((item for item in events if item["event_type"] == "official_injury_report"
                  and (item.get("detail", {}).get("report_status") or "").casefold() == "out"), None)
    if event and current_mean is not None:
        return {"key": "injury", "label": "Official injury status", "adjustment": round(-current_mean, 3),
                "evidence": "The current official weekly injury report lists the player OUT; expected fantasy points set to zero.",
                "source": event["source"]}
    return None

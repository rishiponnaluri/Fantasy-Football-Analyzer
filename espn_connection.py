"""Shared server-side ESPN configuration and team identification."""

import os
from pathlib import Path
import sys


def normalize_swid(value):
    return str(value).strip().strip("{}").casefold()


def configuration():
    from dotenv import load_dotenv

    # Exported environment variables take precedence over the local .env.
    load_dotenv(Path(__file__).resolve().with_name(".env"), override=False)
    required = ("ESPN_LEAGUE_ID", "ESPN_S2", "ESPN_SWID")
    missing = [name for name in required if not os.getenv(name, "").strip()]
    if missing:
        raise ValueError("Missing environment variables: " + ", ".join(missing))
    try:
        league_id = int(os.environ["ESPN_LEAGUE_ID"])
        year = int(os.getenv("ESPN_YEAR", "2026"))
    except ValueError:
        raise ValueError("ESPN_LEAGUE_ID and ESPN_YEAR must be integers.") from None
    if league_id <= 0 or year < 2019:
        raise ValueError("ESPN_LEAGUE_ID must be positive; ESPN_YEAR must be >= 2019.")
    return league_id, year, os.environ["ESPN_S2"].strip(), os.environ["ESPN_SWID"].strip()


def report_error(context, error):
    # Preserve the exception type/message while keeping cookies out of output.
    message = str(error)
    for name in ("ESPN_S2", "ESPN_SWID"):
        secret = os.getenv(name, "").strip()
        if secret:
            message = message.replace(secret, "[credential redacted]")
    print(f"ERROR ({context}): {type(error).__name__}: {message}", file=sys.stderr)


def select_team(teams, swid, team_id):
    if team_id is not None:
        matches = [team for team in teams if team.team_id == team_id]
    else:
        matches = [
            team for team in teams
            if any(normalize_swid(owner.get("id", "")) == normalize_swid(swid)
                   for owner in team.owners)
        ]
    if len(matches) != 1:
        raise ValueError(
            f"Could not identify exactly one team (found {len(matches)}). "
            "Run with --team-id using an ID from the printed team list."
        )
    return matches[0]


def connect_league():
    from espn_api.football import League

    league_id, year, espn_s2, swid = configuration()
    return League(league_id=league_id, year=year, espn_s2=espn_s2,
                  swid=swid, debug=False)

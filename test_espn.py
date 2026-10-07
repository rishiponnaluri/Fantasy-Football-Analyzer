"""Read-only integration smoke test against a real ESPN Fantasy Football league.

Setup:
    python3 -m venv .venv
    source .venv/bin/activate
    python -m pip install -r requirements.txt
    cp .env.example .env
    # Fill in .env locally, then:
    python test_espn.py

Your team is identified by ESPN_SWID in ESPN's owner records. If ESPN does
not return a unique owner match, use python test_espn.py --team-id YOUR_TEAM_ID.
No test fixtures or substitute league data are used. Failures exit nonzero.
"""

import argparse
import sys

from espn_connection import configuration, connect_league, report_error, select_team


def number(value):
    return "unavailable" if value is None else f"{value:.2f}"


def weekly_stat(player, week, key):
    # BoxPlayer convenience attributes default to zero even for missing stats.
    # Check the underlying ESPN-derived stats instead so absence stays visible.
    return player.stats.get(week, {}).get(key)


def print_player(player, week, show_slot=False):
    slot_text = ""
    if show_slot:
        slot = player.lineupSlot
        if slot == "BE":
            status = "Bench"
        elif slot in ("IR", "ER"):
            status = "Reserve"
        elif slot and slot != "FA":
            status = "Starter"
        else:
            status = "Unassigned"
        slot_text = f" | {status} (slot: {slot or 'unavailable'})"
    print(
        f"  {player.name} | {player.position or 'position unavailable'}"
        f" | {player.proTeam}{slot_text}"
        f" | points: {number(weekly_stat(player, week, 'points'))}"
        f" | projected: {number(weekly_stat(player, week, 'projected_points'))}"
    )


def print_fantasy_matchup(matchup, week):
    for side in ("home", "away"):
        team = getattr(matchup, f"{side}_team")
        if team is None:
            print(f"  {side.title()}: BYE (no opponent)")
            continue
        lineup = getattr(matchup, f"{side}_lineup")
        starters = [p for p in lineup if p.slot_position not in ("BE", "IR", "ER", "FA", "")]
        # espn-api may derive a team projection by summing player projections.
        # Don't label its default zero or an incomplete sum as a full projection.
        projection = getattr(matchup, f"{side}_projected") if starters and all(
            weekly_stat(p, week, "projected_points") is not None for p in starters
        ) else None
        print(
            f"  {side.title()}: {team.team_name}"
            f" | current score: {number(getattr(matchup, f'{side}_score'))}"
            f" | projected: {number(projection)}"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--team-id", type=int, help="Override automatic team selection by SWID")
    args = parser.parse_args()

    try:
        league_id, year, espn_s2, swid = configuration()
        print(f"Connecting to ESPN league {league_id}, season {year}...", flush=True)
        league = connect_league()
    except Exception as error:
        report_error("league connection/configuration", error)
        return 1

    week = league.current_week
    print(f"\nLeague name: {league.settings.name}")
    print(f"Current week (scoring period): {week}")
    print("\nAll teams:")
    for team in league.teams:
        print(f"  ID {team.team_id}: {team.team_name} ({team.team_abbrev}) | {team.wins}-{team.losses}-{team.ties}")

    failed = False
    my_team = None
    try:
        my_team = select_team(league.teams, swid, args.team_id)
        print(f"\nMy roster: {my_team.team_name} (team ID {my_team.team_id})")
        if not my_team.roster:
            print("  ESPN returned an empty roster.")
        for player in my_team.roster:
            print_player(player, week, show_slot=True)
    except Exception as error:
        report_error("my team/roster", error)
        failed = True

    try:
        matchups = league.box_scores(week=week)
        print(f"\nCurrent fantasy matchups and scores (week {week}):")
        if not matchups:
            print("  ESPN returned no matchups for this week.")
        my_matchup_found = False
        for matchup in matchups:
            is_mine = my_team is not None and any(
                getattr(team, "team_id", None) == my_team.team_id
                for team in (matchup.home_team, matchup.away_team)
            )
            my_matchup_found = my_matchup_found or is_mine
            print("\n  MY CURRENT FANTASY MATCHUP" if is_mine else "\n  Fantasy matchup")
            print_fantasy_matchup(matchup, week)
        if my_team is not None and not my_matchup_found:
            print("\n  ESPN returned no current fantasy matchup for my team.")
    except Exception as error:
        report_error("current fantasy matchups/scores", error)
        failed = True

    print("\nTop available players: five per position, ranked by ESPN ownership percentage.")
    print("Includes free agents and waiver players; weekly projections shown when ESPN supplies them.")
    for position in ("QB", "RB", "WR", "TE"):
        try:
            players = league.free_agents(week=week, size=5, position=position)
            print(f"\n{position}:")
            if not players:
                print("  ESPN returned no available players at this position.")
            for player in players:
                print_player(player, week)
                owned = player.percent_owned
                print(f"    ESPN ownership: {number(owned) + '%' if owned >= 0 else 'unavailable'}")
        except Exception as error:
            report_error(f"available {position} players", error)
            failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

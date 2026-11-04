"""Run once from hosting cron, or --watch locally while the process is running."""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def run_once(force=False):
    from main import get_espn_service
    from player_news import refresh
    try:
        return refresh(get_espn_service(), force=force)
    except Exception:
        # Never emit provider exceptions that may contain authenticated request data.
        return {'status': 'unavailable', 'errors': ['provider_or_storage_unavailable']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--force', action='store_true', help='On-demand refresh; minimum 60-second cooldown still applies.')
    args = parser.parse_args()
    if args.watch:
        time.sleep(60)
    while True:
        print(json.dumps(run_once(args.force)), flush=True)
        if not args.watch: break
        time.sleep(2700)


if __name__ == '__main__':
    main()

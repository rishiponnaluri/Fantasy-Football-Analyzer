"""Persisted structured player updates. News is context and never model input."""
from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
import time
from urllib.parse import urlparse

import watchlist_store


@contextmanager
def connect():
    db = watchlist_store._connect()
    db.execute('''CREATE TABLE IF NOT EXISTS player_updates (
        dedupe_key TEXT PRIMARY KEY, league_id INTEGER NOT NULL, player_id INTEGER NOT NULL,
        player_name TEXT NOT NULL, source TEXT NOT NULL, source_type TEXT NOT NULL,
        headline TEXT NOT NULL, summary TEXT, published_at TEXT, retrieved_at TEXT NOT NULL,
        url TEXT, source_updated_at TEXT, category TEXT NOT NULL, team TEXT, week INTEGER, impact TEXT NOT NULL)''')
    columns = {row[1] for row in db.execute('PRAGMA table_info(player_updates)')}
    if 'source_updated_at' not in columns:
        db.execute('ALTER TABLE player_updates ADD COLUMN source_updated_at TEXT')
    # Feed-wide update times do not establish an individual report's publication.
    for row in db.execute("SELECT * FROM player_updates WHERE source LIKE 'nflverse%' AND published_at IS NOT NULL").fetchall():
        corrected = record({'player_id': row['player_id'], 'name': row['player_name'], 'nfl_team': row['team']},
                           row['league_id'], row['week'], row['source'], row['category'], row['summary'],
                           row['retrieved_at'], url=row['url'], source_updated_at=row['published_at'])
        db.execute('UPDATE OR IGNORE player_updates SET dedupe_key=?,source_updated_at=?,published_at=NULL WHERE dedupe_key=?',
                   (corrected['dedupe_key'], corrected['source_updated_at'], row['dedupe_key']))
    db.execute('CREATE INDEX IF NOT EXISTS player_updates_lookup ON player_updates(league_id, player_id, week)')
    db.execute('''CREATE TABLE IF NOT EXISTS player_news_jobs (
        league_id INTEGER PRIMARY KEY, last_attempt REAL NOT NULL, last_success REAL,
        running_until REAL NOT NULL DEFAULT 0)''')
    try:
        with db:
            yield db
    finally:
        db.close()


def impact(category, value):
    text = str(value or '').upper().replace('_', ' ')
    if text in {'OUT', 'IR', 'INJURED RESERVE', 'INACTIVE', 'PUP', 'ACTIVATED', 'BENCHED'}: return 'HIGH'
    if category in {'practice', 'depth_chart', 'role'} or text in {'QUESTIONABLE', 'Q', 'DOUBTFUL', 'D'}: return 'MEDIUM'
    return 'LOW'


def record(player, league_id, week, source, category, value, retrieved_at, published_at=None, url=None, source_updated_at=None):
    if not value: return None
    url = url if url and urlparse(url).scheme in {'http', 'https'} and urlparse(url).netloc else None
    headline = f"{player['name']}: {category.replace('_', ' ')} — {value}"
    identity = [league_id, player['player_id'], week, source, category, str(value), published_at, url]
    return {'player_id': player['player_id'], 'player_name': player['name'], 'league_id': league_id,
            'source': source, 'source_type': 'structured_provider', 'headline': headline,
            'summary': str(value), 'published_at': published_at, 'retrieved_at': retrieved_at,
            'url': url, 'source_updated_at': source_updated_at, 'category': category, 'team': player.get('nfl_team'), 'week': week,
            'impact': impact(category, value),
            'dedupe_key': hashlib.sha256(json.dumps(identity).encode()).hexdigest()}


def store(records):
    records = [r for r in records if r]
    inserted = 0
    with connect() as db:
        for row in records:
            keys = list(row)
            inserted += db.execute(f"INSERT OR IGNORE INTO player_updates ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})", list(row.values())).rowcount
    return inserted


def updates(league_id, player_id, week=None):
    with connect() as db:
        query = 'SELECT * FROM player_updates WHERE league_id=? AND player_id=?'
        params = [league_id, player_id]
        if week is not None:
            query += ' AND week=?'; params.append(week)
        return [dict(row) for row in db.execute(query + ' ORDER BY COALESCE(published_at,retrieved_at) DESC LIMIT 30', params)]


def normalize_nflverse(players, league_id, week, mappings, injuries, rosters, sources):
    output = []
    for p in players:
        pid = str(p['player_id'])
        gsis = mappings.get(pid, {}).get('gsis_id')
        for row in injuries:
            if not gsis or row.get('gsis_id') != gsis or row.get('week') != str(week) or row.get('season_type') != 'REG': continue
            meta = sources['injuries']
            for field, category in [('report_status', 'injury'), ('practice_status', 'practice')]:
                output.append(record(p, league_id, week, 'nflverse weekly injury report', category, row.get(field),
                                     meta['retrieved_at'], url=meta.get('url'), source_updated_at=meta.get('source_updated_at')))
        for row in rosters:
            if row.get('espn_id') != pid or row.get('week') != str(week) or row.get('game_type') != 'REG': continue
            meta = sources['weekly_rosters']
            for field, category in [('status_description_abbr', 'availability'), ('depth_chart_position', 'depth_chart')]:
                output.append(record(p, league_id, week, 'nflverse weekly roster', category, row.get(field),
                                     meta['retrieved_at'], url=meta.get('url'), source_updated_at=meta.get('source_updated_at')))
    return [r for r in output if r]


def refresh(service, force=False):
    """Same entry point for local worker, CLI, or hosting cron. Failures are isolated."""
    lid, year, week = service.league.league_id, service.league.year, service.week(None)
    now = time.time()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT * FROM player_news_jobs WHERE league_id=?', (lid,)).fetchone()
        interval = 60 if force else 2700
        if previous and (previous['running_until'] > now or now - previous['last_attempt'] < interval):
            return {'status': 'cached', 'inserted': 0, 'league_id': lid}
        db.execute('''INSERT INTO player_news_jobs(league_id,last_attempt,running_until) VALUES(?,?,?)
                      ON CONFLICT(league_id) DO UPDATE SET last_attempt=excluded.last_attempt,running_until=excluded.running_until''', (lid, now, now + 600))
    errors, records = [], []
    try:
        roster = service.my_team_info(week).get('roster') or []
        monitored = {p['player_id']: p for p in roster}
        try:
            saved = watchlist_store.list_items()
            extra = service.player_insights([r['player_id'] for r in saved if r['player_id'] not in monitored], week)
            monitored.update(extra)
        except Exception:
            errors.append('saved_players_unavailable')
        retrieved = datetime.now(timezone.utc).isoformat()
        for p in monitored.values():
            records.append(record(p, lid, week, 'ESPN Fantasy roster status', 'availability', p.get('injury_status'), retrieved))
        try:
            details = service.player_insights(list(monitored), week)
            for p in monitored.values():
                # Completed prior-week usage is an attributed context update,
                # never an input back into the projection snapshot.
                games = [g for g in details.get(p['player_id'], {}).get('game_log', [])
                         if isinstance(g.get('week'), int) and g['week'] < week]
                if not games:
                    continue
                game = max(games, key=lambda g: g['week'])
                stats = game.get('stats') or {}
                values = [f"{label}: {stats[key]}" for key, label in
                          [('passingAttempts', 'pass attempts'), ('rushingAttempts', 'carries'),
                           ('receivingTargets', 'targets'), ('receivingReceptions', 'receptions')]
                          if isinstance(stats.get(key), (int, float))]
                if values:
                    records.append(record(p, lid, week, 'ESPN Fantasy game log', 'usage',
                                          f"Week {game['week']} — " + ', '.join(values), retrieved))
        except Exception:
            errors.append('usage_unavailable')
        from projection_sources.cache import nflverse_csv
        feeds, sources = {}, {}
        for name, asset, filename in [('players','players','players.csv.gz'),
                                      ('injuries','injuries',f'injuries_{year}.csv.gz'),
                                      ('weekly_rosters','weekly_rosters',f'roster_weekly_{year}.csv.gz')]:
            try:
                rows, meta = nflverse_csv(asset, filename)
                feeds[name] = rows or []
                sources[name] = meta
                if not meta.get('available'): errors.append(f'{name}_unavailable')
            except Exception:
                feeds[name] = []; sources[name] = {}; errors.append(f'{name}_unavailable')
        mappings = {r['espn_id']: r for r in feeds['players'] if r.get('espn_id')}
        records += normalize_nflverse(list(monitored.values()), lid, week, mappings,
                                     feeds['injuries'], feeds['weekly_rosters'], sources)
        count = store(records)
        with connect() as db:
            db.execute('UPDATE player_news_jobs SET last_success=?,running_until=0 WHERE league_id=?', (time.time(), lid))
        return {'status': 'partial' if errors else 'ok', 'week': week, 'monitored': len(monitored),
                'inserted': count, 'errors': errors}
    except Exception:
        with connect() as db: db.execute('UPDATE player_news_jobs SET running_until=0 WHERE league_id=?', (lid,))
        return {'status': 'unavailable', 'errors': ['roster_or_storage_unavailable'], 'inserted': 0}

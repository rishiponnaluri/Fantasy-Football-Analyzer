"""Small persistent server-side SQLite store for watched ESPN player IDs."""

from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3

from espn_service import APIError


DEFAULT_DB = Path(__file__).resolve().with_name(".data") / "watchlist.sqlite3"


def database_path():
    return Path(os.getenv("WATCHLIST_DB_PATH", str(DEFAULT_DB))).expanduser()


def _connect():
    path = database_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("""CREATE TABLE IF NOT EXISTS watchlist (
            player_id INTEGER PRIMARY KEY,
            label TEXT NULL,
            added_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""")
        return connection
    except sqlite3.Error as error:
        raise APIError(500, "watchlist_storage_error", f"Could not open the local watchlist database: {error}") from None


def list_items():
    try:
        with _connect() as connection:
            rows = connection.execute(
                "SELECT player_id, label, added_at, updated_at FROM watchlist ORDER BY added_at DESC, player_id"
            ).fetchall()
            return [dict(row) for row in rows]
    except sqlite3.Error as error:
        raise APIError(500, "watchlist_storage_error", f"Could not read the local watchlist database: {error}") from None


def save_item(player_id, label):
    now = datetime.now(timezone.utc).isoformat()
    try:
        with _connect() as connection:
            connection.execute(
                """INSERT INTO watchlist(player_id, label, added_at, updated_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(player_id) DO UPDATE SET label=excluded.label, updated_at=excluded.updated_at""",
                (player_id, label, now, now),
            )
            row = connection.execute(
                "SELECT player_id, label, added_at, updated_at FROM watchlist WHERE player_id=?", (player_id,)
            ).fetchone()
            return dict(row)
    except sqlite3.Error as error:
        raise APIError(500, "watchlist_storage_error", f"Could not save to the local watchlist database: {error}") from None


def update_label(player_id, label):
    now = datetime.now(timezone.utc).isoformat()
    try:
        with _connect() as connection:
            cursor = connection.execute(
                "UPDATE watchlist SET label=?, updated_at=? WHERE player_id=?", (label, now, player_id)
            )
            if cursor.rowcount == 0:
                return None
            row = connection.execute(
                "SELECT player_id, label, added_at, updated_at FROM watchlist WHERE player_id=?", (player_id,)
            ).fetchone()
            return dict(row)
    except sqlite3.Error as error:
        raise APIError(500, "watchlist_storage_error", f"Could not update the local watchlist database: {error}") from None


def remove_item(player_id):
    try:
        with _connect() as connection:
            cursor = connection.execute("DELETE FROM watchlist WHERE player_id=?", (player_id,))
            return cursor.rowcount > 0
    except sqlite3.Error as error:
        raise APIError(500, "watchlist_storage_error", f"Could not remove from the local watchlist database: {error}") from None

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from loguru import logger


def _db_path() -> Path:
    # 放在项目根目录下（你也可以改成 backend/ 下）
    return (Path(__file__).resolve().parents[1] / "data").resolve() / "save.sqlite3"


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # 并发友好一点
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def init_db() -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
              session_id TEXT PRIMARY KEY,
              state_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def load_state_json(session_id: str) -> str | None:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT state_json FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            return None
        return str(row["state_json"])
    finally:
        conn.close()


def save_state_json(session_id: str, state_json: str) -> None:
    now = int(time.time())
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO sessions(session_id, state_json, created_at, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              state_json=excluded.state_json,
              updated_at=excluded.updated_at
            """,
            (session_id, state_json, now, now),
        )
        conn.commit()
    finally:
        conn.close()


def delete_session(session_id: str) -> None:
    conn = _connect()
    try:
        conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        conn.commit()
    finally:
        conn.close()

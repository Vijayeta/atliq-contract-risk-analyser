"""SQLite storage. Contracts are stored as JSON documents in exactly the frontend's shape;
obligations and precedents also get FTS5 indexes for BM25 retrieval."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

from .access import USERS

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("ATLIQ_DB", ROOT / "atliq.db"))
SEED_PATH = ROOT / "seed" / "seed.json"
UPLOAD_DIR = Path(os.environ.get("ATLIQ_UPLOADS", ROOT / "uploads"))

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uploads (contract_id TEXT PRIMARY KEY, filename TEXT, path TEXT, meta TEXT);
CREATE TABLE IF NOT EXISTS obligations (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS obligations_fts USING fts5(id UNINDEXED, clause_type, counterparty, body);
CREATE TABLE IF NOT EXISTS precedents (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS precedents_fts USING fts5(id UNINDEXED, clause_type, counterparty, body);
CREATE TABLE IF NOT EXISTS pending_precedents (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, at TEXT, actor TEXT, action TEXT, detail TEXT, kind TEXT);
CREATE TABLE IF NOT EXISTS counterparty_events (counterparty_key TEXT, date TEXT, kind TEXT, detail TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, contract_id TEXT, step INTEGER, total INTEGER, status TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def stamp(dt: datetime | None = None) -> str:
    return (dt or datetime.now()).strftime("%d %b %Y, %H:%M")


def today() -> str:
    return datetime.now().strftime("%d %b %Y")


def party_key(name: str) -> str:
    """Normalises a counterparty name: 'Northwind Health Inc.' -> 'northwind health'."""
    s = re.sub(r"[^a-z0-9 ]", " ", name.lower())
    s = re.sub(r"\b(inc|ltd|llc|gmbh|sa|pjsc|plc|bv|pvt|private|limited|co|corp|corporation|fz)\b", " ", s)
    return " ".join(s.split())


# ----------------------------- generic JSON tables -----------------------------

def _next_seq(conn: sqlite3.Connection, table: str) -> int:
    return (conn.execute(f"SELECT COALESCE(MAX(seq), 0) + 1 FROM {table}").fetchone()[0])


def put_json(conn: sqlite3.Connection, table: str, obj: dict) -> dict:
    row = conn.execute(f"SELECT seq FROM {table} WHERE id = ?", (obj["id"],)).fetchone()
    seq = row["seq"] if row else _next_seq(conn, table)
    conn.execute(f"INSERT OR REPLACE INTO {table} (id, json, seq) VALUES (?, ?, ?)", (obj["id"], json.dumps(obj), seq))
    if table in ("obligations", "precedents"):
        _index(conn, table, obj)
    conn.commit()
    return obj


def get_json(conn: sqlite3.Connection, table: str, id_: str) -> dict | None:
    row = conn.execute(f"SELECT json FROM {table} WHERE id = ?", (id_,)).fetchone()
    return json.loads(row["json"]) if row else None


def list_json(conn: sqlite3.Connection, table: str) -> list[dict]:
    """Newest first (highest seq)."""
    return [json.loads(r["json"]) for r in conn.execute(f"SELECT json FROM {table} ORDER BY seq DESC")]


def delete_json(conn: sqlite3.Connection, table: str, id_: str) -> None:
    conn.execute(f"DELETE FROM {table} WHERE id = ?", (id_,))
    conn.commit()


def _index(conn: sqlite3.Connection, table: str, obj: dict) -> None:
    fts = f"{table}_fts"
    conn.execute(f"DELETE FROM {fts} WHERE id = ?", (obj["id"],))
    body = " ".join(str(obj.get(k, "")) for k in ("summary", "outcome", "asked", "context", "sourceContract", "contract", "clauseType"))
    # Index "non-compete" also as "noncompete", so either spelling finds it.
    body += " " + " ".join(re.findall(r"\w+(?:-\w+)+", body)).replace("-", "")
    conn.execute(
        f"INSERT INTO {fts} (id, clause_type, counterparty, body) VALUES (?, ?, ?, ?)",
        (obj["id"], obj.get("clauseType", ""), obj.get("counterparty", ""), body),
    )


def fts_search(conn: sqlite3.Connection, table: str, query: str, limit: int = 5) -> list[dict]:
    """BM25 search. `query` is free text; it is turned into an OR of quoted terms."""
    # Two-letter terms count: "IP", "US" and "EU" are real clause topics.
    low = query.lower()
    terms = re.findall(r"[a-z0-9]{2,}", low) + [h.replace("-", "") for h in re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)+", low)]
    if not terms:
        return []
    q = " OR ".join(f'"{t}"' for t in dict.fromkeys(terms))
    rows = conn.execute(
        f"SELECT t.json FROM {table}_fts f JOIN {table} t ON t.id = f.id WHERE {table}_fts MATCH ? ORDER BY bm25({table}_fts) LIMIT ?",
        (q, limit),
    ).fetchall()
    return [json.loads(r["json"]) for r in rows]


# ----------------------------- contracts -----------------------------

def next_contract_id(conn: sqlite3.Connection) -> str:
    # Uploads reserve their ID before analysis finishes (or fails), so count them too.
    ids = conn.execute("SELECT id FROM contracts UNION SELECT contract_id FROM uploads")
    nums = [int(r[0].split("-")[1]) for r in ids if re.match(r"C-\d+$", r[0])]
    return f"C-{max(nums, default=48) + 1:03d}"  # continues the tracker's numbering (C-001…C-048)


# ----------------------------- audit -----------------------------

def add_audit(conn: sqlite3.Connection, actor: str, action: str, detail: str, kind: str = "human") -> dict:
    actor_name = USERS[actor]["name"] if actor in USERS else actor
    cur = conn.execute(
        "INSERT INTO audit_log (id, at, actor, action, detail, kind) VALUES (?, ?, ?, ?, ?, ?)",
        ("", stamp(), actor_name, action, detail, kind),
    )
    entry_id = f"A-{cur.lastrowid + 100}"
    conn.execute("UPDATE audit_log SET id = ? WHERE seq = ?", (entry_id, cur.lastrowid))
    conn.commit()
    return {"id": entry_id, "at": stamp(), "actor": actor_name, "action": action, "detail": detail, "kind": kind}


def list_audit(conn: sqlite3.Connection, limit: int = 300) -> list[dict]:
    rows = conn.execute("SELECT id, at, actor, action, detail, kind FROM audit_log ORDER BY seq DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


# ----------------------------- counterparty history -----------------------------

def counterparty_history(conn: sqlite3.Connection, name: str) -> list[dict]:
    rows = conn.execute(
        "SELECT date, kind, detail, source FROM counterparty_events WHERE counterparty_key = ? ORDER BY rowid",
        (party_key(name),),
    )
    return [dict(r) for r in rows]


# ----------------------------- seed / reset -----------------------------

def reset(conn: sqlite3.Connection | None = None) -> None:
    """Drops everything and reloads seed/seed.json (built from Project/Dataset by app.dataset)."""
    own = conn is None
    conn = conn or connect()
    with _lock:
        for t in ["contracts", "uploads", "obligations", "obligations_fts", "precedents", "precedents_fts",
                  "pending_precedents", "delegations", "audit_log", "counterparty_events", "jobs", "meta"]:
            conn.execute(f"DROP TABLE IF EXISTS {t}")
        conn.executescript(SCHEMA)
        seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        # Insert in reverse so the first item in the seed file ends up "newest" (highest seq).
        for key in ("contracts", "obligations", "precedents", "delegations"):
            for item in reversed(seed.get(key, [])):
                put_json(conn, key, item)
        for h in seed.get("history", []):
            conn.execute("INSERT INTO counterparty_events VALUES (?, ?, ?, ?, ?)",
                         (party_key(h["counterparty"]), h["date"], h["kind"], h["detail"], h["source"]))
        for a in reversed(seed["audit"]):
            conn.execute(
                "INSERT INTO audit_log (id, at, actor, action, detail, kind) VALUES (?, ?, ?, ?, ?, ?)",
                (a["id"], a["at"], a["actor"], a["action"], a["detail"], a["kind"]),
            )
        for key in ("dataQuality", "asOf", "source"):
            conn.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, json.dumps(seed.get(key))))
        conn.commit()
    if own:
        conn.close()


def get_meta(conn: sqlite3.Connection, key: str):
    row = conn.execute("SELECT json FROM meta WHERE key = ?", (key,)).fetchone()
    return json.loads(row["json"]) if row else None


def ensure() -> None:
    """Creates and seeds the database on first run."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect()
    exists = conn.execute("SELECT name FROM sqlite_master WHERE name = 'contracts'").fetchone()
    if not exists:
        reset(conn)
    else:
        reindex(conn)  # keeps search current when the indexing rules change
    conn.close()


def reindex(conn: sqlite3.Connection) -> None:
    for table in ("obligations", "precedents"):
        for obj in list_json(conn, table):
            _index(conn, table, obj)
    conn.commit()

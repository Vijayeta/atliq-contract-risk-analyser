"""Storage. Contracts are stored as JSON documents in exactly the frontend's shape.

Two backends behind one small connection wrapper:
  - SQLite (default): a local file, ATLIQ_DB. Used for local runs, the dataset build and tests.
    Obligations and precedents get FTS5 indexes for BM25 retrieval.
  - Postgres (when DATABASE_URL is set, e.g. Supabase): for the hosted API, where the local disk is
    temporary. Retrieval uses the same BM25 formula, computed in Python over the (small) tables.
Uploaded files are kept in the database too, so re-runs work after the server restarts.
"""
from __future__ import annotations

import atexit
import json
import math
import os
import re
import sqlite3
import threading
import unicodedata
from collections import Counter
from datetime import datetime
from pathlib import Path

from .access import USERS

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("ATLIQ_DB", ROOT / "atliq.db"))
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
SEED_PATH = ROOT / "seed" / "seed.json"
UPLOAD_DIR = Path(os.environ.get("ATLIQ_UPLOADS", ROOT / "uploads"))

_lock = threading.Lock()

SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uploads (contract_id TEXT PRIMARY KEY, filename TEXT, path TEXT, meta TEXT, content BLOB);
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
SCHEMA = SQLITE_SCHEMA  # kept for callers that predate the Postgres backend

POSTGRES_SCHEMA = """
CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uploads (contract_id TEXT PRIMARY KEY, filename TEXT, path TEXT, meta TEXT, content BYTEA);
CREATE TABLE IF NOT EXISTS obligations (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS precedents (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_precedents (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (seq BIGSERIAL PRIMARY KEY, id TEXT, at TEXT, actor TEXT, action TEXT, detail TEXT, kind TEXT);
CREATE TABLE IF NOT EXISTS counterparty_events (seq BIGSERIAL PRIMARY KEY, counterparty_key TEXT, date TEXT, kind TEXT, detail TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, contract_id TEXT, step INTEGER, total INTEGER, status TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT);
"""
TABLES = ["contracts", "uploads", "obligations", "obligations_fts", "precedents", "precedents_fts",
          "pending_precedents", "delegations", "audit_log", "counterparty_events", "jobs", "meta"]


# ----------------------------- connection wrapper -----------------------------

class Row(dict):
    """A result row readable by column name or by position, like sqlite3.Row."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


class _Cursor:
    def __init__(self, cur, pg: bool):
        self._cur, self._pg = cur, pg

    def _row(self, r):
        if r is None or not self._pg:
            return r
        return Row(zip([d.name for d in self._cur.description], r))

    def fetchone(self):
        return self._row(self._cur.fetchone())

    def fetchall(self):
        return [self._row(r) for r in self._cur.fetchall()]

    def __iter__(self):
        return iter(self.fetchall())

    @property
    def lastrowid(self):
        return self._cur.lastrowid


class Conn:
    """The few calls the app makes, the same on SQLite and Postgres (SQL is written with `?`)."""

    def __init__(self, raw, pg: bool, release=None):
        self.raw, self.pg, self._release = raw, pg, release

    def execute(self, sql: str, params: tuple | list = ()) -> _Cursor:
        if self.pg:
            sql = sql.replace("?", "%s")
            cur = self.raw.cursor()
            cur.execute(sql, tuple(bytes(p) if isinstance(p, memoryview) else p for p in params))
            return _Cursor(cur, True)
        return _Cursor(self.raw.execute(sql, params), False)

    def commit(self) -> None:
        self.raw.commit()

    def close(self) -> None:
        if self._release:
            self.raw.rollback()  # end the read transaction (writes are already committed) before reuse
            self._release(self.raw)
        else:
            self.raw.close()


_pool = None
_pool_lock = threading.Lock()


def _pg_pool():
    """A few kept-open connections: opening a TLS connection to Supabase costs several round trips."""
    global _pool
    with _pool_lock:
        if _pool is None:
            from psycopg_pool import ConnectionPool  # only needed for the hosted API

            # prepare_threshold=None: Supabase's connection pooler can't use prepared statements.
            _pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=5, open=True, check=ConnectionPool.check_connection,
                                   kwargs={"prepare_threshold": None, "connect_timeout": 15})
            atexit.register(close_pool)
        return _pool


def close_pool() -> None:
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None


def connect(sqlite_path: Path | None = None) -> Conn:
    """Postgres when DATABASE_URL is set (unless a SQLite file is asked for), otherwise SQLite."""
    if DATABASE_URL and sqlite_path is None:
        pool = _pg_pool()
        return Conn(pool.getconn(), pg=True, release=pool.putconn)
    raw = sqlite3.connect(sqlite_path or DB_PATH, check_same_thread=False, timeout=10)
    raw.row_factory = sqlite3.Row
    raw.execute("PRAGMA journal_mode=WAL")
    return Conn(raw, pg=False)


def create_schema(conn: Conn) -> None:
    if conn.pg:
        conn.raw.execute(POSTGRES_SCHEMA)
    else:
        conn.raw.executescript(SQLITE_SCHEMA)
    conn.commit()


def _upsert(conn: Conn, table: str, cols: tuple[str, ...], key: str, values: tuple) -> None:
    marks = ", ".join("?" for _ in cols)
    if conn.pg:
        updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c != key)
        conn.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({marks}) ON CONFLICT ({key}) DO UPDATE SET {updates}", values)
    else:
        conn.execute(f"INSERT OR REPLACE INTO {table} ({', '.join(cols)}) VALUES ({marks})", values)


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

def _next_seq(conn: Conn, table: str) -> int:
    return conn.execute(f"SELECT COALESCE(MAX(seq), 0) + 1 FROM {table}").fetchone()[0]


def put_json(conn: Conn, table: str, obj: dict) -> dict:
    row = conn.execute(f"SELECT seq FROM {table} WHERE id = ?", (obj["id"],)).fetchone()
    seq = row["seq"] if row else _next_seq(conn, table)
    _upsert(conn, table, ("id", "json", "seq"), "id", (obj["id"], json.dumps(obj), seq))
    if table in ("obligations", "precedents") and not conn.pg:
        _index(conn, table, obj)
    conn.commit()
    return obj


def get_json(conn: Conn, table: str, id_: str) -> dict | None:
    row = conn.execute(f"SELECT json FROM {table} WHERE id = ?", (id_,)).fetchone()
    return json.loads(row["json"]) if row else None


def list_json(conn: Conn, table: str) -> list[dict]:
    """Newest first (highest seq)."""
    return [json.loads(r["json"]) for r in conn.execute(f"SELECT json FROM {table} ORDER BY seq DESC")]


def delete_json(conn: Conn, table: str, id_: str) -> None:
    conn.execute(f"DELETE FROM {table} WHERE id = ?", (id_,))
    conn.commit()


# ----------------------------- search (BM25) -----------------------------

def _search_fields(obj: dict) -> tuple[str, str, str]:
    """(clause type, counterparty, body) — the three indexed columns."""
    body = " ".join(str(obj.get(k, "")) for k in ("summary", "outcome", "asked", "context", "sourceContract", "contract", "clauseType"))
    # Index "non-compete" also as "noncompete", so either spelling finds it.
    body += " " + " ".join(re.findall(r"\w+(?:-\w+)+", body)).replace("-", "")
    return obj.get("clauseType", ""), obj.get("counterparty", ""), body


def _index(conn: Conn, table: str, obj: dict) -> None:
    fts = f"{table}_fts"
    conn.execute(f"DELETE FROM {fts} WHERE id = ?", (obj["id"],))
    conn.execute(f"INSERT INTO {fts} (id, clause_type, counterparty, body) VALUES (?, ?, ?, ?)", (obj["id"], *_search_fields(obj)))


def _query_terms(query: str) -> list[str]:
    # Two-letter terms count: "IP", "US" and "EU" are real clause topics.
    low = query.lower()
    terms = re.findall(r"[a-z0-9]{2,}", low) + [h.replace("-", "") for h in re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)+", low)]
    return list(dict.fromkeys(terms))


def _tokens(text: str) -> list[str]:
    """FTS5's default unicode61 tokenizer: letters and digits, lower-cased, accents removed."""
    folded = "".join(ch for ch in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(ch))
    return re.findall(r"[^\W_]+", folded)


def bm25_rank(docs: list[tuple[str, tuple[str, ...]]], terms: list[str], limit: int) -> list[str]:
    """SQLite FTS5's bm25() (k1=1.2, b=0.75, all columns weight 1), so both backends rank alike.
    `docs` is [(id, (column texts...))]; returns the ids of matching documents, best first."""
    toks = [(i, [Counter(_tokens(col)) for col in cols]) for i, cols in docs]
    n = len(toks)
    if not n:
        return []
    lengths = {i: sum(sum(c.values()) for c in cols) for i, cols in toks}
    avgdl = sum(lengths.values()) / n or 1.0
    scores: dict[str, float] = {}
    for t in terms:
        hits = [(i, sum(c[t] for c in cols)) for i, cols in toks]
        hits = [(i, f) for i, f in hits if f]
        if not hits:
            continue
        idf = math.log((n - len(hits) + 0.5) / (len(hits) + 0.5))
        idf = idf if idf > 0 else 1e-6
        for i, f in hits:
            scores[i] = scores.get(i, 0.0) + idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * lengths[i] / avgdl))
    return [i for i, _ in sorted(scores.items(), key=lambda kv: -kv[1])][:limit]  # stable: ties keep `docs` order


def fts_search(conn: Conn, table: str, query: str, limit: int = 5) -> list[dict]:
    """BM25 search. `query` is free text; it is turned into an OR of quoted terms."""
    terms = _query_terms(query)
    if not terms:
        return []
    if conn.pg:
        objs = list_json(conn, table)[::-1]  # oldest first, so ties break the way FTS5 breaks them (by insertion)
        by_id = {o["id"]: o for o in objs}
        return [by_id[i] for i in bm25_rank([(o["id"], _search_fields(o)) for o in objs], terms, limit)]
    q = " OR ".join(f'"{t}"' for t in terms)
    rows = conn.execute(
        f"SELECT t.json FROM {table}_fts f JOIN {table} t ON t.id = f.id WHERE {table}_fts MATCH ? ORDER BY bm25({table}_fts) LIMIT ?",
        (q, limit),
    ).fetchall()
    return [json.loads(r["json"]) for r in rows]


# ----------------------------- contracts and uploads -----------------------------

def next_contract_id(conn: Conn) -> str:
    # Uploads reserve their ID before analysis finishes (or fails), so count them too.
    ids = conn.execute("SELECT id FROM contracts UNION SELECT contract_id FROM uploads")
    nums = [int(r[0].split("-")[1]) for r in ids if re.match(r"C-\d+$", r[0])]
    return f"C-{max(nums, default=48) + 1:03d}"  # continues the tracker's numbering (C-001…C-048)


def upload_file(conn: Conn, cid: str) -> Path | None:
    """The uploaded file for a contract on local disk, restored from the database if the disk copy
    is gone (the hosted server's disk is wiped on every restart). None for dataset contracts."""
    row = conn.execute("SELECT path, content FROM uploads WHERE contract_id = ?", (cid,)).fetchone()
    if not row:
        return None
    path = Path(row["path"])
    if not path.exists() and row["content"] is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes(row["content"]))
    return path


# ----------------------------- audit -----------------------------

def add_audit(conn: Conn, actor: str, action: str, detail: str, kind: str = "human") -> dict:
    actor_name = USERS[actor]["name"] if actor in USERS else actor
    values = ("", stamp(), actor_name, action, detail, kind)
    if conn.pg:
        seq = conn.execute("INSERT INTO audit_log (id, at, actor, action, detail, kind) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq", values).fetchone()[0]
    else:
        seq = conn.execute("INSERT INTO audit_log (id, at, actor, action, detail, kind) VALUES (?, ?, ?, ?, ?, ?)", values).lastrowid
    entry_id = f"A-{seq + 100}"
    conn.execute("UPDATE audit_log SET id = ? WHERE seq = ?", (entry_id, seq))
    conn.commit()
    return {"id": entry_id, "at": stamp(), "actor": actor_name, "action": action, "detail": detail, "kind": kind}


def list_audit(conn: Conn, limit: int = 300) -> list[dict]:
    rows = conn.execute("SELECT id, at, actor, action, detail, kind FROM audit_log ORDER BY seq DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


# ----------------------------- counterparty history -----------------------------

def add_history(conn: Conn, h: dict) -> None:
    conn.execute("INSERT INTO counterparty_events (counterparty_key, date, kind, detail, source) VALUES (?, ?, ?, ?, ?)",
                 (party_key(h["counterparty"]), h["date"], h["kind"], h["detail"], h["source"]))


def counterparty_history(conn: Conn, name: str) -> list[dict]:
    order = "seq" if conn.pg else "rowid"
    rows = conn.execute(
        f"SELECT date, kind, detail, source FROM counterparty_events WHERE counterparty_key = ? ORDER BY {order}",
        (party_key(name),),
    )
    return [dict(r) for r in rows]


# ----------------------------- seed / reset -----------------------------

def reset(conn: Conn | None = None) -> None:
    """Drops everything and reloads seed/seed.json (built from Project/Dataset by app.dataset)."""
    own = conn is None
    conn = conn or connect()
    with _lock:
        for t in TABLES:
            if conn.pg and t.endswith("_fts"):
                continue
            conn.execute(f"DROP TABLE IF EXISTS {t}")
        conn.commit()
        create_schema(conn)
        seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        # Insert in reverse so the first item in the seed file ends up "newest" (highest seq).
        for key in ("contracts", "obligations", "precedents", "delegations"):
            for item in reversed(seed.get(key, [])):
                put_json(conn, key, item)
        for h in seed.get("history", []):
            add_history(conn, h)
        for a in reversed(seed["audit"]):
            conn.execute(
                "INSERT INTO audit_log (id, at, actor, action, detail, kind) VALUES (?, ?, ?, ?, ?, ?)",
                (a["id"], a["at"], a["actor"], a["action"], a["detail"], a["kind"]),
            )
        for key in ("dataQuality", "asOf", "source"):
            _upsert(conn, "meta", ("key", "json"), "key", (key, json.dumps(seed.get(key))))
        conn.commit()
    if own:
        conn.close()


def get_meta(conn: Conn, key: str):
    row = conn.execute("SELECT json FROM meta WHERE key = ?", (key,)).fetchone()
    return json.loads(row["json"]) if row else None


def ensure() -> None:
    """Creates and seeds the database on first run; brings an existing one up to date."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect()
    if conn.pg:
        exists = conn.execute("SELECT to_regclass('contracts') IS NOT NULL").fetchone()[0]
    else:
        exists = conn.execute("SELECT name FROM sqlite_master WHERE name = 'contracts'").fetchone()
    if not exists:
        reset(conn)
    else:
        if not conn.pg:
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(uploads)")}
            if "content" not in cols:  # databases created before uploads were stored in the database
                conn.execute("ALTER TABLE uploads ADD COLUMN content BLOB")
                conn.commit()
            reindex(conn)  # keeps search current when the indexing rules change
    conn.close()


def reindex(conn: Conn) -> None:
    if conn.pg:
        return  # Postgres search reads the tables directly
    for table in ("obligations", "precedents"):
        for obj in list_json(conn, table):
            _index(conn, table, obj)
    conn.commit()

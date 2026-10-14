"""Retrieval over AtliQ's own records with SQLite FTS5 (BM25): precedent for each finding and
obligations for the conflict check. Obligation status (live / expired / superseded) comes from
the register's dates, never from the model (PRD FR-7)."""
from __future__ import annotations


from .. import db

def precedent_for(conn: db.Conn, query: str, limit: int = 2) -> list[dict]:
    if not query:
        return []
    hits = db.fts_search(conn, "precedents", query, limit=limit)
    return [
        {"contract": p["contract"], "counterparty": p["counterparty"], "date": p["date"], "outcome": p["outcome"], "label": p["label"]}
        for p in hits
    ]

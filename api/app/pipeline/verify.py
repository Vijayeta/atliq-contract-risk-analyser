"""Citation verification (PRD §11: unsupported material claims fail closed)."""
from __future__ import annotations

from .parse import normalise
from .segment import Clause


def quote_supported(quote: str, clauses: list[Clause], section: str | None = None) -> bool:
    """True if the quote (minus a trailing ellipsis) appears verbatim in the cited clause,
    or anywhere in the document when the section is unknown."""
    q = normalise(quote.rstrip("…").rstrip("."))
    if len(q) < 12:
        return False
    pool = [c for c in clauses if c.readable and (section is None or c.section == section)] or [c for c in clauses if c.readable]
    return any(q in normalise(f"{c.title}. {c.text}") for c in pool)

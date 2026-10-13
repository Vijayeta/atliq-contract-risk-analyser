"""Pages → clauses. Every clause is accounted for (FR-21).

Understands the heading styles used in the capstone dataset:
  ## 12. RESTRICTIVE COVENANTS        ## ARTICLE 11 — DELAY; LIQUIDATED DAMAGES
  ## § 6 Supplier Tools and Rights    ## SCHEDULE 1 — SOW-1 (SUMMARY) / ANNEX / EXHIBIT
  6. RESTRICTIVE C0VENANT  (plain, OCR'd scans)
and clause numbering such as "11.2 **Liquidated Damages.** …", "S1.2 Approach." and lettered
sub-items "(a) …", which are folded into their parent clause.
Unreadable pages become 'not-covered' rows so coverage reflects what could not be examined.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .parse import Page

MD_HEADING = re.compile(r"^\s{0,3}#{1,4}\s+(.*?)\s*#*\s*$")
ARTICLE = re.compile(r"^(?:article|clause|section)\s+(\d{1,2})\s*[—–:.-]+\s*(.+)$", re.I)
PARA = re.compile(r"^§\s*(\d{1,2})\s+(.+)$")
NUMBERED = re.compile(r"^(\d{1,2})\.?\s+(.+)$")
ANNEX = re.compile(r"^(schedule|annex(?:ure)?|exhibit|appendix)\s+([A-Z0-9]{1,3})\b\s*[—–:.-]*\s*(.*)$", re.I)
# Plain all-caps numbered heading in OCR'd text: "6. RESTRICTIVE C0VENANT"
PLAIN_HEADING = re.compile(r"^(\d{1,2})\.\s+([A-Z0-9][A-Z0-9 &,;'()/\-]{2,60})$")
SUBCLAUSE = re.compile(r"^(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?|S\d{1,2}\.\d{1,2})\.?\s+(.*)$")
# Letter paragraphs: "2. Pursuant to Clause 12.4 …" (sentence case, not a heading)
LETTER_PARA = re.compile(r"^(\d{1,2})\.\s+([A-Z][a-z].{20,})$")
RUN_IN = re.compile(r"^([A-Z][A-Za-z0-9 ,;'&/()\-]{2,70}?)\.\s+(?=\S)")
SKIP_HEADINGS = re.compile(r"^(signatures?|in witness whereof|execution)\b", re.I)


@dataclass
class Clause:
    section: str
    title: str
    text: str
    page: int
    readable: bool = True


def clean(line: str) -> str:
    return line.replace("**", "").replace("__", "").replace("\\", "").strip()


def _title_case(s: str) -> str:
    s = s.strip().rstrip(".:")
    return s[:1].upper() + s[1:].lower() if s.isupper() else s


def _heading(text: str) -> tuple[str | None, str] | None:
    """Parses a heading's text into (number or annex label, title). None → not a clause heading."""
    t = clean(text)
    if not t or t.startswith("("):
        return None
    for rx in (ARTICLE, PARA):
        m = rx.match(t)
        if m:
            return m.group(1), _title_case(m.group(2))
    m = ANNEX.match(t)
    if m:
        kind = {"schedule": "Sch", "exhibit": "Ex", "appendix": "App"}.get(m.group(1).lower(), "Annex")
        return f"{kind} {m.group(2)}", _title_case(m.group(3) or m.group(1))
    m = NUMBERED.match(t)
    if m:
        return m.group(1), _title_case(m.group(2))
    return None, _title_case(t)


def segment(pages: list[Page]) -> list[Clause]:
    clauses: list[Clause] = []
    used: set[str] = set()
    heading_no: str | None = None
    heading_title = "Preamble"
    heading_buf: list[str] = []
    heading_page = 1
    heading_has_sub = False
    cur: Clause | None = None
    skip = False

    def unique(section: str) -> str:
        s, n = section, 2
        while s in used:
            s = f"{section} ({n})"
            n += 1
        used.add(s)
        return s

    def flush_clause() -> None:
        nonlocal cur
        if cur and cur.text.strip():
            clauses.append(cur)
        cur = None

    def flush_heading() -> None:
        """A section with body text but no numbered subclauses becomes one clause row."""
        body = "\n".join(heading_buf).strip()
        if not heading_has_sub and not skip and sum(ch.isalnum() for ch in body) >= 30:
            label = heading_no or heading_title
            clauses.append(Clause(unique(label), heading_title, body, heading_page))

    for page in pages:
        if not page.readable:
            flush_clause()
            clauses.append(Clause(unique(f"p{page.number}"), f"Page {page.number} - no readable text", "", page.number, readable=False))
            continue
        for raw in page.text.splitlines():
            line = clean(raw)
            if not line or re.fullmatch(r"[-=_*|: ]+", line):
                continue
            md = MD_HEADING.match(raw)
            plain = PLAIN_HEADING.match(line) if not md else None
            if md or plain:
                parsed = _heading(md.group(1)) if md else (plain.group(1), _title_case(plain.group(2)))
                if raw.lstrip().startswith("# ") and not raw.lstrip().startswith("##"):
                    continue  # H1 = document title
                if parsed is None:
                    continue  # e.g. "## (Dienstleistungs- und Werkvertrag — English version)"
                flush_clause()
                flush_heading()
                heading_no, heading_title = parsed
                heading_buf, heading_page, heading_has_sub = [], page.number, False
                skip = bool(SKIP_HEADINGS.match(heading_title))
                continue
            # Letters (e.g. the Al Noor waiver) number their paragraphs "1.", "2." with no headings.
            m = SUBCLAUSE.match(line) or (LETTER_PARA.match(line) if heading_no is None and heading_title == "Preamble" else None)
            if m:
                flush_clause()
                heading_has_sub = True
                body = m.group(2)
                title = heading_title
                ri = RUN_IN.match(body)
                if ri and len(ri.group(1).split()) <= 6:
                    title = f"{heading_title} - {ri.group(1)}" if heading_title not in ("Preamble",) else ri.group(1)
                cur = Clause(unique(m.group(1)), title, body, page.number)
            elif cur:
                cur.text = f"{cur.text}\n{line}"
            else:
                heading_buf.append(line)
    flush_clause()
    flush_heading()
    return clauses


def preamble_text(pages: list[Page]) -> str:
    """Text before the first numbered clause — title and parties."""
    first = next((p for p in pages if p.readable), None)
    return first.text[:3000] if first else ""

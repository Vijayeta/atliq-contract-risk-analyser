"""File → pages. Handles the capstone dataset's Markdown contracts (.md), plain text (with
'Page N of M' markers from OCR'd scans), PDF and DOCX.

No OCR in the demo build: a page without a usable text layer is marked unreadable, which lowers
clause coverage and can trigger the "no verdict" state (PRD §10.2)."""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

PAGE_CHARS = 3500  # pseudo-page size for formats without real pages
MIN_ALNUM = 40  # fewer letters/digits than this → treat the page as unreadable
MAX_JUNK = 0.02  # more NUL / replacement / control characters than this share → unreadable
PAGE_BREAK = re.compile(r"^\s*(page\s+\d+\s+of\s+\d+|-{8,})\s*$", re.I)


@dataclass
class Page:
    number: int
    text: str

    @property
    def readable(self) -> bool:
        if sum(ch.isalnum() for ch in self.text) < MIN_ALNUM:
            return False
        # Mis-decoded or binary text has letters too, between NULs, U+FFFD and control codes.
        junk = sum(ch == "\ufffd" or (ord(ch) < 32 and ch not in "\t\n\r\f") for ch in self.text)
        return junk <= MAX_JUNK * len(self.text)


class UnsupportedFile(ValueError):
    pass


SUPPORTED = (".pdf", ".docx", ".txt", ".md")
# ~300 pages of text. A 100-page contract is ~300k characters; anything far beyond is not a
# contract, and analysing it would tie up the server for minutes.
MAX_CHARS = 1_000_000


def _chunk(lines: list[str]) -> list[Page]:
    pages: list[Page] = []
    buf: list[str] = []
    size = 0
    for ln in lines:
        if buf and size + len(ln) > PAGE_CHARS:
            pages.append(Page(len(pages) + 1, "\n".join(buf)))
            buf, size = [], 0
        buf.append(ln)
        size += len(ln) + 1
    if buf:
        pages.append(Page(len(pages) + 1, "\n".join(buf)))
    # A tiny trailing chunk (e.g. a signature block) is not an "unreadable page" — merge it back.
    if len(pages) > 1 and not pages[-1].readable:
        last = pages.pop()
        pages[-1] = Page(pages[-1].number, pages[-1].text + "\n" + last.text)
    return pages


def parse_text(text: str) -> list[Page]:
    """Splits on form feeds or OCR page markers when present; otherwise chunks by length."""
    if "\f" in text:
        return [Page(i + 1, t.strip()) for i, t in enumerate(text.split("\f"))]
    lines = text.splitlines()
    if sum(bool(PAGE_BREAK.match(ln)) for ln in lines) >= 2:
        pages, buf = [], []
        for ln in lines:
            if PAGE_BREAK.match(ln):
                if any(x.strip() for x in buf):
                    pages.append(Page(len(pages) + 1, "\n".join(buf)))
                buf = []
            else:
                buf.append(ln)
        if any(x.strip() for x in buf):
            pages.append(Page(len(pages) + 1, "\n".join(buf)))
        return pages
    return _chunk([ln.rstrip() for ln in lines])


def read_text(path: Path) -> str:
    text = _read_text(path)
    if len(text) > MAX_CHARS:
        raise UnsupportedFile(f"This file has about {len(text) // 3000} pages of text. Contracts up to ~100 pages are supported.")
    return text


def _read_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".pdf":
        from pypdf import PdfReader

        return "\f".join((pg.extract_text() or "").strip() for pg in PdfReader(str(path)).pages)
    if ext == ".docx":
        from docx import Document

        return "\n".join(p.text for p in Document(str(path)).paragraphs)
    if ext in (".txt", ".md"):
        return decode_text(path.read_bytes())
    raise UnsupportedFile(f"{path.name}: only PDF, DOCX, Markdown and TXT are supported")


def decode_text(raw: bytes) -> str:
    """Plain-text contracts arrive as UTF-8, UTF-16 (Notepad's "Unicode") or Windows-1252."""
    for bom, enc in ((b"\xef\xbb\xbf", "utf-8-sig"), (b"\xff\xfe", "utf-16"), (b"\xfe\xff", "utf-16")):
        if raw.startswith(bom):
            return raw.decode(enc, errors="replace")
    # UTF-16 without a BOM: every other byte of ASCII text is NUL.
    head = raw[:4000]
    if len(head) >= 2 and head.count(0) > len(head) // 4:
        return raw.decode("utf-16-le" if head[1::2].count(0) > head[0::2].count(0) else "utf-16-be", errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def parse_file(path: Path) -> list[Page]:
    return parse_text(read_text(path))


def provenance(text: str) -> str | None:
    """The dataset's first line, e.g. '*(Client draft received 2026-09-10 via Dhaval's email…)*'."""
    m = re.match(r"\s*\*\((.+?)\)\*", text)
    return m.group(1).strip() if m else None


def normalise(s: str) -> str:
    """Whitespace/quote/markdown normalisation used by the citation verifier."""
    s = s.replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'").replace("**", "")
    return re.sub(r"\s+", " ", s).strip().lower()

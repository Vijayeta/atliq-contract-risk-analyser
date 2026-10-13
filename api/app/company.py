"""Facts about AtliQ that the rules need, taken from the capstone dataset (Project/Dataset).

Sources:
- atliq_entities.md (finance fact sheet, Jan 2026) — the two legal entities;
- karandeep_contract_checklist.md (Mar 2024) — the only written review positions;
- contract_tracker.csv C-046 note — "ours is $1M" cyber cover;
- signed Crestline / Brightwater MSAs — AtliQ already carries $2M professional and $1M general cover.
"""
from __future__ import annotations

import os
import re
from datetime import date, datetime

# "Treat today as 2026-09-28" (Dataset/README.md). Override with ATLIQ_AS_OF=YYYY-MM-DD.
AS_OF: date = datetime.strptime(os.environ.get("ATLIQ_AS_OF", "2026-09-28"), "%Y-%m-%d").date()

ENTITIES = {
    "pvt": {
        "name": "AtliQ Technologies Pvt Ltd",
        "aliases": ["atliq technologies pvt", "atliq technologies private", "atliq technologies"],
        "serves": "Clients in India, the Middle East, Europe and every other region outside the United States",
    },
    "inc": {
        "name": "AtliQ Inc",
        "aliases": ["atliq inc", "atliq, inc"],
        "serves": "Clients in the United States only",
    },
}

US_STATES = [
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
    "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
    "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
    "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
    "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
    "west virginia", "wisconsin", "wyoming",
]

# Insurance AtliQ actually holds (USD). Used to spot requirements AtliQ can't meet.
INSURANCE = {"cyber": 1_000_000, "professional": 2_000_000, "general": 1_000_000}

# Karandeep's checklist — positions, not a policy table for commercial terms (PRD §6).
PAYMENT_MAX_DAYS = 45
PAYMENT_PREFERRED_DAYS = 30
CHECKLIST = "karandeep_contract_checklist.md"


def is_us(country: str | None) -> bool:
    c = (country or "").strip().lower().rstrip("?")
    return c in ("usa", "us", "u.s.", "u.s.a.", "united states", "united states of america")


def entity_for_country(country: str | None) -> str:
    return "inc" if is_us(country) else "pvt"


def parse_day(s: str | None) -> date | None:
    for fmt in ("%Y-%m-%d", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime((s or "").strip(), fmt).date()
        except ValueError:
            continue
    return None


# Deal value at or above which a contract is high-value: only KD approves it, never an
# "all routine" delegate. Every value in the dataset is in US dollars.
HIGH_VALUE_USD = 100_000

_SCALE = {"k": 1e3, "thousand": 1e3, "m": 1e6, "mn": 1e6, "mm": 1e6, "million": 1e6, "b": 1e9, "bn": 1e9, "billion": 1e9}
_AMOUNT = re.compile(r"(\d{1,3}(?:,\d{2,3})+|\d+)(\.\d+)?\s*(" + "|".join(sorted(_SCALE, key=len, reverse=True)) + r")?")


def parse_usd(value: str | None) -> float | None:
    """'$480,000' / '$1.2M' / 'USD 250k' / '$100k-150k' → dollars (a range gives its upper end).
    None when the text isn't a readable US-dollar amount: other currencies can't be compared with
    the threshold (the dataset has no exchange rates), and a misread must never look small."""
    s = (value or "").strip().lower()
    s = re.sub(r"^(?:~|approx\.?|about|c\.)\s*", "", s)
    s = re.sub(r"us\$|usd|\$", "", s).strip()
    parts = [x.strip() for x in re.split(r"\s*(?:-|–|—|\bto\b)\s*", s)]
    if not s or not all(parts):
        return None
    amounts = []
    for part in parts:
        m = _AMOUNT.fullmatch(part)
        if not m:
            return None
        amounts.append(float(m.group(1).replace(",", "") + (m.group(2) or "")) * _SCALE.get(m.group(3) or "", 1))
    return max(amounts)


def fmt_day(d: date | None) -> str:
    return d.strftime("%d %b %Y") if d else "-"

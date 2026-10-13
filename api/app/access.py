"""Server-side ports of the helpers in Project/web/src/data.ts.

The frontend uses the same rules for display; the backend enforces them (FR-16/17/18).
"""
from __future__ import annotations

from datetime import date, datetime

USERS = {
    "kd": {"id": "kd", "name": "Karandeep", "superAdmin": True, "canSign": True},
    "bhavin": {"id": "bhavin", "name": "Bhavin", "superAdmin": False, "canSign": False},
    "dhaval": {"id": "dhaval", "name": "Dhaval", "superAdmin": False, "canSign": False},
    "jay": {"id": "jay", "name": "Jay", "superAdmin": False, "canSign": False},
}
USER_IDS = list(USERS)


def parse_day(s: str) -> date | None:
    """Parses '17 Oct 2026'. Returns None for 'Ongoing' or unparseable values."""
    try:
        # Browsers' en-GB short month for September is "Sept", which %b doesn't accept.
        return datetime.strptime(s.strip().replace("Sept ", "Sep "), "%d %b %Y").date()
    except (ValueError, AttributeError):
        return None


def coverage(c: dict) -> dict:
    rows = c.get("clauses", [])
    total = len(rows)
    flagged = sum(r["outcome"] == "finding" for r in rows)
    no_issue = sum(r["outcome"] == "no-issue" for r in rows)
    not_covered = sum(r["outcome"] == "not-covered" for r in rows)
    pct = (total - not_covered) / total if total else 0.0
    return {
        "total": total,
        "flagged": flagged,
        "noIssue": no_issue,
        "notCovered": not_covered,
        "pct": pct,
        "below": pct < c.get("coverageThreshold", 0.99),
    }


def open_high_severity(c: dict) -> int:
    return sum(f["severity"] == "high" and f["decision"] == "pending" for f in c["findings"])


def live_conflicts(c: dict) -> list[dict]:
    return [x for x in c["conflicts"] if x["prior"]["status"] == "active"]


def block_reasons(c: dict) -> list[str]:
    """§10.2 / §11 — why ready-to-sign is blocked. Mirrors blockReasons() in data.ts."""
    r: list[str] = []
    cov = coverage(c)
    if cov["below"]:
        r.append(f"Clause coverage {round(cov['pct'] * 100)}% is below the {round(c['coverageThreshold'] * 100)}% threshold")
    highs = open_high_severity(c)
    if highs:
        r.append(f"{highs} high-severity finding{'s' if highs > 1 else ''} not yet dispositioned")
    live = len(live_conflicts(c))
    if live:
        r.append(f"{live} conflict{'s' if live > 1 else ''} with a live obligation")
    if c["entityCheck"]["status"] == "fail":
        r.append("Legal entity check failed")
    if (c.get("family") or {}).get("orphan"):
        r.append("Parent agreement not located")
    if any(m["blocking"] and not m["resolved"] for m in c["missingInfo"]):
        r.append("Blocking questions still open")
    return r


def visible_to(c: dict, user: str) -> bool:
    return USERS[user]["superAdmin"] or user in c["access"]


def delegation_active(d: dict, today: date | None = None) -> bool:
    """A delegation is active until revoked or past its expiry date. Every delegation must
    expire, so an unreadable date counts as inactive rather than open-ended."""
    if not d["active"]:
        return False
    end = parse_day(d["expires"])
    return end is not None and end >= (today or date.today())


def delegation_for(c: dict, user: str, delegations: list[dict]) -> dict | None:
    for d in delegations:
        if not delegation_active(d) or d["to"] != user:
            continue
        if d["scope"] == "all-routine":
            if not c["highValue"] and user in c["access"]:
                return d
        elif c["id"] in d["scope"]:
            return d
    return None


def approver_of(c: dict, delegations: list[dict]) -> str:
    for u in USER_IDS:
        if u != "kd" and delegation_for(c, u, delegations):
            return u
    return "kd"


def can_approve(c: dict, user: str, delegations: list[dict]) -> bool:
    return user == "kd" or delegation_for(c, user, delegations) is not None


def reviewer_role(c: dict, user: str) -> str | None:
    if c["primary"] == user:
        return "primary"
    if c.get("secondary") == user:
        return "secondary"
    return None

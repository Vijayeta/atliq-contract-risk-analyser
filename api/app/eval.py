"""Measures the analyzer against the golden set (eval/expected.json) — PRD §12.

    uv run python -m app.eval            # uses seed/seed.json (run `python -m app.dataset` first)

Reports recall on expected issues (overall and high-severity), cross-contract conflict recall,
entity-rule accuracy, false positives on the clean drafts, and per-draft misses. Writes
eval/results.json, which the UI shows under "How reliable is this?".
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RANK = {"low": 0, "unknown": 1, "medium": 2, "high": 3}


def norm(section: str) -> str:
    s = re.sub(r"\s*\(\d+\)$", "", section.strip())  # drop the "(2)" de-duplication suffix
    return s


def evaluate(seed: dict, expected: dict) -> dict:
    by_file = {c.get("sourceFile"): c for c in seed["contracts"]}
    per, totals = [], {"issues": 0, "found": 0, "found_lower": 0, "high": 0, "high_found": 0, "conflicts": 0, "conflicts_found": 0,
                       "entity": 0, "entity_ok": 0, "clean": 0, "clean_ok": 0, "extra_high": 0}
    for f, exp in expected["drafts"].items():
        c = by_file.get(f)
        if not c:
            per.append({"file": f, "error": "not in seed"})
            continue
        findings = c["findings"]
        misses, lower = [], []
        for it in exp["issues"]:
            totals["issues"] += 1
            want = RANK[it["min"]]
            is_high = it["min"] == "high"
            totals["high"] += is_high
            cand = [x for x in findings if it["section"] == "*" or norm(x["citation"]["section"]) == it["section"]]
            if any(RANK[x["severity"]] >= want for x in cand):
                totals["found"] += 1
                totals["high_found"] += is_high
            elif cand:
                totals["found_lower"] += 1
                lower.append(f"{it['section']} {it['topic']} (got {max(cand, key=lambda x: RANK[x['severity']])['severity']})")
            else:
                misses.append(f"{it['section']} {it['topic']}")
        live = {x["prior"]["obligationId"] for x in c["conflicts"] if x["prior"]["status"] == "active"}
        conflict_miss = [o for o in exp.get("conflicts", []) if o not in live]
        totals["conflicts"] += len(exp.get("conflicts", []))
        totals["conflicts_found"] += len(exp.get("conflicts", [])) - len(conflict_miss)
        ent_ok = None
        if "entityFail" in exp:
            totals["entity"] += 1
            ent_ok = (c["entityCheck"]["status"] == "fail") == exp["entityFail"]
            totals["entity_ok"] += ent_ok
        clean_ok = None
        if exp.get("clean"):
            totals["clean"] += 1
            clean_ok = not any(x["severity"] == "high" for x in findings) and not live
            totals["clean_ok"] += clean_ok
        allowed = {i["section"] for i in exp["issues"]} | set(exp.get("noHighOutside", []))
        extra_high = [f"{x['citation']['section']} {x['clauseTitle'].split(' - ')[-1]}" for x in findings
                      if x["severity"] == "high" and norm(x["citation"]["section"]) not in allowed and "*" not in allowed]
        totals["extra_high"] += len(extra_high)
        per.append({"file": f, "id": c["id"], "counterparty": c["counterparty"], "expected": len(exp["issues"]),
                    "found": len(exp["issues"]) - len(misses) - len(lower), "missed": misses, "lowerSeverity": lower,
                    "conflictsMissed": conflict_miss, "entityOk": ent_ok, "cleanOk": clean_ok, "unexpectedHigh": extra_high})
    pct = lambda a, b: round(a / b, 3) if b else None  # noqa: E731
    return {
        "ranAt": datetime.now().strftime("%d %b %Y, %H:%M"),
        "testSet": f"{len(expected['drafts'])} capstone drafts, {totals['issues']} expected issues, {totals['conflicts']} cross-contract conflicts",
        "issueRecall": pct(totals["found"], totals["issues"]),
        "highRecall": pct(totals["high_found"], totals["high"]),
        "conflictRecall": pct(totals["conflicts_found"], totals["conflicts"]),
        "entityAccuracy": pct(totals["entity_ok"], totals["entity"]),
        "cleanCorrect": f"{totals['clean_ok']}/{totals['clean']}",
        "foundAtLowerSeverity": totals["found_lower"],
        "unexpectedHighFindings": totals["extra_high"],
        "totals": totals,
        "drafts": per,
    }


def main() -> None:
    seed = json.loads((ROOT / "seed" / "seed.json").read_text(encoding="utf-8"))
    expected = json.loads((ROOT / "eval" / "expected.json").read_text(encoding="utf-8"))
    res = evaluate(seed, expected)
    (ROOT / "eval" / "results.json").write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"Test set: {res['testSet']}")
    print(f"Issue recall {res['issueRecall']:.0%} · high-severity recall {res['highRecall']:.0%} · conflict recall {res['conflictRecall']:.0%} · "
          f"entity accuracy {res['entityAccuracy']:.0%} · clean drafts {res['cleanCorrect']} · found at lower severity {res['foundAtLowerSeverity']} · "
          f"unexpected high findings {res['unexpectedHighFindings']}")
    for d in res["drafts"]:
        flags = []
        if d.get("missed"):
            flags.append("MISSED: " + "; ".join(d["missed"]))
        if d.get("lowerSeverity"):
            flags.append("LOWER: " + "; ".join(d["lowerSeverity"]))
        if d.get("conflictsMissed"):
            flags.append("CONFLICT MISSED: " + ", ".join(d["conflictsMissed"]))
        if d.get("entityOk") is False:
            flags.append("ENTITY WRONG")
        if d.get("cleanOk") is False:
            flags.append("NOT CLEAN")
        if d.get("unexpectedHigh"):
            flags.append("EXTRA HIGH: " + "; ".join(d["unexpectedHigh"]))
        print(f"  {d.get('id', '?'):6} {d.get('counterparty', d['file'])[:30]:30} {d.get('found', 0)}/{d.get('expected', 0)}  " + (" | ".join(flags) or "ok"))


if __name__ == "__main__":
    main()

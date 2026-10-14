"""Imports the capstone dataset (Project/Dataset) into seed/seed.json.

    uv run python -m app.dataset            # rebuild seed/seed.json from Project/Dataset
    uv run python -m app.dataset --reset    # …and reload the running database from it

What it does:
1. Loads the curated obligation register and negotiation precedent (api/dataset/*.json).
2. Runs the review pipeline on the 17 signed contracts (status Signed, read-only) and the
   15 incoming drafts (in review), with metadata and deal context from contract_tracker.csv.
3. Records data-quality problems found in the tracker (duplicates, blank entities, …).
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from . import db
from .company import AS_OF, entity_for_country, fmt_day, parse_day

ROOT = Path(__file__).resolve().parent.parent
DATASET = Path(os.environ.get("ATLIQ_DATASET", ROOT.parent / "Dataset"))
CURATED = ROOT / "dataset"

# Dataset file → contract_tracker.csv contract_id
FILES = {
    "incoming/2026-09-10_harrington_health_msa_draft.md": "C-023",
    "incoming/2026-09-15_travelhub_services_agreement_draft.md": "C-024",
    "incoming/2026-09-16_harrington_health_baa_draft.md": "C-046",
    "incoming/2026-09-18_gulf_crown_hotels_msa_draft.md": "C-025",
    "incoming/2026-09-19_lakeshore_grocers_msa_draft.md": "C-026",
    "incoming/2026-09-21_blueorchid_hotels_pilot_agreement_draft.md": "C-027",
    "incoming/2026-09-23_rheinwerk_analytics_services_agreement_draft.md": "C-028",
    "incoming/2026-09-24_datavane_strategic_partnership_agreement_draft.md": "C-035",
    "incoming/2026-09-24_sunrise_foods_sow2_draft.md": "C-029",
    "incoming/2026-09-25_finserve_capital_mutual_nda_draft.md": "C-036",
    "incoming/2026-09-26_kriti_data_labs_subcontractor_agreement_draft.md": "C-037",
    "incoming/2026-09-27_daniel_ortiz_contractor_agreement_draft.md": "C-047",
    "incoming/2026-09-27_daniel_ortiz_nda_draft.md": "C-048",
    "incoming/2026-09-27_loopmart_mutual_nda_draft.md": "C-038",
    "incoming/2026-09-27_marcus_reed_contractor_agreement_draft.md": "C-040",
    "signed_contracts/2022-07-01_orbit_travels_msa_scanned.md": "C-001",
    "signed_contracts/2024-08-01_crestline_retail_msa.md": "C-002",
    "signed_contracts/2025-01-22_al_noor_mutual_nda.md": "C-013",
    "signed_contracts/2025-01-22_paytrack_technologies_msa.md": "C-005",
    "signed_contracts/2025-03-10_acme_retail_group_msa.md": "C-006",
    "signed_contracts/2025-03-15_al_noor_hospitality_msa.md": "C-007",
    "signed_contracts/2025-04-18_sunrise_foods_msa.md": "C-008",
    "signed_contracts/2025-04-28_rohan_iyer_contractor_agreement.md": "C-039",
    "signed_contracts/2025-06-20_northwind_logistics_msa.md": "C-009",
    "signed_contracts/2025-09-01_cloudspan_strategic_partnership_agreement.md": "C-032",
    "signed_contracts/2025-10-06_atliq_intercompany_subcontractor_baa.md": "C-044",
    "signed_contracts/2025-10-06_carebridge_clinics_baa.md": "C-043",
    "signed_contracts/2025-11-28_brightwater_insurance_msa.md": "C-014",
    "signed_contracts/2026-02-10_al_noor_waiver_letter.md": "C-016",
    "signed_contracts/2026-07-16_meridian_healthcare_nda.md": "C-020",
    "signed_contracts/2026-08-15_trustline_nbfc_msa.md": "C-021",
    "signed_contracts/2026-08-20_harrington_health_mutual_nda.md": "C-045",
}

REQUESTER = {"karandeep": "kd", "bhavin": "bhavin", "dhaval": "dhaval", "jay": "jay", "pranav": "kd"}
PHI = re.compile(r"\bphi\b|protected health information|electronic health record|patient", re.I)


def tracker() -> dict[str, dict]:
    with (DATASET / "contract_tracker.csv").open(encoding="utf-8") as fh:
        return {r["contract_id"]: r for r in csv.DictReader(fh)}


def due_date(notes: str) -> str | None:
    m = re.search(r"(?:by|before)\s+(?:\w{3}\s+)?(\d{1,2})\s+(Sep|Oct|Nov|Dec)", notes or "", re.I)
    if not m:
        return None
    return fmt_day(datetime.strptime(f"{m.group(1)} {m.group(2)[:3].title()} 2026", "%d %b %Y").date())


def money(row: dict) -> str:
    v = (row.get("value_usd") or "").strip()
    try:
        n = float(v)
    except ValueError:
        return "-"
    return f"-${abs(n):,.0f}" if n < 0 else f"${n:,.0f}"


def data_quality(rows: dict[str, dict], register: list[dict]) -> list[dict]:
    """Problems in the tracker that the README promises: blanks, a duplicate, stale statuses…"""
    out = []
    seen: dict[tuple, str] = {}
    for cid, r in rows.items():
        key = (r["counterparty"], r["doc_type"], r["signed_date"])
        if r["signed_date"] and key in seen:
            out.append({"severity": "medium", "title": f"Possible duplicate: {cid} and {seen[key]}",
                        "detail": f"{r['counterparty']} {r['doc_type']} signed {r['signed_date']} appears twice ({r['notes'] or 'no note'}). The value is counted twice.", "rows": [seen[key], cid]})
        seen.setdefault(key, cid)
        expected = "Inc" if entity_for_country(r["client_country"]) == "inc" else "Pvt Ltd"
        if not r["atliq_entity"].strip() and r["status"] in ("Signed", "In review", "Draft", ""):
            out.append({"severity": "medium", "title": f"{cid} {r['counterparty']}: AtliQ entity blank",
                        "detail": f"{r['client_country'] or 'Unknown country'} → should be AtliQ {expected} (atliq_entities.md).", "rows": [cid]})
        elif r["atliq_entity"].strip() and r["client_country"] and r["atliq_entity"].strip() != expected and "intercompany" not in r["counterparty"].lower():
            out.append({"severity": "high", "title": f"{cid} {r['counterparty']}: wrong entity recorded",
                        "detail": f"Tracker says AtliQ {r['atliq_entity']} for a {r['client_country']} counterparty; the rule is AtliQ {expected}.", "rows": [cid]})
        if r["status"] == "Signed" and not r["file_location"].strip():
            out.append({"severity": "low", "title": f"{cid} {r['counterparty']} {r['doc_type']}: no file location",
                        "detail": "Signed, but nobody recorded where the executed copy is.", "rows": [cid]})
        if not r["status"].strip():
            out.append({"severity": "low", "title": f"{cid} {r['counterparty']}: no status", "detail": r["notes"] or "", "rows": [cid]})
    restricted = {o["counterparty"].split()[0].lower() for o in register if o.get("match")}
    for cid, r in rows.items():
        first = r["counterparty"].split()[0].lower()
        if r["status"] == "Signed" and first in restricted and r["restrictive_clauses"].strip().lower() in ("", "none") and r["doc_type"] in ("MSA", "Partnership Agreement", "SOW-1"):
            out.append({"severity": "high", "title": f"{cid} {r['counterparty']}: restriction not recorded",
                        "detail": f"restrictive_clauses is '{r['restrictive_clauses'] or 'blank'}', but the signed contract restricts AtliQ (see the obligation register).", "rows": [cid]})
    on_file = set(FILES.values())
    missing = [cid for cid, r in rows.items() if r["status"] == "Signed" and cid not in on_file]
    if missing:
        out.append({"severity": "medium", "title": f"{len(missing)} signed contracts not in the dataset",
                    "detail": "Signed per the tracker but no executed copy collected: " + ", ".join(f"{c} {rows[c]['counterparty']} {rows[c]['doc_type']}" for c in missing),
                    "rows": missing})
    out.append({"severity": "medium", "title": "C-001 Orbit Travels: scanned copy with OCR errors",
                "detail": "The only copy is an OCR'd scan ('AGREERNENT', 'twelve (l2) months' in the non-compete, '[illegible]' in the indemnity). Its non-compete expired 30 Jun 2025.", "rows": ["C-001"]})
    order = {"high": 0, "medium": 1, "low": 2}
    return sorted(out, key=lambda x: order[x["severity"]])


def build() -> dict:
    from .pipeline import run as run_mod

    run_mod.STEP_DELAY = 0
    rows = tracker()
    reg = json.loads((CURATED / "register.json").read_text(encoding="utf-8"))
    prec = json.loads((CURATED / "precedents.json").read_text(encoding="utf-8"))

    tmp = Path(tempfile.mkdtemp()) / "build.db"
    conn = db.connect(sqlite_path=tmp)  # always a throwaway SQLite file, even when DATABASE_URL is set
    db.create_schema(conn)
    register = []
    for o in reg["obligations"]:
        o = dict(o)
        o["status"] = "superseded" if o.get("statusOverride") == "superseded" else (
            "expired" if parse_day(o["expires"]) and parse_day(o["expires"]) < AS_OF else "active")
        o["effective"] = fmt_day(parse_day(o["effective"]))
        o["expires"] = fmt_day(parse_day(o["expires"])) if parse_day(o["expires"]) else o["expires"]
        o["entity"] = {"pvt": "AtliQ Technologies Pvt Ltd", "inc": "AtliQ Inc"}[o["entity"]]
        register.append(o)
        db.put_json(conn, "obligations", o)
    for p in prec["precedents"]:
        db.put_json(conn, "precedents", p)
    for h in prec["history"]:
        db.add_history(conn, h)
    conn.commit()

    texts = {f: (DATASET / f).read_text(encoding="utf-8") for f in FILES}
    phi_party: dict[str, bool] = {}
    for f, cid in FILES.items():
        k = db.party_key(rows[cid]["counterparty"])
        phi_party[k] = phi_party.get(k, False) or bool(PHI.search(texts[f]))

    contracts, audit = [], []
    for f, cid in sorted(FILES.items(), key=lambda kv: (not kv[0].startswith("signed"), kv[0])):
        r = rows[cid]
        signed = f.startswith("signed")
        k = db.party_key(r["counterparty"])
        meta = {
            "counterparty": r["counterparty"].replace(" (intercompany)", ""), "country": r["client_country"].rstrip("?") or "India",
            "direction": "inbound", "doc_type": r["doc_type"], "value": money(r), "primary": REQUESTER.get(r["requested_by"].lower(), "kd"),
            "uploader": "kd", "filename": f.split("/")[-1], "status": "Signed" if signed else "Awaiting review",
            "received": fmt_day(parse_day(r["received_date"])) if r["received_date"] else "-",
            "signed_on": fmt_day(parse_day(r["signed_date"])) if r["signed_date"] else "",
            "related_phi": phi_party.get(k, False) and not signed,
            "deal": {
                "trackerId": cid, "requestedBy": r["requested_by"], "received": fmt_day(parse_day(r["received_date"])) if r["received_date"] else None,
                "due": due_date(r["notes"]), "notes": r["notes"], "trackerStatus": r["status"] or "(blank)",
                "fileLocation": r["file_location"] or None, "signed": fmt_day(parse_day(r["signed_date"])) if r["signed_date"] else None,
                "expires": fmt_day(parse_day(r["expiry_date"])) if r["expiry_date"] else None,
            },
        }
        c = run_mod.run_review(conn, cid, DATASET / f, meta)
        db.put_json(conn, "contracts", c)
        contracts.append(c)
        if not signed:
            audit.append({"at": "28 Sep 2026, 09:00", "actor": "System", "action": "Review generated",
                          "detail": f"{cid} {c['name']}: {len(c['findings'])} findings, {sum(x['prior']['status'] == 'active' for x in c['conflicts'])} live conflicts. {c['audit']['model']}.", "kind": "ai"})
    conn.close()

    dq = data_quality(rows, register)
    audit.append({"at": "28 Sep 2026, 08:50", "actor": "System", "action": "Dataset imported",
                  "detail": f"{sum(1 for f in FILES if f.startswith('incoming'))} drafts, {sum(1 for f in FILES if f.startswith('signed'))} signed contracts, {len(register)} obligations, {len(prec['precedents'])} precedents.", "kind": "system"})
    for i, a in enumerate(audit):
        a["id"] = f"A-{i + 1}"

    # Newest received first, drafts before signed — the order the UI shows.
    contracts.sort(key=lambda c: (c["status"] == "Signed", -(parse_day(c["received"]) or AS_OF).toordinal()))
    return {
        "asOf": fmt_day(AS_OF),
        "source": str(DATASET.name),
        "contracts": contracts,
        "obligations": register,
        "precedents": prec["precedents"],
        "history": prec["history"],
        "delegations": [],
        "audit": audit,
        "dataQuality": dq,
    }


def main() -> None:
    seed = build()
    out = ROOT / "seed" / "seed.json"
    out.write_text(json.dumps(seed, indent=1, ensure_ascii=False), encoding="utf-8")
    drafts = [c for c in seed["contracts"] if c["status"] != "Signed"]
    print(f"wrote {out}: {len(drafts)} drafts, {len(seed['contracts']) - len(drafts)} signed, {len(seed['obligations'])} obligations, "
          f"{len(seed['dataQuality'])} data-quality issues")
    if "--reset" in sys.argv:
        db.reset()
        print("database reset from the new seed")


if __name__ == "__main__":
    main()

"""Review pipeline (PRD §8.3). Produces a Contract document in exactly the frontend's shape."""
from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
from pathlib import Path
from typing import Callable

from .. import db
from ..access import USERS
from ..company import AS_OF, ENTITIES, HIGH_VALUE_USD, entity_for_country, fmt_day, parse_usd
from ..rules import CURRENT_RULES, PROMPT_VERSION, entity_check
from . import conflicts as conflict_mod
from . import llm_engine, retrieve, rules_engine
from .detect import DOC_TITLES, detect
from .parse import parse_text, provenance, read_text
from .rules_engine import Ctx, Draft
from .segment import segment
from .verify import quote_supported

log = logging.getLogger("atliq.pipeline")

STEPS = 10
SEV_RANK = {"high": 3, "medium": 2, "unknown": 1, "low": 0}
STEP_DELAY = 0.35  # small pause per step so the progress UI is readable; the work itself is fast
REGISTER_FILE = Path(__file__).resolve().parents[2] / "dataset" / "register.json"


def _high_value(value: str) -> bool:
    if value == "-":
        return False
    usd = parse_usd(value)
    return usd is None or usd >= HIGH_VALUE_USD  # unreadable: assume high, so only KD approves


def _clients() -> list[dict]:
    try:
        return json.loads(REGISTER_FILE.read_text(encoding="utf-8")).get("activeClients", [])
    except FileNotFoundError:
        return []


def _family(conn: sqlite3.Connection, cid: str, doc_type: str, role: str, cp: str, full: str, parent_id: str | None = None) -> dict | None:
    key = db.party_key(cp)
    others = [c for c in db.list_json(conn, "contracts") if c["id"] != cid]
    # A revised draft uploaded from an earlier review ("Upload revised draft") links to that review.
    prev = next((c for c in others if c["id"] == parent_id), None) if parent_id else None
    if prev:
        return {"relation": f"Revised draft of {prev['id']}", "parent": {"name": prev["name"], "signed": prev["status"], "id": prev["id"]},
                "note": f"Replaces the draft reviewed in {prev['id']} ({prev['status'].lower()}). Compare the two reviews to see what changed."}
    same = [c for c in others if db.party_key(c["counterparty"]) == key]
    if doc_type == "SOW":
        parent = next((c for c in same if c["docType"] == "MSA"), None)
        if parent:
            return {"relation": "SOW under MSA", "parent": {"name": parent["name"], "signed": parent["received"].split(",")[0], "id": parent["id"]},
                    "note": f"Linked to {parent['name']} ({parent['id']}, {parent['status'].lower()}). Terms the SOW doesn't set come from the MSA, which prevails on conflict."}
        return {"relation": "SOW - parent MSA not found", "orphan": True, "note": f"No MSA with {cp} is on file. Without it, liability, IP and indemnity terms are undefined."}
    if doc_type == "BAA":
        msa = next((c for c in same if c["docType"] in ("MSA", "Services")), None)
        if msa:
            return {"relation": "Bundle - signed together with the services contract", "parent": {"name": msa["name"], "signed": msa["status"], "id": msa["id"]},
                    "note": f"US healthcare work needs the NDA, the BAA and the services contract to line up. Review with {msa['id']}; the BAA overrides the MSA on PHI."}
    if role == "Buyer":
        for c in others:
            if c["direction"] == "inbound" and c.get("atliqRole") != "Buyer":
                first = db.party_key(c["counterparty"]).split(" ")[0]
                if len(first) > 4 and re.search(rf"\b{re.escape(first)}\b", full):
                    return {"relation": f"Engagement for {c['counterparty']}", "parent": {"name": c["name"], "signed": c["status"], "id": c["id"]},
                            "note": f"This agreement staffs AtliQ's work for {c['counterparty']} ({c['id']}). Its terms must flow down that contract's requirements."}
    if same:
        sib = same[0]
        return {"relation": f"Related: {len(same)} other document(s) with {cp}", "parent": {"name": sib["name"], "signed": sib["status"], "id": sib["id"]},
                "note": "Other agreements with the same counterparty are on file. Check they say the same thing."}
    return None


def _source(prov: str | None) -> str:
    """Short "who sent it" line from the file's provenance note, e.g. "Bhavin's email" or "Prepared by Dhaval"."""
    if not prov:
        return ""
    if m := re.search(r"via ([^.;,]+?)(?:[.;,]|$)", prov):
        return m.group(1).strip()
    if m := re.search(r"prepared by (\w+)", prov, re.I):
        return f"Prepared by {m.group(1)}"
    if m := re.search(r"extracted from ([^.—]+)", prov):
        return m.group(1).strip() + (" (scanned, OCR)" if "scanned" in prov else "")
    if m := re.search(r"Stored: ([^>]+)", prov):
        return m.group(1).strip()
    return prov.split(".")[0].strip()


def run_review(
    conn: sqlite3.Connection,
    contract_id: str,
    path: Path,
    meta: dict,
    progress: Callable[[int], None] = lambda s: None,
) -> dict:
    t0 = time.time()
    cp = meta["counterparty"].strip()
    uploader = meta.get("uploader", "kd")
    signed = meta.get("status") == "Signed"

    def step(i: int) -> None:
        progress(i)
        if STEP_DELAY:
            time.sleep(STEP_DELAY)

    # 1 — parse
    step(0)
    text = read_text(path)
    prov = provenance(text)
    pages = parse_text(text)
    readable_pages = [p for p in pages if p.readable]
    parse_quality = len(readable_pages) / len(pages) if pages else 0.0
    full = "\n".join(p.text for p in readable_pages)

    # 2 — detect type, role, entity, who is who
    step(1)
    det = detect(text, prov, {"doc_type": meta.get("doc_type")})
    clauses = segment(pages)
    full = re.sub(r"\*\*|__", "", full)  # Markdown emphasis would break phrase matching
    atliq_l, other_l = list(det.atliq_labels), list(det.other_labels)
    # Client paper often calls the counterparty "Client"/"Company"/"Customer" without defining it
    # next to their name; on AtliQ's own buyer paper "Company" means AtliQ.
    generic = ["Client", "Customer", "Covered Entity"] + (["Company"] if det.role != "Buyer" else [])
    for lab in generic:
        if lab not in atliq_l and lab not in other_l and re.search(rf"\b{lab}\b", full):
            other_l.append(lab)
    if det.role == "Buyer":
        for lab in ("Contractor", "Vendor", "Subcontractor", "Consultant"):
            if re.search(rf"\b{lab}\b", full) and lab not in other_l:
                other_l.append(lab)
            if lab in atliq_l:
                atliq_l.remove(lab)
        if "Company" not in atliq_l and re.search(r"\(the \"?\**Company\**\"?\)", full):
            atliq_l.append("Company")
    groups: dict[str, list[str]] = {}
    for c in clauses:
        groups.setdefault(c.section.split(".")[0], []).append(c.text)
    country = meta.get("country") or "Unknown"
    ctx = Ctx(role=det.role, doc_type=det.doc_type, atliq=atliq_l, other=other_l, counterparty=cp, country=country,
              entity_key=det.entity_key, governing_law=det.governing_law, full=full.lower(),
              groups={k: "\n".join(v) for k, v in groups.items()}, related_phi=bool(meta.get("related_phi")), presented_as=det.presented_as)

    # 3 — contract family
    step(2)
    family = _family(conn, contract_id, det.doc_type, det.role, cp, full.lower(), meta.get("parent_id"))

    # 4 — clause analysis (rules always; Claude when enabled)
    step(3)
    drafts: list[Draft] = rules_engine.analyse(clauses, ctx)
    usage: dict | None = None
    if llm_engine.enabled() and not signed:
        llm_drafts, usage = llm_engine.analyse(clauses, cp)
        have = {(d.section, d.category) for d in drafts}
        drafts += [d for d in llm_drafts if (d.section, d.category) not in have]

    # 5 — entity and jurisdiction (deterministic)
    step(4)
    # The entity rule follows where AtliQ serves clients. For a partnership that is the territory,
    # not the partner's home country (e.g. a US platform appointing AtliQ for India, GCC and Europe).
    ent_country = country
    terr = re.search(r'"?territory"? means ([^.]+)', full, re.I)
    if det.role == "Partner" and terr and not re.search(r"united states|\busa\b", terr.group(1), re.I):
        ent_country = "Territory outside the US"
    ent = entity_check(ent_country, det.entity_key, det.governing_law, det.invoicing_key)

    # 6 — retrieve the register
    step(5)
    register = db.list_json(conn, "obligations")
    sources = len(register)

    # 7 — compare with what AtliQ already promised (not for the signed contracts the register came from)
    step(6)
    hits = [] if signed else conflict_mod.find(clauses, ctx, register, _clients())
    conflicts, extra_q = [], []
    for h in hits:
        drafts.extend(h.extra_findings)
        o = h.obligation
        st = conflict_mod.status_of(o) if not o["id"].startswith("client:") else "active"
        conflicts.append({
            "id": f"X-{len(conflicts) + 1}",
            "newClause": {"quote": h.quote, "page": h.clause.page, "section": h.clause.section},
            "prior": {
                "obligationId": o["id"], "contract": o["sourceContract"], "counterparty": o["counterparty"],
                "effective": fmt_day(_d(o.get("effective"))) if o.get("effective") else "-",
                "expires": fmt_day(_d(o["expires"])) if _d(o.get("expires")) else o.get("expires", "-"),
                "quote": o.get("quote") or o.get("summary", ""), "status": st,
                "reliesOn": conflict_mod.relies_on(o) if not o["id"].startswith("client:") else o["summary"],
                "sourceFile": o.get("sourceFile"), "clause": o.get("clause"),
            },
            "explanation": h.explanation,
            "severity": h.severity,
        })
        if st == "active":
            if o["id"] == "OB-15":
                extra_q.append(("Assigned reviewer", f"Al Noor's non-compete covers this deal until {fmt_day(_d(o['expires']))}. Either ask Al Noor for written consent under cl. 12.4 (as for Seaside) or take the GCC hospitality work out of scope, and ask counsel before signing.", True))
            elif o["id"] == "OB-30":
                extra_q.append(("Assigned reviewer", "CloudSpan's exclusivity (cl. 7.1) covers India and the GCC until 31 Aug 2028. Limit this partnership to Europe, or give CloudSpan 90 days' notice (cl. 14.2) first.", True))
            elif o["id"] == "OB-46":
                extra_q.append(("Assigned reviewer", "Real PHI from Harrington is already with the Pune engineers, which the signed NDA (cl. 2.3) forbids. Get counsel's view on notification before signing the BAA.", True))
            elif o["id"].startswith("client:"):
                extra_q.append(("Assigned reviewer", f"Strike or narrow the non-compete: it would cover {o['counterparty']}, a live client.", True))

    # 8 — counterparty history (AtliQ's own records)
    step(7)
    events = db.counterparty_history(conn, cp)
    if events:
        legitimacy = {"held": True, "summary": f"{len(events)} record(s) held: " + "; ".join(e["detail"] for e in events[:2]),
                      "source": events[0]["source"], "events": [{"date": e["date"], "kind": e["kind"], "detail": e["detail"]} for e in events]}
    else:
        legitimacy = {"held": False, "summary": f"AtliQ holds no payment or dispute history for {cp}. Absence of records is not evidence of a clean record.",
                      "source": "contract_tracker.csv · negotiation_notes.md · meeting notes", "events": []}

    # 9 — verify every quote, then coverage
    step(8)
    verified: list[Draft] = []
    seen: set[tuple[str, str]] = set()
    for d in drafts:
        if not quote_supported(d.quote, clauses, d.section):
            log.info("dropped unverified quote for %s %s", d.section, d.category)
            continue
        key = (d.section, d.clauseTitle.split(" - ")[-1])
        if key in seen:
            continue
        seen.add(key)
        verified.append(d)
    verified.sort(key=lambda d: -SEV_RANK[d.severity])

    findings = []
    for i, d in enumerate(verified):
        precedents = retrieve.precedent_for(conn, d.precedentQuery or d.category)
        sources += len(precedents)
        f = {
            "id": f"F-{i + 1}", "clauseTitle": d.clauseTitle, "category": d.category, "severity": d.severity,
            "whyItMatters": d.whyItMatters, "citation": {"quote": d.quote, "page": d.page, "section": d.section},
            "confidence": d.confidence, "recommendedAction": d.recommendedAction, "precedents": precedents,
            "marks": [], "decision": "pending", "drivers": d.drivers,
        }
        if d.fallback:
            f["suggestedFallback"] = d.fallback
        if d.abstained:
            f["abstained"], f["abstentionReason"] = True, d.abstentionReason
        findings.append(f)

    flagged = {d.section for d in verified}
    clause_rows = [
        {"section": c.section, "title": c.title, "text": c.text,
         "outcome": "not-covered" if not c.readable else ("finding" if c.section in flagged else "no-issue")}
        for c in clauses
    ]
    total = len(clause_rows)
    not_cov = sum(r["outcome"] == "not-covered" for r in clause_rows)
    below = total == 0 or (total - not_cov) / total < 0.99
    brand = [{"type": d.brand, "severity": d.severity, "citation": {"quote": d.quote, "page": d.page, "section": d.section}, "note": d.whyItMatters}
             for d in verified if d.brand]
    inj = next((d for d in verified if d.injection), None)

    # Questions routed to owners (FR-12)
    primary = meta.get("primary", "kd")
    questions: list[tuple[str, str, bool]] = []
    if below:
        questions.append(("Assigned reviewer", f"Request a text-based copy from {cp}: {not_cov} page(s) have no readable text.", True))
    if ent["status"] == "fail":
        questions.append(("Finance", f"Fix the contracting entity: a {country} counterparty contracts with {ent['expectedEntity']} (atliq_entities.md). Who signs, and which entity invoices?", True))
    for d in verified:
        q = d.extra.get("question")
        if q:
            questions.append((q[0], q[1], d.severity == "high"))
    questions += extra_q
    if family and family.get("orphan"):
        questions.append(("Assigned reviewer", f"Does a parent agreement with {cp} exist? If not, should AtliQ send its MSA alongside?", True))
    missing = [
        {"id": f"M-{i + 1}", "question": q, "owner": owner, "blocking": blocking, "resolved": signed,
         **({"assignee": primary} if owner == "Assigned reviewer" else {})}
        for i, (owner, q, blocking) in enumerate(dict.fromkeys(questions))
    ]

    # 10 — verdict and summary
    step(9)
    highs = [f for f in findings if f["severity"] == "high"]
    live = [x for x in conflicts if x["prior"]["status"] == "active"]
    mediums = [f for f in findings if f["severity"] in ("medium", "unknown")]
    def short(f: dict) -> str:
        return f["clauseTitle"].split(" - ")[-1]
    if below:
        state, disposition = "insufficient-evidence", "no-verdict"
        summary = f"No overall verdict. {not_cov} of {total} sections could not be read, so the review can't be complete."
    elif highs or live or ent["status"] == "fail":
        state, disposition = "red", "do-not-sign"
        bits = []
        if live:
            bits.append("Conflicts with what AtliQ already promised: " + "; ".join(f"{x['prior']['counterparty']} ({x['prior']['obligationId']})" for x in live[:2]) + ".")
        if ent["status"] == "fail":
            bits.append("Wrong AtliQ entity for this counterparty.")
        if highs:
            bits.append(f"{len(highs)} high-severity issue{'s' if len(highs) > 1 else ''}: " + "; ".join(short(f) for f in highs[:3]) + ".")
        summary = "Do not sign yet. " + " ".join(bits) + f" All {total} clauses were examined."
    elif mediums:
        state = "amber"
        disposition = "negotiate" if any(f["recommendedAction"] == "negotiate" for f in mediums) else "internal-confirmation"
        summary = f"Negotiable. {len(mediums)} point{'s' if len(mediums) > 1 else ''} to raise: " + "; ".join(short(f) for f in mediums[:3]) + f". All {total} clauses were examined."
    else:
        state, disposition = "green", "proceed"
        summary = f"No material issue found across all {total} clauses and no conflict with AtliQ's register. Recommend normal human approval; the system does not sign."
    if det.presented_as:
        summary += f" Presented as “{det.presented_as}”; reviewed in full regardless."
    if signed:
        summary = (f"Signed {meta.get('signed_on', '')}. " + summary.replace("Do not sign yet. ", "Signed with these issues: ")
                   .replace("Negotiable. ", "Signed with these open points: ")
                   .replace(" Recommend normal human approval; the system does not sign.", ""))

    llm_ok = usage is not None and not usage["errors"]
    model = (f"{usage['model']} + rules-engine v2" if llm_ok else "rules-engine v2 (AI unavailable; rules only)" if usage is not None else "rules-engine v2 (no AI key set)")
    conf = [f["confidence"] for f in findings] or [0.9]
    value = (meta.get("value") or "").strip() or "-"
    access = list(dict.fromkeys([u for u in ["kd", primary, meta.get("secondary"), uploader] if u]))
    named = ENTITIES[det.entity_key]["name"] if det.entity_key else ENTITIES[entity_for_country(country)]["name"]
    contract = {
        "id": contract_id,
        "name": f"{cp} - {DOC_TITLES.get(det.doc_type, det.doc_type)}" + (" (AtliQ draft)" if det.paper == "atliq" and not signed else ""),
        "counterparty": cp,
        "docType": det.doc_type,
        **({"presentedAs": det.presented_as} if det.presented_as else {}),
        "direction": "outbound" if det.paper == "atliq" else meta.get("direction", "inbound"),
        "receivedFrom": _source(prov) or meta.get("filename", ""),
        "atliqRole": det.role,
        "entity": named,
        "country": country,
        "value": value,
        "highValue": _high_value(value),
        "received": meta.get("received") or db.stamp(),
        "pages": len(pages),
        "status": meta.get("status", "Awaiting review"),
        "state": state,
        "disposition": disposition,
        "summary": summary,
        "parseQuality": round(parse_quality, 2),
        "primary": primary,
        **({"secondary": meta["secondary"]} if meta.get("secondary") else {}),
        "access": access,
        **({"family": family} if family else {}),
        "clauses": clause_rows,
        "coverageThreshold": 0.99,
        "findings": findings,
        "conflicts": conflicts,
        "entityCheck": ent,
        "brand": brand,
        "legitimacy": legitimacy,
        "missingInfo": missing,
        **({"injection": {"page": inj.page, "note": f"Text addressed to the AI: “{inj.quote}”. Treated as document data only."}} if inj else {}),
        "detectConfidence": det.confidence,
        "sourceFile": meta.get("filename"),
        **({"dealContext": {**meta["deal"], **({"provenance": prov} if prov else {})}} if meta.get("deal") else {}),
        "asOf": fmt_day(AS_OF),
        "audit": {
            "model": model, "promptVersion": PROMPT_VERSION, "rulesVersion": CURRENT_RULES, "sourcesUsed": sources,
            "overallConfidence": round(0.3 if below else sum(conf) / len(conf), 2),
            "completedAt": db.stamp(), "durationSeconds": max(1, round(time.time() - t0)),
        },
    }
    if usage:
        contract["audit"]["tokens"] = {k: usage[k] for k in ("input", "output", "cache_read", "cache_write")}
    return contract


def _d(s):
    from ..company import parse_day

    return parse_day(s) if s else None

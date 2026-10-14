"""AtliQ Contract Risk Analyzer — demo API.

Run:  uv run uvicorn app.main:app --reload --port 8000     (docs at http://localhost:8000/docs)
The signed-in user is the X-User header (kd | bhavin | dhaval | jay), set by the UI's
"Viewing as" switcher. Every access rule is enforced here, not just in the UI (FR-18).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import uuid
from contextlib import asynccontextmanager
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated, Literal

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, StringConstraints, model_validator

from . import db
from .access import USERS, approver_of, block_reasons, can_approve, delegation_active, parse_day, reviewer_role, visible_to
from .company import parse_usd
from .pipeline import llm_engine
from .pipeline.parse import SUPPORTED, UnsupportedFile
from .pipeline.run import STEPS, run_review
from .rules import CURRENT_RULES, entity_check, entity_key_for_name

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("atliq")


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.ensure()
    log.info("AI analyzer: %s", f"Claude ({llm_engine.MODEL})" if llm_engine.enabled() else "rules engine only (no ANTHROPIC_API_KEY)")
    log.info("Database: %s", "Postgres (DATABASE_URL)" if db.DATABASE_URL else f"SQLite ({db.DB_PATH.name})")
    yield
    db.close_pool()


app = FastAPI(title="AtliQ Contract Risk Analyzer API", version="0.1.0", lifespan=lifespan)
# Local Vite dev server, plus the hosted web app's addresses (comma-separated in ATLIQ_CORS_ORIGINS).
CORS_ORIGINS = ["http://localhost:5173", *[o.strip() for o in os.environ.get("ATLIQ_CORS_ORIGINS", "").split(",") if o.strip()]]
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=1000)  # the bootstrap payload is ~1 MB of JSON

MAX_BYTES = 25 * 1024 * 1024
Severity = Literal["high", "medium", "low", "unknown"]
Decision = Literal["pending", "accepted", "modified", "rejected", "escalated"]
# Free text from people: trimmed, and capped so one request can't bloat a contract record.
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=10000)]
Status = Literal["Awaiting review", "In negotiation", "Internal confirmation", "With counsel", "Ready to sign", "Signed", "Rejected"]


# ----------------------------- dependencies -----------------------------

def get_conn():
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def get_user(x_user: str = Header("kd", alias="X-User")) -> str:
    if x_user not in USERS:
        raise HTTPException(401, f"Unknown user '{x_user}'")
    return x_user


def load_visible(conn, cid: str, user: str) -> dict:
    c = db.get_json(conn, "contracts", cid)
    if not c:
        raise HTTPException(404, "Contract not found")
    if not visible_to(c, user):
        db.add_audit(conn, user, "Access denied", f"{cid}: not an assigned reviewer", "system")
        raise HTTPException(403, "You don't have access to this contract")
    return c


def delegations(conn) -> list[dict]:
    return db.list_json(conn, "delegations")


def require_editable(c: dict) -> None:
    """Signed contracts are read-only for good; rejected ones until someone reopens them."""
    if c["status"] == "Signed":
        raise HTTPException(409, "This contract is signed and read-only")
    if c["status"] == "Rejected":
        raise HTTPException(409, "This contract was rejected. Reopen it to make changes")


def require_approver(conn, c: dict, user: str) -> None:
    if not can_approve(c, user, delegations(conn)):
        raise HTTPException(403, f"Only {USERS[approver_of(c, delegations(conn))]['name']} can decide on this contract")
    if c["status"] == "Signed":
        raise HTTPException(409, "This contract is signed and read-only")


CONTRACT_ID = re.compile(r"\bC-\d+\b")


def audit_for(conn, user: str) -> list[dict]:
    """The audit log, minus entries about contracts this user can't open (they'd leak names and findings)."""
    entries = db.list_audit(conn)
    if USERS[user]["superAdmin"]:
        return entries
    visible = {c["id"] for c in db.list_json(conn, "contracts") if visible_to(c, user)}
    return [a for a in entries if all(cid in visible for cid in CONTRACT_ID.findall(a.get("detail") or ""))]


# ----------------------------- read -----------------------------

@app.get("/api/health")
def health():
    return {"ok": True, "ai": f"claude:{llm_engine.MODEL}" if llm_engine.enabled() else "rules", "rules": CURRENT_RULES}


@app.get("/api/bootstrap")
def bootstrap(user: str = Depends(get_user), conn=Depends(get_conn)):
    """Everything the UI needs in one call, filtered to what this user may see."""
    contracts = db.list_json(conn, "contracts")
    visible = [c for c in contracts if visible_to(c, user)]
    return {
        "contracts": visible,
        "hidden": len(contracts) - len(visible),
        "delegations": delegations(conn),
        "obligations": db.list_json(conn, "obligations"),
        "precedents": db.list_json(conn, "precedents"),
        "pending": db.list_json(conn, "pending_precedents"),
        "audit": audit_for(conn, user),
        "ai": "claude" if llm_engine.enabled() else "rules",
        "asOf": db.get_meta(conn, "asOf"),
        "dataQuality": data_quality_for(conn, user, visible),
        "reliability": _reliability(),
    }


def data_quality_for(conn, user: str, visible: list[dict]) -> list[dict]:
    """Tracker problems, limited to contracts this user can open (each names the contract and its issue)."""
    issues = db.get_meta(conn, "dataQuality") or []
    if USERS[user]["superAdmin"]:
        return issues
    ids = {c["id"] for c in visible}
    return [q for q in issues if all(r in ids for r in q.get("rows", []))]


def _reliability() -> dict | None:
    """Measured results from `python -m app.eval` (PRD §12), shown under "How reliable is this?"."""
    p = db.ROOT / "eval" / "results.json"
    if not p.exists():
        return None
    r = json.loads(p.read_text(encoding="utf-8"))
    return {k: r.get(k) for k in ("ranAt", "testSet", "issueRecall", "highRecall", "conflictRecall", "entityAccuracy", "cleanCorrect", "unexpectedHighFindings")}


@app.get("/api/contracts/{cid}")
def get_contract(cid: str, user: str = Depends(get_user), conn=Depends(get_conn)):
    c = load_visible(conn, cid, user)
    db.add_audit(conn, user, "Opened review", f"{cid}: AI review, evidence and precedent retrieved (permission-filtered).", "retrieval")
    return c


@app.get("/api/obligations")
def obligations(status: str | None = None, q: str | None = None, conn=Depends(get_conn)):
    rows = db.fts_search(conn, "obligations", q, 50) if q else db.list_json(conn, "obligations")
    return [o for o in rows if not status or o["status"] == status]


@app.get("/api/precedents")
def precedents(q: str | None = None, label: str | None = None, conn=Depends(get_conn)):
    rows = db.fts_search(conn, "precedents", q, 50) if q else db.list_json(conn, "precedents")
    return [p for p in rows if not label or p["label"] == label]


@app.get("/api/audit")
def audit(kind: str | None = None, user: str = Depends(get_user), conn=Depends(get_conn)):
    return [a for a in audit_for(conn, user) if not kind or a["kind"] == kind]


# ----------------------------- upload + jobs -----------------------------

def _set_job(conn, job_id: str, **kw) -> None:
    sets = ", ".join(f"{k} = ?" for k in kw)
    conn.execute(f"UPDATE jobs SET {sets} WHERE id = ?", (*kw.values(), job_id))
    conn.commit()


def _run_job(job_id: str, cid: str, path: str, meta: dict, keep: dict | None = None) -> None:
    """`keep` carries human-set state (status, confirmed details) across a re-run."""
    from pathlib import Path

    conn = db.connect()
    try:
        contract = run_review(conn, cid, Path(path), meta, progress=lambda s: _set_job(conn, job_id, step=s))
        if keep:
            contract.update(keep)
            if "entity" in keep:
                recheck_entity(contract)  # the kept, human-confirmed entity — not the one detected again
            if contract["status"] == "Ready to sign" and block_reasons(contract):
                # Decisions on the old findings were replaced, so the approval no longer holds.
                contract["status"] = "Awaiting review"
                db.add_audit(conn, "System", "Ready-to-sign withdrawn", f"{cid}: re-run produced findings that need a decision.", "system")
        db.put_json(conn, "contracts", contract)
        actor = meta["uploader"]
        db.add_audit(conn, "System", "Review generated",
                     f"{cid} {contract['name']}: {len(contract['findings'])} findings, {len(contract['conflicts'])} conflicts, "
                     f"coverage {sum(r['outcome'] != 'not-covered' for r in contract['clauses'])}/{len(contract['clauses'])}. {contract['audit']['model']}.", "ai")
        if contract.get("injection"):
            db.add_audit(conn, "System", "Embedded instruction ignored", f"{cid}: text addressed to the AI treated as data.", "system")
        if block_reasons(contract):
            db.add_audit(conn, "System", "Ready-to-sign blocked", f"{cid}: " + "; ".join(block_reasons(contract)), "system")
        _set_job(conn, job_id, step=STEPS, status="done")
        log.info("job %s done by %s → %s", job_id, actor, cid)
    except UnsupportedFile as e:
        _set_job(conn, job_id, status="error", error=str(e))
    except Exception as e:  # keep the job visible as failed rather than silently dropped (NFR reliability)
        log.exception("job %s failed", job_id)
        kind = Path(path).suffix.lstrip(".").upper() or "contract"
        _set_job(conn, job_id, status="error", error=f"The file couldn't be read. It may be damaged, password-protected or not really a {kind} file.")
    finally:
        conn.close()


@app.post("/api/contracts")
async def upload(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    counterparty: str = Form(...),
    country: str = Form(...),
    direction: Literal["inbound", "outbound"] = Form("inbound"),
    doc_type: str = Form("Other"),
    value: str = Form(""),
    parent_id: str = Form(""),
    primary: str = Form("kd"),
    secondary: str = Form(""),
    user: str = Depends(get_user),
    conn=Depends(get_conn),
):
    name = file.filename or "contract"
    if not name.lower().endswith(SUPPORTED):
        raise HTTPException(422, f"“{name}” isn't supported. Upload a PDF, DOCX, Markdown or TXT file.")
    if primary not in USERS or (secondary and secondary not in USERS):
        raise HTTPException(422, "Unknown reviewer")
    counterparty, country = counterparty.strip(), country.strip()
    if not counterparty or not country:
        raise HTTPException(422, "Enter the counterparty and their country")
    if len(counterparty) > 200 or len(country) > 100:
        raise HTTPException(422, "Counterparty or country is too long")
    if parent_id:
        prev = db.get_json(conn, "contracts", parent_id)
        if not prev or not visible_to(prev, user):
            raise HTTPException(422, f"Previous review {parent_id} not found")
    if value.strip() and parse_usd(value) is None:
        raise HTTPException(422, f"Couldn't read “{value.strip()}” as a US-dollar amount. Enter it like $480,000, $1.2M or $100k–150k.")
    # Reserve the ID before the first await, so a concurrent upload can't be given the same one.
    cid = db.next_contract_id(conn)
    dest = db.UPLOAD_DIR / f"{cid}{'.' + name.rsplit('.', 1)[-1].lower()}"
    conn.execute("INSERT INTO uploads (contract_id, filename, path) VALUES (?, ?, ?)", (cid, name, str(dest)))
    conn.commit()
    size = 0
    content = bytearray()
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                conn.execute("DELETE FROM uploads WHERE contract_id = ?", (cid,))
                conn.commit()
                raise HTTPException(413, "That file is over 25 MB. Contracts up to ~100 pages are supported.")
            out.write(chunk)
            content += chunk
    meta = {
        "counterparty": counterparty, "country": country, "direction": direction, "doc_type": doc_type, "value": value,
        "parent_id": parent_id or None, "primary": primary, "secondary": secondary or None, "uploader": user, "filename": name,
        "status": "Awaiting review", "received": db.stamp(),
    }
    # The file's bytes go in the database too: a hosted server's disk doesn't survive restarts.
    conn.execute("UPDATE uploads SET meta = ?, content = ? WHERE contract_id = ?", (json.dumps(meta), bytes(content), cid))
    job_id = uuid.uuid4().hex[:12]
    conn.execute("INSERT INTO jobs VALUES (?, ?, 0, ?, 'running', NULL)", (job_id, cid, STEPS))
    conn.commit()
    db.add_audit(conn, user, "Contract uploaded", f"{cid}: {name} ({direction}) for {counterparty}", "human")
    background.add_task(_run_job, job_id, cid, str(dest), meta)
    return {"jobId": job_id, "contractId": cid}


@app.get("/api/jobs/{job_id}")
def job(job_id: str, user: str = Depends(get_user), conn=Depends(get_conn)):
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Job not found")
    c = db.get_json(conn, "contracts", row["contract_id"])
    up = conn.execute("SELECT meta FROM uploads WHERE contract_id = ?", (row["contract_id"],)).fetchone()
    uploader = json.loads(up["meta"]).get("uploader") if up and up["meta"] else None
    if not (USERS[user]["superAdmin"] or (c and visible_to(c, user)) or uploader == user):
        raise HTTPException(404, "Job not found")
    return {"id": row["id"], "contractId": row["contract_id"], "step": row["step"], "total": row["total"], "status": row["status"], "error": row["error"]}


# ----------------------------- findings -----------------------------

class Mark(BaseModel):
    verdict: Literal["agree", "regrade", "comment"]
    regradeTo: Severity | None = None
    comment: ShortText = ""

    @model_validator(mode="after")
    def _complete(self):
        if self.verdict == "regrade" and not self.regradeTo:
            raise ValueError("Say which severity it should be")
        if self.verdict == "comment" and not self.comment:
            raise ValueError("Write a comment")
        return self


class Feedback(BaseModel):
    useful: bool
    reason: ShortText | None = None


class FindingPatch(BaseModel):
    decision: Decision | None = None
    severityOverride: Severity | None = None  # null clears; equal to the AI grade also clears
    editedFallback: LongText | None = None  # blank clears the edit
    dismissReason: ShortText | None = None  # present → "not an issue"
    feedback: Feedback | None = None  # null clears
    wordingFeedback: Literal["usable", "edited", "unusable"] | None = None
    mark: Mark | None = None


@app.patch("/api/contracts/{cid}/findings/{fid}")
def patch_finding(cid: str, fid: str, body: FindingPatch, user: str = Depends(get_user), conn=Depends(get_conn)):
    c = load_visible(conn, cid, user)
    f = next((x for x in c["findings"] if x["id"] == fid), None)
    if not f:
        raise HTTPException(404, "Finding not found")
    require_editable(c)
    sent = body.model_fields_set
    approver_fields = {"decision", "severityOverride", "editedFallback", "dismissReason"} & sent
    if approver_fields:
        require_approver(conn, c, user)
    notes = []

    if "dismissReason" in sent:
        f.update(decision="rejected", decidedBy=user, dismissReason=body.dismissReason or "")
        notes.append(("Dismissed as not an issue", body.dismissReason or ""))
    elif "decision" in sent and body.decision:
        f["decision"] = body.decision
        f.pop("dismissReason", None)
        if body.decision == "pending":
            f.pop("decidedBy", None)
        else:
            f["decidedBy"] = user
        notes.append((f"Finding {body.decision}" if body.decision != "pending" else "Finding decision cleared", ""))
    if "severityOverride" in sent:
        if body.severityOverride is None or body.severityOverride == f["severity"]:
            f.pop("severityOverride", None)
        else:
            f["severityOverride"] = {"to": body.severityOverride, "by": user}
        notes.append(("Severity corrected", f"AI {f['severity']} → {body.severityOverride or f['severity']}"))
    if "editedFallback" in sent:
        if body.editedFallback:
            f["editedFallback"] = {"text": body.editedFallback, "by": user}
            f.update(decision="modified", decidedBy=user)
        else:
            f.pop("editedFallback", None)
        notes.append(("Suggested wording edited", "AI original kept"))
    if "feedback" in sent:
        if body.feedback:
            f["feedback"] = {"useful": body.feedback.useful, "reason": body.feedback.reason, "by": user}
            notes.append(("Finding feedback", "helpful" if body.feedback.useful else f"not helpful: {body.feedback.reason}"))
        else:
            f.pop("feedback", None)
    if "wordingFeedback" in sent and body.wordingFeedback:
        f["wordingFeedback"] = body.wordingFeedback
        notes.append(("Suggested-wording feedback", body.wordingFeedback))
    if "mark" in sent and body.mark:
        role = reviewer_role(c, user)
        if not role:
            raise HTTPException(403, "Only the primary or secondary reviewer can add an assessment")
        f["marks"].append({
            "by": user, "as": role, "verdict": body.mark.verdict, "comment": body.mark.comment.strip(), "at": db.stamp().replace(" 2026", ""),
            **({"regradeTo": body.mark.regradeTo} if body.mark.verdict == "regrade" and body.mark.regradeTo else {}),
        })
        notes.append(("Reviewer assessment", f"as {role} reviewer: {body.mark.verdict}"))

    db.put_json(conn, "contracts", c)
    for action, detail in notes:
        db.add_audit(conn, user, action, f"{cid} {fid}{': ' + detail if detail else ''}")
    return c


# ----------------------------- contract-level actions -----------------------------

class StatusBody(BaseModel):
    status: Status
    note: ShortText = ""


# Category → obligation type written to the register on signature (FR-13).
REGISTER_CATEGORIES = {
    "Non-compete / exclusivity": "Exclusivity / non-compete",
    "Most-favoured-customer / pricing promises": "MFC pricing",
    "Liability caps and carve-outs": "Liability cap",
    "Liquidated damages / delay penalties": "Liquidated damages",
    "Data protection / BAA / DPA dependencies": "Data protection",
    "Confidentiality / NDA mutuality": "Confidentiality",
    "Indemnity": "Indemnity",
}


@app.post("/api/contracts/{cid}/status")
def set_status(cid: str, body: StatusBody, user: str = Depends(get_user), conn=Depends(get_conn)):
    c = load_visible(conn, cid, user)
    require_approver(conn, c, user)
    if body.status == "Ready to sign":
        reasons = block_reasons(c)
        if reasons:
            raise HTTPException(409, {"message": "Ready-to-sign is blocked", "reasons": reasons})
    if body.status == "Signed":
        if not USERS[user]["canSign"]:
            raise HTTPException(403, "Only Karandeep can record a signature")
        if c["status"] != "Ready to sign":
            raise HTTPException(409, "Approve for signature first")
    c["status"] = body.status
    db.put_json(conn, "contracts", c)
    db.add_audit(conn, user, body.note or f"Status: {body.status}", f"{cid} → {body.status}")

    if body.status == "Signed":
        # Only human-approved outcomes enter the register.
        n = 0
        for f in c["findings"]:
            if f["decision"] in ("accepted", "modified") and f["category"] in REGISTER_CATEGORIES:
                n += 1
                oid = f"OB-{200 + len(db.list_json(conn, 'obligations'))}"
                db.put_json(conn, "obligations", {
                    "id": oid, "clauseType": REGISTER_CATEGORIES[f["category"]], "counterparty": c["counterparty"], "sourceContract": c["name"],
                    "entity": c["entity"], "effective": db.today(), "expires": "Ongoing", "status": "active", "basis": "standard",
                    "summary": (f.get("editedFallback") or {}).get("text") or (f.get("suggestedFallback") or {}).get("text") or f["citation"]["quote"],
                })
        db.add_audit(conn, "System", "Obligations registered", f"{cid}: {n} obligation(s) written from human-approved outcomes only.", "system")
    return c


@app.post("/api/contracts/{cid}/questions/{mid}/resolve")
def resolve_question(cid: str, mid: str, user: str = Depends(get_user), conn=Depends(get_conn)):
    c = load_visible(conn, cid, user)
    m = next((x for x in c["missingInfo"] if x["id"] == mid), None)
    if not m:
        raise HTTPException(404, "Question not found")
    require_editable(c)
    if not (can_approve(c, user, delegations(conn)) or m.get("assignee") == user):
        raise HTTPException(403, "Only the approver or the person it's routed to can answer this")
    m["resolved"] = True
    db.put_json(conn, "contracts", c)
    db.add_audit(conn, user, "Question answered", f"{cid} {mid}")
    return c


class DetailsBody(BaseModel):
    # Same choices as the review page's "Correct details" form (Review.tsx DOC_TYPES / ROLES).
    docType: Literal["NDA", "MSA", "SOW", "DPA", "BAA", "Partnership", "Services", "Subcontractor", "Contractor", "Pilot", "Waiver"] | None = None
    atliqRole: Literal["Supplier", "Buyer", "Partner", "NDA party"] | None = None
    entity: Literal["AtliQ Technologies Pvt Ltd", "AtliQ Inc"] | None = None
    country: str | None = None


def recheck_entity(c: dict, country: str | None = None) -> None:
    """Re-runs the entity rule against the contract's current entity (and a corrected country).
    Without this a correction leaves the old pass/fail in place, and the ready-to-sign gate reads it."""
    old = c["entityCheck"]
    named = entity_key_for_name(c["entity"])
    # Only two entities exist, so an invoicing mismatch means the other one invoices.
    was_named = entity_key_for_name(old["namedEntity"])
    invoicing = None if old["invoicingConsistent"] or not was_named else ("pvt" if was_named == "inc" else "inc")
    law = None if old["governingLaw"] == "Not stated" else old["governingLaw"]
    # Keep clientLocation unless the country was corrected: for partnerships it is the territory.
    c["entityCheck"] = entity_check(country or old["clientLocation"], named, law, invoicing)


@app.post("/api/contracts/{cid}/details")
def confirm_details(cid: str, body: DetailsBody, user: str = Depends(get_user), conn=Depends(get_conn)):
    c = load_visible(conn, cid, user)
    if not (can_approve(c, user, delegations(conn)) or reviewer_role(c, user)):
        raise HTTPException(403, "Only reviewers or the approver can confirm details")
    require_editable(c)
    if body.country is not None:
        body.country = body.country.strip()
        if not body.country:
            raise HTTPException(422, "Enter the counterparty's country")
    changes = {k: v for k, v in body.model_dump().items() if v is not None and v != c.get(k)}
    c.update(changes)
    if {"entity", "country"} & changes.keys():
        before = c["entityCheck"]["status"]
        recheck_entity(c, changes.get("country"))
        if c["entityCheck"]["status"] != before:
            db.add_audit(conn, "System", "Entity check re-run", f"{cid}: {before} → {c['entityCheck']['status']} after corrected details", "system")
    c["detailsCheckedBy"] = {"by": user, "corrected": bool(changes)}
    db.put_json(conn, "contracts", c)
    db.add_audit(conn, user, "AI-detected details corrected" if changes else "AI-detected details confirmed",
                 f"{cid}{': ' + ', '.join(f'{k}: {v}' for k, v in changes.items()) if changes else ''}")
    return c


@app.post("/api/contracts/{cid}/rerun")
def rerun(cid: str, background: BackgroundTasks, user: str = Depends(get_user), conn=Depends(get_conn)):
    c = load_visible(conn, cid, user)
    require_approver(conn, c, user)
    up = conn.execute("SELECT meta FROM uploads WHERE contract_id = ?", (cid,)).fetchone()
    path = db.upload_file(conn, cid)
    if not up or not up["meta"] or path is None or not path.exists():
        # Seed contracts have no stored file — record the engine version only.
        c["audit"].update(rulesVersion=CURRENT_RULES, completedAt=db.stamp())
        db.put_json(conn, "contracts", c)
        db.add_audit(conn, "System", "Review re-run", f"{cid} with {CURRENT_RULES}. Findings unchanged (no Saudi or DIFC terms).", "ai")
        return {"contract": c}
    job_id = uuid.uuid4().hex[:12]
    conn.execute("INSERT INTO jobs VALUES (?, ?, 0, ?, 'running', NULL)", (job_id, cid, STEPS))
    conn.commit()
    db.add_audit(conn, user, "Review re-run requested", f"{cid} with {CURRENT_RULES}; decisions on the old findings are replaced", "human")
    meta = json.loads(up["meta"])
    keep = {"status": c["status"]}
    if c.get("detailsCheckedBy"):
        # Analyse with the human-confirmed details, and keep them on the new review.
        meta.update(country=c["country"], doc_type=c["docType"])
        keep.update({k: c[k] for k in ("docType", "atliqRole", "entity", "country", "detailsCheckedBy") if k in c})
    background.add_task(_run_job, job_id, cid, str(path), meta, keep)
    return {"jobId": job_id, "contractId": cid}


# ----------------------------- delegations -----------------------------

class DelegationBody(BaseModel):
    to: Literal["bhavin", "dhaval", "jay"]
    scope: list[str] | Literal["all-routine"]
    expires: str


@app.post("/api/delegations")
def create_delegation(body: DelegationBody, user: str = Depends(get_user), conn=Depends(get_conn)):
    if user != "kd":
        raise HTTPException(403, "Only Karandeep can delegate")
    end = parse_day(body.expires)
    if end is None:
        raise HTTPException(422, f"“{body.expires}” isn't a date. Use the form 24 Oct 2026.")
    if end < date.today():
        raise HTTPException(422, "The expiry date has already passed")
    if end > date.today() + timedelta(days=366):
        raise HTTPException(422, "A delegation can last up to a year")
    body.expires = end.strftime("%d %b %Y")  # one spelling everywhere ("Sep", not "Sept")
    name = USERS[body.to]["name"]
    if body.scope != "all-routine":
        body.scope = list(dict.fromkeys(body.scope))
        if not body.scope:
            raise HTTPException(422, "Choose at least one contract to delegate")
        found = {cid: db.get_json(conn, "contracts", cid) for cid in body.scope}
        unknown = [cid for cid, c in found.items() if not c]
        if unknown:
            raise HTTPException(422, f"Unknown contract(s): {', '.join(unknown)}")
        unseen = [cid for cid, c in found.items() if not visible_to(c, body.to)]
        if unseen:
            raise HTTPException(422, f"{name} isn't a reviewer on {', '.join(unseen)}, so they couldn't open it")
    current = next((d for d in db.list_json(conn, "delegations") if d["to"] == body.to and delegation_active(d)), None)
    if current:
        raise HTTPException(409, f"{name} already has an active delegation ({current['id']}, until {current['expires']}). Revoke it first")
    existing = db.list_json(conn, "delegations")
    d = {"id": f"D-{len(existing) + 7:02d}", "to": body.to, "scope": body.scope, "rights": "Review and approval",
         "created": db.today(), "expires": body.expires, "active": True}
    db.put_json(conn, "delegations", d)
    scope = "all routine contracts" if body.scope == "all-routine" else ", ".join(body.scope)
    db.add_audit(conn, user, "Delegation granted", f"{d['id']}: {USERS[body.to]['name']}, review and approval of {scope}, expires {body.expires}. Signature retained by KD.", "delegation")
    return db.list_json(conn, "delegations")


@app.post("/api/delegations/{did}/revoke")
def revoke_delegation(did: str, user: str = Depends(get_user), conn=Depends(get_conn)):
    if user != "kd":
        raise HTTPException(403, "Only Karandeep can revoke a delegation")
    d = db.get_json(conn, "delegations", did)
    if not d:
        raise HTTPException(404, "Delegation not found")
    d["active"] = False
    db.put_json(conn, "delegations", d)
    db.add_audit(conn, user, "Delegation revoked", did, "delegation")
    return db.list_json(conn, "delegations")


# ----------------------------- learning from decisions (HAX G13/G14) -----------------------------

class PendingBody(BaseModel):
    contractId: str
    findingId: str
    label: Literal["standard", "exception"]


@app.post("/api/pending-precedents")
def save_pending(body: PendingBody, user: str = Depends(get_user), conn=Depends(get_conn)):
    c = load_visible(conn, body.contractId, user)
    require_approver(conn, c, user)
    f = next((x for x in c["findings"] if x["id"] == body.findingId), None)
    if not f:
        raise HTTPException(404, "Finding not found")
    if f["decision"] not in ("accepted", "modified"):
        raise HTTPException(409, "Accept or edit the finding before saving its outcome")
    key = f"{c['id']}/{f['id']}"
    if any(p["key"] == key and p["status"] in ("pending", "approved") for p in db.list_json(conn, "pending_precedents")):
        raise HTTPException(409, "This outcome is already saved")
    item = {
        "id": f"PP-{uuid.uuid4().hex[:6]}", "key": f"{c['id']}/{f['id']}", "clauseType": f["category"], "counterparty": c["counterparty"],
        "contract": c["name"], "outcome": (f.get("editedFallback") or f.get("suggestedFallback") or {}).get("text") or f["clauseTitle"],
        "label": body.label, "by": user, "at": db.stamp(), "status": "pending",
    }
    db.put_json(conn, "pending_precedents", item)
    db.add_audit(conn, user, "Outcome saved as pending precedent", f"{item['key']} as {body.label}, awaiting KD approval")
    return item


def _kd_only(user: str) -> None:
    if user != "kd":
        raise HTTPException(403, "Only Karandeep can approve what the assistant learns")


@app.post("/api/pending-precedents/{pid}/approve")
def approve_pending(pid: str, user: str = Depends(get_user), conn=Depends(get_conn)):
    _kd_only(user)
    p = db.get_json(conn, "pending_precedents", pid)
    if not p:
        raise HTTPException(404, "Not found")
    if p["status"] != "pending":
        raise HTTPException(409, "This outcome was already approved")
    p["status"] = "approved"
    db.put_json(conn, "pending_precedents", p)
    db.put_json(conn, "precedents", {
        "id": f"P-{100 + len(db.list_json(conn, 'precedents'))}", "clauseType": p["clauseType"], "counterparty": p["counterparty"],
        "contract": p["contract"], "date": db.today(), "asked": "see review", "outcome": p["outcome"], "label": p["label"],
        "context": f"Saved from a review by {USERS[p['by']]['name']}, approved by Karandeep",
    })
    db.add_audit(conn, user, "Precedent approved", f"{pid}: now used in future reviews")
    return db.list_json(conn, "pending_precedents")


@app.post("/api/pending-precedents/{pid}/discard")
def discard_pending(pid: str, user: str = Depends(get_user), conn=Depends(get_conn)):
    _kd_only(user)
    db.delete_json(conn, "pending_precedents", pid)
    db.add_audit(conn, user, "Precedent discarded", pid)
    return db.list_json(conn, "pending_precedents")


# ----------------------------- demo -----------------------------

@app.post("/api/admin/reset")
def reset(user: str = Depends(get_user)):
    if user != "kd":
        raise HTTPException(403, "Only Karandeep can reset the demo")
    db.reset()
    shutil.rmtree(db.UPLOAD_DIR, ignore_errors=True)
    db.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    return {"ok": True}

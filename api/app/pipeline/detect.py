"""Detects document type, AtliQ's side of the table, who is who (the defined party labels),
the AtliQ entity named, governing law and forum, and how the document presents itself.
Each guess carries a confidence so the UI can ask a person to confirm when unsure (HAX G10)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..rules import entity_key_for_name

DOC_TYPES = [
    ("Waiver", r"waiver|consent letter"),
    ("BAA", r"business associate agreement"),
    ("NDA", r"non-?disclosure|confidentiality agreement|\bnda\b"),
    ("SOW", r"statement of work|\bsow\b"),
    ("DPA", r"data processing (agreement|addendum)"),
    ("Subcontractor", r"subcontractor"),
    ("Contractor", r"independent contractor|contractor agreement|freelance"),
    ("Partnership", r"partnership agreement|partner agreement|referral agreement"),
    ("Pilot", r"pilot"),
    ("MSA", r"master (professional )?services? agre\w+|\bmsa\b"),  # tolerant of OCR ("AGREERNENT")
    ("Services", r"services agreement|service agreement|software development"),
]

DOC_TITLES = {
    "NDA": "Non-Disclosure Agreement", "SOW": "Statement of Work", "DPA": "Data Processing Agreement",
    "BAA": "Business Associate Agreement", "MSA": "Master Services Agreement", "Partnership": "Partnership Agreement",
    "Services": "Services Agreement", "Subcontractor": "Subcontractor Agreement", "Contractor": "Contractor Agreement",
    "Pilot": "Pilot Agreement", "Waiver": "Waiver Letter",
}

GENERIC_LABELS = {
    "agreement", "effective date", "services", "purpose", "msa", "sow", "initial sow", "parent", "upstream baa", "baa",
    "baa effective date", "party", "parties", "travelhub app", "seaside", "seaside sow", "disclosing party",
    "receiving party", "deliverables", "work product", "confidential information", "intercompany agreement", "engagement",
    "engagement services", "territory", "platform", "term", "proposed transaction", "representatives", "client data",
}

NOT_A_PARTY = re.compile(r"\b(IP|Tools?|Materials?|Fees?|Indemni\w*|GST|App|Data|Date|Account)\b", re.I)
LABEL = re.compile(r'(?:\(\s*(?:the\s+)?|hereinafter\s+)["“]\**([A-Z][A-Za-z ]{1,30}?)\**["”]\s*\)?')
LAW = re.compile(
    r"(?:governed by|construed in accordance with)(?: and construed in accordance with)?\s+(?:the\s+)?laws?"
    r"(?:\s+and regulations in force)?\s+(?:of|in)\s+(?:the\s+)?(.+?)(?=,|\.|;|\(| without| except| excluding| and the| and applicable|$)",
    re.I,
)
FORUM = re.compile(
    r"(courts?\s+(?:of|at|in|located in)\s+(?:the\s+)?[A-Z][A-Za-z ,]+?(?=\s+shall|\.|,|;| for )|"
    r"\b(?:SIAC|LCIA|ICC|DIFC)\b[^.]{0,40}|arbitration[^.]{0,60}?seated in [A-Z][A-Za-z]+|seat of (?:the )?arbitration shall be [A-Z][A-Za-z]+)",
)


@dataclass
class Detected:
    doc_type: str
    role: str
    entity_key: str | None
    entity_raw: str | None
    governing_law: str | None
    forum: str | None
    presented_as: str | None
    confidence: float
    atliq_labels: list[str] = field(default_factory=list)
    other_labels: list[str] = field(default_factory=list)
    paper: str = "counterparty"
    invoicing_key: str | None = None
    title: str = ""


def _labels(head: str) -> tuple[list[str], list[str]]:
    """Defined terms for AtliQ vs the counterparty, from the parties block.
    A label belongs to AtliQ when the text since the previous label mentions AtliQ."""
    atliq, other = [], []
    prev = 0
    for m in LABEL.finditer(head):
        lab = m.group(1).strip()
        seg = head[prev:m.start()]
        prev = m.end()
        if lab.lower() in GENERIC_LABELS or NOT_A_PARTY.search(lab):
            continue
        if lab.lower() == "atliq" or re.search(r"atliq", seg, re.I):
            if lab not in atliq:
                atliq.append(lab)
        elif lab not in other:
            other.append(lab)
    # Templates where AtliQ is "the Company" and the other side "the Contractor"/"Vendor".
    if "AtliQ" not in atliq:
        atliq.append("AtliQ")
    return atliq, [o for o in other if o not in atliq]


def detect(text: str, provenance: str | None = None, hint: dict | None = None) -> Detected:
    hint = hint or {}
    # Drop the dataset's provenance line ("*(Client draft received … AtliQ has not yet marked up)*")
    # and undo common OCR digit/letter swaps ("TECHN0LOGIES", "0RBIT") — for detection only.
    text = re.sub(r"^\s*\*\(.+?\)\*\s*", "", text, flags=re.S)  # may wrap over lines in PDFs
    text = re.sub(r"(?<=[A-Za-z])0(?=[A-Za-z])|\b0(?=[A-Z]{2})", "O", text)
    lines = [ln for ln in text.splitlines() if ln.strip()]
    # Markdown title if there is one; otherwise (PDF, Word, plain text) the first short line near
    # the top that names a document type, e.g. "MUTUAL NON-DISCLOSURE AGREEMENT".
    title_line = next((ln for ln in lines if ln.lstrip().startswith("# ")), None) or next(
        (ln for ln in lines[:6] if len(ln) <= 100 and any(re.search(pat, ln, re.I) for _, pat in DOC_TYPES)),
        lines[1] if len(lines) > 1 else "",
    )
    title = re.sub(r"[#*]", "", title_line).strip()
    head = "\n".join(lines[:60])
    full_l = text.lower()

    doc_type, conf = "Services", 0.6
    for src, c in ((title.lower(), 0.95), (head.lower(), 0.8)):
        hit = next((t for t, pat in DOC_TYPES if re.search(pat, src)), None)
        if hit:
            doc_type, conf = hit, c
            break
    if hint.get("doc_type"):
        ht = hint["doc_type"].lower()
        expected = next((t for t, pat in DOC_TYPES if re.search(pat, ht)), None)
        if expected and expected != doc_type:
            conf = min(conf, 0.7)  # tracker and document disagree — ask a person (HAX G10)

    prov = (provenance or "").lower()
    paper = "atliq" if ("atliq draft" in prov or "atliq's own" in prov or "our own" in prov) else "counterparty"

    if doc_type in ("Subcontractor", "Contractor") or (paper == "atliq" and re.search(r"\bvendor\b|\bcontractor\b", head, re.I) and doc_type != "NDA"):
        role = "Buyer"
    elif doc_type == "Partnership":
        role = "Partner"
    elif doc_type == "NDA":
        role = "NDA party"
    else:
        role = "Supplier"

    # Named AtliQ entity: the one in the parties block wins.
    em = re.search(r"\bATLIQ\s+(INC\b\.?|TECHNOLOGIES\s+(?:PVT\.?\s+LTD|PRIVATE\s+LIMITED))|\bAtliQ\s+(Inc\b\.?|Technologies\s+(?:Pvt\.?\s+Ltd|Private\s+Limited))", head)
    entity_raw = em.group(0) if em else None
    entity_key = entity_key_for_name(entity_raw)
    inv = re.search(r"invoices?[^.]{0,40}?(?:raised|issued)\s+by\s+(AtliQ[^,.;(]+)", text, re.I)
    invoicing_key = entity_key_for_name(inv.group(1)) if inv else None

    lm = LAW.search(text)
    law = re.sub(r"^(State|Republic|Federal Republic|Kingdom|Emirate|Sultanate) of\s+", "", lm.group(1).strip()) if lm else None
    if law and "dubai international financial centre" in law.lower():
        law = "DIFC (Dubai International Financial Centre)"
    fm = FORUM.search(text)
    forum = re.sub(r"\s+", " ", re.sub(r"[\"“”*()]", " ", fm.group(0))).strip() if fm else None

    presented = None
    if re.search(r"\bmutual\b", title, re.I):
        presented = f"Mutual {doc_type}"
    elif re.search(r"standard (form|template|terms)|our standard", prov + " " + head.lower()):
        presented = "Standard form"

    atliq_labels, other_labels = _labels(head)
    if "atliq" not in full_l:
        conf = min(conf, 0.6)
    return Detected(doc_type, role, entity_key, entity_raw, law, forum, presented, conf, atliq_labels, other_labels, paper, invoicing_key, title)

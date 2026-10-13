"""Deterministic clause checks — the default analyzer when no AI key is set.

Built from Karandeep's checklist (Dataset/karandeep_contract_checklist.md), AtliQ's negotiation
history (negotiation_notes.md) and the issues found in the capstone drafts. Each check reads one
clause, works out *who* bears it from the document's defined party labels ("Contractor", "Vendor",
"Recipient"…), and returns a finding with a verbatim quote (so it always passes citation checks),
the factors behind the grade (HAX G11), a recommended action and, where AtliQ has precedent, draft
wording. Commercial terms are graded against AtliQ's own past positions, never a fixed "policy".

When AtliQ is the *buyer* (its own vendor/contractor paper), terms that are one-sided in AtliQ's
favour are flagged too: "I don't want our paper to be the thing I hate receiving" (Karandeep,
PixelCraft, Oct 2025; checklist note, Sep 2026).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

from ..company import INSURANCE, PAYMENT_MAX_DAYS, US_STATES
from ..rules import law_is_ours
from .segment import Clause

MUTUAL = re.compile(r"\b(either party|each party|neither party|both parties|the parties|mutual(ly)?)\b", re.I)
CAP = re.compile(r"shall not (?:in (?:the )?aggregate )?exceed|capped at|maximum (?:aggregate )?|not exceed\b", re.I)
WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "ten": 10, "twelve": 12, "fifteen": 15,
         "thirty": 30, "forty-five": 45, "sixty": 60, "ninety": 90, "twenty-four": 24, "forty-eight": 48}


@dataclass
class Draft:
    section: str
    clauseTitle: str
    category: str
    severity: str
    whyItMatters: str
    quote: str
    page: int
    confidence: float
    recommendedAction: str
    drivers: list[str]
    precedentQuery: str = ""
    fallback: dict | None = None
    brand: str | None = None
    abstained: bool = False
    abstentionReason: str | None = None
    injection: bool = False
    extra: dict = field(default_factory=dict)


@dataclass
class Ctx:
    role: str  # Supplier | Buyer | Partner | NDA party
    doc_type: str
    atliq: list[str]  # defined labels that mean AtliQ
    other: list[str]  # defined labels that mean the counterparty
    counterparty: str
    country: str
    entity_key: str | None
    governing_law: str | None
    full: str  # full text, lower-case
    groups: dict[str, str]  # clause-group number → combined text (e.g. "11" → 11.1 + 11.2 + …)
    related_phi: bool = False  # a sibling document in the same deal involves PHI
    presented_as: str | None = None


# ----------------------------------------------------------------------------- helpers

def sentence(text: str, pattern: re.Pattern | str) -> str:
    """The sentence containing the match, verbatim (trimmed to ~420 chars)."""
    pat = re.compile(pattern, re.I) if isinstance(pattern, str) else pattern
    flat = " ".join(text.split())
    for s in re.split(r"(?<=[.;])\s+(?=[A-Z(])", flat):
        if pat.search(s):
            return s if len(s) <= 420 else s[:417].rsplit(" ", 1)[0] + "…"
    return flat[:300]


def num(s: str) -> int | None:
    s = s.lower().strip("() ")
    return int(s) if s.isdigit() else WORDS.get(s)


def days_in(text: str) -> list[int]:
    out = []
    for m in re.finditer(r"(?:(\w+(?:-\w+)?)\s*\((\d+)\)|(\d+))\s*(?:calendar |business |working )?days", text, re.I):
        n = int(m.group(2) or m.group(3))
        out.append(n)
    return out


def money(text: str) -> list[int]:
    out = [int(x.replace(",", "")) for x in re.findall(r"\$\s?([\d,]{5,})", text)]
    out += [int(x.replace(",", "")) for x in re.findall(r"USD\s?([\d,]{5,})", text)]
    if re.search(r"\bfive million\b", text, re.I):
        out.append(5_000_000)
    return out


def side(text: str, ctx: Ctx) -> str | None:
    """Who is the grammatical subject of a clause: 'atliq', 'other' or None.
    Uses the earliest defined label in the text ("Contractor shall …", "the Company shall …")."""
    best: tuple[int, str] | None = None
    for labels, who in ((ctx.atliq, "atliq"), (ctx.other, "other")):
        for lab in labels:
            m = re.search(rf"\b{re.escape(lab)}\b", text, re.I)
            if m and (best is None or m.start() < best[0]):
                best = (m.start(), who)
    return best[1] if best else None


def mentions(text: str, labels: list[str]) -> bool:
    return any(re.search(rf"\b{re.escape(lab)}\b", text, re.I) for lab in labels)


def group_of(c: Clause, ctx: Ctx) -> str:
    return ctx.groups.get(c.section.split(".")[0], c.text)


def _d(c: Clause, title: str, **kw) -> Draft:
    return Draft(section=c.section, page=c.page, clauseTitle=f"{c.title.split(' - ')[0]} - {title}", **kw)


FAIR = "One-sided in AtliQ's favour"
FAIR_WHY = (" AtliQ is the buyer here, and this is the kind of term Karandeep rejects when a client sends it, "
            "'I don't want our paper to be the thing I hate receiving' (PixelCraft, Oct 2025).")

Check = Callable[[Clause, Ctx], list[Draft]]


# ----------------------------------------------------------------------------- checks

def delay_damages(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    out: list[Draft] = []
    if re.search(r"in addition to and not in lieu of[^.]*actual damages", t, re.I):
        who = side(t, ctx) or "atliq"
        out.append(_d(c, "delay damages on top of actual damages", category="Liquidated damages / delay penalties",
                      severity="high", whyItMatters="Liquidated damages are meant to be the agreed price of delay. Here the client can claim them and its actual losses as well, so the 'cap' on delay exposure disappears."
                      + (FAIR_WHY if ctx.role == "Buyer" and who == "atliq" else ""),
                      quote=sentence(t, r"in addition to"), confidence=0.9, recommendedAction="negotiate",
                      drivers=["Not the sole remedy"] + ([FAIR] if ctx.role == "Buyer" else []), precedentQuery="liquidated damages"))
    m = re.search(r"liquidated damages|delay penalt|service credit|for each (?:calendar )?(?:day|week)[^.]{0,40}delay|per (?:calendar )?(?:day|week)", t, re.I)
    if not m or not re.search(r"(\d+(?:\.\d+)?)\s*%|per cent|percent", t, re.I):
        # A clause in the delay section that excuses delay only for force majeure.
        if re.search(r"not be liable for delay", t, re.I) and not re.search(r"caused by (?:the )?(?:client|company|customer|" + "|".join(map(re.escape, ctx.other)) + r")", t, re.I):
            out.append(_d(c, "no relief for delay the client causes", category="Liquidated damages / delay penalties", severity="high",
                          whyItMatters="Delay is excused only for force majeure. Nothing excuses AtliQ when the client itself is late with access or data, exactly what happened with Brightwater (warehouse access 19 days late; $18,400 claim).",
                          quote=sentence(t, r"not be liable for delay"), confidence=0.85, recommendedAction="negotiate",
                          drivers=["No client-delay exclusion", "Brightwater pattern"], precedentQuery="liquidated damages",
                          fallback={"text": "No liquidated damages shall accrue for any delay caused by the Client, its personnel or third parties under its control, or by a change request.",
                                    "basis": "Acme / Northwind / Trustline MSAs", "label": "standard"}))
        return out
    # A cap or "sole remedy" clause in the delay section is judged as part of the group, not alone.
    if CAP.search(t) and not re.search(r"for each|per (?:calendar )?(?:day|week)|each (?:calendar )?(?:day|week)", t, re.I):
        return out
    # Who pays: the subject of the sentence that sets the damages, not of the clause's preamble.
    payer = side(sentence(t, r"\d+(?:\.\d+)?\s*%"), ctx) or side(t, ctx) or "atliq"
    grp = group_of(c, ctx)
    on_total = bool(re.search(r"(?:total )?contract value|total fees|total contract|of the fees payable under this agreement", t, re.I)) and not re.search(r"milestone fee", t, re.I)
    daily = bool(re.search(r"each (?:calendar )?day|per day|each day or part", t, re.I))
    capped = bool(CAP.search(grp))
    client_excl = bool(re.search(r"caused by (?:the )?(?:client|company|customer|" + "|".join(map(re.escape, ctx.other + ctx.atliq)) + r")|attributable to|client delay|customer delay", grp, re.I))
    pct = re.search(r"(\d+(?:\.\d+)?)\s*%", t)
    p = float(pct.group(1)) if pct else 0
    drivers = []
    if on_total:
        drivers.append("On total contract value")
    if daily:
        drivers.append("Daily accrual")
    if not capped:
        drivers.append("Uncapped")
    if not client_excl:
        drivers.append("No client-delay exclusion")
    standard = not on_total and not daily and capped and client_excl and p <= 1
    if standard:
        return out
    sev = "high" if (not capped or daily or (on_total and p >= 1)) else "medium"
    fair = ctx.role == "Buyer" and payer == "other"
    if payer == "other" and not fair:
        return out
    if fair:
        drivers.append(FAIR)
    out.append(_d(c, "delay damages" + (" on the vendor" if fair else ""), category="Liquidated damages / delay penalties", severity=sev,
                  whyItMatters=("Karandeep's checklist: 'LDs → cap it. never open ended.' AtliQ's standard (Acme, Northwind, Trustline) is 0.5% of the affected milestone fee per week, capped at 5% of that milestone, with no LDs for client-caused delay. "
                                + ("This one runs daily on the whole contract value. " if daily and on_total else "")
                                + ("The 10% cap matches Al Noor's, which Karandeep approved as 'a strategic exception for Al Noor only, not our new standard'." if capped and on_total else ""))
                  + (FAIR_WHY if fair else ""),
                  quote=sentence(t, m.re if pct is None else r"\d+(?:\.\d+)?\s*%"), confidence=0.9, recommendedAction="negotiate",
                  drivers=drivers, precedentQuery="liquidated damages",
                  fallback={"text": "Liquidated damages of 0.5% of the Milestone Fee of the delayed Milestone for each complete week of delay attributable to the Supplier, capped at 5% of that Milestone Fee, as the sole remedy for delay; none for delay caused by the Client.",
                            "basis": "Acme Retail MSA (Mar 2025); Trustline MSA (Aug 2026)", "label": "standard"}))
    return out


def liability(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    out: list[Draft] = []
    unl = re.search(r"nothing in this agreement shall limit or exclude ([\w\s']+?)'s liability|not (?:be )?subject to any limitation or (?:exclusion of liability|cap)|without limitation for all damages|unlimited liability", t, re.I)
    if unl:
        who = side(unl.group(1), ctx) if unl.lastindex and unl.group(1) else side(t, ctx)
        who = who or "atliq"
        if who == "atliq" or ctx.role == "Buyer":
            fair = who == "other"
            out.append(_d(c, "unlimited liability" + (" for the vendor" if fair else ""), category="Liability caps and carve-outs", severity="high",
                          whyItMatters=("Checklist: 'liability → 1x fees. NOT unlimited.' AtliQ walked away from Kessler Mobility over exactly this: "
                                        "'Unlimited liability on a €120k deal means one bad incident … and the company is gone.'") + (FAIR_WHY if fair else ""),
                          quote=sentence(t, unl.re), confidence=0.93, recommendedAction="negotiate",
                          drivers=["Unlimited"] + ([FAIR] if fair else ["Kessler walk-away line"]), precedentQuery="liability",
                          fallback={"text": "Each party's aggregate liability shall not exceed the fees paid or payable under this Agreement in the twelve (12) months preceding the claim, save for fraud and wilful misconduct.",
                                    "basis": "PayTrack MSA (1x fees); Kessler offer", "label": "standard"}))
    tiny = re.search(r"([A-Z][A-Za-z]+)'S TOTAL AGGREGATE LIABILITY[\s\S]{0,220}?(TEN THOUSAND|\$\s?10,000|USD 10,000)", t)
    if tiny and side(tiny.group(1), ctx) == "other":
        out.append(_d(c, "their liability capped at $10,000", category="Liability caps and carve-outs", severity="high",
                      whyItMatters="The counterparty's total liability is capped at USD 10,000 while AtliQ's is not limited at all: a one-way cap.",
                      quote=sentence(t, r"SHALL NOT EXCEED"), confidence=0.9, recommendedAction="negotiate", drivers=["Asymmetric caps"], precedentQuery="liability"))
    carve = re.search(r"save in respect of liability arising from[^.]*(data protection|confidentiality)", t, re.I)
    if carve:
        out.append(_d(c, "data-protection liability uncapped", category="Liability caps and carve-outs", severity="medium",
                      whyItMatters="The 1x-fees cap is fine, but breaches of confidentiality and data protection sit outside it, the area with the largest possible losses.",
                      quote=sentence(t, r"save in respect of"), confidence=0.85, recommendedAction="negotiate", drivers=["Carve-out for data breaches"], precedentQuery="liability"))
    if ctx.role == "Buyer":
        own = re.search(r"(?:the )?(company|atliq)'s liability[^.]{0,40}shall not exceed", t, re.I)
        if own and not re.search(rf"({'|'.join(map(re.escape, ctx.other))})'s (?:aggregate |total )?liability[^.]{{0,80}}(?:shall not exceed|limited)", ctx.full, re.I) and not re.search(r"each party's (?:aggregate |total )?liability", ctx.full, re.I):
            out.append(_d(c, "AtliQ capped, the other side not", category="Liability caps and carve-outs", severity="high",
                          whyItMatters="AtliQ's liability to the individual is capped at a few months' fees, while theirs to AtliQ has no cap at all." + FAIR_WHY,
                          quote=sentence(t, r"shall not exceed"), confidence=0.85, recommendedAction="negotiate", drivers=["Asymmetric caps", FAIR], precedentQuery="liability",
                          fallback={"text": "Each party's aggregate liability under this Agreement shall not exceed the fees paid or payable in the twelve (12) months preceding the claim.",
                                    "basis": "PixelCraft vendor agreement (Oct 2025)", "label": "standard"}))
    return out


def indemnity(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    if not re.search(r"indemnif", t, re.I):
        return []
    who = side(t, ctx) or "atliq"
    neg = re.search(r"negligence of (?:any |the )?[\w\s]*indemnit|caused in whole or in part by the negligence", t, re.I)
    uncapped = re.search(r"not be subject to any limitation or cap|shall not be subject to any limitation|all losses, costs and expenses", t, re.I)
    reciprocal = any(re.search(rf"\b{re.escape(lab)}\b[^.]{{0,40}}shall (?:defend, )?indemnif", ctx.full, re.I) for lab in (ctx.other if who == "atliq" else ctx.atliq))
    if not (neg or (uncapped and not reciprocal)):
        return []
    fair = ctx.role == "Buyer" and who == "other"
    if who == "other" and not fair:
        return []
    drivers = (["Covers their own negligence"] if neg else []) + (["Uncapped"] if uncapped else []) + ([] if reciprocal else ["One-way"]) + ([FAIR] if fair else [])
    return [_d(c, "indemnity" + (" covering the indemnitee's own negligence" if neg else ", one-way and uncapped"), category="Indemnity", severity="high",
               whyItMatters=("Checklist: 'indemnity → mutual. we don't cover their mistakes.' "
                             + ("AtliQ would indemnify losses even where the other side's own negligence caused them: the PayTrack clause Karandeep refused: 'we can't insure against PayTrack's own negligence.' " if neg else "")
                             + ("Only AtliQ indemnifies, with no cap." if uncapped and not reciprocal else "")) + (FAIR_WHY if fair else ""),
               quote=sentence(t, neg.re if neg else r"indemnif"), confidence=0.9, recommendedAction="negotiate", drivers=drivers, precedentQuery="indemnity",
               fallback={"text": "Each party shall indemnify the other against third-party claims to the extent caused by its own breach, negligence or wilful misconduct, subject to the limitation of liability.",
                         "basis": "PayTrack MSA (Jan 2025)", "label": "standard"})]


def payment(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    out: list[Draft] = []
    if re.search(r"conditional upon[^.]*receipt of payment|pay[- ]when[- ]paid|after [\w ]*receives? (?:the corresponding )?payment from", t, re.I):
        payer = side(t, ctx) or "atliq"
        fair = ctx.role == "Buyer" and payer == "atliq"
        quarter = re.search(r"end of the calendar quarter", t, re.I)
        out.append(_d(c, "paid only when the end client pays" + (" (pay-when-paid)" if fair else ""), category="Payment terms", severity="high",
                      whyItMatters=(f"Checklist: 'payment → 30 days, 45 max.' " + ("Payment waits for the other side's own customer to pay" + (", then another quarter-end plus 60 days" if quarter else "") + ".")) + (FAIR_WHY + " Kriti (12 people) is already pushing back on this." if fair else ""),
                      quote=sentence(t, r"conditional|receives? (?:the corresponding )?payment|quarter"), confidence=0.9, recommendedAction="negotiate",
                      drivers=["Pay-when-paid"] + ([FAIR] if fair else []), precedentQuery="payment terms",
                      fallback={"text": "Undisputed invoices are payable within thirty (30) days of receipt, regardless of payment by any end client.",
                                "basis": "PixelCraft vendor agreement (Oct 2025)", "label": "standard"}))
        return out
    if re.search(r"set off against any amount[^.]*any other agreement", t, re.I):
        out.append(_d(c, "set-off across all agreements", category="Payment terms", severity="medium",
                      whyItMatters="The client may deduct anything it claims under any other agreement from what it owes here, so disputes elsewhere stop cash on this deal.",
                      quote=sentence(t, r"set off"), confidence=0.85, recommendedAction="negotiate", drivers=["Cross-agreement set-off"]))
    if not re.search(r"\bpa(?:y|id|yment)\b", t, re.I):
        return out
    ds = [d for d in days_in(t) if 15 <= d <= 180]
    if not ds:
        return out
    d = max(ds)
    # On AtliQ's own buyer paper AtliQ is the one paying; on client paper the client pays.
    payer = "atliq" if ctx.role == "Buyer" else "other" if ctx.role in ("Supplier", "NDA party") else (side(t, ctx) or "other")
    if payer == "atliq" and ctx.role != "Buyer":
        return out
    fair = ctx.role == "Buyer" and payer == "atliq"
    if d <= PAYMENT_MAX_DAYS:
        return out
    discretion = bool(re.search(r"approval|approved", t, re.I) and re.search(r"discretion", group_of(c, ctx), re.I))
    sev = "high" if (d >= 90 or fair) else "medium"
    out.append(_d(c, f"{d} days to pay", category="Payment terms", severity=sev,
                  whyItMatters=f"Checklist: 'payment → 30 days, 45 max.' AtliQ got Trustline down from 90 to 45 days in Aug 2026." + (" The clock starts only after an approval that is at AtliQ's discretion." if discretion else "") + (FAIR_WHY if fair else ""),
                  quote=sentence(t, r"\(\d+\)\s*days|\d+\s*days"), confidence=0.9, recommendedAction="negotiate",
                  drivers=[f"{d}-day terms"] + (["Discretionary approval"] if discretion else []) + ([FAIR] if fair else []), precedentQuery="payment terms",
                  fallback={"text": "Undisputed invoices are payable within thirty (30) days of receipt.", "basis": "Trustline MSA (45 days, Aug 2026); checklist (30 days)", "label": "standard"}))
    return out


def termination(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    out: list[Draft] = []
    if re.search(r"may not terminate this agreement for convenience", t, re.I) and side(t, ctx) == "atliq":
        out.append(_d(c, "AtliQ can't exit for convenience", category="Termination and payment for work performed", severity="high",
                      whyItMatters="Only the counterparty can walk away. CloudSpan accepted a mutual 90-day termination for convenience, which is AtliQ's position on partnerships.",
                      quote=sentence(t, r"may not terminate"), confidence=0.9, recommendedAction="negotiate", drivers=["One-way exit"], precedentQuery="termination",
                      fallback={"text": "Either Party may terminate this Agreement for convenience on ninety (90) days' written notice.", "basis": "CloudSpan partnership (Sep 2025)", "label": "standard"}))
    conv = re.search(r"terminat\w*[^.]{0,80}for convenience|for any reason or no reason", t, re.I)
    nopay = re.search(r"no obligation to pay for work in progress|performed and accepted up to|sole obligation shall be to pay[^.]*accepted", t, re.I)
    if conv and nopay:
        who = side(t, ctx) or "other"
        fair = ctx.role == "Buyer" and who == "atliq"
        if who == "other" or fair:
            hard = bool(re.search(r"no obligation to pay for work in progress", t, re.I))
            out.append(_d(c, "work in progress unpaid on termination", category="Termination and payment for work performed", severity="high" if hard else "medium",
                          whyItMatters="Checklist: 'termination → they pay for work done.' Here only accepted work is paid; anything in progress is lost." + (FAIR_WHY if fair else ""),
                          quote=sentence(t, nopay.re), confidence=0.88, recommendedAction="negotiate",
                          drivers=["Work in progress unpaid"] + ([FAIR] if fair else []), precedentQuery="termination",
                          fallback={"text": "On termination for convenience the Client shall pay for all Services performed up to the effective date of termination and any non-cancellable costs.",
                                    "basis": "Al Noor MSA 6.4; BlueOrchid pilot 6.3", "label": "standard"}))
    hours = re.search(r"terminate[^.]*?(\w+(?:-\w+)?)\s*\((\d+)\)\s*hours", t, re.I)
    if hours and ctx.role == "Buyer" and side(t, ctx) == "atliq":
        out.append(_d(c, f"{hours.group(2)}-hour termination", category="Termination and payment for work performed", severity="medium",
                      whyItMatters="AtliQ can end the engagement on a day's notice while the individual must give far longer notice." + FAIR_WHY,
                      quote=sentence(t, r"hours"), confidence=0.85, recommendedAction="negotiate", drivers=["Asymmetric notice", FAIR]))
    return out


def acceptance_refund(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    if not re.search(r"reject the deliverable and receive a refund of all fees", t, re.I):
        return []
    fair = ctx.role == "Buyer"
    return [_d(c, "rejection with a refund of everything paid", category="Termination and payment for work performed", severity="medium",
               whyItMatters="The client can reject a deliverable and claw back all fees paid for it, with no deemed acceptance." + (FAIR_WHY if fair else ""),
               quote=sentence(t, r"refund"), confidence=0.8, recommendedAction="negotiate", drivers=["Refund of all fees"] + ([FAIR] if fair else []))]


def ip(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    out: list[Draft] = []
    if ctx.role == "Supplier" and re.search(r"pre-existing materials?[^.]{0,220}(?:assign|vest)|(?:assign|vest)[^.]{0,160}pre-existing materials?", t, re.I) and not re.search(r"(?:supplier|atliq|service provider|contractor|vendor) (?:shall )?retains?", t, re.I):
        out.append(_d(c, "AtliQ's pre-existing tools assigned to the client", category="IP ownership and reuse", severity="high",
                      whyItMatters="Checklist: 'IP → client owns what we build for them, we keep our own stuff.' This hands over AtliQ's pre-existing materials too, the same wording that cost AtliQ PipeKit at Northwind.",
                      quote=sentence(t, r"pre-existing"), confidence=0.88, recommendedAction="negotiate", drivers=["Pre-existing IP assigned", "Northwind/PipeKit precedent"], precedentQuery="IP",
                      fallback={"text": "Supplier retains ownership of its pre-existing tools, libraries and know-how and grants the Client a perpetual, non-exclusive, royalty-free licence to use them as incorporated in the Deliverables.",
                                "basis": "PayTrack MSA 8.2; Sunrise MSA 10.2", "label": "standard"},
                      extra={"question": ("CTO", "Which AtliQ accelerators would be incorporated in the deliverables? They would be assigned to the client under this clause.")}))
    keep = re.search(r"\b(\w+) shall retain all right, title and interest[^.]*(outputs|deliverables|work product)", t, re.I)
    if keep and side(keep.group(1), ctx) == "other":
        out.append(_d(c, "the vendor keeps the outputs AtliQ pays for", category="IP ownership and reuse", severity="high",
                      whyItMatters="The deliverables themselves stay with the vendor; AtliQ only gets a project-limited licence. AtliQ can't pass ownership on to its own client.",
                      quote=sentence(t, r"retain"), confidence=0.88, recommendedAction="negotiate", drivers=["Outputs not assigned"]))
    if ctx.role == "Buyer" and re.search(r"(?:shall )?vest in the company upon creation|vest in (?:the company|atliq) on creation", t, re.I) and not re.search(r"pre-existing|contractor tools|retains? ownership", group_of(c, ctx) + ctx.full[:0], re.I):
        out.append(_d(c, "no carve-out for the contractor's own tools", category="IP ownership and reuse", severity="medium",
                      whyItMatters="Everything the contractor creates vests in AtliQ, with no exception for tools they bring with them. AtliQ keeps its own pre-existing IP with clients; Rohan Iyer kept his visuals library." + FAIR_WHY,
                      quote=sentence(t, r"vest"), confidence=0.75, recommendedAction="negotiate", drivers=["No pre-existing carve-out", FAIR]))
    lic = re.search(r"perpetual, irrevocable[^.]*right to use[^.]*(\b[A-Z][A-Za-z]+Kit\b|accelerator|tool)", c.text)
    if lic and re.search(r"sub-?licen", t, re.I):
        out.append(_d(c, "perpetual, sub-licensable licence to AtliQ's tool", category="IP ownership and reuse", severity="medium",
                      whyItMatters="The client may modify AtliQ's accelerator and sub-license it to affiliates and other service providers, for ever.",
                      quote=sentence(t, r"perpetual"), confidence=0.8, recommendedAction="negotiate", drivers=["Perpetual", "Sub-licensable"]))
    return out


def nda_terms(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    out: list[Draft] = []
    oneway = re.search(r'"?confidential information"? means[^.]*disclosed or made available by or on behalf of the (\w+) to the (\w+)', t, re.I)
    if oneway and side(oneway.group(1), ctx) == "other":
        out.append(_d(c, "only the other side's information is protected", category="Confidentiality / NDA mutuality", severity="high",
                      whyItMatters=(f"Presented as '{ctx.presented_as}', but only information flowing to AtliQ is confidential; AtliQ's own architecture and pricing get no protection. "
                                    if ctx.presented_as else "Only information flowing to AtliQ is protected. ")
                      + "Checklist: 'NDAs → just sign if mutual', and GlobalMart: 'We only sign mutual; we'll be sharing our architecture too.'",
                      quote=sentence(t, r"by or on behalf of"), confidence=0.9, recommendedAction="negotiate",
                      drivers=["One-way definition"] + (["Labelled mutual"] if ctx.presented_as else []), precedentQuery="NDA mutuality",
                      fallback={"text": "\"Confidential Information\" means all information disclosed by either Party (the \"Disclosing Party\") to the other Party (the \"Receiving Party\") in connection with the Purpose.",
                                "basis": "GlobalMart NDA (Mar 2026)", "label": "standard"}))
    if re.search(r"residual", t, re.I) and not MUTUAL.search(t):
        who = side(t, ctx)
        if who == "other":
            out.append(_d(c, "one-way residuals", category="Confidentiality / NDA mutuality", severity="high",
                          whyItMatters="The other side may freely reuse whatever its staff remember of AtliQ's information, for any purpose. AtliQ gets no such right.",
                          quote=sentence(t, r"residual"), confidence=0.88, recommendedAction="negotiate", drivers=["One-way", "Any purpose"], precedentQuery="NDA mutuality"))
    nc = re.search(r"shall not[^.]{0,160}(?:provide|perform)[^.]{0,80}(?:services?)[^.]{0,120}(?:competitor|in competition with)", t, re.I)
    if nc:
        who = side(t, ctx) or "atliq"
        fair = ctx.role == "Buyer" and who == "other"
        if who == "atliq" or fair:
            world = bool(re.search(r"anywhere in the world|worldwide", t, re.I))
            out.append(_d(c, "non-compete" + (" on the contractor" if fair else ""), category="Non-compete / exclusivity", severity="high",
                          whyItMatters=("AtliQ would be barred from serving the other side's competitors, checked against AtliQ's existing clients below. " if not fair else
                                        ("A worldwide 12-month non-compete on an individual, likely unenforceable and the opposite of the balanced terms AtliQ wants." + FAIR_WHY)),
                          quote=sentence(t, nc.re), confidence=0.88, recommendedAction="negotiate",
                          drivers=(["Worldwide"] if world else []) + ["Post-term"] + ([FAIR] if fair else []), precedentQuery="non-compete",
                          extra={"competitor_restriction": who == "atliq"}))
    ns = re.search(r"(?:solicit|hire|engage|employ)[^.]{0,60}(?:employee|consultant|personnel|staff)|solicit or accept work", t, re.I)
    if ns and not MUTUAL.search(t) and re.search(r"\bshall not\b", t, re.I):
        who = side(t, ctx) or "atliq"
        fair = ctx.role == "Buyer" and who == "other"
        if who == "atliq" or fair:
            out.append(_d(c, "one-way non-solicit" + (" / no-hire" if re.search(r"hire|employ", t, re.I) else ""), category="Confidentiality / NDA mutuality", severity="medium",
                          whyItMatters="Only one side is restricted. AtliQ's usual non-solicits (PayTrack, Acme, Al Noor) are mutual and limited to staff on the engagement." + (FAIR_WHY if fair else ""),
                          quote=sentence(t, ns.re), confidence=0.82, recommendedAction="negotiate", drivers=["One-way"] + ([FAIR] if fair else [])))
    if re.search(r"continue in perpetuity|survive[^.]*perpetual|in perpetuity", t, re.I) and side(t, ctx) in ("atliq", None):
        out.append(_d(c, "confidentiality forever", category="Confidentiality / NDA mutuality", severity="medium",
                      whyItMatters="Obligations never end. AtliQ's signed NDAs run 3–5 years after expiry (trade secrets aside).",
                      quote=sentence(t, r"perpetu"), confidence=0.8, recommendedAction="negotiate", drivers=["Perpetual"]))
    hrs = re.search(r"within (\w+(?:-\w+)?)\s*\((\d+)\)\s*hours", t, re.I)
    if hrs and re.search(r"breach|incident|privacy event", t, re.I):
        h = int(hrs.group(2))
        deemed = bool(re.search(r"deemed discovered|reasonable diligence would have been known", t, re.I))
        if h < 24 or deemed:
            out.append(_d(c, f"{h}-hour breach notice" + (" from deemed discovery" if deemed else ""), category="Data protection / BAA / DPA dependencies",
                          severity="high" if deemed else "medium",
                          whyItMatters=("The clock starts when AtliQ 'should have known', not when it knew." if deemed else f"{h} hours is tighter than AtliQ's other commitments (24 hours at PayTrack; 6 hours at Trustline is the exception).")
                          + (" PHI is already sitting with the Pune engineers, so this would be triggered on signature." if deemed and ctx.related_phi else ""),
                          quote=sentence(t, r"hours"), confidence=0.82, recommendedAction="negotiate", drivers=[f"{h}h notice"] + (["Deemed discovery"] if deemed else [])))
    return out


def data_location(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    out: list[Draft] = []
    if re.search(r"outside the united states", t, re.I) and re.search(r"\bphi\b|protected health|personal data|data", t, re.I) and re.search(r"shall not|no phi", t, re.I):
        out.append(_d(c, "no data access from outside the US", category="Data protection / BAA / DPA dependencies", severity="high",
                      whyItMatters="AtliQ Inc delivers through the Pune team (intercompany agreement). A US-only rule, including remote access, means the delivery model has to change before signing. CareBridge allowed de-identified data offshore; this may not.",
                      quote=sentence(t, r"outside the united states"), confidence=0.88, recommendedAction="seek-internal-confirmation",
                      drivers=["US-only", "Pune delivery model"], precedentQuery="BAA",
                      extra={"question": ("CTO", "Can this engagement be delivered entirely by US-based staff with no remote access from Pune?")}))
    if re.search(r"organized under the laws of a state of the united states", t, re.I):
        out.append(_d(c, "subcontractors must be US companies", category="Data protection / BAA / DPA dependencies", severity="high",
                      whyItMatters="AtliQ Technologies Pvt Ltd (Pune) can never qualify, so the usual intercompany subcontract is impossible; any US contractor needs written approval and a flow-down BAA first.",
                      quote=sentence(t, r"organized under"), confidence=0.88, recommendedAction="escalate-to-counsel", drivers=["Pvt Ltd excluded"]))
    if re.search(r"shall not subcontract", t, re.I) and ctx.entity_key == "inc" and ctx.role == "Supplier":
        out.append(_d(c, "subcontracting needs the client's consent", category="Entity and signing-party mismatch", severity="high",
                      whyItMatters="AtliQ Inc sub-contracts all delivery to AtliQ Technologies Pvt Ltd under the intercompany agreement (atliq_entities.md). Without consent written into the contract, the normal delivery model is a breach.",
                      quote=sentence(t, r"subcontract"), confidence=0.85, recommendedAction="negotiate", drivers=["Inc delivers via Pvt Ltd"]))
    if re.search(r"(?:forty-eight|\(48\))\s*(?:\(48\)\s*)?hours'? notice", t, re.I) and re.search(r"audit|inspect", t, re.I):
        out.append(_d(c, "audit on 48 hours' notice", category="Data protection / BAA / DPA dependencies", severity="medium",
                      whyItMatters="On-site audit of AtliQ and its subcontractors at two days' notice, for as long as any data is held.",
                      quote=sentence(t, r"hours"), confidence=0.8, recommendedAction="negotiate", drivers=["48h notice"]))
    if re.search(r"may assign this agreement to an affiliate", t, re.I) and ctx.related_phi and side(sentence(t, r"may assign this agreement to an affiliate"), ctx) == "atliq":
        out.append(_d(c, "work could move to the offshore affiliate", category="Data protection / BAA / DPA dependencies", severity="medium",
                      whyItMatters="AtliQ may assign to an Affiliate, including the Pune entity, which must never see this client's PHI.",
                      quote=sentence(t, r"affiliate"), confidence=0.75, recommendedAction="negotiate", drivers=["Offshore affiliate"]))
    return out


def insurance(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    if not re.search(r"insurance|liability of \$|cyber", t, re.I):
        return []
    gaps = []
    for kind, pat in (("cyber", r"cyber[^.;]{0,160}?(?:\$\s?([\d,]{7,})|five million)"), ("professional", r"(?:professional liability|errors and omissions)[^.;]{0,80}?\$\s?([\d,]{7,})")):
        m = re.search(pat, t, re.I)
        if m:
            amt = 5_000_000 if m.group(0).lower().find("five million") >= 0 and not (m.lastindex and m.group(1)) else int((m.group(1) or "0").replace(",", ""))
            if amt > INSURANCE[kind]:
                gaps.append(f"{kind} ${amt / 1e6:g}M required vs ${INSURANCE[kind] / 1e6:g}M held")
    if not gaps:
        return []
    return [_d(c, "insurance AtliQ doesn't hold", category="Insurance", severity="high",
               whyItMatters="Required cover exceeds what AtliQ carries (" + "; ".join(gaps) + "). Buying it takes time and money; signing without it is an immediate breach.",
               quote=sentence(t, r"\$|million"), confidence=0.9, recommendedAction="seek-internal-confirmation", drivers=gaps,
               extra={"question": ("Finance", "Can AtliQ obtain the required insurance (" + "; ".join(gaps) + ") before signing, and at what cost?")})]


def entity_template(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    out: list[Draft] = []
    inv = re.search(r"invoices?[^.]{0,40}(?:raised|issued) by (AtliQ [^,.;(]+)", t, re.I)
    if inv:
        from ..rules import entity_key_for_name

        k = entity_key_for_name(inv.group(1))
        if k and ctx.entity_key and k != ctx.entity_key:
            out.append(_d(c, "invoicing entity differs from the contracting entity", category="Entity and signing-party mismatch", severity="high",
                          whyItMatters="The contract is with one AtliQ entity but invoices come from the other. Finance: entity mismatches delayed payment twice in 2025. A UAE client should contract with AtliQ Technologies Pvt Ltd throughout.",
                          quote=sentence(t, r"invoice"), confidence=0.92, recommendedAction="seek-internal-confirmation", drivers=["Contract ≠ invoice entity"]))
    from ..company import is_us

    if is_us(ctx.country) and ctx.role == "Buyer" and re.search(r"\bPAN\b|\bGSTIN\b|section 194J|TDS", t) and c.section in ("Preamble", "Parties", "1", "1.1"):
        out.append(_d(c, "India template used for a US individual", category="Entity and signing-party mismatch", severity="high",
                      whyItMatters="Asks a US resident for an Indian PAN, applies Indian TDS/GST and stamp duty, pays in rupees and names the Pune company. A US contractor should be engaged by AtliQ Inc on the US template (W-9/1099).",
                      quote=sentence(t, r"PAN|GSTIN"), confidence=0.9, recommendedAction="reject", drivers=["Wrong template", "Wrong entity"]))
    if ctx.role == "Buyer" and re.search(r"devote his professional working time exclusively|shall not[^.]{0,80}provide services to[^.]{0,40}any other person", t, re.I):
        out.append(_d(c, "exclusivity on an independent contractor", category="Non-compete / exclusivity", severity="high",
                      whyItMatters="Requiring a contractor to work only for AtliQ (with timesheets and policies) makes them look like an employee, a misclassification risk under US law." + FAIR_WHY,
                      quote=sentence(t, r"exclusively|any other person"), confidence=0.85, recommendedAction="negotiate", drivers=["Misclassification risk", FAIR]))
    return out


def law_forum(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    out: list[Draft] = []
    if re.search(r"governed by|construed in accordance with", t, re.I) and ctx.governing_law and not law_is_ours(ctx.entity_key or "pvt", ctx.governing_law):
        law = ctx.governing_law
        if law.lower() in t.lower() or re.search(r"laws? of", t, re.I):
            out.append(_d(c, f"{law} law", category="Governing law / dispute resolution", severity="medium",
                          whyItMatters="Checklist: 'gov law → ours (India for Pvt Ltd, US for Inc).' AtliQ has accepted foreign law before (DIFC for Al Noor, English law for Northwind), each as a one-off, and Northwind's IP was only skimmed.",
                          quote=sentence(t, r"governed|construed"), confidence=0.9, recommendedAction="negotiate", drivers=["Not AtliQ's law"], precedentQuery="governing law"))
    if re.search(r"arabic text shall prevail|(?:arabic|german|local) (?:version|text) shall prevail", t, re.I):
        out.append(_d(c, "the Arabic text prevails", category="Governing law / dispute resolution", severity="medium",
                      whyItMatters="AtliQ reviews and negotiates the English text, but the Arabic version wins any inconsistency: a translation nobody at AtliQ can check.",
                      quote=sentence(t, r"prevail"), confidence=0.85, recommendedAction="negotiate", drivers=["Unreviewed controlling text"]))
    return out


def partnership(c: Clause, ctx: Ctx) -> list[Draft]:
    if ctx.role != "Partner":
        return []
    t = c.text
    out: list[Draft] = []
    if re.search(r"shall not[^.]{0,80}(?:solicit|market to|provide)[^.]{0,120}account", t, re.I):
        out.append(_d(c, "can't serve their accounts on any other platform for years", category="Non-compete / exclusivity", severity="high",
                      whyItMatters="AtliQ and its Affiliates could not provide any data-platform services to a registered account on another platform, during the term and for 24 months after. That blocks CloudSpan work for the same clients.",
                      quote=sentence(t, r"shall not"), confidence=0.88, recommendedAction="negotiate", drivers=["Post-term restriction", "Binds Affiliates"]))
    if re.search(r"existing client[^.]*shall become a[^.]*account", t, re.I):
        out.append(_d(c, "AtliQ's existing clients become their accounts", category="Non-compete / exclusivity", severity="high",
                      whyItMatters="Proposing the platform to an existing AtliQ client turns that client into the partner's protected account, triggering the restriction above on AtliQ's own relationships.",
                      quote=sentence(t, r"existing client"), confidence=0.86, recommendedAction="negotiate", drivers=["Captures existing clients"]))
    share = re.search(r"(\d+)%\)?\s*to (\w+)", t)
    if share and re.search(r"services fees|partner services", t, re.I) and int(share.group(1)) >= 70 and side(share.group(2), ctx) == "other":
        out.append(_d(c, f"{share.group(1)}% of joint revenue, including AtliQ's services", category="Most-favoured-customer / pricing promises", severity="high",
                      whyItMatters="The split applies even when AtliQ's own services are most of the deal, so AtliQ would hand over most of its services revenue.",
                      quote=sentence(t, r"%"), confidence=0.85, recommendedAction="negotiate", drivers=["Takes services revenue"]))
    if re.search(r"obligations of partner hereunder shall bind partner's affiliates|shall bind (?:its|partner's) affiliates", t, re.I):
        out.append(_d(c, "binds AtliQ Inc too", category="Non-compete / exclusivity", severity="medium",
                      whyItMatters="All obligations extend to AtliQ's Affiliates, so AtliQ Inc's US business would be bound as well.",
                      quote=sentence(t, r"affiliates"), confidence=0.8, recommendedAction="negotiate", drivers=["Binds Affiliates"]))
    return out


def rates_fixed(c: Clause, ctx: Ctx) -> list[Draft]:
    t = c.text
    m = re.search(r"rates?[^.]{0,120}(?:remain fixed|fixed for)[^.]{0,40}\((\d+)\)\s*months", t, re.I)
    if not m:
        return []
    return [_d(c, f"rates locked for {m.group(1)} months", category="Most-favoured-customer / pricing promises", severity="medium",
               whyItMatters="Today's rate card can't move for two years and applies to all future SOWs, so any discount given now is locked in (and visible to Crestline's pricing audit).",
               quote=sentence(t, r"fixed"), confidence=0.8, recommendedAction="negotiate", drivers=["Long rate lock"])]


INJECTION = re.compile(
    r"ignore (?:all |any )?(?:prior|previous|above|earlier) instructions|disregard [^.]{0,30}instructions|"
    r"(?:summari[sz]e|rate|mark|classify) this (?:agreement|contract|document) as (?:low risk|standard|safe)|you are an? (?:ai|language model|assistant)",
    re.I,
)


def injection(c: Clause, ctx: Ctx) -> list[Draft]:
    m = INJECTION.search(c.text)
    if not m:
        return []
    return [_d(c, "hidden instruction aimed at the AI", category="Embedded instructions (prompt injection)", severity="high",
               whyItMatters="The document contains text addressed to automated review. It was treated as data and ignored.",
               quote=sentence(c.text, INJECTION), confidence=0.97, recommendedAction="escalate-to-counsel", drivers=["Text aimed at AI"], injection=True)]


CHECKS: list[Check] = [injection, delay_damages, liability, indemnity, payment, termination, acceptance_refund, ip, nda_terms,
                       data_location, insurance, entity_template, law_forum, partnership, rates_fixed]

PERSONAL_DATA = re.compile(r"personal data|personal information|technician names|employee names|\bnames\b|free-text notes|patient", re.I)
PHI = re.compile(r"\bphi\b|protected health information|electronic health record|patient|medical record", re.I)
DPA = re.compile(r"data processing agreement|\bdpa\b|gdpr|article 28|standard contractual clauses|business associate|hipaa", re.I)


def document_checks(clauses: list[Clause], ctx: Ctx) -> list[Draft]:
    """Checks about what is *missing* from the whole document."""
    out: list[Draft] = []
    readable = [c for c in clauses if c.readable]
    if not readable:
        return out
    phi_clause = next((c for c in readable if PHI.search(c.text)), None)
    if ctx.role == "Buyer" and (phi_clause or ctx.related_phi) and not re.search(r"business associate|hipaa|\bbaa\b", ctx.full):
        c = phi_clause or readable[0]
        out.append(_d(c, "no BAA / HIPAA flow-down for patient data", category="Data protection / BAA / DPA dependencies", severity="high",
                      whyItMatters="This engagement touches a US healthcare client's PHI, but the agreement has no Business Associate terms. The client's BAA requires every subcontractor to accept the same restrictions in writing, and to be approved, before any access to PHI.",
                      quote=sentence(c.text, PHI) if phi_clause else sentence(c.text, r"."), confidence=0.85, recommendedAction="escalate-to-counsel",
                      drivers=["PHI without BAA", "Client approval needed"], precedentQuery="BAA"))
    if ctx.doc_type == "NDA" and ctx.related_phi and not PHI.search(ctx.full):
        c = readable[0] if readable[0].section != "Preamble" or len(readable) == 1 else readable[1]
        out.append(_d(c, "an NDA can't carry patient data", category="Data protection / BAA / DPA dependencies", severity="high",
                      whyItMatters="This NDA is for someone who will work on a US healthcare client's PHI. It says nothing about PHI, and an NDA is no substitute for a subcontractor BAA (the client's own NDA bars PHI before a BAA).",
                      quote=sentence(c.text, r"."), confidence=0.75, recommendedAction="escalate-to-counsel", drivers=["NDA ≠ BAA"]))
    pd_clause = next((c for c in readable if PERSONAL_DATA.search(c.text)), None)
    if ctx.role == "Buyer" and pd_clause and not DPA.search(ctx.full) and not phi_clause:
        out.append(_d(pd_clause, "personal data with no data-processing terms", category="Data protection / BAA / DPA dependencies", severity="high",
                      whyItMatters="The vendor will process records containing personal data on its own platform, but there is no DPA, GDPR or security clause. AtliQ's own client contract will require these terms to flow down.",
                      quote=sentence(pd_clause.text, PERSONAL_DATA), confidence=0.8, recommendedAction="negotiate", drivers=["No DPA", "Flow-down missing"]))
    return out


def analyse(clauses: list[Clause], ctx: Ctx) -> list[Draft]:
    out: list[Draft] = []
    for c in clauses:
        if not c.readable:
            continue
        for check in CHECKS:
            found = check(c, ctx)
            out.extend(found)
            if any(d.injection for d in found):
                break  # don't grade text addressed to the AI
    out.extend(document_checks(clauses, ctx))
    return out

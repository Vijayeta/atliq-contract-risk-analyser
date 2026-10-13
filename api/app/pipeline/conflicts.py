"""Cross-contract conflict check: compares a draft with what AtliQ has already promised
(the obligation register, api/dataset/register.json) and with its live client relationships.

Obligation status (live / expired / superseded / waived-in-part) is computed against the as-of
date from the register's own dates — never guessed by the model (PRD FR-7). Each hit cites both
the new clause and the prior obligation; live conflicts can't be auto-cleared.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..company import AS_OF, fmt_day, parse_day
from .rules_engine import Ctx, Draft, sentence
from .segment import Clause

GCC = ["gcc", "gulf cooperation council", "united arab emirates", "uae", "dubai", "abu dhabi", "sharjah", "saudi", "ksa", "riyadh",
       "jeddah", "qatar", "doha", "kuwait", "bahrain", "manama", "oman", "muscat"]
INDIA = ["india", "indian", "mumbai", "bengaluru", "bangalore", "delhi", "hyderabad", "chennai"]
# AtliQ's own address lines mention India; ignore them when looking for where the work relates to.
ATLIQ_ADDRESS = re.compile(r"baner|pune 411045|cin u72900|gstin|atliq technologies", re.I)

ROLE_ALIASES = {
    "senior data engineer": ["senior data engineer", "sr data engineer", "sr. data engineer"],
    "data engineer": ["data engineer"],
    "bi developer": ["bi developer", "bi dev", "business intelligence developer"],
}


@dataclass
class Hit:
    obligation: dict
    clause: Clause
    quote: str
    explanation: str
    severity: str
    extra_findings: list[Draft] = field(default_factory=list)


def status_of(o: dict, today=AS_OF) -> str:
    end = parse_day(o.get("expires"))
    if o.get("statusOverride") == "superseded":
        return "superseded"
    if end and end < today:
        return "expired"
    return "active"


def relies_on(o: dict) -> str:
    s = status_of(o)
    if s == "expired":
        return f"Expired {fmt_day(parse_day(o['expires']))}; {o['sourceContract']} cl. {o['clause']}"
    if o.get("statusOverride") == "waived-in-part":
        return f"Live until {fmt_day(parse_day(o['expires']))}; waived only for {', '.join(o['match'].get('waivedFor', []))}; {o['sourceContract']} cl. {o['clause']}"
    end = parse_day(o.get("expires"))
    return f"Live until {fmt_day(end) if end else o['expires']}; {o['sourceContract']} cl. {o['clause']}"


def _terms(text: str, words: list[str]) -> set[str]:
    low = text.lower()
    return {w for w in words if re.search(rf"\b{re.escape(w)}\b", low)}


def _work_lines(c: Clause) -> str:
    return "\n".join(ln for ln in c.text.splitlines() if not ATLIQ_ADDRESS.search(ln))


def _region_words(regions: list[str]) -> list[str]:
    out: list[str] = []
    for r in regions:
        out += GCC if r == "GCC" else INDIA if r == "India" else [r.lower()]
    return out


def find(clauses: list[Clause], ctx: Ctx, register: list[dict], clients: list[dict]) -> list[Hit]:
    readable = [c for c in clauses if c.readable]
    hits: list[Hit] = []
    for o in register:
        m = o.get("match")
        if not m:
            continue
        kind = m["kind"]

        if kind in ("non-compete", "exclusivity"):
            if kind == "exclusivity" and m.get("requiresPartnerRole") and ctx.role != "Partner":
                continue
            if any(w.lower() in ctx.counterparty.lower() for w in m.get("waivedFor", [])):
                continue
            topic = m.get("sectors") or m.get("platforms") or []
            regions = _region_words(m["regions"])
            best, score = None, 0
            for c in readable:
                body = _work_lines(c)
                s, r = _terms(body, topic), _terms(body, regions)
                # Prefer the clause that describes the work over the parties block or recitals.
                bonus = 0 if c.section in ("Preamble", "Recitals") or c.title.lower().startswith(("parties", "preamble")) else 10
                if s and r and len(s) + len(r) + bonus > score:
                    best, score = c, len(s) + len(r) + bonus
            if not best:
                # Sector words in one clause, place names in another (e.g. a property schedule).
                doc_s = {w for c in readable for w in _terms(_work_lines(c), topic)}
                place = next((c for c in readable if _terms(_work_lines(c), regions) and c.section != "Preamble"), None)
                if len(doc_s) >= 2 and place:
                    best = place
            if not best:
                continue
            live = status_of(o) == "active"
            what = "provide analytics/AI/revenue-management services to a hospitality business in the GCC" if kind == "non-compete" and "hotel" in topic else \
                   "act as implementation or referral partner for a competing data platform in India or the GCC" if kind == "exclusivity" else "do this work"
            aff = " It binds AtliQ's Affiliates, so contracting through AtliQ Inc does not avoid it." if m.get("affiliates") and ctx.entity_key == "inc" else \
                  " It binds AtliQ and all its Affiliates." if m.get("affiliates") else ""
            exp = (f"This deal would have AtliQ {what}, which {o['counterparty']} cl. {o['clause']} forbids until {fmt_day(parse_day(o['expires']))}.{aff}"
                   + (" The only waiver granted (Seaside Hotels) is limited to its express terms, a new written consent would be needed." if o.get("statusOverride") == "waived-in-part" else "")
                   if live else f"Would have overlapped {o['counterparty']}'s {o['clauseType'].lower()}, but it expired on {fmt_day(parse_day(o['expires']))}. Shown for context only.")
            hit = Hit(o, best, sentence(best.text, r"|".join(re.escape(w) for w in (topic + regions))), exp, "high" if live else "low")
            if live:
                warranty = next((c for c in readable if re.search(r"not bound by any (?:agreement or )?restriction", c.text, re.I)), None)
                if warranty:
                    hit.extra_findings.append(Draft(
                        section=warranty.section, page=warranty.page, clauseTitle=f"{warranty.title} - warranty would be false on signature",
                        category="Non-compete / exclusivity", severity="high",
                        whyItMatters=f"AtliQ would warrant it isn't bound by any restriction that prevents this work, but {o['counterparty']} cl. {o['clause']} does exactly that until {fmt_day(parse_day(o['expires']))}.",
                        quote=sentence(warranty.text, r"not bound by"), confidence=0.9, recommendedAction="escalate-to-counsel",
                        drivers=["Conflicts with a live non-compete"]))
            hits.append(hit)

        elif kind == "mfn":
            rate_clause, lower = None, []
            for c in readable:
                low = c.text.lower()
                for role, protected in m["rates"].items():
                    for alias in ROLE_ALIASES.get(role, [role]):
                        for mm in re.finditer(rf"{re.escape(alias)}[^$\n]{{0,40}}\$\s?(\d{{2,3}})", low):
                            if role == "data engineer" and re.search(r"senior|sr\.?\s*$", low[max(0, mm.start() - 8):mm.start()]):
                                continue
                            rate = int(mm.group(1))
                            if rate < protected:
                                lower.append(f"{role.title()} ${rate}/hr vs ${protected}")
                                rate_clause = rate_clause or c
                            break
            if rate_clause and status_of(o) == "active":
                lower = list(dict.fromkeys(lower))
                exp = (f"Crestline's MFN (cl. {o['clause']}, live until {fmt_day(parse_day(o['expires']))}) requires its rates to stay no lower than any other customer's, "
                       f"including AtliQ's Affiliates' customers. These rates are lower ({'; '.join(lower)}), so they would apply to Crestline retroactively, and Crestline can audit pricing yearly (cl. 6.5).")
                hit = Hit(o, rate_clause, sentence(rate_clause.text, r"\$"), exp, "high")
                hit.extra_findings.append(Draft(
                    section=rate_clause.section, page=rate_clause.page, clauseTitle=f"{rate_clause.title} - rates trigger Crestline's best-price promise",
                    category="Most-favoured-customer / pricing promises", severity="high", whyItMatters=exp,
                    quote=sentence(rate_clause.text, r"\$"), confidence=0.9, recommendedAction="seek-internal-confirmation",
                    drivers=lower + ["Crestline MFN live", "Retroactive credit"], precedentQuery="MFN",
                    extra={"question": ("Finance", "Either keep Lakeshore at or above Crestline's rates, or estimate the retroactive credit owed to Crestline under its MSA §6.4.")}))
                hits.append(hit)

        elif kind == "ip-assigned":
            for tool in m["tools"]:
                warr = next((c for c in readable if tool.lower() in c.text.lower() and re.search(r"sole owner|warrants?", c.text, re.I)), None)
                use = warr or next((c for c in readable if tool.lower() in c.text.lower()), None)
                if not use:
                    continue
                exp = (f"{o['counterparty']} cl. {o['clause']} vested IP in everything delivered, including pre-existing tools incorporated in it. "
                       f"{tool} was incorporated in Northwind SOW-1, so AtliQ may no longer be its sole owner. Reusing it 'like we did for Northwind' is the risk itself.")
                hit = Hit(o, use, sentence(use.text, re.escape(tool)), exp, "high")
                if warr:
                    hit.extra_findings.append(Draft(
                        section=warr.section, page=warr.page, clauseTitle=f"{warr.title.split(' - ')[0]} - warrants sole ownership of {tool}",
                        category="IP ownership and reuse", severity="high",
                        whyItMatters=exp + " The warranty (and the indemnity that usually follows it) could be false on signature.",
                        quote=sentence(warr.text, r"sole owner|warrant"), confidence=0.9, recommendedAction="escalate-to-counsel",
                        drivers=[f"{tool} assigned to Northwind", "Ownership warranty"], precedentQuery="IP",
                        extra={"question": ("CTO", f"What exactly is in the {tool} version AtliQ would use here: anything delivered to Northwind, or only code written since?")}))
                hits.append(hit)

        elif kind == "no-phi-before-baa":
            if m["counterparty"].lower() not in ctx.full and m["counterparty"].lower() not in ctx.counterparty.lower():
                continue
            if not (re.search(r"\bphi\b|protected health|health record|patient", ctx.full) or ctx.related_phi):
                continue
            c = next((c for c in readable if re.search(r"\bphi\b|protected health|health record", c.text, re.I)), readable[0])
            exp = ("The signed Harrington NDA (cl. 2.3, live) bars any PHI before a BAA. The 12 Sep 'sample extract' contained real PHI and was forwarded to the Pune engineers "
                   "(meeting notes, 27 Sep): a privacy incident that predates this contract. Resolve with counsel before signing anything that starts the BAA's 24-hour clock.")
            hits.append(Hit(o, c, sentence(c.text, r"phi|health|patient|."), exp, "high"))

    # A new non-compete on AtliQ that would cover clients it already serves.
    comp = re.search(r'"?competitor"? means ([^.]+)', ctx.full)
    restricts = re.search(r"shall not[^.]{0,160}(?:provide|perform)[^.]{0,80}services?[^.]{0,120}competitor", ctx.full)
    if comp and restricts:
        defn = comp.group(1)
        clause = next((c for c in readable if re.search(r"competitor", c.text, re.I) and re.search(r"shall not", c.text, re.I)), readable[0])
        for cl in clients:
            if parse_day(cl["until"]) and parse_day(cl["until"]) < AS_OF:
                continue
            if any(re.search(rf"\b{re.escape(s)}", defn) for s in cl["sector"]) and (cl["region"].lower() in defn or cl["region"] == "India" and "india" in defn):
                o = {"id": f"client:{cl['name']}", "clauseType": "Live client relationship", "counterparty": cl["name"], "sourceContract": f"{cl['name']} agreement",
                     "clause": "-", "effective": "", "expires": cl["until"], "summary": f"Active {', '.join(cl['sector'][:2])} client until {fmt_day(parse_day(cl['until']))}.",
                     "quote": f"Signed contract on file ({cl['source']}).", "sourceFile": cl["source"]}
                exp = (f"The non-compete would stop AtliQ serving any '{defn.strip()[:90]}…', and {cl['name']} is exactly that: a live client until "
                       f"{fmt_day(parse_day(cl['until']))}. Signing this would put existing work in breach.")
                hits.append(Hit(o, clause, sentence(clause.text, r"competitor"), exp, "high"))
    return hits

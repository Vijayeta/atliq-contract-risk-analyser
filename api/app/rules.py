"""Deterministic entity / jurisdiction rules (PRD §6: rules cover entity, jurisdiction and
document completeness only — never commercial terms).

Source: Dataset/atliq_entities.md — AtliQ operates through two entities only:
  EM-01  US clients            → AtliQ Inc (Delaware)           law: a US state
  EM-02  every other country   → AtliQ Technologies Pvt Ltd     law: India
"""
from __future__ import annotations

from .company import ENTITIES, US_STATES, entity_for_country

CURRENT_RULES = "rules-v3.0"
PROMPT_VERSION = "p-2026.10.08"


def entity_key_for_name(named: str | None) -> str | None:
    if not named:
        return None
    low = named.lower()
    for key in ("inc", "pvt"):  # check Inc first: "AtliQ Inc" contains no Pvt alias
        if any(a in low for a in ENTITIES[key]["aliases"]):
            return key
    return None


def law_is_ours(entity_key: str, law: str | None) -> bool:
    if not law:
        return True
    low = law.lower()
    if entity_key == "pvt":
        return "india" in low
    return any(s in low for s in US_STATES) or "united states" in low


def entity_check(country: str, named_key: str | None, governing_law: str | None, invoicing_key: str | None = None) -> dict:
    """Returns an EntityCheck dict in the frontend's shape."""
    expected = entity_for_country(country)
    rid = "EM-01" if expected == "inc" else "EM-02"
    named_display = ENTITIES[named_key]["name"] if named_key else "No AtliQ entity found in the document"
    law = governing_law or "Not stated"
    entity_ok = named_key == expected
    invoice_ok = invoicing_key is None or invoicing_key == named_key
    ok = entity_ok and invoice_ok

    if not named_key:
        note = f"The document doesn't name an AtliQ entity. Rule {rid}: a {country} counterparty contracts with {ENTITIES[expected]['name']}."
    elif not entity_ok:
        note = (
            f"Rule {rid} (atliq_entities.md): {ENTITIES[expected]['serves'].lower()} contract with {ENTITIES[expected]['name']}. "
            f"This document names {named_display}. The named entity decides who invoices, the tax regime and the bank account, "
            "mismatches delayed payment twice in 2025. Ready-to-sign is blocked until this is fixed."
        )
    elif not invoice_ok:
        note = (
            f"The document names {named_display} as the contracting party but says invoices are raised by {ENTITIES[invoicing_key]['name']}. "
            "Contracting and invoicing entity must match (finance note, atliq_entities.md)."
        )
    else:
        note = f"Correct entity under rule {rid}."
    if not law_is_ours(named_key or expected, governing_law):
        note += f" Governing law is {law}, not {'India' if (named_key or expected) == 'pvt' else 'a US state'}. See the governing-law finding."
    return {
        "namedEntity": named_display,
        "expectedEntity": ENTITIES[expected]["name"],
        "clientLocation": country,
        "governingLaw": law,
        "invoicingConsistent": invoice_ok,
        "signatoryValid": entity_ok,
        "status": "pass" if ok else "fail",
        "rule": f"{rid} · {CURRENT_RULES}",
        "note": note,
    }

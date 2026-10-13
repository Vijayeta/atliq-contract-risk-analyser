import json
from pathlib import Path

import pytest

from app.company import AS_OF
from app.dataset import build
from app.eval import evaluate
from app.pipeline.conflicts import status_of
from app.pipeline.detect import detect
from app.pipeline.parse import Page, parse_file, provenance, read_text
from app.pipeline.segment import segment
from app.pipeline.verify import quote_supported
from app.rules import entity_check

from conftest import DATASET, INCOMING, SIGNED

ALL = sorted(INCOMING.glob("*.md")) + sorted(SIGNED.glob("*.md"))
REGISTER = {o["id"]: o for o in json.loads((Path(__file__).resolve().parents[1] / "dataset" / "register.json").read_text(encoding="utf-8"))["obligations"]}


@pytest.mark.parametrize("path", ALL, ids=lambda p: p.stem[:40])
def test_every_file_segments_completely(path):
    clauses = segment(parse_file(path))
    readable = [c for c in clauses if c.readable]
    assert len(readable) >= (5 if "waiver" in path.name else 10)
    assert all(len(c.text.strip()) >= 10 for c in readable), "no empty clauses"
    assert not [c for c in clauses if not c.readable], "dataset files are all readable text"


def test_clause_numbers_match_the_documents():
    secs = {c.section for c in segment(parse_file(INCOMING / "2026-09-10_harrington_health_msa_draft.md"))}
    assert {"4.3", "9.1", "10.3", "11.2", "13.1"} <= secs
    secs = {c.section for c in segment(parse_file(INCOMING / "2026-09-23_rheinwerk_analytics_services_agreement_draft.md"))}
    assert "6.3" in secs  # "## § 6 …" headings with dotted subclauses
    secs = {c.section for c in segment(parse_file(SIGNED / "2022-07-01_orbit_travels_msa_scanned.md"))}
    assert "6.1" in secs  # OCR'd scan with page markers


@pytest.mark.parametrize("name,doc,role,entity", [
    ("2026-09-15_travelhub_services_agreement_draft.md", "Services", "Supplier", "inc"),
    ("2026-09-26_kriti_data_labs_subcontractor_agreement_draft.md", "Subcontractor", "Buyer", "pvt"),
    ("2026-09-24_datavane_strategic_partnership_agreement_draft.md", "Partnership", "Partner", "pvt"),
    ("2026-09-25_finserve_capital_mutual_nda_draft.md", "NDA", "NDA party", "pvt"),
])
def test_detection(name, doc, role, entity):
    t = read_text(INCOMING / name)
    d = detect(t, provenance(t))
    assert (d.doc_type, d.role, d.entity_key) == (doc, role, entity)


def test_two_entity_rule():
    assert entity_check("UAE", "inc", "Dubai")["status"] == "fail"  # TravelHub named AtliQ Inc
    assert entity_check("Saudi Arabia", "pvt", "Saudi Arabia")["status"] == "pass"  # Gulf Crown: right entity…
    assert entity_check("USA", "inc", "Texas")["status"] == "pass"
    assert entity_check("UAE", "inc", "Dubai", invoicing_key="pvt")["invoicingConsistent"] is False


def test_obligation_status_as_of_28_sep_2026():
    assert str(AS_OF) == "2026-09-28"
    assert status_of(REGISTER["OB-01"]) == "expired"  # Orbit non-compete ended 30 Jun 2025
    assert status_of(REGISTER["OB-33"]) == "active"  # CareBridge BAA runs to 5 Oct 2026
    assert status_of(REGISTER["OB-15"]) == "active"  # Al Noor non-compete to 14 Sep 2029


def test_verifier_drops_fabricated_quote():
    clauses = segment([Page(1, "## 4. PAYMENT\n4.3 Client shall pay each undisputed invoice within ninety (90) days after receipt.")])
    assert quote_supported("Client shall pay each undisputed invoice within ninety (90) days after receipt.", clauses, "4.3")
    assert not quote_supported("Client shall pay each undisputed invoice within thirty (30) days after receipt.", clauses, "4.3")


def test_eval_meets_launch_targets():
    """PRD §12-style gates on the 15 capstone drafts (the rules were tuned on these — not a held-out set)."""
    seed = build()
    res = evaluate(seed, json.loads((Path(__file__).resolve().parents[1] / "eval" / "expected.json").read_text(encoding="utf-8")))
    assert res["highRecall"] >= 0.85
    assert res["conflictRecall"] == 1.0
    assert res["entityAccuracy"] == 1.0
    assert res["cleanCorrect"] == "2/2"


def test_key_cross_contract_conflicts():
    seed = {c["id"]: c for c in build()["contracts"]}
    live = lambda cid: {x["prior"]["obligationId"] for x in seed[cid]["conflicts"] if x["prior"]["status"] == "active"}  # noqa: E731
    assert "OB-15" in live("C-025")  # Gulf Crown vs Al Noor non-compete
    assert "OB-03" in live("C-026")  # Lakeshore rates vs Crestline MFN
    assert "OB-30" in live("C-035")  # Datavane vs CloudSpan exclusivity
    assert "OB-26" in live("C-028")  # Rheinwerk vs PipeKit assigned to Northwind
    assert not live("C-038") and not live("C-029")  # LoopMart, Sunrise SOW-2 are clean
    assert DATASET.exists()


def test_claude_section_labels_resolve_to_real_clauses():
    from app.pipeline.llm_engine import resolve_section

    known = ["Preamble", "1.2", "4.1", "4.12", "12", "Sch A"]
    assert resolve_section("8.1] Non-compete", known + ["8.1"]) == "8.1"  # echoed the clause-list line
    assert resolve_section("Preamble] Preamble", known) == "Preamble"
    assert resolve_section("[4.1]", known) == "4.1"
    assert resolve_section("4.1(b)", known) == "4.1"  # sub-clause the segmenter doesn't split
    assert resolve_section("4.12", known) == "4.12"  # not swallowed by "4.1"
    assert resolve_section("sch a", known) == "Sch A"
    assert resolve_section("Annex Z", known) == "Annex Z"  # unknown labels pass through unchanged

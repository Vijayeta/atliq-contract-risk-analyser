import json
from datetime import date, timedelta

from app import db

from conftest import INCOMING, as_user


def soon(days: int = 30) -> str:
    """A delegation expiry inside the one-year limit, in the app's date format."""
    return (date.today() + timedelta(days=days)).strftime("%d %b %Y")


def test_seed_loads_the_dataset(client):
    seed = json.loads(db.SEED_PATH.read_text(encoding="utf-8"))
    r = client.get("/api/bootstrap", headers=as_user("kd")).json()
    assert len(r["contracts"]) == 32 and r["hidden"] == 0
    assert r["asOf"] == "28 Sep 2026"
    assert len(r["obligations"]) == len(seed["obligations"])
    assert r["dataQuality"], "tracker problems are surfaced"
    assert [c["id"] for c in r["contracts"]] == [c["id"] for c in seed["contracts"]]


def test_rbac_hides_and_forbids(client):
    r = client.get("/api/bootstrap", headers=as_user("bhavin")).json()
    ids = {c["id"] for c in r["contracts"]}
    assert "C-023" not in ids and r["hidden"] > 0  # Harrington is Dhaval's
    assert client.get("/api/contracts/C-023", headers=as_user("bhavin")).status_code == 403
    assert any(a["action"] == "Access denied" for a in client.get("/api/audit").json())


def test_ready_to_sign_blocked_by_gates(client):
    r = client.post("/api/contracts/C-025/status", json={"status": "Ready to sign"}, headers=as_user("kd"))
    assert r.status_code == 409
    assert any("live obligation" in x for x in r.json()["detail"]["reasons"])  # Al Noor non-compete


def test_delegate_can_decide_but_not_sign(client):
    assert client.patch("/api/contracts/C-038/findings/F-1", json={"decision": "accepted"}, headers=as_user("jay")).status_code in (403, 404)
    client.post("/api/delegations", json={"to": "jay", "scope": ["C-038"], "expires": soon()}, headers=as_user("kd"))
    r = client.post("/api/contracts/C-038/status", json={"status": "Ready to sign"}, headers=as_user("jay"))
    assert r.status_code == 200  # LoopMart NDA is clean
    assert client.post("/api/contracts/C-038/status", json={"status": "Signed"}, headers=as_user("jay")).status_code == 403
    assert client.post("/api/contracts/C-038/status", json={"status": "Signed"}, headers=as_user("kd")).status_code == 200


def test_reviewer_marks_and_feedback(client):
    r = client.patch("/api/contracts/C-023/findings/F-1", json={"mark": {"verdict": "comment", "comment": "Their lawyers say non-negotiable"}}, headers=as_user("dhaval"))
    assert r.status_code == 200
    f = next(x for x in r.json()["findings"] if x["id"] == "F-1")
    assert f["marks"][-1]["by"] == "dhaval" and f["marks"][-1]["as"] == "primary"
    assert client.patch("/api/contracts/C-023/findings/F-1", json={"decision": "accepted"}, headers=as_user("dhaval")).status_code == 403


def test_pending_precedent_needs_kd(client):
    client.patch("/api/contracts/C-023/findings/F-2", json={"decision": "accepted"}, headers=as_user("kd"))
    p = client.post("/api/pending-precedents", json={"contractId": "C-023", "findingId": "F-2", "label": "standard"}, headers=as_user("kd")).json()
    assert p["status"] == "pending"
    assert client.post(f"/api/pending-precedents/{p['id']}/approve", headers=as_user("jay")).status_code == 403
    client.post(f"/api/pending-precedents/{p['id']}/approve", headers=as_user("kd"))
    assert any("approved by Karandeep" in x.get("context", "") for x in client.get("/api/precedents").json())


def test_upload_markdown_runs_pipeline(client):
    f = INCOMING / "2026-09-27_loopmart_mutual_nda_draft.md"
    with f.open("rb") as fh:
        r = client.post("/api/contracts", files={"file": (f.name, fh, "text/markdown")},
                        data={"counterparty": "LoopMart", "country": "India", "primary": "bhavin"}, headers=as_user("kd"))
    assert r.status_code == 200
    job = client.get(f"/api/jobs/{r.json()['jobId']}").json()
    assert job["status"] == "done", job
    assert job["contractId"] == "C-049"  # continues the tracker's numbering
    c = client.get(f"/api/contracts/{job['contractId']}", headers=as_user("bhavin")).json()
    assert c["docType"] == "NDA" and c["state"] == "green"
    assert client.get(f"/api/contracts/{job['contractId']}", headers=as_user("jay")).status_code == 403


def test_upload_rejects_unsupported_type(client):
    r = client.post("/api/contracts", files={"file": ("x.exe", b"MZ", "application/octet-stream")},
                    data={"counterparty": "X", "country": "India"}, headers=as_user("kd"))
    assert r.status_code == 422


def test_only_kd_delegates(client):
    body = {"to": "jay", "scope": "all-routine", "expires": soon()}
    assert client.post("/api/delegations", json=body, headers=as_user("bhavin")).status_code == 403
    ds = client.post("/api/delegations", json=body, headers=as_user("kd")).json()
    assert any(d["to"] == "jay" and d["active"] for d in ds)


def _upload(client, name: str, content: bytes, **data):
    r = client.post("/api/contracts", files={"file": (name, content, "text/plain")},
                    data={"counterparty": "Probe", "country": "India", **data}, headers=as_user("kd"))
    assert r.status_code == 200, r.text
    return r.json()


def test_failed_uploads_do_not_reuse_contract_ids(client):
    ids = [_upload(client, f"junk{i}.pdf", b"\x00not a pdf")["contractId"] for i in range(2)]
    ids.append(_upload(client, "ok.txt", b"This Agreement is between AtliQ and Probe.")["contractId"])
    assert ids == ["C-049", "C-050", "C-051"]


def test_upload_reserves_id_before_reading_the_file(client):
    # The ID is reserved before the first await, so an upload still being read already holds it.
    cid = db.next_contract_id(conn := db.connect())
    conn.execute("INSERT INTO uploads (contract_id, filename, path) VALUES (?, 'in-flight.txt', 'x')", (cid,))
    conn.commit()
    conn.close()
    assert _upload(client, "next.txt", b"hello")["contractId"] != cid


def test_signed_contract_is_read_only(client):
    signed = next(c for c in client.get("/api/bootstrap").json()["contracts"] if c["status"] == "Signed")
    r = client.post(f"/api/contracts/{signed['id']}/details", json={"country": "Mars"}, headers=as_user("kd"))
    assert r.status_code == 409
    assert client.get(f"/api/contracts/{signed['id']}").json()["country"] != "Mars"
    if signed["findings"]:
        fid = signed["findings"][0]["id"]
        r = client.patch(f"/api/contracts/{signed['id']}/findings/{fid}", json={"feedback": {"useful": True}}, headers=as_user("kd"))
        assert r.status_code == 409


def test_rerun_keeps_status_and_confirmed_details(client):
    f = INCOMING / "2026-09-27_loopmart_mutual_nda_draft.md"
    cid = _upload(client, f.name, f.read_bytes(), counterparty="LoopMart")["contractId"]
    client.post(f"/api/contracts/{cid}/details", json={"country": "UAE"}, headers=as_user("kd"))
    client.post(f"/api/contracts/{cid}/status", json={"status": "In negotiation"}, headers=as_user("kd"))
    assert client.post(f"/api/contracts/{cid}/rerun", headers=as_user("kd")).status_code == 200
    c = client.get(f"/api/contracts/{cid}").json()
    assert c["status"] == "In negotiation"
    assert c["country"] == "UAE" and c["detailsCheckedBy"]["corrected"]


def test_delegation_expiry_is_validated(client):
    def delegate(expires, scope="all-routine"):
        return client.post("/api/delegations", json={"to": "jay", "scope": scope, "expires": expires}, headers=as_user("kd"))

    assert delegate("not a date").status_code == 422
    assert delegate("01 Jan 2020").status_code == 422
    assert delegate(soon(), scope=[]).status_code == 422
    assert delegate(soon(), scope=["C-999"]).status_code == 422
    sept = date(date.today().year + (date.today().month >= 9), 9, 5)
    r = delegate(f"05 Sept {sept.year}")  # browsers' en-GB month for September
    assert r.status_code == 200 and r.json()[0]["expires"] == f"05 Sep {sept.year}"  # stored in one spelling


def test_unreadable_delegation_expiry_is_inactive():
    from app.access import delegation_active

    assert not delegation_active({"active": True, "expires": "not a date"})
    assert delegation_active({"active": True, "expires": "01 Jan 2030"})


def test_long_unbroken_text_is_analysed_quickly(tmp_path):
    import time

    from app.pipeline.run import run_review

    p = tmp_path / "x.txt"
    p.write_text("y" * 200_000)  # used to take minutes: an unanchored (\w+) regex was quadratic
    t = time.time()
    run_review(db.connect(), "C-900", p, {"counterparty": "X", "country": "India", "primary": "kd"})
    assert time.time() - t < 5


def test_oversized_text_fails_the_job_with_a_message(client):
    from app.pipeline.parse import MAX_CHARS

    job = client.get(f"/api/jobs/{_upload(client, 'huge.txt', b'word ' * (MAX_CHARS // 5 + 1))['jobId']}").json()
    assert job["status"] == "error" and "100 pages" in job["error"]


def test_correcting_details_reruns_the_entity_check(client):
    c = client.get("/api/contracts/C-038", headers=as_user("kd")).json()  # LoopMart NDA, India, Pvt Ltd: passes
    assert c["entityCheck"]["status"] == "pass"
    r = client.post("/api/contracts/C-038/details", json={"country": "United States"}, headers=as_user("kd")).json()
    assert r["entityCheck"]["status"] == "fail" and r["entityCheck"]["expectedEntity"] == "AtliQ Inc"
    assert client.post("/api/contracts/C-038/status", json={"status": "Ready to sign"}, headers=as_user("kd")).status_code == 409
    r = client.post("/api/contracts/C-038/details", json={"entity": "AtliQ Inc"}, headers=as_user("kd")).json()
    assert r["entityCheck"]["status"] == "pass"


def test_details_reject_values_outside_the_choices(client):
    for body in ({"entity": "Totally Fake Ltd"}, {"docType": "banana"}, {"atliqRole": "Overlord"}, {"country": "   "}):
        assert client.post("/api/contracts/C-038/details", json=body, headers=as_user("kd")).status_code == 422, body


def test_deal_values_are_read_as_us_dollars():
    from app.company import parse_usd

    assert parse_usd("$480,000") == 480_000 and parse_usd("$1.2M") == 1_200_000 and parse_usd("USD 250k") == 250_000
    assert parse_usd("$100k to $150k") == 150_000  # a range counts at its upper end
    for v in ("₹ 2 crore", "€500k", "1.000.000 EUR", "-500000", "1e9", "abc"):
        assert parse_usd(v) is None, v


def test_upload_rejects_unreadable_deal_value_and_flags_high_value(client):
    r = client.post("/api/contracts", files={"file": ("a.txt", b"x", "text/plain")},
                    data={"counterparty": "X", "country": "India", "value": "2 crore"}, headers=as_user("kd"))
    assert r.status_code == 422 and "US-dollar" in r.json()["detail"]
    cid = _upload(client, "nda.md", (INCOMING / "2026-09-27_loopmart_mutual_nda_draft.md").read_bytes(), value="$1.2M")["contractId"]
    assert client.get(f"/api/contracts/{cid}").json()["highValue"] is True


def test_text_encodings_are_decoded(client):
    text = (INCOMING / "2026-09-27_loopmart_mutual_nda_draft.md").read_text(encoding="utf-8")
    want = client.get(f"/api/contracts/{_upload(client, 'u8.md', text.encode('utf-8'))['contractId']}").json()
    for enc in ("utf-16", "utf-16-le", "utf-8-sig"):
        got = client.get(f"/api/contracts/{_upload(client, f'{enc}.md', text.encode(enc))['contractId']}").json()
        assert (got["state"], got["entityCheck"]["status"], len(got["clauses"])) == (want["state"], want["entityCheck"]["status"], len(want["clauses"])), enc


def test_garbled_text_is_unreadable_not_judged():
    from app.pipeline.parse import Page

    text = "This Agreement is made between AtliQ Technologies Pvt Ltd and the Client for services. " * 3
    assert Page(1, text).readable
    assert not Page(1, text.encode("utf-16").decode("utf-8", errors="replace")).readable


def test_delegation_limits(client):
    def delegate(to, expires, scope="all-routine"):
        return client.post("/api/delegations", json={"to": to, "scope": scope, "expires": expires}, headers=as_user("kd"))

    assert delegate("jay", soon(400)).status_code == 422  # more than a year
    assert delegate("jay", soon()).status_code == 200
    r = delegate("jay", soon(60))
    assert r.status_code == 409 and "Revoke it first" in r.json()["detail"]  # one active delegation per person
    r = delegate("bhavin", soon(), scope=["C-023"])  # Harrington is Dhaval's; Bhavin can't open it
    assert r.status_code == 422 and "isn't a reviewer" in r.json()["detail"]


def test_precedents_need_a_decision_and_are_saved_once(client):
    body = {"contractId": "C-023", "findingId": "F-3", "label": "standard"}
    assert client.post("/api/pending-precedents", json=body, headers=as_user("kd")).status_code == 409  # undecided
    client.patch("/api/contracts/C-023/findings/F-3", json={"decision": "accepted"}, headers=as_user("kd"))
    p = client.post("/api/pending-precedents", json=body, headers=as_user("kd")).json()
    assert client.post("/api/pending-precedents", json=body, headers=as_user("kd")).status_code == 409  # already saved
    before = len(client.get("/api/precedents").json())
    assert client.post(f"/api/pending-precedents/{p['id']}/approve", headers=as_user("kd")).status_code == 200
    assert client.post(f"/api/pending-precedents/{p['id']}/approve", headers=as_user("kd")).status_code == 409
    assert len(client.get("/api/precedents").json()) == before + 1


def test_audit_log_hides_contracts_the_user_cannot_open(client):
    client.get("/api/contracts/C-023", headers=as_user("kd"))  # writes an audit entry about Harrington
    visible = {c["id"] for c in client.get("/api/bootstrap", headers=as_user("bhavin")).json()["contracts"]}
    for audit in (client.get("/api/bootstrap", headers=as_user("bhavin")).json()["audit"], client.get("/api/audit", headers=as_user("bhavin")).json()):
        mentioned = {cid for a in audit for cid in __import__("re").findall(r"\bC-\d+\b", a.get("detail") or "")}
        assert mentioned <= visible
    assert any("C-023" in (a.get("detail") or "") for a in client.get("/api/audit", headers=as_user("kd")).json())


def test_upload_job_is_private_and_errors_hide_paths(client):
    r = _upload(client, "broken.docx", b"not a word file")
    assert client.get(f"/api/jobs/{r['jobId']}", headers=as_user("jay")).status_code == 404
    job = client.get(f"/api/jobs/{r['jobId']}", headers=as_user("kd")).json()
    assert job["status"] == "error" and ":\\" not in job["error"] and "/" not in job["error"].replace("password-protected", "")


def test_upload_requires_counterparty_and_country(client):
    for fields in ({"counterparty": "   "}, {"country": "  "}):
        r = client.post("/api/contracts", files={"file": ("a.md", b"x", "text/markdown")},
                        data={"counterparty": "X", "country": "India", **fields}, headers=as_user("kd"))
        assert r.status_code == 422


def test_revised_draft_links_to_the_review_it_replaces(client):
    nda = (INCOMING / "2026-09-27_loopmart_mutual_nda_draft.md").read_bytes()
    first = _upload(client, "v1.md", nda, counterparty="LoopMart")["contractId"]
    second = _upload(client, "v2.md", nda, counterparty="LoopMart", parent_id=first)["contractId"]
    fam = client.get(f"/api/contracts/{second}").json()["family"]
    assert fam["parent"]["id"] == first and fam["relation"].startswith("Revised draft")
    r = client.post("/api/contracts", files={"file": ("v3.md", nda, "text/markdown")},
                    data={"counterparty": "LoopMart", "country": "India", "parent_id": "C-023"}, headers=as_user("jay"))
    assert r.status_code == 422  # Jay can't see C-023


def test_rejected_contract_is_read_only_until_reopened(client):
    client.post("/api/contracts/C-023/status", json={"status": "Rejected"}, headers=as_user("kd"))
    assert client.patch("/api/contracts/C-023/findings/F-1", json={"decision": "accepted"}, headers=as_user("kd")).status_code == 409
    assert client.post("/api/contracts/C-023/details", json={"country": "UAE"}, headers=as_user("kd")).status_code == 409
    assert client.post("/api/contracts/C-023/status", json={"status": "Awaiting review"}, headers=as_user("kd")).status_code == 200
    assert client.patch("/api/contracts/C-023/findings/F-1", json={"decision": "accepted"}, headers=as_user("kd")).status_code == 200


def test_free_text_is_trimmed_checked_and_capped(client):
    patch = lambda body, u="kd": client.patch("/api/contracts/C-023/findings/F-1", json=body, headers=as_user(u))  # noqa: E731
    f = next(x for x in patch({"editedFallback": "   "}).json()["findings"] if x["id"] == "F-1")
    assert "editedFallback" not in f  # blank wording clears the edit instead of saving spaces
    assert patch({"mark": {"verdict": "comment", "comment": "  "}}, "dhaval").status_code == 422
    assert patch({"mark": {"verdict": "regrade"}}, "dhaval").status_code == 422
    assert patch({"editedFallback": "x" * 10001}).status_code == 422
    assert client.post("/api/contracts/C-023/status", json={"status": "In negotiation", "note": "x" * 2001}, headers=as_user("kd")).status_code == 422


def test_search_finds_short_terms_and_hyphen_variants(client):
    assert client.get("/api/precedents?q=IP").json(), "two-letter topics like IP must be searchable"
    joined = {o["id"] for o in client.get("/api/obligations?q=noncompete").json()}
    assert joined and joined <= {o["id"] for o in client.get("/api/obligations?q=non-compete").json()}
    assert all("non-compete" in o["clauseType"].lower() for o in client.get("/api/obligations?q=noncompete").json())


def test_tracker_problems_are_limited_to_visible_contracts(client):
    kd = client.get("/api/bootstrap", headers=as_user("kd")).json()
    bh = client.get("/api/bootstrap", headers=as_user("bhavin")).json()
    visible = {c["id"] for c in bh["contracts"]}
    assert len(bh["dataQuality"]) < len(kd["dataQuality"])
    assert all(set(q["rows"]) <= visible for q in bh["dataQuality"])


def test_cors_allows_this_projects_vercel_addresses_only(client):
    def allowed(origin):
        r = client.options("/api/bootstrap", headers={"Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-user"})
        return r.status_code == 200 and r.headers.get("access-control-allow-origin") == origin

    for ok in ("http://localhost:5173", "https://atliq-contract-risk-analyser.vercel.app", "https://atliq-contract-risk-analyser-botd.vercel.app",
               "https://atliq-contract-risk-analyser-git-main-vijayeta-s-projects.vercel.app",
               "https://atliq-contract-risk-analyser-a1b2c3d4e-vijayeta-s-projects.vercel.app"):
        assert allowed(ok), ok
    for bad in ("https://evil.example", "https://atliq-contract-risk-analyser-evil.vercel.app", "https://atliq-contract-risk-analyser.vercel.app.evil.com",
                "http://atliq-contract-risk-analyser.vercel.app"):
        assert not allowed(bad), bad

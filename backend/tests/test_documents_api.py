"""REST layer: authorization, stored files + signed links, audit trail, PDF generation and PDF import."""
import io
from datetime import timedelta

import pdfplumber
import pytest
from mongomock_motor import AsyncMongoMockClient
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

import documents as docstore
import exports
import imports as data_imports

from .docs_support import DOMAIN, NOW, env, equipment_doc, hdr, make_xlsx, server, snapshot  # noqa: F401  (env is a fixture)

pytestmark = pytest.mark.anyio

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
HEAD = ["Name", "Category", "QR", "Quantity", "Daily Rate", "Condition", "Location"]
ADMIN, FOREMAN, CREW = hdr("boss", "admin"), hdr("fore1", "foreman"), hdr("crew1", "crew")


def pdf_text(content: bytes, flat: bool = False) -> str:
    """Page text. `flat` collapses wrapping, since narrow table cells split words across lines."""
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)
    return " ".join(text.split()) if flat else text


async def upload(env, headers, content, dataset="equipment", **form):
    return await env.client.post("/api/imports", headers=headers, files={"file": ("inv.xlsx", content, XLSX_MIME)}, data={"dataset": dataset, **form})


# ----------------------------- exports -------------------------------------
async def test_xlsx_export_requires_auth_and_is_stored_and_audited(env):
    assert (await env.client.get("/api/exports/equipment/xlsx")).status_code in (401, 403)
    r = await env.client.get("/api/exports/equipment/xlsx", headers=ADMIN)
    assert r.status_code == 200 and r.content[:2] == b"PK" and r.headers["content-type"] == XLSX_MIME
    assert "attachment" in r.headers["content-disposition"] and r.headers["x-content-type-options"] == "nosniff" and "no-store" in r.headers["cache-control"]
    stored = await env.db.generated_files.find_one({"id": r.headers["x-file-id"]}, {"_id": 0})
    assert stored["content"] == r.content and stored["size_bytes"] == len(r.content) and stored["created_by_id"] == "boss"
    assert stored["expires_at"] > stored["created_at"]
    audit = await env.db.operational_activity.find_one({"source": "export", "event_type": "xlsx_export"}, {"_id": 0})
    assert audit["requesting_user"] == "boss" and audit["result"]["records"] == 5 and audit["parameters"]["dataset"] == "equipment"
    assert audit["result"]["sha256"] == stored["sha256"]


async def test_crew_exports_exclude_money_in_every_format(env):
    for fmt in ("xlsx", "csv", "pdf"):
        r = await env.client.get(f"/api/exports/equipment/{fmt}", headers=CREW)
        assert r.status_code == 200
        text = r.text if fmt == "csv" else pdf_text(r.content) if fmt == "pdf" else ""
        assert "Daily Rate" not in text and "12.50" not in text
    assert "Daily Rate" not in exports.render_xlsx(exports.DATASETS["equipment"], [], "crew", brand="x", generated_by="x") .decode("latin1")


@pytest.mark.parametrize("path", ["/api/exports/users/xlsx", "/api/exports/rentals/docx", "/api/exports/rentals/xlsx?%24where=1",
                                  "/api/exports/equipment/xlsx?status=active"])
async def test_bad_export_requests_are_rejected(env, path):
    assert (await env.client.get(path, headers=ADMIN)).status_code == 400


async def test_filtered_export_reports_filters_and_count(env):
    r = await env.client.get("/api/exports/assignments/xlsx?checked_out_to=nick", headers=ADMIN)
    stored = await env.db.generated_files.find_one({"id": r.headers["x-file-id"]}, {"_id": 0})
    assert stored["filters"] == {"checked_out_to": "nick"} and stored["record_count"] == 1 and stored["dataset"] == "assignments"


# ----------------------------- stored files --------------------------------
async def test_file_downloads_are_owner_or_admin_only(env):
    r = await env.client.get("/api/exports/equipment/xlsx", headers=CREW)
    fid = r.headers["x-file-id"]
    assert (await env.client.get(f"/api/files/{fid}/download")).status_code in (401, 403)
    assert (await env.client.get(f"/api/files/{fid}/download", headers=CREW)).content == r.content  # owner
    assert (await env.client.get(f"/api/files/{fid}/download", headers=ADMIN)).status_code == 200  # admin
    assert (await env.client.get(f"/api/files/{fid}/download", headers=FOREMAN)).status_code == 404  # someone else's file looks absent
    assert (await env.client.get("/api/files/nope/download", headers=ADMIN)).status_code == 404
    mine = (await env.client.get("/api/files", headers=CREW)).json()
    assert [f["id"] for f in mine] == [fid] and "content" not in mine[0] and "_id" not in mine[0]
    assert (await env.client.get("/api/files", headers=FOREMAN)).json() == []
    assert [f["id"] for f in (await env.client.get("/api/files", headers=ADMIN)).json()] == [fid]


async def test_expired_files_are_gone(env):
    r = await env.client.get("/api/exports/equipment/xlsx", headers=ADMIN)
    await env.db.generated_files.update_one({"id": r.headers["x-file-id"]}, {"$set": {"expires_at": NOW - timedelta(days=900)}})
    assert (await env.client.get(f"/api/files/{r.headers['x-file-id']}/download", headers=ADMIN)).status_code == 404
    assert (await env.client.get("/api/files", headers=ADMIN)).json() == []


async def test_signed_links_work_without_login_and_cannot_be_forged_or_repurposed(env):
    meta = await server.generate_export_file("equipment", "xlsx", {}, user_id="crew1", user_name="Crew", role="crew")
    token = server.signed_file_token(meta["id"], "crew")
    ok = await env.client.get(f"/api/files/shared/{token}")
    assert ok.status_code == 200 and ok.content[:2] == b"PK"
    assert (await env.db.generated_files.find_one({"id": meta["id"]}))["download_count"] == 1
    assert (await env.client.get(f"/api/files/shared/{token[:-3]}abc")).status_code == 403
    expired = docstore.sign_token(server.EXPORT_SECRET, "file", {"fid": meta["id"], "role": "crew"}, ttl=600, now=1)
    assert (await env.client.get(f"/api/files/shared/{expired}")).status_code == 403
    upload_token = server.mint_import_upload_token("equipment", "skip", None, issued_by="Nathan")
    assert (await env.client.get(f"/api/files/shared/{upload_token}")).status_code == 403, "an upload link is not a download link"
    gone = docstore.sign_token(server.EXPORT_SECRET, "file", {"fid": "missing", "role": "admin"}, ttl=600)
    assert (await env.client.get(f"/api/files/shared/{gone}")).status_code == 404


# ----------------------------- import authorization ------------------------
async def test_import_routes_are_admin_only(env):
    good = make_xlsx(HEAD, [["Planer", "tool", "P-1", 1, 0, "good", "Yard"]])
    before = await snapshot(env.db, *DOMAIN, "import_jobs")
    assert (await upload(env, {}, good)).status_code in (401, 403)
    for who in (CREW, FOREMAN):
        assert (await upload(env, who, good)).status_code == 403
    assert await snapshot(env.db, *DOMAIN, "import_jobs") == before, "a refused upload must not even stage"

    staged = await upload(env, ADMIN, good)
    assert staged.status_code == 200, staged.text
    iid, phash = staged.json()["import_id"], staged.json()["plan_hash"]
    for who in (CREW, FOREMAN):
        assert (await env.client.get(f"/api/imports/{iid}", headers=who)).status_code == 403
        assert (await env.client.get(f"/api/imports/{iid}/report.xlsx", headers=who)).status_code == 403
        assert (await env.client.post(f"/api/imports/{iid}/commit", headers=who, json={"plan_hash": phash})).status_code == 403
        assert (await env.client.post(f"/api/imports/{iid}/cancel", headers=who)).status_code == 403
    assert (await env.client.post(f"/api/imports/{iid}/commit", json={"plan_hash": phash})).status_code in (401, 403)
    assert await env.db.equipment.count_documents({"qr_code": "P-1"}) == 0


async def test_admin_end_to_end_over_http(env):
    rows = [["Planer", "tool", "P-1", 3, 4.5, "good", "Yard"], ["Circular Saw", "tool", "Q-101", 2, 8, "good", "Yard"], ["", "tool", "BAD", 1, 0, "good", ""]]
    staged = (await upload(env, ADMIN, make_xlsx(HEAD, rows))).json()
    assert staged["summary"] == {"total": 3, "create": 1, "update": 0, "unchanged": 0, "skip_duplicate": 1, "error": 1}
    page = (await env.client.get(f"/api/imports/{staged['import_id']}?action=error", headers=ADMIN)).json()
    assert [r["row"] for r in page["rows"]] == [4]
    report = await env.client.get(f"/api/imports/{staged['import_id']}/report.xlsx", headers=ADMIN)
    assert report.status_code == 200 and report.content[:2] == b"PK"

    wrong = await env.client.post(f"/api/imports/{staged['import_id']}/commit", headers=ADMIN, json={"plan_hash": "f" * 64})
    assert wrong.status_code == 409 and await env.db.equipment.count_documents({"qr_code": "P-1"}) == 0
    invalid = await env.client.post(f"/api/imports/{staged['import_id']}/commit", headers=ADMIN, json={"plan_hash": staged["plan_hash"]})
    assert invalid.status_code == 409 and "invalid" in invalid.json()["detail"]
    done = await env.client.post(f"/api/imports/{staged['import_id']}/commit", headers=ADMIN, json={"plan_hash": staged["plan_hash"], "skip_invalid_rows": True})
    assert done.status_code == 200 and done.json()["result"]["created"] == 1
    assert await env.db.equipment.count_documents({"qr_code": "P-1"}) == 1
    again = await env.client.post(f"/api/imports/{staged['import_id']}/commit", headers=ADMIN, json={"plan_hash": staged["plan_hash"], "skip_invalid_rows": True})
    assert again.status_code == 409


async def test_http_rejects_malformed_uploads_with_400(env):
    for content in (b"", b"just text", b"PK\x03\x04garbage"):
        r = await upload(env, ADMIN, content)
        assert r.status_code == 400, r.text
    assert (await upload(env, ADMIN, make_xlsx(HEAD, []), dataset="rentals")).status_code == 400
    assert (await upload(env, ADMIN, make_xlsx(HEAD, [["a", "tool", "1", 1, 0, "good", ""]]), mapping="not json")).status_code == 400
    assert (await upload(env, ADMIN, make_xlsx(HEAD, [["a", "tool", "1", 1, 0, "good", ""]]), mapping='["x"]')).status_code == 400
    assert (await env.client.get("/api/imports/does-not-exist", headers=ADMIN)).status_code == 404


async def test_upload_link_stages_only_is_single_use_and_cannot_commit(env):
    token = server.mint_import_upload_token("equipment", "skip", None, issued_by="Nathan (for Boss)")
    good = make_xlsx(HEAD, [["Planer", "tool", "P-1", 3, 4.5, "good", "Yard"]])
    before = await snapshot(env.db, *DOMAIN)
    r = await env.client.post(f"/api/imports/upload/{token}", files={"file": ("inv.xlsx", good, XLSX_MIME)})
    assert r.status_code == 200 and r.json()["summary"]["create"] == 1
    assert await snapshot(env.db, *DOMAIN) == before, "an upload link can only stage"
    job = await env.db.import_jobs.find_one({"id": r.json()["import_id"]})
    assert job["uploaded_by_id"] == "hermes-agent" and job["uploaded_by_name"] == "Nathan (for Boss)" and job["channel"] == "upload-link"
    replay = await env.client.post(f"/api/imports/upload/{token}", files={"file": ("inv.xlsx", good, XLSX_MIME)})
    assert replay.status_code == 403 and "already been used" in replay.json()["detail"]
    for bad in ("garbage", token[:-2] + "xx", docstore.sign_token(server.EXPORT_SECRET, "import-upload", {"ds": "equipment"}, ttl=60, now=1),
                server.signed_file_token("x", "admin")):
        assert (await env.client.post(f"/api/imports/upload/{bad}", files={"file": ("a.xlsx", good, XLSX_MIME)})).status_code == 403
    assert (await env.client.post(f"/api/imports/{r.json()['import_id']}/commit", json={"plan_hash": r.json()["plan_hash"]})).status_code in (401, 403)


async def test_upload_link_rejects_unsupported_dataset_at_mint_time(env):
    with pytest.raises(server.HTTPException) as err:
        server.mint_import_upload_token("rentals", "skip", None, issued_by="x")
    assert err.value.status_code == 400


# ----------------------------- PDF documents -------------------------------
async def test_rental_agreement_pdf_has_the_transaction_details(env):
    r = await env.client.get("/api/rentals/r1-aaaaaaaa/agreement.pdf", headers=ADMIN)
    assert r.status_code == 200 and r.content.startswith(b"%PDF") and r.headers["content-type"] == "application/pdf"
    text = pdf_text(r.content)
    for expected in ("Rental Agreement & Transaction Record", "ABC Homes", "Oak St", "Strongback 8ft", "Gate code 1234", "Deposit", "$250.00",
                     "$1.50", "Confirmed drop-off", "Customer signature", "Page 1 of 1"):
        assert expected in text, f"{expected!r} missing from:\n{text}"
    assert "10 ordered · 10 delivered · 4 returned · 1 damaged · 6 outstanding" in text
    assert (await env.db.operational_activity.find_one({"event_type": "pdf_rental_agreement"}))["parameters"]["source_ref"] == "r1-aaaaaaaa"


async def test_rental_pdf_omits_money_for_crew_and_checks_auth(env):
    text = pdf_text((await env.client.get("/api/rentals/r1-aaaaaaaa/agreement.pdf", headers=CREW)).content)
    assert "ABC Homes" in text and "Deposit" not in text and "$250" not in text and "Daily rate" not in text and "$1.50" not in text
    assert (await env.client.get("/api/rentals/r1-aaaaaaaa/agreement.pdf")).status_code in (401, 403)
    assert (await env.client.get("/api/rentals/missing/agreement.pdf", headers=ADMIN)).status_code == 404


@pytest.mark.parametrize("dispatch_id,title,qty_note", [
    ("d1-bbbbbbbb", "Outbound Delivery Ticket", "10"), ("d2-cccccccc", "Inbound / Return Pickup Ticket", "4"),
])
async def test_dispatch_tickets_for_outbound_and_inbound(env, dispatch_id, title, qty_note):
    r = await env.client.get(f"/api/dispatches/{dispatch_id}/ticket.pdf", headers=FOREMAN)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    text = pdf_text(r.content)
    for expected in (title, "ABC Homes", "Dee", "T-1", "Strongback 8ft", "Driver signature", qty_note):
        assert expected in text
    assert (await env.client.get("/api/dispatches/nope/ticket.pdf", headers=FOREMAN)).status_code == 404


@pytest.mark.parametrize("dataset,needle", [
    ("equipment", "Equipment Inventory"), ("tools", "Tools"), ("assignments", "Nick Smith"), ("damaged", "Broken Grinder"),
    ("returns", "Inbound / Returns"), ("outbound", "Outbound Deliveries"), ("shop_tasks", "Sharpen blades"),
    ("consumables", "FA-1"), ("block", "ICF Block 8in"), ("rentals", "ABC Homes"),
])
async def test_dataset_pdfs_render_for_every_report_type(env, dataset, needle):
    r = await env.client.get(f"/api/exports/{dataset}/pdf", headers=ADMIN)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert needle in pdf_text(r.content, flat=True)


async def test_long_report_paginates_with_repeating_headers_and_page_numbers(env):
    await env.db.equipment.insert_many([equipment_doc(name=f"Bulk Item {i:03d}", sku=f"BULK-{i}", qr_code=f"BK-{i}") for i in range(150)])
    r = await env.client.get("/api/exports/equipment/pdf", headers=ADMIN)
    with pdfplumber.open(io.BytesIO(r.content)) as pdf:
        pages = len(pdf.pages)
        assert pages > 2
        assert all("Name" in (p.extract_text() or "") for p in pdf.pages), "table header must repeat on every page"
        assert f"Page {pages} of {pages}" in pdf.pages[-1].extract_text()
    assert "Total records: 155" in pdf_text(r.content)


async def test_pdf_text_is_escaped_not_interpreted(env):
    await env.db.equipment.insert_one(equipment_doc(name="<b>Bold</b> & <script>x</script>", sku="ESC-1", qr_code="ESC-1"))
    r = await env.client.get("/api/exports/equipment/pdf", headers=ADMIN)
    text = pdf_text(r.content, flat=True)
    assert r.status_code == 200 and "<b>Bold</b>" in text, "markup in a name must print literally, not style the cell or break the document"
    assert "script>x</script>" in text


# ----------------------------- PDF import ----------------------------------
async def table_pdf(env, dataset="equipment", **filters) -> bytes:
    return (await env.client.get(f"/api/exports/{dataset}/pdf", headers=ADMIN)).content


async def test_a_table_pdf_export_can_be_previewed_for_import_but_changes_nothing(env):
    pdf = await table_pdf(env)
    fresh = AsyncMongoMockClient()["pdfimport"]
    preview = await data_imports.stage_import(fresh, dataset="equipment", filename="inv.pdf", content=pdf, actor_id="boss", actor_name="Boss")
    assert preview["source"] == "pdf" and preview["blocking_errors"] == []
    assert preview["summary"]["total"] == 5 and preview["summary"]["error"] == 0 and preview["summary"]["create"] == 5
    names = {r["data"]["name"] for r in (await fresh.import_jobs.find_one({"id": preview["import_id"]}))["rows"]}
    assert names == {"Hammer Drill", "Circular Saw", "Strongback 8ft", "Broken Grinder", "Dominick Level"}
    assert await fresh.equipment.count_documents({}) == 0, "extraction must stay a preview until confirmed"
    committed = await data_imports.commit_import(fresh, server, import_id=preview["import_id"], plan_hash=preview["plan_hash"], actor_id="boss", actor_name="Boss")
    assert committed["result"]["created"] == 5


async def test_pdf_import_against_existing_inventory_only_reports_duplicates(env):
    preview = await data_imports.stage_import(env.db, dataset="equipment", filename="inv.pdf", content=await table_pdf(env), actor_id="boss", actor_name="Boss")
    assert preview["summary"]["create"] == 0 and preview["summary"]["skip_duplicate"] + preview["summary"]["error"] == 5
    with pytest.raises(data_imports.ImportFileError, match="only add new records"):
        await data_imports.stage_import(env.db, dataset="equipment", filename="inv.pdf", content=await table_pdf(env), actor_id="b", actor_name="B", on_duplicate="update")


def _text_only_pdf() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.drawString(72, 700, "Delivery receipt - 4 turnbuckles and 2 jacks, signed by Pat.")
    c.save()
    return buf.getvalue()


async def test_pdfs_without_a_reliable_table_are_refused(env):
    before = await snapshot(env.db, *DOMAIN, "import_jobs")
    with pytest.raises(data_imports.ImportFileError, match="No structured table"):
        await data_imports.stage_import(env.db, dataset="equipment", filename="r.pdf", content=_text_only_pdf(), actor_id="b", actor_name="B")
    assert await snapshot(env.db, *DOMAIN, "import_jobs") == before


async def test_pdf_table_with_unmappable_columns_is_blocked(env):
    # a rentals report is a perfectly good table, but not importable as equipment
    preview = await data_imports.stage_import(env.db, dataset="equipment", filename="r.pdf", content=await table_pdf(env, "rentals"), actor_id="b", actor_name="B")
    assert preview["blocking_errors"] and preview["summary"]["total"] == 0
    with pytest.raises(data_imports.ImportStateError, match="blocking"):
        await data_imports.commit_import(env.db, server, import_id=preview["import_id"], plan_hash=preview["plan_hash"], actor_id="b", actor_name="B")

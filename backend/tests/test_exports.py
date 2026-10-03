"""CSV/PDF export: role redaction, filter whitelist, PDF validity, signed links, hub targeting."""
import io
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from exports import (
    DATASETS, ExportError, clean_filters, render_csv, render_pdf, resolve_dataset,
    sign_export_token, verify_export_token,
)

EQ = [
    {"name": "Wall Brace", "qr_code": "Q1", "category": "Bracing", "condition": "good", "location": "Yard",
     "quantity": 10, "available": 7, "reserved": 1, "daily_rate": 12.5},
    {"name": "=cmd|' /C calc'!A0", "category": "Bracing", "condition": "fair", "quantity": 1, "available": 1, "daily_rate": 1},
]
SECRET = b"s3cret"


class CsvTest(unittest.TestCase):
    def test_admin_sees_money_crew_does_not(self):
        ds = resolve_dataset("equipment")
        self.assertIn("Daily Rate", render_csv(ds, EQ, "foreman").splitlines()[0])
        crew = render_csv(ds, EQ, "crew")
        self.assertNotIn("Daily Rate", crew)
        self.assertNotIn("12.50", crew)

    def test_formula_injection_is_neutralised(self):
        out = render_csv(resolve_dataset("equipment"), EQ, "admin")
        self.assertIn("'=cmd", out)
        self.assertNotIn(",=cmd", out)
        self.assertTrue(out.splitlines()[2].startswith("'=cmd"))


class FilterTest(unittest.TestCase):
    def test_only_whitelisted_equality_filters(self):
        ds = resolve_dataset("rentals")
        self.assertEqual(clean_filters(ds, {"status": "active"}), {"status": "active"})
        with self.assertRaises(ExportError):
            clean_filters(ds, {"$where": "1"})
        with self.assertRaises(ExportError):
            clean_filters(ds, {"status": {"$ne": "x"}})
        with self.assertRaises(ExportError):
            clean_filters(resolve_dataset("equipment"), {"status": "active"})

    def test_unknown_dataset(self):
        with self.assertRaises(ExportError):
            resolve_dataset("users")  # no user/admin data is exportable
        self.assertNotIn("users", DATASETS)


class PdfTest(unittest.TestCase):
    def test_pdf_is_real_paginated_and_contains_data(self):
        from pypdf import PdfReader
        docs = [{"name": f"Item {i}", "category": "C", "condition": "good", "quantity": i, "available": i} for i in range(200)]
        pdf = render_pdf(resolve_dataset("equipment"), docs, "admin", brand="Concrete Form", generated_by="Rusty",
                         filters={"category": "C"}, generated_at=datetime(2026, 10, 2, 12, 0))
        self.assertTrue(pdf.startswith(b"%PDF"))
        reader = PdfReader(io.BytesIO(pdf))
        self.assertGreater(len(reader.pages), 1)  # not silently truncated
        text = "\n".join(p.extract_text() for p in reader.pages)
        for needle in ("Concrete Form", "Equipment Inventory", "2026-10-02 12:00", "category=C", "Item 199",
                       "Total records: 200", f"Page 1 of {len(reader.pages)}"):
            self.assertIn(needle, text)

    def test_crew_pdf_omits_money(self):
        from pypdf import PdfReader
        pdf = render_pdf(resolve_dataset("equipment"), EQ[:1], "crew", brand="B", generated_by="c")
        self.assertNotIn("Daily Rate", PdfReader(io.BytesIO(pdf)).pages[0].extract_text())

    def test_markup_in_data_does_not_break_pdf(self):
        pdf = render_pdf(resolve_dataset("equipment"), [{"name": "<b>bad & </i>"}], "admin", brand="B", generated_by="c")
        self.assertTrue(pdf.startswith(b"%PDF"))


class TokenTest(unittest.TestCase):
    def mint(self, **kw):
        return sign_export_token(SECRET, dataset="rentals", fmt="pdf", filters={"status": "active"},
                                 role="foreman", issued_for="Nathan", **kw)

    def test_roundtrip_binds_role_and_filters(self):
        p = verify_export_token(SECRET, self.mint())
        self.assertEqual((p["ds"], p["role"], p["f"]), ("rentals", "foreman", {"status": "active"}))

    def test_tampered_wrong_secret_and_expired_rejected(self):
        token = self.mint(now=1000)
        with self.assertRaises(ExportError):
            verify_export_token(SECRET, token, now=1000 + 601)
        with self.assertRaises(ExportError):
            verify_export_token(b"other", token, now=1001)
        body, sig = token.split(".")
        with self.assertRaises(ExportError):
            verify_export_token(SECRET, body[:-2] + "AA." + sig, now=1001)
        with self.assertRaises(ExportError):
            verify_export_token(SECRET, "garbage", now=1001)


async def _coro(v):
    return v


class FakeCursor:
    def __init__(self, docs):
        self.docs = docs

    def sort(self, *_):
        return self

    async def to_list(self, _n):
        return [dict(d) for d in self.docs]


class FakeColl:
    def __init__(self, docs):
        self.docs, self.queries = docs, []

    def find(self, query, *_):
        self.queries.append(query)
        return FakeCursor(self.docs)


class BuildExportApiTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for k, v in dict(JWT_SECRET_KEY="x", JWT_REFRESH_SECRET_KEY="y", MONGO_URL="mongodb://localhost", DB_NAME="t").items():
            os.environ.setdefault(k, v)
        import server
        self.server = server
        self.equipment = FakeColl([{"name": "Brace", "daily_rate": 9.0, "quantity": 1}])
        site = SimpleNamespace(find_one=lambda *_: _coro({"brand_name": "ICF Co"}))
        p = patch.object(server, "db", SimpleNamespace(equipment=self.equipment, site=site)); p.start(); self.addCleanup(p.stop)

    async def test_crew_download_is_redacted_even_via_pdf_csv(self):
        body, media, name = await self.server.build_export("equipment", "csv", {}, "crew", "Crew")
        self.assertEqual(media, "text/csv")
        self.assertNotIn(b"Daily Rate", body)
        body, media, name = await self.server.build_export("equipment", "csv", {}, "admin", "Admin")
        self.assertIn(b"Daily Rate", body)
        self.assertTrue(name.startswith("mobileops-equipment-") and name.endswith(".csv"))

    async def test_pdf_branding_and_filter_passed_to_query(self):
        body, media, _ = await self.server.build_export("equipment", "pdf", {"category": "Bracing"}, "admin", "Admin")
        self.assertEqual((media, body[:4]), ("application/pdf", b"%PDF"))
        self.assertEqual(self.equipment.queries[-1], {"category": "Bracing"})

    async def test_bad_dataset_format_and_filter_are_400(self):
        for args in (("users", "pdf", {}), ("equipment", "docx", {}), ("equipment", "pdf", {"$where": "1"})):
            with self.assertRaises(HTTPException) as cm:
                await self.server.build_export(*args, "admin", "A")
            self.assertEqual(cm.exception.status_code, 400)

    async def test_shared_link_rejects_bad_token_with_403(self):
        with self.assertRaises(HTTPException) as cm:
            await self.server.download_shared_export("nope.nope")
        self.assertEqual(cm.exception.status_code, 403)


class HubAndNotificationEndpointTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for k, v in dict(JWT_SECRET_KEY="x", JWT_REFRESH_SECRET_KEY="y", MONGO_URL="mongodb://localhost", DB_NAME="t").items():
            os.environ.setdefault(k, v)
        import server
        self.server = server

    async def test_send_to_user_only_reaches_that_users_sockets(self):
        class Sock:
            def __init__(self): self.got = []
            async def send_json(self, e): self.got.append(e)
        hub, a, b, anon = self.server.WhiteboardRealtimeHub(), Sock(), Sock(), Sock()
        await hub.add(a, "u1"); await hub.add(b, "u2"); await hub.add(anon)
        await hub.send_to_user("u1", {"type": "notification.created"})
        self.assertEqual((len(a.got), len(b.got), len(anon.got)), (1, 0, 0))
        await hub.broadcast({"type": "message.created"})
        self.assertEqual((len(a.got), len(b.got), len(anon.got)), (2, 1, 1))
        await hub.remove(a)
        self.assertNotIn(a, hub.socket_users)

    async def test_mark_read_is_scoped_to_caller(self):
        calls = []
        async def update_one(flt, upd):
            calls.append(flt)
            return SimpleNamespace(matched_count=0)
        db = SimpleNamespace(notifications=SimpleNamespace(update_one=update_one))
        me = self.server.UserPublic(id="u1", email="a@b.c", name="A", role=self.server.Role.crew)
        with patch.object(self.server, "db", db):
            with self.assertRaises(HTTPException) as cm:
                await self.server.mark_notification_read("someone-elses", me)
        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(calls[0], {"id": "someone-elses", "user_id": "u1"})


if __name__ == "__main__":
    unittest.main()

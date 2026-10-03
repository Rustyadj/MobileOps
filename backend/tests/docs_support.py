"""Shared fixtures for the XLSX / PDF import-export tests (mongomock-backed, no live server)."""
import io
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

pytest.importorskip("mongomock_motor")
from httpx import ASGITransport, AsyncClient  # noqa: E402
from mongomock_motor import AsyncMongoMockClient  # noqa: E402
from openpyxl import Workbook  # noqa: E402

for _k, _v in dict(
    JWT_SECRET_KEY="x", JWT_REFRESH_SECRET_KEY="y", MONGO_URL="mongodb://localhost", DB_NAME="t",
    ADMIN_EMAIL="a@b.c", ADMIN_PASSWORD="pw",
).items():
    os.environ.setdefault(_k, _v)
import server  # noqa: E402

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


def hdr(uid: str, role: str) -> dict:
    return {"Authorization": f"Bearer {server.make_token(uid, role)}"}


def make_xlsx(headers, rows, sheet="Data", extra_sheets=None) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    if headers is not None:
        ws.append(list(headers))
    for row in rows:
        ws.append(list(row))
    for name in extra_sheets or []:
        wb.create_sheet(name)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def equipment_doc(**kw) -> dict:
    base = dict(name="Item", category="tool", sku=f"SKU-{kw.get('name', 'Item')}", quantity=1, available=1, location="Yard", condition="good")
    base.update(kw)
    doc = server.Equipment(**base).model_dump()
    if "created_at" not in kw:
        doc["created_at"] = NOW
    return doc


async def seed(db) -> None:
    await db.users.insert_many([
        {"id": "crew1", "name": "Crew", "email": "c@x.com", "role": "crew"},
        {"id": "fore1", "name": "Foreman", "email": "f@x.com", "role": "foreman"},
        {"id": "boss", "name": "Boss", "email": "b@x.com", "role": "admin"},
    ])
    await db.equipment.insert_many([
        equipment_doc(name="Hammer Drill", qr_code="Q-100", sku="QR-Q-100", quantity=1, available=0, checked_out=1,
                      checked_out_to="Nick Smith", checked_out_crew="Crew A", checked_out_job="Oak St", checked_out_at=NOW - timedelta(days=3),
                      daily_rate=12.5, model="DH-9", serial_number="SN-1", notes="Red case"),
        equipment_doc(name="Circular Saw", qr_code="Q-101", sku="QR-Q-101", quantity=2, available=2, daily_rate=8.0),
        equipment_doc(name="Strongback 8ft", category="strongback", sku="SB-8", quantity=50, available=40, in_maintenance=2, condition="fair", daily_rate=1.5),
        equipment_doc(name="Broken Grinder", qr_code="Q-102", sku="QR-Q-102", condition="broken", quantity=1, available=0),
        equipment_doc(name="Dominick Level", qr_code="Q-103", sku="QR-Q-103", quantity=1, available=0, checked_out=1, checked_out_to="Dominick Rey"),
    ])
    await db.rentals.insert_many([
        {"id": "r1-aaaaaaaa", "customer_name": "ABC Homes", "customer_type": "company", "job_site": "Oak St", "job_address": "1 Oak St",
         "status": "active", "deposit": 250.0, "start_date": NOW, "due_date": NOW + timedelta(days=7), "created_at": NOW,
         "primary_contact": "Pat", "customer_phone": "555-0100", "delivery_notes": "Gate code 1234",
         "lines": [{"equipment_id": "e1", "sku": "SB-8", "name": "Strongback 8ft", "qty": 10, "daily_rate": 1.5, "delivered_qty": 10, "returned_qty": 4, "damaged_qty": 1}],
         "communication_log": [{"id": "c1", "channel": "call", "direction": "outgoing", "summary": "Confirmed drop-off", "outcome": "ok", "created_at": NOW}]},
    ])
    await db.dispatches.insert_many([
        {"id": "d1-bbbbbbbb", "direction": "outbound", "status": "scheduled", "scheduled_date": NOW, "customer_name": "ABC Homes", "job_site": "Oak St",
         "driver_name": "Dee", "truck": "T-1", "created_at": NOW, "lines": [{"equipment_id": "e1", "sku": "SB-8", "name": "Strongback 8ft", "qty": 10}]},
        {"id": "d2-cccccccc", "direction": "inbound", "status": "scheduled", "scheduled_date": NOW, "customer_name": "ABC Homes", "job_site": "Oak St",
         "driver_name": "Dee", "truck": "T-1", "created_at": NOW, "lines": [{"equipment_id": "e1", "sku": "SB-8", "name": "Strongback 8ft", "qty": 4}]},
    ])
    await db.shop_tasks.insert_many([
        {"id": "t1-dddddddd", "title": "Sharpen blades", "task_type": "repair", "status": "to_do", "priority": "high", "assignee": "Nick Smith", "created_at": NOW},
        {"id": "t2-eeeeeeee", "title": "Stage bracing", "task_type": "staging", "status": "done", "priority": "normal", "assignee": "Lee", "created_at": NOW},
    ])
    await db.sellable_items.insert_many([
        {"id": "s1", "kind": "consumable", "product": "Foam Adhesive", "manufacturer": "Acme", "sku": "FA-1", "unit": "can", "quantity_on_hand": 12, "quantity_reserved": 0, "cost": 5.0, "price": 9.0, "notes": "", "created_at": NOW, "updated_at": NOW},
        {"id": "s2", "kind": "block", "product": "ICF Block 8in", "manufacturer": "Beta", "sku": "B-8", "core_size": "8", "form_type": "straight", "quantity_on_hand": 400, "quantity_reserved": 0, "cost": 3.0, "price": 6.0, "notes": "", "created_at": NOW, "updated_at": NOW},
    ])


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def env():
    db = AsyncMongoMockClient()["docs"]
    await seed(db)
    with patch.object(server, "db", db):
        async with AsyncClient(transport=ASGITransport(app=server.app), base_url="http://t") as client:
            yield SimpleNamespace(client=client, db=db, server=server)


async def snapshot(db, *collections: str) -> dict:
    """Everything in the named collections, for exact before/after comparisons."""
    return {c: sorted(await db[c].find({}, {"_id": 0}).to_list(None), key=lambda d: str(d.get("id"))) for c in collections}


DOMAIN = ("equipment", "ledger_entries", "sellable_items")


class FaultyDB:
    """Proxy that makes chosen collection methods fail, to prove rollback against real driver errors.

    faults: {(collection, method): predicate(call_number) -> bool}; a True result raises RuntimeError.
    """

    def __init__(self, db, faults=None):
        self._db, self.faults, self.calls = db, dict(faults or {}), {}

    def __getitem__(self, name):
        return _FaultyCollection(self._db[name], name, self)

    def __getattr__(self, name):
        return self[name]


class _FaultyCollection:
    def __init__(self, coll, name, owner):
        self._coll, self._name, self._owner = coll, name, owner

    def __getattr__(self, method):
        attr = getattr(self._coll, method)
        key = (self._name, method)
        if key not in self._owner.faults or not callable(attr):
            return attr

        async def wrapped(*args, **kwargs):
            n = self._owner.calls[key] = self._owner.calls.get(key, 0) + 1
            if self._owner.faults[key](n):
                raise RuntimeError(f"injected failure in {self._name}.{method} (call {n})")
            return await attr(*args, **kwargs)

        return wrapped

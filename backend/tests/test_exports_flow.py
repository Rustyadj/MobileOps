"""Export routes end to end: auth, role redaction, filters, signed Hermes links."""
import os
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

pytest.importorskip("mongomock_motor")
from httpx import ASGITransport, AsyncClient  # noqa: E402
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

for _k, _v in dict(JWT_SECRET_KEY="x", JWT_REFRESH_SECRET_KEY="y", MONGO_URL="mongodb://localhost", DB_NAME="t").items():
    os.environ.setdefault(_k, _v)
import server  # noqa: E402
from exports import sign_export_token  # noqa: E402

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def env():
    db = AsyncMongoMockClient()["exp"]
    await db.users.insert_many([
        {"id": "crew1", "name": "Crew", "email": "c@x.com", "role": "crew"},
        {"id": "boss", "name": "Boss", "email": "b@x.com", "role": "admin"},
    ])
    now = datetime.now(timezone.utc)
    await db.rentals.insert_many([
        {"id": "r1-aaaaaaaa", "customer_name": "ABC Homes", "status": "active", "deposit": 250.0, "start_date": now, "created_at": now, "lines": [{}]},
        {"id": "r2-bbbbbbbb", "customer_name": "Closed Co", "status": "returned", "deposit": 99.0, "start_date": now, "created_at": now},
    ])
    with patch.object(server, "db", db):
        async with AsyncClient(transport=ASGITransport(app=server.app), base_url="http://t") as client:
            yield client


def hdr(uid, role):
    return {"Authorization": f"Bearer {server.make_token(uid, role)}"}


async def test_requires_authentication(env):
    assert (await env.get("/api/exports/rentals/csv")).status_code in (401, 403)


async def test_csv_filter_and_role_redaction(env):
    admin = await env.get("/api/exports/rentals/csv?status=active", headers=hdr("boss", "admin"))
    assert admin.status_code == 200 and "attachment" in admin.headers["content-disposition"]
    assert "ABC Homes" in admin.text and "Closed Co" not in admin.text and "250.00" in admin.text
    crew = await env.get("/api/exports/rentals/csv", headers=hdr("crew1", "crew"))
    assert "Deposit" not in crew.text and "250" not in crew.text and "99" not in crew.text
    assert "ABC Homes" in crew.text and "Closed Co" in crew.text  # unfiltered: nothing silently dropped


async def test_pdf_is_generated(env):
    r = await env.get("/api/exports/rentals/pdf", headers=hdr("boss", "admin"))
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf" and r.content.startswith(b"%PDF")


@pytest.mark.parametrize("path", ["/api/exports/users/csv", "/api/exports/rentals/docx", "/api/exports/rentals/csv?%24where=1"])
async def test_bad_requests_rejected(env, path):
    assert (await env.get(path, headers=hdr("boss", "admin"))).status_code == 400


async def test_signed_link_downloads_without_auth_and_binds_role(env):
    token = sign_export_token(server.EXPORT_SECRET, dataset="rentals", fmt="csv", filters={}, role="crew", issued_for="Nathan")
    r = await env.get(f"/api/exports/shared/{token}")
    assert r.status_code == 200 and "Deposit" not in r.text
    expired = sign_export_token(server.EXPORT_SECRET, dataset="rentals", fmt="csv", filters={}, role="admin", issued_for="N", now=1)
    assert (await env.get(f"/api/exports/shared/{expired}")).status_code == 403
    assert (await env.get(f"/api/exports/shared/{token[:-3]}abc")).status_code == 403

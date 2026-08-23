"""Idempotency-key dedup — see idempotent() in backend/server.py.

The offline mutation queue retries a request whenever it can't confirm the
previous attempt landed (dropped response, app killed mid-request). Without
dedup, a retried checkout/create would double-apply. These tests confirm:
a request sent twice with the same Idempotency-Key only runs its side
effects once and returns the same response both times, while a request
without a key (every existing caller, unaffected by this change) still runs
every time exactly as before.
"""
import uuid

import pytest

from conftest import BASE_URL


def create_equipment(api_client, auth_headers, qty=100, **overrides):
    sku = f"TEST-IDEM-{uuid.uuid4().hex[:8]}"
    body = {"sku": sku, "name": "Test Strongback", "category": "strongback", "quantity": qty, "available": qty}
    body.update(overrides)
    r = api_client.post(f"{BASE_URL}/api/equipment", headers=auth_headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


class TestIdempotencyKey:
    def test_replayed_checkout_does_not_double_apply(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        key = uuid.uuid4().hex
        body = {"checked_out_to": "Foreman A", "qty": 3}
        headers = {**auth_headers, "Idempotency-Key": key}

        r1 = api_client.post(f"{BASE_URL}/api/equipment/{eq['id']}/checkout", headers=headers, json=body)
        assert r1.status_code == 200, r1.text
        r2 = api_client.post(f"{BASE_URL}/api/equipment/{eq['id']}/checkout", headers=headers, json=body)
        assert r2.status_code == 200, r2.text

        # Same response both times — the second call never re-ran the handler.
        assert r1.json() == r2.json()

        after = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        current = next(e for e in after if e["id"] == eq["id"])
        assert current["checked_out"] == 3, "checkout applied twice would show 6"
        assert current["available"] == 7

        ledger = api_client.get(f"{BASE_URL}/api/equipment/{eq['id']}/ledger", headers=auth_headers).json()
        checkout_entries = [e for e in ledger if e["reason"] == "tool_checkout"]
        assert len(checkout_entries) == 1, "replayed request must not write a second ledger entry"

    def test_without_a_key_still_applies_every_call(self, api_client, auth_headers):
        """Backward compatibility: no Idempotency-Key header means no dedup,
        same as before this existed — every existing (non-queued) caller is
        unaffected."""
        eq = create_equipment(api_client, auth_headers, qty=10)
        body = {"checked_out_to": "Foreman B", "qty": 1}

        r1 = api_client.post(f"{BASE_URL}/api/equipment/{eq['id']}/checkout", headers=auth_headers, json=body)
        assert r1.status_code == 200, r1.text
        r2 = api_client.post(f"{BASE_URL}/api/equipment/{eq['id']}/checkin", headers=auth_headers, json={"qty": 1})
        assert r2.status_code == 200, r2.text
        r3 = api_client.post(f"{BASE_URL}/api/equipment/{eq['id']}/checkout", headers=auth_headers, json=body)
        assert r3.status_code == 200, r3.text

        after = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        current = next(e for e in after if e["id"] == eq["id"])
        assert current["checked_out"] == 1

    def test_replayed_rental_create_does_not_duplicate(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        key = uuid.uuid4().hex
        body = {
            "customer_name": f"TEST_Idem_{uuid.uuid4().hex[:6]}",
            "job_site": "", "start_date": "2026-01-01T00:00:00Z", "deposit": 0.0,
            "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 2, "daily_rate": 0}],
        }
        headers = {**auth_headers, "Idempotency-Key": key}

        r1 = api_client.post(f"{BASE_URL}/api/rentals", headers=headers, json=body)
        assert r1.status_code == 201, r1.text
        r2 = api_client.post(f"{BASE_URL}/api/rentals", headers=headers, json=body)
        assert r2.status_code == 201, r2.text

        assert r1.json()["id"] == r2.json()["id"], "replay must return the SAME rental, not a new one"

        rentals = api_client.get(f"{BASE_URL}/api/rentals", headers=auth_headers).json()
        matching = [r for r in rentals if r["customer_name"] == body["customer_name"]]
        assert len(matching) == 1, "replayed create must not produce a second rental"

        current = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        eq_after = next(e for e in current if e["id"] == eq["id"])
        assert eq_after["available"] == 8, "double-created rental would over-commit to 6"

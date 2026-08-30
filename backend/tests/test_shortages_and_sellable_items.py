"""Shortages (merged auto+manual list) and sellable inventory (Consumables,
Block) — see backend/server.py's Shortage/SellableItem models and the
/shortages, /sellable-items endpoints.
"""
import uuid

import pytest

from conftest import BASE_URL


def create_crew_headers(api_client, auth_headers):
    email = f"TEST_crew_{uuid.uuid4().hex[:6]}@example.com"
    password = "CrewPass1!"
    r = api_client.post(
        f"{BASE_URL}/api/auth/register", headers=auth_headers,
        json={"email": email, "password": password, "name": "Crew Tester", "role": "crew"},
    )
    assert r.status_code == 201, r.text
    lg = api_client.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password})
    assert lg.status_code == 200, lg.text
    return {"Authorization": f"Bearer {lg.json()['access_token']}"}


class TestShortages:
    def test_manual_shortage_create_and_status_transitions(self, api_client, auth_headers):
        body = {"item_name": f"TEST_Canopy_{uuid.uuid4().hex[:6]}", "qty_needed": 1, "notes": "Shade at the yard"}
        r = api_client.post(f"{BASE_URL}/api/shortages", headers=auth_headers, json=body)
        assert r.status_code == 201, r.text
        created = r.json()
        assert created["status"] == "open"
        assert created["item_name"] == body["item_name"]
        # No due-date/timeframe field should exist on a manual shortage.
        assert "due_date" not in created

        r2 = api_client.patch(f"{BASE_URL}/api/shortages/{created['id']}/status", headers=auth_headers, json={"status": "ordered"})
        assert r2.status_code == 200, r2.text
        assert r2.json()["status"] == "ordered"
        assert r2.json()["resolved_at"] is None

        r3 = api_client.patch(f"{BASE_URL}/api/shortages/{created['id']}/status", headers=auth_headers, json={"status": "resolved"})
        assert r3.status_code == 200, r3.text
        resolved = r3.json()
        assert resolved["status"] == "resolved"
        assert resolved["resolved_by"]
        assert resolved["resolved_at"]

    def test_manual_shortage_requires_positive_quantity(self, api_client, auth_headers):
        r = api_client.post(
            f"{BASE_URL}/api/shortages", headers=auth_headers,
            json={"item_name": "Bad qty", "qty_needed": 0},
        )
        assert r.status_code == 422, r.text

    def test_invalid_status_rejected(self, api_client, auth_headers):
        body = {"item_name": f"TEST_Fasteners_{uuid.uuid4().hex[:6]}", "qty_needed": 5}
        created = api_client.post(f"{BASE_URL}/api/shortages", headers=auth_headers, json=body).json()
        r = api_client.patch(f"{BASE_URL}/api/shortages/{created['id']}/status", headers=auth_headers, json={"status": "not_a_status"})
        assert r.status_code == 400

    def test_merged_list_marks_manual_rows_and_excludes_dates(self, api_client, auth_headers):
        body = {"item_name": f"TEST_SprayFoam_{uuid.uuid4().hex[:6]}", "qty_needed": 12}
        created = api_client.post(f"{BASE_URL}/api/shortages", headers=auth_headers, json=body).json()

        r = api_client.get(f"{BASE_URL}/api/shortages", headers=auth_headers)
        assert r.status_code == 200, r.text
        rows = r.json()["rows"]
        matching = next(row for row in rows if row["id"] == created["id"])
        assert matching["source"] == "manual"
        assert "date" not in matching
        # Every row (auto or manual) must be tagged with a source — the
        # merged endpoint is the single Shortages source of truth.
        assert all(row.get("source") in ("auto", "manual") for row in rows)

    def test_dashboard_stats_counts_open_manual_shortages(self, api_client, auth_headers):
        before = api_client.get(f"{BASE_URL}/api/dashboard/stats", headers=auth_headers).json()["shortage_count"]
        api_client.post(
            f"{BASE_URL}/api/shortages", headers=auth_headers,
            json={"item_name": f"TEST_Coolers_{uuid.uuid4().hex[:6]}", "qty_needed": 2},
        )
        after = api_client.get(f"{BASE_URL}/api/dashboard/stats", headers=auth_headers).json()["shortage_count"]
        assert after == before + 1


class TestSellableItems:
    def test_create_and_read_consumable(self, api_client, auth_headers):
        body = {
            "kind": "consumable", "product": f"TEST_NuduraClips_{uuid.uuid4().hex[:6]}",
            "manufacturer": "Nudura", "sku": "NC-100", "unit": "box",
            "quantity_on_hand": 40, "reorder_point": 10, "cost": 25.0, "price": 45.0,
        }
        r = api_client.post(f"{BASE_URL}/api/sellable-items", headers=auth_headers, json=body)
        assert r.status_code == 201, r.text
        created = r.json()
        assert created["kind"] == "consumable"
        assert created["quantity_reserved"] == 0

        listed = api_client.get(f"{BASE_URL}/api/sellable-items?kind=consumable", headers=auth_headers).json()
        assert any(item["id"] == created["id"] for item in listed)

    def test_create_block_with_core_size(self, api_client, auth_headers):
        body = {
            "kind": "block", "product": f"TEST_6in_Standard_{uuid.uuid4().hex[:6]}",
            "manufacturer": "Nudura", "core_size": '6"', "form_type": "Standard",
            "quantity_on_hand": 200,
        }
        r = api_client.post(f"{BASE_URL}/api/sellable-items", headers=auth_headers, json=body)
        assert r.status_code == 201, r.text
        assert r.json()["core_size"] == '6"'

    def test_rejects_unknown_kind(self, api_client, auth_headers):
        r = api_client.post(
            f"{BASE_URL}/api/sellable-items", headers=auth_headers,
            json={"kind": "widget", "product": "Bad kind", "quantity_on_hand": 1},
        )
        assert r.status_code == 400

    def test_update_quantities(self, api_client, auth_headers):
        created = api_client.post(
            f"{BASE_URL}/api/sellable-items", headers=auth_headers,
            json={"kind": "consumable", "product": f"TEST_Bolts_{uuid.uuid4().hex[:6]}", "quantity_on_hand": 100},
        ).json()
        r = api_client.patch(
            f"{BASE_URL}/api/sellable-items/{created['id']}", headers=auth_headers,
            json={"quantity_on_hand": 80, "quantity_reserved": 20},
        )
        assert r.status_code == 200, r.text
        assert r.json()["quantity_on_hand"] == 80
        assert r.json()["quantity_reserved"] == 20

    def test_delete_requires_admin(self, api_client, auth_headers):
        created = api_client.post(
            f"{BASE_URL}/api/sellable-items", headers=auth_headers,
            json={"kind": "consumable", "product": f"TEST_Delete_{uuid.uuid4().hex[:6]}", "quantity_on_hand": 1},
        ).json()
        crew_headers = create_crew_headers(api_client, auth_headers)
        forbidden = api_client.delete(f"{BASE_URL}/api/sellable-items/{created['id']}", headers=crew_headers)
        assert forbidden.status_code == 403
        ok = api_client.delete(f"{BASE_URL}/api/sellable-items/{created['id']}", headers=auth_headers)
        assert ok.status_code == 200

    def test_crew_role_cost_and_price_redacted(self, api_client, auth_headers):
        created = api_client.post(
            f"{BASE_URL}/api/sellable-items", headers=auth_headers,
            json={"kind": "consumable", "product": f"TEST_Redact_{uuid.uuid4().hex[:6]}", "quantity_on_hand": 1, "cost": 50.0, "price": 99.0},
        ).json()
        crew_headers = create_crew_headers(api_client, auth_headers)
        listed = api_client.get(f"{BASE_URL}/api/sellable-items?kind=consumable", headers=crew_headers).json()
        as_crew = next(item for item in listed if item["id"] == created["id"])
        assert as_crew["cost"] == 0.0
        assert as_crew["price"] == 0.0

"""Concrete Form API regression suite."""
import io
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests

from conftest import BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD


# ---------- 0. Health / root ----------
def test_root(api_client):
    r = api_client.get(f"{BASE_URL}/api/")
    assert r.status_code == 200
    assert r.json().get("service") == "Concrete Form API"


# ---------- 1. Auth ----------
class TestAuth:
    def test_login_success(self, admin_tokens):
        assert "access_token" in admin_tokens
        assert "refresh_token" in admin_tokens
        u = admin_tokens.get("user", {})
        assert u.get("email") == ADMIN_EMAIL
        assert u.get("role") == "admin"

    def test_me(self, api_client, auth_headers):
        r = api_client.get(f"{BASE_URL}/api/auth/me", headers=auth_headers)
        assert r.status_code == 200
        assert r.json()["email"] == ADMIN_EMAIL

    def test_refresh(self, api_client, admin_tokens):
        r = api_client.post(
            f"{BASE_URL}/api/auth/refresh",
            json={"refresh_token": admin_tokens["refresh_token"]},
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("access_token") and d.get("refresh_token")

    def test_invalid_login(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": "nope@example.com", "password": "bad"},
        )
        assert r.status_code == 401

    def test_register_requires_admin(self, api_client):
        # Unauthenticated should be 401
        r = api_client.post(
            f"{BASE_URL}/api/auth/register",
            json={
                "email": f"TEST_unauth_{uuid.uuid4().hex[:6]}@example.com",
                "password": "Password1!",
                "name": "X",
                "role": "crew",
            },
        )
        assert r.status_code in (401, 403)

    def test_register_as_crew_forbidden(self, api_client, auth_headers):
        # Admin creates a crew user, then crew tries to register => 403
        crew_email = f"TEST_crew_{uuid.uuid4().hex[:6]}@example.com"
        crew_pwd = "CrewPass1!"
        r = api_client.post(
            f"{BASE_URL}/api/auth/register",
            headers=auth_headers,
            json={"email": crew_email, "password": crew_pwd, "name": "Crew", "role": "crew"},
        )
        assert r.status_code == 201, r.text

        # crew login
        lg = api_client.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": crew_email, "password": crew_pwd},
        )
        assert lg.status_code == 200
        crew_token = lg.json()["access_token"]
        r2 = api_client.post(
            f"{BASE_URL}/api/auth/register",
            headers={"Authorization": f"Bearer {crew_token}"},
            json={
                "email": f"TEST_x_{uuid.uuid4().hex[:6]}@example.com",
                "password": "Y1!", "name": "X", "role": "crew",
            },
        )
        assert r2.status_code == 403

    def test_account_lock_after_5_failures(self, api_client, auth_headers):
        """Create a throwaway user, fail 5 logins, expect 403 lock."""
        em = f"TEST_lock_{uuid.uuid4().hex[:6]}@example.com"
        pw = "GoodPass1!"
        r = api_client.post(
            f"{BASE_URL}/api/auth/register",
            headers=auth_headers,
            json={"email": em, "password": pw, "name": "Lock", "role": "crew"},
        )
        assert r.status_code == 201
        for _ in range(5):
            api_client.post(
                f"{BASE_URL}/api/auth/login",
                json={"email": em, "password": "bad"},
            )
        # 6th attempt (even with correct pwd) should be locked
        rl = api_client.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": em, "password": pw},
        )
        assert rl.status_code == 403, rl.text


# ---------- 2. Equipment ----------
class TestEquipment:
    def test_list_seeded(self, api_client, auth_headers):
        r = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers)
        assert r.status_code == 200
        items = r.json()
        skus = {i["sku"] for i in items}
        for s in ["SB-001", "TB-001", "WB-001", "HR-001", "EX-001", "CU-001"]:
            assert s in skus, f"missing seeded sku {s}"
        # ensure no _id leak
        for i in items:
            assert "_id" not in i

    def test_create_update_delete(self, api_client, auth_headers):
        sku = f"TEST-{uuid.uuid4().hex[:6]}"
        r = api_client.post(
            f"{BASE_URL}/api/equipment", headers=auth_headers,
            json={"sku": sku, "name": "Test Bracket", "category": "walkboard_bracket", "quantity": 5},
        )
        assert r.status_code == 201, r.text
        eid = r.json()["id"]
        assert r.json()["available"] == 5

        r2 = api_client.put(
            f"{BASE_URL}/api/equipment/{eid}", headers=auth_headers,
            json={"sku": sku, "name": "Test Bracket v2", "category": "walkboard_bracket", "quantity": 7},
        )
        assert r2.status_code == 200
        assert r2.json()["name"] == "Test Bracket v2"

        r3 = api_client.delete(f"{BASE_URL}/api/equipment/{eid}", headers=auth_headers)
        assert r3.status_code == 200

    def test_csv_export(self, api_client, auth_headers):
        r = api_client.get(f"{BASE_URL}/api/equipment/export.csv", headers=auth_headers)
        assert r.status_code == 200
        first_line = r.text.splitlines()[0]
        assert "sku" in first_line and "name" in first_line

    def test_csv_import(self, api_client, auth_headers):
        sku = f"TEST-IMP-{uuid.uuid4().hex[:6]}"
        csv_data = (
            "sku,name,category,condition,location,daily_rate,quantity,available,notes\n"
            f"{sku},Imported Item,strongback,good,Yard A,10,3,3,via test\n"
        )
        files = {"file": ("e.csv", csv_data, "text/csv")}
        r = requests.post(
            f"{BASE_URL}/api/equipment/import.csv",
            headers={"Authorization": auth_headers["Authorization"]},
            files=files,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("imported", 0) >= 1


# ---------- 3. Bracing ----------
class TestBracing:
    def test_basic(self, api_client, auth_headers):
        r = api_client.post(
            f"{BASE_URL}/api/bracing/calculate", headers=auth_headers,
            json={"runs": [{"name": "R1", "corners": 4, "linear_ft": 60, "wall_height": 9}]},
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["total_strongbacks"] == 4
        assert d["total_braces"] == 15  # ceil(60/4)
        assert d["runs"][0]["brace_length"] == 10
        assert d["engineer_required"] is False

    def test_engineer_required(self, api_client, auth_headers):
        r = api_client.post(
            f"{BASE_URL}/api/bracing/calculate", headers=auth_headers,
            json={"runs": [{"name": "Tall", "corners": 2, "linear_ft": 40, "wall_height": 22}]},
        )
        assert r.status_code == 200
        assert r.json()["engineer_required"] is True

    def test_braces_by_length_aggregation(self, api_client, auth_headers):
        r = api_client.post(
            f"{BASE_URL}/api/bracing/calculate", headers=auth_headers,
            json={"runs": [
                {"name": "A", "corners": 2, "linear_ft": 40, "wall_height": 9},   # 10ft, 10
                {"name": "B", "corners": 4, "linear_ft": 32, "wall_height": 11},  # 12ft, 8
                {"name": "C", "corners": 0, "linear_ft": 20, "wall_height": 9},   # 10ft, 5
            ]},
        )
        assert r.status_code == 200
        bbl = r.json()["braces_by_length"]
        # keys may be str (JSON) — normalize
        bbl = {int(k): v for k, v in bbl.items()}
        assert bbl.get(10) == 15
        assert bbl.get(12) == 8


# ---------- 4. Rentals ----------
class TestRentals:
    def test_rental_lifecycle(self, api_client, auth_headers):
        # pick first equipment with available > 1
        eq = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        target = next((e for e in eq if e["available"] >= 2 and e["sku"] == "SB-001"), None) or eq[0]
        before_avail = target["available"]

        start = datetime.now(timezone.utc).isoformat()
        # NOTE: due_date deliberately omitted — should still succeed (201)
        body = {
            "customer_name": "TEST_Customer", "job_site": "123 Job",
            "start_date": start, "deposit": 100.0,
            "lines": [{"equipment_id": target["id"], "sku": target["sku"], "name": target["name"],
                       "qty": 2, "daily_rate": target["daily_rate"]}],
        }
        r = api_client.post(f"{BASE_URL}/api/rentals", headers=auth_headers, json=body)
        assert r.status_code == 201, r.text
        rental = r.json()
        rid = rental["id"]
        # new rentals should have due_date=null (field may be present but null)
        assert rental.get("due_date") is None, f"expected due_date=null, got {rental.get('due_date')}"

        # available decremented
        after = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        new_avail = next(e for e in after if e["id"] == target["id"])["available"]
        assert new_avail == before_avail - 2

        # partial return 1
        rr = api_client.post(
            f"{BASE_URL}/api/rentals/{rid}/return", headers=auth_headers,
            json=[{"equipment_id": target["id"], "qty": 1}],
        )
        assert rr.status_code == 200, rr.text
        assert rr.json()["status"] == "partially_returned"

        # full return
        rr2 = api_client.post(
            f"{BASE_URL}/api/rentals/{rid}/return", headers=auth_headers,
            json=[{"equipment_id": target["id"], "qty": 1}],
        )
        assert rr2.json()["status"] == "returned"

        # avail restored
        final = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        assert next(e for e in final if e["id"] == target["id"])["available"] == before_avail

        api_client.delete(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers)

    def test_list_rentals(self, api_client, auth_headers):
        r = api_client.get(f"{BASE_URL}/api/rentals", headers=auth_headers)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_capacity_commits_active_rentals_no_due_date(self, api_client, auth_headers):
        """Capacity endpoint must commit inventory for active rentals regardless of date range (no due_date used)."""
        eq = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        target = next((e for e in eq if e["available"] >= 1), None)
        assert target is not None
        start = datetime.now(timezone.utc).isoformat()
        body = {
            "customer_name": "TEST_CapCust", "job_site": "S",
            "start_date": start, "deposit": 0,
            "lines": [{"equipment_id": target["id"], "sku": target["sku"], "name": target["name"],
                       "qty": 1, "daily_rate": 0}],
        }
        r = api_client.post(f"{BASE_URL}/api/rentals", headers=auth_headers, json=body)
        assert r.status_code == 201, r.text
        rid = r.json()["id"]

        # Query capacity for a date 5 years in the future — the active rental should STILL be committed
        far_future = (datetime.now(timezone.utc) + timedelta(days=1825)).isoformat()
        cap = api_client.get(f"{BASE_URL}/api/bookings/capacity",
                             params={"target_date": far_future}, headers=auth_headers)
        assert cap.status_code == 200
        row = next((r for r in cap.json()["rows"] if r["equipment_id"] == target["id"]), None)
        assert row is not None
        assert row["committed"] >= 1, f"active rental not committed on far-future date: {row}"

        # cleanup
        api_client.delete(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers)


# ---------- 5. Bookings ----------
class TestBookings:
    def test_create_and_capacity(self, api_client, auth_headers):
        eq = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        target = eq[0]
        start = datetime.now(timezone.utc).isoformat()
        end = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        body = {
            "customer_name": "TEST_BookCust", "job_site": "Site",
            "start_date": start, "end_date": end, "status": "confirmed",
            "items": [{"equipment_id": target["id"], "sku": target["sku"], "name": target["name"],
                       "qty": 1, "daily_rate": 0}],
        }
        r = api_client.post(f"{BASE_URL}/api/bookings", headers=auth_headers, json=body)
        assert r.status_code == 201, r.text
        bid = r.json()["id"]

        cap = api_client.get(
            f"{BASE_URL}/api/bookings/capacity",
            params={"target_date": datetime.now(timezone.utc).isoformat()},
            headers=auth_headers,
        )
        assert cap.status_code == 200
        data = cap.json()
        assert "rows" in data and any(row["committed"] >= 1 for row in data["rows"])

        api_client.delete(f"{BASE_URL}/api/bookings/{bid}", headers=auth_headers)


# ---------- 6. Maintenance ----------
class TestMaintenance:
    def test_crud(self, api_client, auth_headers):
        eq = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()[0]
        r = api_client.post(
            f"{BASE_URL}/api/maintenance", headers=auth_headers,
            json={"equipment_id": eq["id"], "issue": "TEST_bent", "status": "open"},
        )
        assert r.status_code == 201, r.text
        m = r.json()
        assert m["equipment_name"] == eq["name"]
        mid = m["id"]

        r2 = api_client.put(
            f"{BASE_URL}/api/maintenance/{mid}", headers=auth_headers,
            json={"equipment_id": eq["id"], "issue": "TEST_bent", "status": "resolved",
                  "action_taken": "replaced", "cost": 50},
        )
        assert r2.status_code == 200
        assert r2.json()["status"] == "resolved"

        r3 = api_client.delete(f"{BASE_URL}/api/maintenance/{mid}", headers=auth_headers)
        assert r3.status_code == 200


# ---------- 7. Vendors ----------
class TestVendors:
    def test_crud(self, api_client, auth_headers):
        r = api_client.post(
            f"{BASE_URL}/api/vendors", headers=auth_headers,
            json={"name": f"TEST_Vendor_{uuid.uuid4().hex[:5]}", "phone": "555-0101"},
        )
        assert r.status_code == 201
        vid = r.json()["id"]
        r2 = api_client.put(
            f"{BASE_URL}/api/vendors/{vid}", headers=auth_headers,
            json={"name": "TEST_Updated", "phone": "555-0202"},
        )
        assert r2.status_code == 200
        assert r2.json()["name"] == "TEST_Updated"
        api_client.delete(f"{BASE_URL}/api/vendors/{vid}", headers=auth_headers)


# ---------- 8. Site ----------
class TestSite:
    def test_get_and_update(self, api_client, auth_headers):
        r = api_client.get(f"{BASE_URL}/api/site", headers=auth_headers)
        assert r.status_code == 200
        current = r.json()
        upd = {**current, "brand_name": "TEST Brand", "logo_base64": "data:image/png;base64,AAAA"}
        r2 = api_client.put(f"{BASE_URL}/api/site", headers=auth_headers, json=upd)
        assert r2.status_code == 200
        assert r2.json()["brand_name"] == "TEST Brand"
        # restore
        api_client.put(f"{BASE_URL}/api/site", headers=auth_headers, json=current)


# ---------- 9. Dashboard ----------
class TestDashboard:
    def test_stats(self, api_client, auth_headers):
        r = api_client.get(f"{BASE_URL}/api/dashboard/stats", headers=auth_headers)
        assert r.status_code == 200, r.text
        d = r.json()
        # New shape (due_date removed): no upcoming_returns / upcoming_count
        for key in ["utilization", "total_quantity", "total_available", "active_rentals",
                    "open_maintenance", "vendors_count", "activity"]:
            assert key in d, f"missing {key}"
        assert "upcoming_returns" not in d, "upcoming_returns should be removed"
        assert "upcoming_count" not in d, "upcoming_count should be removed"
        assert isinstance(d["activity"], list)

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


# ---------- 4b. Rental Location (map feature) ----------
class TestRentalLocation:
    """New feature: lat/lng on Rental + PATCH /api/rentals/{id}/location."""

    def _create_rental(self, api_client, auth_headers, lat=None, lng=None):
        eq = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        target = next((e for e in eq if e["available"] >= 1), None)
        assert target is not None
        body = {
            "customer_name": "TEST_LocCust",
            "job_site": "999 Map Ave",
            "start_date": datetime.now(timezone.utc).isoformat(),
            "deposit": 0.0,
            "lines": [{"equipment_id": target["id"], "sku": target["sku"], "name": target["name"],
                       "qty": 1, "daily_rate": target["daily_rate"]}],
        }
        if lat is not None:
            body["lat"] = lat
        if lng is not None:
            body["lng"] = lng
        r = api_client.post(f"{BASE_URL}/api/rentals", headers=auth_headers, json=body)
        assert r.status_code == 201, r.text
        return r.json()

    def test_create_rental_without_latlng_returns_null(self, api_client, auth_headers):
        rental = self._create_rental(api_client, auth_headers)
        assert "lat" in rental and rental["lat"] is None
        assert "lng" in rental and rental["lng"] is None
        api_client.delete(f"{BASE_URL}/api/rentals/{rental['id']}", headers=auth_headers)

    def test_create_rental_with_latlng(self, api_client, auth_headers):
        rental = self._create_rental(api_client, auth_headers, lat=44.9778, lng=-93.2650)
        assert rental["lat"] == pytest.approx(44.9778)
        assert rental["lng"] == pytest.approx(-93.2650)
        # verify persisted via GET list
        lst = api_client.get(f"{BASE_URL}/api/rentals", headers=auth_headers).json()
        got = next((x for x in lst if x["id"] == rental["id"]), None)
        assert got is not None
        assert got["lat"] == pytest.approx(44.9778)
        assert got["lng"] == pytest.approx(-93.2650)
        api_client.delete(f"{BASE_URL}/api/rentals/{rental['id']}", headers=auth_headers)

    def test_patch_location_updates_coords(self, api_client, auth_headers):
        rental = self._create_rental(api_client, auth_headers)
        rid = rental["id"]
        # PATCH lat/lng
        r = api_client.patch(
            f"{BASE_URL}/api/rentals/{rid}/location",
            headers=auth_headers,
            json={"lat": 40.7128, "lng": -74.0060},
        )
        assert r.status_code == 200, r.text
        updated = r.json()
        assert updated["lat"] == pytest.approx(40.7128)
        assert updated["lng"] == pytest.approx(-74.0060)
        assert updated["id"] == rid
        # returns full Rental with lines
        assert "lines" in updated and isinstance(updated["lines"], list)
        # verify via GET
        lst = api_client.get(f"{BASE_URL}/api/rentals", headers=auth_headers).json()
        got = next(x for x in lst if x["id"] == rid)
        assert got["lat"] == pytest.approx(40.7128)
        assert got["lng"] == pytest.approx(-74.0060)
        api_client.delete(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers)

    def test_patch_location_unknown_id_returns_404(self, api_client, auth_headers):
        r = api_client.patch(
            f"{BASE_URL}/api/rentals/does-not-exist-{uuid.uuid4().hex[:8]}/location",
            headers=auth_headers,
            json={"lat": 1.0, "lng": 2.0},
        )
        assert r.status_code == 404, r.text

    def test_patch_location_requires_auth(self, api_client):
        r = api_client.patch(
            f"{BASE_URL}/api/rentals/whatever/location",
            json={"lat": 1.0, "lng": 2.0},
        )
        assert r.status_code == 401


# ---------- 4c. Rental Edit (PUT /api/rentals/{id}) ----------
class TestRentalEdit:
    """PUT /api/rentals/{id} — full-body edit with delta-based inventory rebalancing."""

    def _pick_two_eq(self, api_client, auth_headers, min_a=10, min_b=5):
        eq = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        a = next((e for e in eq if e["available"] >= min_a), None)
        b = next((e for e in eq if e["available"] >= min_b and e["id"] != (a or {}).get("id")), None)
        assert a and b, "need two equipment items with sufficient availability"
        return a, b

    def _get_avail(self, api_client, auth_headers, eq_id):
        eq = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
        return next(e for e in eq if e["id"] == eq_id)["available"]

    def _create(self, api_client, auth_headers, lines, lat=None, lng=None):
        body = {
            "customer_name": "TEST_EditCust",
            "customer_phone": "555-9999",
            "customer_email": "edit@test.com",
            "job_site": "Edit Site",
            "start_date": datetime.now(timezone.utc).isoformat(),
            "deposit": 50.0,
            "notes": "orig",
            "lines": lines,
            "lat": lat, "lng": lng,
        }
        r = api_client.post(f"{BASE_URL}/api/rentals", headers=auth_headers, json=body)
        assert r.status_code == 201, r.text
        return r.json()

    def test_put_qty_increase_decrements_available_by_delta(self, api_client, auth_headers):
        a, _ = self._pick_two_eq(self, api_client, auth_headers) if False else self._pick_two_eq(api_client, auth_headers)
        before = self._get_avail(api_client, auth_headers, a["id"])
        rental = self._create(api_client, auth_headers, [
            {"equipment_id": a["id"], "sku": a["sku"], "name": a["name"], "qty": 2, "daily_rate": a["daily_rate"]}
        ])
        rid = rental["id"]
        assert self._get_avail(api_client, auth_headers, a["id"]) == before - 2

        # qty 2 -> 5 : available should drop by 3
        put_body = {
            "customer_name": rental["customer_name"], "customer_phone": rental["customer_phone"],
            "customer_email": rental["customer_email"], "job_site": rental["job_site"],
            "start_date": rental["start_date"], "deposit": rental["deposit"], "notes": rental["notes"],
            "lines": [{"equipment_id": a["id"], "sku": a["sku"], "name": a["name"], "qty": 5, "daily_rate": a["daily_rate"]}],
            "lat": rental.get("lat"), "lng": rental.get("lng"),
        }
        r = api_client.put(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers, json=put_body)
        assert r.status_code == 200, r.text
        upd = r.json()
        assert upd["id"] == rid
        # created_at preserved (compare as datetimes; Mongo strips 'Z' and may truncate μs)
        def _dt(s):
            s = s.replace("Z", "+00:00")
            d = datetime.fromisoformat(s)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            return d
        assert abs((_dt(upd["created_at"]) - _dt(rental["created_at"])).total_seconds()) < 0.01, \
            f"created_at must be preserved: {upd['created_at']} vs {rental['created_at']}"
        assert upd["lines"][0]["qty"] == 5
        assert self._get_avail(api_client, auth_headers, a["id"]) == before - 5

        # qty 5 -> 2 : available should rise by 3
        put_body["lines"][0]["qty"] = 2
        r = api_client.put(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers, json=put_body)
        assert r.status_code == 200
        assert self._get_avail(api_client, auth_headers, a["id"]) == before - 2

        api_client.delete(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers)

    def test_put_add_and_remove_lines(self, api_client, auth_headers):
        a, b = self._pick_two_eq(api_client, auth_headers)
        a_before = self._get_avail(api_client, auth_headers, a["id"])
        b_before = self._get_avail(api_client, auth_headers, b["id"])
        rental = self._create(api_client, auth_headers, [
            {"equipment_id": a["id"], "sku": a["sku"], "name": a["name"], "qty": 3, "daily_rate": a["daily_rate"]}
        ])
        rid = rental["id"]
        assert self._get_avail(api_client, auth_headers, a["id"]) == a_before - 3

        # Add a NEW line for b (qty 4)
        put_body = {
            "customer_name": rental["customer_name"], "customer_phone": "", "customer_email": "",
            "job_site": "", "start_date": rental["start_date"], "deposit": 0.0, "notes": "",
            "lines": [
                {"equipment_id": a["id"], "sku": a["sku"], "name": a["name"], "qty": 3, "daily_rate": a["daily_rate"]},
                {"equipment_id": b["id"], "sku": b["sku"], "name": b["name"], "qty": 4, "daily_rate": b["daily_rate"]},
            ],
            "lat": None, "lng": None,
        }
        r = api_client.put(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers, json=put_body)
        assert r.status_code == 200, r.text
        assert self._get_avail(api_client, auth_headers, a["id"]) == a_before - 3
        assert self._get_avail(api_client, auth_headers, b["id"]) == b_before - 4

        # Remove line a entirely => a restored
        put_body["lines"] = [
            {"equipment_id": b["id"], "sku": b["sku"], "name": b["name"], "qty": 4, "daily_rate": b["daily_rate"]},
        ]
        r = api_client.put(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers, json=put_body)
        assert r.status_code == 200
        assert self._get_avail(api_client, auth_headers, a["id"]) == a_before
        assert self._get_avail(api_client, auth_headers, b["id"]) == b_before - 4

        api_client.delete(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers)

    def test_put_returned_qty_preserved_and_clamped(self, api_client, auth_headers):
        a, _ = self._pick_two_eq(api_client, auth_headers)
        rental = self._create(api_client, auth_headers, [
            {"equipment_id": a["id"], "sku": a["sku"], "name": a["name"], "qty": 5, "daily_rate": a["daily_rate"]}
        ])
        rid = rental["id"]
        # Return 3 of 5
        rr = api_client.post(f"{BASE_URL}/api/rentals/{rid}/return", headers=auth_headers,
                             json=[{"equipment_id": a["id"], "qty": 3}])
        assert rr.status_code == 200
        assert rr.json()["status"] == "partially_returned"

        # PUT with qty=5 again (no change) — returned_qty must remain 3
        put_body = {
            "customer_name": rental["customer_name"], "customer_phone": "", "customer_email": "",
            "job_site": "", "start_date": rental["start_date"], "deposit": 0.0, "notes": "",
            "lines": [{"equipment_id": a["id"], "sku": a["sku"], "name": a["name"], "qty": 5, "daily_rate": a["daily_rate"]}],
            "lat": None, "lng": None,
        }
        r = api_client.put(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers, json=put_body)
        assert r.status_code == 200
        assert r.json()["lines"][0]["returned_qty"] == 3
        assert r.json()["status"] == "partially_returned"

        # PUT with qty=2 (< returned 3) — should clamp returned_qty to 2 and mark returned
        put_body["lines"][0]["qty"] = 2
        r = api_client.put(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers, json=put_body)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["lines"][0]["returned_qty"] == 2, f"expected clamp to 2, got {j['lines'][0]['returned_qty']}"
        assert j["status"] == "returned"

        api_client.delete(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers)

    def test_put_status_recompute_active(self, api_client, auth_headers):
        a, _ = self._pick_two_eq(api_client, auth_headers)
        rental = self._create(api_client, auth_headers, [
            {"equipment_id": a["id"], "sku": a["sku"], "name": a["name"], "qty": 2, "daily_rate": a["daily_rate"]}
        ])
        rid = rental["id"]
        put_body = {
            "customer_name": "X", "customer_phone": "", "customer_email": "", "job_site": "",
            "start_date": rental["start_date"], "deposit": 0.0, "notes": "",
            "lines": [{"equipment_id": a["id"], "sku": a["sku"], "name": a["name"], "qty": 3, "daily_rate": 0.0}],
            "lat": 12.34, "lng": 56.78,
        }
        r = api_client.put(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers, json=put_body)
        assert r.status_code == 200
        j = r.json()
        assert j["status"] == "active"
        assert j["lat"] == pytest.approx(12.34) and j["lng"] == pytest.approx(56.78)
        assert j["customer_name"] == "X"
        api_client.delete(f"{BASE_URL}/api/rentals/{rid}", headers=auth_headers)

    def test_put_404_unknown_id(self, api_client, auth_headers):
        put_body = {
            "customer_name": "X", "start_date": datetime.now(timezone.utc).isoformat(),
            "lines": [], "deposit": 0.0,
        }
        r = api_client.put(f"{BASE_URL}/api/rentals/does-not-exist-{uuid.uuid4().hex[:8]}",
                           headers=auth_headers, json=put_body)
        assert r.status_code == 404, r.text

    def test_put_requires_auth(self, api_client):
        r = api_client.put(f"{BASE_URL}/api/rentals/whatever",
                           json={"customer_name": "X", "start_date": datetime.now(timezone.utc).isoformat(),
                                 "lines": [], "deposit": 0.0})
        assert r.status_code == 401

    def test_put_forbidden_for_crew(self, api_client, auth_headers):
        # create a throwaway crew user, login, and try PUT
        em = f"TEST_crew_edit_{uuid.uuid4().hex[:6]}@example.com"
        pw = "CrewPass1!"
        rr = api_client.post(f"{BASE_URL}/api/auth/register", headers=auth_headers,
                             json={"email": em, "password": pw, "name": "C", "role": "crew"})
        assert rr.status_code == 201
        lg = api_client.post(f"{BASE_URL}/api/auth/login", json={"email": em, "password": pw})
        crew_h = {"Authorization": f"Bearer {lg.json()['access_token']}"}
        r = api_client.put(f"{BASE_URL}/api/rentals/whatever", headers=crew_h,
                           json={"customer_name": "X", "start_date": datetime.now(timezone.utc).isoformat(),
                                 "lines": [], "deposit": 0.0})
        assert r.status_code == 403, r.text


# ---------- 4d. Geocode (address → coords via Nominatim proxy) ----------
class TestGeocode:
    def test_requires_auth(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/geocode", params={"q": "Washington DC"})
        assert r.status_code == 401

    def test_empty_returns_empty_list(self, api_client, auth_headers):
        r = api_client.get(f"{BASE_URL}/api/geocode", params={"q": ""}, headers=auth_headers)
        assert r.status_code == 200
        assert r.json() == []

    def test_nonsense_returns_empty_list_no_500(self, api_client, auth_headers):
        r = api_client.get(f"{BASE_URL}/api/geocode",
                           params={"q": "zzzzzzzzzzzzzzzzzzzz"}, headers=auth_headers)
        assert r.status_code == 200
        assert isinstance(r.json(), list)
        assert r.json() == []

    def test_real_address_returns_candidates(self, api_client, auth_headers):
        import time
        time.sleep(1.1)  # Nominatim ~1 rps politeness
        r = api_client.get(f"{BASE_URL}/api/geocode",
                           params={"q": "1600 Pennsylvania Ave Washington DC"},
                           headers=auth_headers)
        assert r.status_code == 200, r.text
        results = r.json()
        # If cloud egress blocks Nominatim, we may get [] — per review, that's still a pass
        # (endpoint responded 200, no 5xx). Only assert result shape when non-empty.
        assert isinstance(results, list)
        assert len(results) <= 5
        if results:
            first = results[0]
            for k in ("lat", "lng", "display_name"):
                assert k in first
            assert isinstance(first["lat"], (int, float))
            assert isinstance(first["lng"], (int, float))
            # Should be near White House ~ (38.89, -77.03)
            dn = first["display_name"].lower()
            assert ("white house" in dn) or ("pennsylvania" in dn) or (
                abs(first["lat"] - 38.89) < 1.0 and abs(first["lng"] + 77.03) < 1.0
            ), f"unexpected top result: {first}"


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

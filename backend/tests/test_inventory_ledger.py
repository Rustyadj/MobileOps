"""Inventory ledger regression suite.

Guards the bucket accounting engine that the rest of MobileOps trusts to
answer "what do we own, where is it, what's available" correctly. Every
test that mutates equipment re-fetches it and checks the core invariant:

    owned == available + reserved + on_rental + in_transit
             + pending_inspection + in_maintenance + missing

Covers: booking reserve/cancel, booking dispatch (the only path from a
reservation into a rental — prevents double-committing the same units),
partial return with a damaged subset (regression guard for the
returned_qty/damaged_qty double-counting bug), inspection pass/fail,
repair-task completion, transfers, physical-count reconciliation, and
rental delete/edit rollback.
"""
import uuid

import pytest

from conftest import BASE_URL

BUCKET_FIELDS = [
    "available", "reserved", "staged", "outbound", "on_rental", "inbound",
    "in_transit", "pending_inspection", "in_maintenance", "missing",
]


def assert_invariant(eq: dict):
    total = sum(eq[b] for b in BUCKET_FIELDS)
    assert total == eq["quantity"], (
        f"Invariant violated for {eq['sku']}: owned={eq['quantity']} sum(buckets)={total} ({eq})"
    )


def create_equipment(api_client, auth_headers, qty=100, **overrides):
    sku = f"TEST-LEDGER-{uuid.uuid4().hex[:8]}"
    body = {"sku": sku, "name": "Test Strongback", "category": "strongback", "quantity": qty, "available": qty}
    body.update(overrides)
    r = api_client.post(f"{BASE_URL}/api/equipment", headers=auth_headers, json=body)
    assert r.status_code == 201, r.text
    eq = r.json()
    assert_invariant(eq)
    return eq


def get_equipment(api_client, auth_headers, eq_id):
    items = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers).json()
    eq = next(e for e in items if e["id"] == eq_id)
    assert_invariant(eq)
    return eq


def create_rental(api_client, auth_headers, eq, qty, **overrides):
    body = {
        "customer_name": f"Test Customer {uuid.uuid4().hex[:4]}", "job_site": "Test Site",
        "start_date": "2026-08-20T00:00:00Z",
        "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": qty, "daily_rate": 0}],
    }
    body.update(overrides)
    r = api_client.post(f"{BASE_URL}/api/rentals", headers=auth_headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def create_booking(api_client, auth_headers, eq, qty, **overrides):
    body = {
        "customer_name": f"Test Booking {uuid.uuid4().hex[:4]}", "job_site": "Test Site",
        "start_date": "2026-09-01T00:00:00Z", "end_date": "2026-09-03T00:00:00Z",
        "items": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": qty, "daily_rate": 0}],
    }
    body.update(overrides)
    r = api_client.post(f"{BASE_URL}/api/bookings", headers=auth_headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


class TestBucketInvariant:
    def test_fresh_equipment_invariant(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=50)
        assert eq["available"] == 50
        assert eq["reserved"] == eq["staged"] == eq["outbound"] == eq["on_rental"] == eq["inbound"] == eq["in_transit"] == 0
        assert eq["pending_inspection"] == eq["in_maintenance"] == eq["missing"] == 0


class TestBookingReserveCancel:
    def test_reserve_then_cancel_returns_to_available(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=100)
        bk = create_booking(api_client, auth_headers, eq, 30)

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["reserved"] == 30 and eq2["available"] == 70

        r = api_client.patch(f"{BASE_URL}/api/bookings/{bk['id']}/status", headers=auth_headers, json={"status": "cancelled"})
        assert r.status_code == 200, r.text

        eq3 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq3["reserved"] == 0 and eq3["available"] == 100

    def test_delete_booking_releases_reservation(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=100)
        bk = create_booking(api_client, auth_headers, eq, 25)
        r = api_client.delete(f"{BASE_URL}/api/bookings/{bk['id']}", headers=auth_headers)
        assert r.status_code == 200

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["reserved"] == 0 and eq2["available"] == 100


class TestBookingDispatch:
    def test_dispatch_requires_confirmed(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=100)
        bk = create_booking(api_client, auth_headers, eq, 40)
        r = api_client.post(f"{BASE_URL}/api/bookings/{bk['id']}/dispatch", headers=auth_headers)
        assert r.status_code == 400

    def test_dispatch_moves_reserved_to_on_rental_without_double_commit(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=100)
        bk = create_booking(api_client, auth_headers, eq, 40)
        r = api_client.patch(f"{BASE_URL}/api/bookings/{bk['id']}/status", headers=auth_headers, json={"status": "confirmed"})
        assert r.status_code == 200, r.text

        r = api_client.post(f"{BASE_URL}/api/bookings/{bk['id']}/dispatch", headers=auth_headers)
        assert r.status_code == 201, r.text
        rental = r.json()
        assert rental["lines"][0]["qty"] == 40

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["reserved"] == 0 and eq2["on_rental"] == 40

        # A second dispatch, or any status change, must be rejected — the
        # reservation is already spent, so nothing should be double-committed.
        r = api_client.post(f"{BASE_URL}/api/bookings/{bk['id']}/dispatch", headers=auth_headers)
        assert r.status_code == 400
        r = api_client.patch(f"{BASE_URL}/api/bookings/{bk['id']}/status", headers=auth_headers, json={"status": "cancelled"})
        assert r.status_code == 400

        # Deleting the now-dispatched booking must not phantom-release units
        # that already belong to the rental.
        r = api_client.delete(f"{BASE_URL}/api/bookings/{bk['id']}", headers=auth_headers)
        assert r.status_code == 200
        eq3 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq3["on_rental"] == 40 and eq3["reserved"] == 0


class TestPartialReturnDamaged:
    def test_returned_qty_includes_damaged_not_double_counted(self, api_client, auth_headers):
        """Regression guard: 100 delivered, 10 returned (2 damaged) must
        leave 90 on site, not 88 — damaged_qty is a subset of returned_qty,
        not an additional deduction."""
        eq = create_equipment(api_client, auth_headers, qty=200)
        rental = create_rental(api_client, auth_headers, eq, 100)

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["on_rental"] == 100

        r = api_client.post(
            f"{BASE_URL}/api/rentals/{rental['id']}/return", headers=auth_headers,
            json=[{"equipment_id": eq["id"], "qty": 10, "damaged_qty": 2}],
        )
        assert r.status_code == 200, r.text
        line = r.json()["lines"][0]
        assert line["returned_qty"] == 10
        assert line["damaged_qty"] == 2

        eq3 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq3["on_rental"] == 90, f"expected 90 on site, got {eq3['on_rental']}"
        assert eq3["pending_inspection"] == 8
        assert eq3["in_maintenance"] == 2

        # A damaged return auto-creates a high-priority repair task.
        tasks = api_client.get(f"{BASE_URL}/api/shop-tasks", headers=auth_headers).json()
        repair = next((t for t in tasks if t["related_rental_id"] == rental["id"] and t["task_type"] == "repair"), None)
        assert repair is not None and repair["qty"] == 2

    def test_full_return_closes_rental(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=50)
        rental = create_rental(api_client, auth_headers, eq, 20)
        r = api_client.post(
            f"{BASE_URL}/api/rentals/{rental['id']}/return", headers=auth_headers,
            json=[{"equipment_id": eq["id"], "qty": 20, "damaged_qty": 0}],
        )
        assert r.status_code == 200
        assert r.json()["status"] == "returned"
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["on_rental"] == 0


class TestInspection:
    def test_inspect_pass_and_fail(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=50)
        rental = create_rental(api_client, auth_headers, eq, 20)
        api_client.post(
            f"{BASE_URL}/api/rentals/{rental['id']}/return", headers=auth_headers,
            json=[{"equipment_id": eq["id"], "qty": 20, "damaged_qty": 0}],
        )
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["pending_inspection"] == 20

        r = api_client.post(
            f"{BASE_URL}/api/equipment/{eq['id']}/inspect", headers=auth_headers,
            json={"qty": 15, "outcome": "available", "note": "clean"},
        )
        assert r.status_code == 200, r.text
        r = api_client.post(
            f"{BASE_URL}/api/equipment/{eq['id']}/inspect", headers=auth_headers,
            json={"qty": 5, "outcome": "damaged", "note": "cracked"},
        )
        assert r.status_code == 200, r.text

        eq3 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq3["pending_inspection"] == 0
        assert eq3["in_maintenance"] == 5
        assert eq3["available"] == 30 + 15

    def test_inspect_qty_over_pending_rejected(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        r = api_client.post(
            f"{BASE_URL}/api/equipment/{eq['id']}/inspect", headers=auth_headers,
            json={"qty": 1, "outcome": "available", "note": ""},
        )
        assert r.status_code == 400


class TestRepairCompletion:
    def test_completing_repair_task_moves_maintenance_to_available(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=30)
        rental = create_rental(api_client, auth_headers, eq, 10)
        api_client.post(
            f"{BASE_URL}/api/rentals/{rental['id']}/return", headers=auth_headers,
            json=[{"equipment_id": eq["id"], "qty": 4, "damaged_qty": 4}],
        )
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["in_maintenance"] == 4

        tasks = api_client.get(f"{BASE_URL}/api/shop-tasks", headers=auth_headers).json()
        repair = next(t for t in tasks if t["related_rental_id"] == rental["id"] and t["task_type"] == "repair")

        r = api_client.patch(f"{BASE_URL}/api/shop-tasks/{repair['id']}/status", headers=auth_headers, json={"status": "done"})
        assert r.status_code == 200, r.text
        assert r.json()["completed_by"]

        eq3 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq3["in_maintenance"] == 0
        assert eq3["available"] == eq2["available"] + 4

    def test_manual_repair_task_qty_clamped_to_actual_maintenance(self, api_client, auth_headers):
        """A manually-created repair task with a qty that doesn't line up
        with real in_maintenance units must never drive the bucket negative."""
        eq = create_equipment(api_client, auth_headers, qty=20)
        r = api_client.post(
            f"{BASE_URL}/api/shop-tasks", headers=auth_headers,
            json={"title": "Repair 6 (no real damage on file)", "task_type": "repair", "priority": "high",
                  "qty": 6, "related_equipment_id": eq["id"]},
        )
        assert r.status_code == 201, r.text
        task = r.json()

        r = api_client.patch(f"{BASE_URL}/api/shop-tasks/{task['id']}/status", headers=auth_headers, json={"status": "done"})
        assert r.status_code == 200, r.text

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["in_maintenance"] == 0, "in_maintenance must never go negative"
        assert eq2["available"] == 20


class TestTransfers:
    def test_transfer_out_and_receive(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=40, location="Yard A")
        r = api_client.post(
            f"{BASE_URL}/api/equipment/{eq['id']}/transfer", headers=auth_headers,
            json={"qty": 15, "to_location": "Yard B", "note": "rebalance"},
        )
        assert r.status_code == 201, r.text
        transfer = r.json()
        assert transfer["status"] == "in_transit"

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["in_transit"] == 15 and eq2["available"] == 25

        r = api_client.post(f"{BASE_URL}/api/transfers/{transfer['id']}/receive", headers=auth_headers)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "received"

        eq3 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq3["in_transit"] == 0 and eq3["available"] == 40
        # A partial transfer must not relabel the whole SKU's pool: Yard A
        # still holds more units (25) than Yard B (15), so it stays primary.
        assert eq3["location"] == "Yard A"
        assert eq3["location_balances"] == {"Yard A": 25, "Yard B": 15}

    def test_partial_transfer_does_not_relocate_whole_pool(self, api_client, auth_headers):
        """Regression for: receiving part of a transfer used to overwrite the
        equipment's single `location` field for its ENTIRE available pool,
        even though only a fraction of the units actually moved yards."""
        eq = create_equipment(api_client, auth_headers, qty=40, location="Yard A")
        r = api_client.post(
            f"{BASE_URL}/api/equipment/{eq['id']}/transfer", headers=auth_headers,
            json={"qty": 15, "to_location": "Yard B", "note": ""},
        )
        assert r.status_code == 201, r.text
        transfer = r.json()
        r = api_client.post(f"{BASE_URL}/api/transfers/{transfer['id']}/receive", headers=auth_headers)
        assert r.status_code == 200, r.text

        breakdown = api_client.get(f"{BASE_URL}/api/equipment/{eq['id']}/breakdown", headers=auth_headers).json()
        yard_rows = {row["label"]: row["qty"] for row in breakdown["rows"] if row["kind"] == "yard"}
        assert yard_rows == {"Yard A": 25, "Yard B": 15}

        # A second transfer that tips the balance toward Yard B moves the
        # equipment's primary `location`, but the split is still exact.
        r = api_client.post(
            f"{BASE_URL}/api/equipment/{eq['id']}/transfer", headers=auth_headers,
            json={"qty": 20, "to_location": "Yard B", "note": ""},
        )
        assert r.status_code == 400, "Yard A only has 25 available, not 20+15 already at Yard B"

    def test_transfer_over_available_rejected(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=5)
        r = api_client.post(
            f"{BASE_URL}/api/equipment/{eq['id']}/transfer", headers=auth_headers,
            json={"qty": 6, "to_location": "Yard B", "note": ""},
        )
        assert r.status_code == 400

    def test_transfer_over_source_location_balance_rejected(self, api_client, auth_headers):
        """qty must be checked against the SOURCE location's own balance, not
        just the SKU's total available count across all locations."""
        eq = create_equipment(api_client, auth_headers, qty=40, location="Yard A")
        r = api_client.post(
            f"{BASE_URL}/api/equipment/{eq['id']}/transfer", headers=auth_headers,
            json={"qty": 15, "to_location": "Yard B", "note": ""},
        )
        assert r.status_code == 201, r.text
        # Yard A now has 25 available; asking to move 30 more from Yard A
        # must fail even though total available (40) would cover it.
        r = api_client.post(
            f"{BASE_URL}/api/equipment/{eq['id']}/transfer", headers=auth_headers,
            json={"qty": 30, "to_location": "Yard C", "note": ""},
        )
        assert r.status_code == 400


class TestReconciliation:
    def test_negative_variance_moves_available_to_missing(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=100)
        r = api_client.post(f"{BASE_URL}/api/equipment/{eq['id']}/count", headers=auth_headers, json={"counted_qty": 97})
        assert r.status_code == 201, r.text
        count = r.json()
        assert count["variance"] == -3 and count["status"] == "pending"

        r = api_client.post(f"{BASE_URL}/api/inventory-counts/{count['id']}/reconcile", headers=auth_headers, json={"reason": "lost on site"})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "reconciled"

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["missing"] == 3 and eq2["available"] == 97 and eq2["quantity"] == 100

    def test_positive_variance_increases_owned(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=50)
        r = api_client.post(f"{BASE_URL}/api/equipment/{eq['id']}/count", headers=auth_headers, json={"counted_qty": 53})
        count = r.json()
        assert count["variance"] == 3

        api_client.post(f"{BASE_URL}/api/inventory-counts/{count['id']}/reconcile", headers=auth_headers, json={"reason": "found extra stock"})
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["quantity"] == 53 and eq2["available"] == 53

    def test_reconcile_requires_reason(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        r = api_client.post(f"{BASE_URL}/api/equipment/{eq['id']}/count", headers=auth_headers, json={"counted_qty": 9})
        count = r.json()
        r = api_client.post(f"{BASE_URL}/api/inventory-counts/{count['id']}/reconcile", headers=auth_headers, json={"reason": ""})
        assert r.status_code == 400, "empty reason must not silently reconcile a variance"
        r = api_client.post(f"{BASE_URL}/api/inventory-counts/{count['id']}/reconcile", headers=auth_headers, json={"reason": "   "})
        assert r.status_code == 400, "whitespace-only reason must not silently reconcile a variance"

    def test_double_reconcile_rejected(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        r = api_client.post(f"{BASE_URL}/api/equipment/{eq['id']}/count", headers=auth_headers, json={"counted_qty": 8})
        count = r.json()
        api_client.post(f"{BASE_URL}/api/inventory-counts/{count['id']}/reconcile", headers=auth_headers, json={"reason": "damaged"})
        r = api_client.post(f"{BASE_URL}/api/inventory-counts/{count['id']}/reconcile", headers=auth_headers, json={"reason": "damaged again"})
        assert r.status_code == 400


class TestRentalDeleteEditRollback:
    def test_delete_rental_restores_outstanding_only(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=50)
        rental = create_rental(api_client, auth_headers, eq, 20)
        api_client.post(
            f"{BASE_URL}/api/rentals/{rental['id']}/return", headers=auth_headers,
            json=[{"equipment_id": eq["id"], "qty": 8, "damaged_qty": 0}],
        )
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["on_rental"] == 12 and eq2["pending_inspection"] == 8

        r = api_client.delete(f"{BASE_URL}/api/rentals/{rental['id']}", headers=auth_headers)
        assert r.status_code == 200

        eq3 = get_equipment(api_client, auth_headers, eq["id"])
        # only the still-outstanding 12 return to available; the 8 already
        # returned stay wherever the return routed them (pending_inspection)
        assert eq3["on_rental"] == 0
        assert eq3["available"] == eq2["available"] + 12
        assert eq3["pending_inspection"] == 8

    def test_update_rental_rebalances_only_the_delta(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=50)
        rental = create_rental(api_client, auth_headers, eq, 10)
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["on_rental"] == 10

        r = api_client.put(
            f"{BASE_URL}/api/rentals/{rental['id']}", headers=auth_headers,
            json={
                "customer_name": rental["customer_name"], "job_site": rental["job_site"],
                "start_date": rental["start_date"],
                "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 25, "daily_rate": 0}],
            },
        )
        assert r.status_code == 200, r.text

        eq3 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq3["on_rental"] == 25 and eq3["available"] == 25

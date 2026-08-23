"""Dispatch/Movement regression suite.

Covers the outbound (yard -> job) and inbound (job -> yard) delivery
lifecycle: DISPATCH_FLOWS status progression, the bucket move each status
implies, invalid-jump rejection, cancellation rollback (including the
standalone-vs-booking-linked distinction), the Rental an outbound dispatch
creates on completion, an inbound dispatch crediting returned_qty back onto
its rental, and the booking-confirm -> auto-linked-dispatch integration.

Every test that mutates equipment re-fetches it and checks the same core
bucket invariant test_inventory_ledger.py guards.
"""
import uuid

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


def create_equipment(api_client, auth_headers, qty=20, **overrides):
    sku = f"TEST-DISPATCH-{uuid.uuid4().hex[:8]}"
    body = {"sku": sku, "name": "Test Dispatch Unit", "category": "misc", "quantity": qty, "available": qty}
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


def create_outbound_dispatch(api_client, auth_headers, eq, qty, **overrides):
    body = {
        "direction": "outbound",
        "customer_name": f"Dispatch Customer {uuid.uuid4().hex[:4]}",
        "job_site": "Test Job Site",
        "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": qty}],
    }
    body.update(overrides)
    r = api_client.post(f"{BASE_URL}/api/dispatches", headers=auth_headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def advance(api_client, auth_headers, d_id, status):
    r = api_client.patch(f"{BASE_URL}/api/dispatches/{d_id}/status", headers=auth_headers, json={"status": status})
    assert r.status_code == 200, r.text
    return r.json()


def create_booking(api_client, auth_headers, eq, qty, **overrides):
    body = {
        "customer_name": f"Dispatch Booking {uuid.uuid4().hex[:4]}", "job_site": "Test Site",
        "start_date": "2026-09-01T00:00:00Z", "end_date": "2026-09-03T00:00:00Z",
        "items": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": qty, "daily_rate": 0}],
    }
    body.update(overrides)
    r = api_client.post(f"{BASE_URL}/api/bookings", headers=auth_headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def get_dispatches(api_client, auth_headers, **params):
    r = api_client.get(f"{BASE_URL}/api/dispatches", headers=auth_headers, params=params)
    assert r.status_code == 200, r.text
    return r.json()


class TestOutboundLifecycle:
    def test_full_outbound_flow_moves_through_every_bucket(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        d = create_outbound_dispatch(api_client, auth_headers, eq, 4)
        assert d["status"] == "scheduled"

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["available"] == 6 and eq2["reserved"] == 4

        expected = {
            "staging": ("reserved", 4), "ready": ("staged", 4), "loaded": ("staged", 4),
            "dispatched": ("outbound", 4), "arrived": ("outbound", 4), "completed": ("on_rental", 4),
        }
        for status, (bucket, qty) in expected.items():
            d = advance(api_client, auth_headers, d["id"], status)
            assert d["status"] == status
            eq2 = get_equipment(api_client, auth_headers, eq["id"])
            assert eq2[bucket] == qty, f"after {status}: expected {bucket}=={qty}, got {eq2}"

        assert d["rental_id"], "completing an outbound dispatch must create a Rental"
        r = api_client.get(f"{BASE_URL}/api/rentals", headers=auth_headers)
        rental = next(x for x in r.json() if x["id"] == d["rental_id"])
        assert rental["lines"][0]["qty"] == 4

    def test_invalid_status_jump_rejected(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        d = create_outbound_dispatch(api_client, auth_headers, eq, 2)
        r = api_client.patch(
            f"{BASE_URL}/api/dispatches/{d['id']}/status", headers=auth_headers, json={"status": "loaded"}
        )
        assert r.status_code == 400
        assert "next step is" in r.json()["detail"]

    def test_cannot_advance_past_completed_or_cancelled(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        d = create_outbound_dispatch(api_client, auth_headers, eq, 2)
        d = advance(api_client, auth_headers, d["id"], "staging")
        r = api_client.patch(
            f"{BASE_URL}/api/dispatches/{d['id']}/status", headers=auth_headers, json={"status": "cancelled"}
        )
        assert r.status_code == 200
        r = api_client.patch(
            f"{BASE_URL}/api/dispatches/{d['id']}/status", headers=auth_headers, json={"status": "ready"}
        )
        assert r.status_code == 400
        assert "already cancelled" in r.json()["detail"]


class TestOutboundCancellationRollback:
    def test_standalone_cancel_releases_fully_to_available(self, api_client, auth_headers):
        """A dispatch with no booking_id reserved the units itself on
        create — cancelling it must release them all the way back to
        available, not leave them stuck in reserved with nothing left to
        release them."""
        eq = create_equipment(api_client, auth_headers, qty=10)
        d = create_outbound_dispatch(api_client, auth_headers, eq, 3)
        d = advance(api_client, auth_headers, d["id"], "staging")
        d = advance(api_client, auth_headers, d["id"], "ready")
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["staged"] == 3

        d = advance(api_client, auth_headers, d["id"], "cancelled")
        assert d["status"] == "cancelled"
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["available"] == 10
        assert eq2["reserved"] == 0 and eq2["staged"] == 0

    def test_cancel_from_dispatched_stage_still_rolls_back(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        d = create_outbound_dispatch(api_client, auth_headers, eq, 5)
        for status in ("staging", "ready", "loaded", "dispatched"):
            d = advance(api_client, auth_headers, d["id"], status)
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["outbound"] == 5

        d = advance(api_client, auth_headers, d["id"], "cancelled")
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["available"] == 10
        assert eq2["outbound"] == 0
        assert d.get("rental_id") is None, "a cancelled dispatch must never create a Rental"

    def test_no_bucket_goes_negative_across_repeated_cancellations(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=6)
        for _ in range(5):
            d = create_outbound_dispatch(api_client, auth_headers, eq, 6)
            d = advance(api_client, auth_headers, d["id"], "staging")
            d = advance(api_client, auth_headers, d["id"], "cancelled")
            eq2 = get_equipment(api_client, auth_headers, eq["id"])
            assert eq2["available"] == 6
            for b in BUCKET_FIELDS:
                assert eq2[b] >= 0, f"bucket {b} went negative: {eq2}"


class TestInboundLifecycle:
    def test_inbound_requires_rental_id(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        r = api_client.post(
            f"{BASE_URL}/api/dispatches", headers=auth_headers,
            json={
                "direction": "inbound", "customer_name": "X", "job_site": "Y",
                "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 2}],
            },
        )
        assert r.status_code == 400

    def test_full_inbound_flow_and_rental_return_crediting(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        r = api_client.post(
            f"{BASE_URL}/api/rentals", headers=auth_headers,
            json={
                "customer_name": "Inbound Test Co", "job_site": "Inbound Job",
                "start_date": "2026-08-01T00:00:00Z",
                "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 6, "daily_rate": 0}],
            },
        )
        assert r.status_code == 201, r.text
        rental = r.json()

        r = api_client.post(
            f"{BASE_URL}/api/dispatches", headers=auth_headers,
            json={
                "direction": "inbound", "customer_name": "Inbound Test Co", "job_site": "Inbound Job",
                "rental_id": rental["id"],
                "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 6}],
            },
        )
        assert r.status_code == 201, r.text
        d = r.json()

        expected = {
            "dispatched": ("on_rental", 6), "arrived": ("on_rental", 6), "loaded": ("inbound", 6),
            "returning": ("inbound", 6), "at_yard": ("inbound", 6), "completed": ("pending_inspection", 6),
        }
        for status, (bucket, qty) in expected.items():
            d = advance(api_client, auth_headers, d["id"], status)
            eq2 = get_equipment(api_client, auth_headers, eq["id"])
            assert eq2[bucket] == qty, f"after {status}: expected {bucket}=={qty}, got {eq2}"

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["on_rental"] == 0

        r = api_client.get(f"{BASE_URL}/api/rentals", headers=auth_headers)
        rental2 = next(x for x in r.json() if x["id"] == rental["id"])
        assert rental2["status"] == "returned"
        assert rental2["lines"][0]["returned_qty"] == 6

    def test_desk_return_and_scheduled_pickup_split_correctly(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        r = api_client.post(
            f"{BASE_URL}/api/rentals", headers=auth_headers,
            json={
                "customer_name": "Split Return Co", "job_site": "Split Job",
                "start_date": "2026-08-01T00:00:00Z",
                "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 10, "daily_rate": 0}],
            },
        )
        rental = r.json()

        r = api_client.post(
            f"{BASE_URL}/api/rentals/{rental['id']}/return", headers=auth_headers,
            json=[{"equipment_id": eq["id"], "qty": 3, "damaged_qty": 0}],
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "partially_returned"

        r = api_client.post(
            f"{BASE_URL}/api/rentals/{rental['id']}/schedule-pickup", headers=auth_headers, json={"driver_name": "Dan"}
        )
        assert r.status_code == 201, r.text
        d = r.json()
        assert d["lines"][0]["qty"] == 7, "pickup must only cover what's still outstanding, not the full rental qty"

        r = api_client.post(
            f"{BASE_URL}/api/rentals/{rental['id']}/schedule-pickup", headers=auth_headers, json={}
        )
        assert r.status_code == 400, "a second live pickup for the same rental must be rejected"

        for status in ("dispatched", "arrived", "loaded", "returning", "at_yard", "completed"):
            d = advance(api_client, auth_headers, d["id"], status)

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["pending_inspection"] == 10, "3 from desk return + 7 from pickup"
        assert eq2["on_rental"] == 0

        r = api_client.get(f"{BASE_URL}/api/rentals", headers=auth_headers)
        rental2 = next(x for x in r.json() if x["id"] == rental["id"])
        assert rental2["status"] == "returned"
        assert rental2["lines"][0]["returned_qty"] == 10

        r = api_client.post(
            f"{BASE_URL}/api/rentals/{rental['id']}/schedule-pickup", headers=auth_headers, json={}
        )
        assert r.status_code == 400, "cannot schedule a pickup on an already fully-returned rental"


class TestBookingLinkedDispatch:
    def test_confirming_a_booking_creates_a_linked_outbound_dispatch(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=20)
        r = api_client.post(
            f"{BASE_URL}/api/bookings", headers=auth_headers,
            json={
                "customer_name": "Booking Link Co", "job_site": "Booking Job",
                "start_date": "2026-09-01T00:00:00Z", "end_date": "2026-09-05T00:00:00Z",
                "status": "tentative",
                "items": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 5, "daily_rate": 0}],
            },
        )
        assert r.status_code == 201, r.text
        bk = r.json()

        r = api_client.patch(
            f"{BASE_URL}/api/bookings/{bk['id']}/status", headers=auth_headers, json={"status": "confirmed"}
        )
        assert r.status_code == 200, r.text

        r = api_client.get(f"{BASE_URL}/api/dispatches", headers=auth_headers, params={"booking_id": bk["id"]})
        assert r.status_code == 200
        dispatches = r.json()
        assert len(dispatches) == 1
        assert dispatches[0]["direction"] == "outbound"
        assert dispatches[0]["status"] == "scheduled"
        assert dispatches[0]["lines"][0]["qty"] == 5

    def test_reconfirming_does_not_double_create_or_double_reserve(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=20)
        r = api_client.post(
            f"{BASE_URL}/api/bookings", headers=auth_headers,
            json={
                "customer_name": "Reconfirm Co", "job_site": "Reconfirm Job",
                "start_date": "2026-09-01T00:00:00Z", "end_date": "2026-09-05T00:00:00Z",
                "status": "tentative",
                "items": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 4, "daily_rate": 0}],
            },
        )
        bk = r.json()
        api_client.patch(f"{BASE_URL}/api/bookings/{bk['id']}/status", headers=auth_headers, json={"status": "confirmed"})
        api_client.patch(f"{BASE_URL}/api/bookings/{bk['id']}/status", headers=auth_headers, json={"status": "tentative"})
        api_client.patch(f"{BASE_URL}/api/bookings/{bk['id']}/status", headers=auth_headers, json={"status": "confirmed"})

        r = api_client.get(f"{BASE_URL}/api/dispatches", headers=auth_headers, params={"booking_id": bk["id"]})
        assert len(r.json()) == 1

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["reserved"] == 4

    def test_quick_dispatch_shortcut_fast_forwards_linked_dispatch(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=20)
        r = api_client.post(
            f"{BASE_URL}/api/bookings", headers=auth_headers,
            json={
                "customer_name": "Quick Dispatch Co", "job_site": "Quick Job",
                "start_date": "2026-09-01T00:00:00Z", "end_date": "2026-09-05T00:00:00Z",
                "status": "confirmed",
                "items": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 6, "daily_rate": 0}],
            },
        )
        bk = r.json()

        r = api_client.post(f"{BASE_URL}/api/bookings/{bk['id']}/dispatch", headers=auth_headers)
        assert r.status_code == 201, r.text
        rental = r.json()
        assert rental["lines"][0]["qty"] == 6

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["on_rental"] == 6
        assert eq2["reserved"] == 0 and eq2["staged"] == 0 and eq2["outbound"] == 0

        r = api_client.get(f"{BASE_URL}/api/dispatches", headers=auth_headers, params={"booking_id": bk["id"]})
        d = r.json()[0]
        assert d["status"] == "completed"
        assert d["rental_id"] == rental["id"]

        r = api_client.get(f"{BASE_URL}/api/bookings", headers=auth_headers)
        bk2 = next(b for b in r.json() if b["id"] == bk["id"])
        assert bk2["status"] == "dispatched"
        assert bk2["dispatched_rental_id"] == rental["id"]


class TestReviewFixes:
    """Regression coverage for issues found reviewing the merged Dispatch PR:
    booking cancel/delete didn't account for a linked Dispatch that had
    already moved units out of 'reserved', booking/dispatch creation skipped
    availability checks other reservation paths already had, and a dispatch
    with two lines for the same equipment_id was checked against stale
    per-line availability instead of aggregated demand."""

    def test_cancel_confirmed_booking_after_dispatch_progressed_past_staging(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        bk = create_booking(api_client, auth_headers, eq, 6, status="confirmed")

        d = get_dispatches(api_client, auth_headers, booking_id=bk["id"])[0]
        advance(api_client, auth_headers, d["id"], "staging")
        advance(api_client, auth_headers, d["id"], "ready")
        advance(api_client, auth_headers, d["id"], "loaded")
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["staged"] == 6 and eq2["reserved"] == 0

        r = api_client.patch(
            f"{BASE_URL}/api/bookings/{bk['id']}/status", headers=auth_headers, json={"status": "cancelled"}
        )
        assert r.status_code == 200, r.text

        eq3 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq3["available"] == 10, f"cancelling must release all the way back to available, got {eq3}"
        assert eq3["reserved"] == 0 and eq3["staged"] == 0

        d2 = get_dispatches(api_client, auth_headers, booking_id=bk["id"])[0]
        assert d2["status"] == "cancelled"

    def test_delete_confirmed_booking_after_dispatch_progressed_past_staging(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        bk = create_booking(api_client, auth_headers, eq, 4, status="confirmed")
        d = get_dispatches(api_client, auth_headers, booking_id=bk["id"])[0]
        advance(api_client, auth_headers, d["id"], "staging")
        advance(api_client, auth_headers, d["id"], "ready")

        r = api_client.delete(f"{BASE_URL}/api/bookings/{bk['id']}", headers=auth_headers)
        assert r.status_code == 200, r.text

        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["available"] == 10, f"deleting must release all the way back to available, got {eq2}"

    def test_booking_over_capacity_rejected(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=5)
        r = api_client.post(
            f"{BASE_URL}/api/bookings", headers=auth_headers,
            json={
                "customer_name": "Over Capacity Co", "job_site": "Test Site",
                "start_date": "2026-09-01T00:00:00Z", "end_date": "2026-09-03T00:00:00Z",
                "items": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 50, "daily_rate": 0}],
            },
        )
        assert r.status_code == 400, r.text
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["available"] == 5, "a rejected over-capacity booking must not touch inventory"

    def test_standalone_dispatch_duplicate_lines_aggregated_not_checked_independently(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=8)
        r = api_client.post(
            f"{BASE_URL}/api/dispatches", headers=auth_headers,
            json={
                "direction": "outbound", "customer_name": "Dup Line Co", "job_site": "Test Site",
                "lines": [
                    {"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 5},
                    {"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 5},
                ],
            },
        )
        assert r.status_code == 400, f"combined demand (10) exceeds available (8), must be rejected: {r.text}"
        eq2 = get_equipment(api_client, auth_headers, eq["id"])
        assert eq2["available"] == 8, "a rejected dispatch must not touch inventory"

    def test_inbound_dispatch_rejects_duplicate_live_pickup(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        r = api_client.post(
            f"{BASE_URL}/api/rentals", headers=auth_headers,
            json={
                "customer_name": "Dup Pickup Co", "job_site": "Test Site", "start_date": "2026-08-01T00:00:00Z",
                "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 6, "daily_rate": 0}],
            },
        )
        rental = r.json()
        body = {
            "direction": "inbound", "customer_name": "Dup Pickup Co", "job_site": "Test Site",
            "rental_id": rental["id"],
            "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 6}],
        }
        r1 = api_client.post(f"{BASE_URL}/api/dispatches", headers=auth_headers, json=body)
        assert r1.status_code == 201, r1.text
        r2 = api_client.post(f"{BASE_URL}/api/dispatches", headers=auth_headers, json=body)
        assert r2.status_code == 400, "a second live pickup for the same rental must be rejected"

    def test_inbound_dispatch_rejects_qty_over_outstanding(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        r = api_client.post(
            f"{BASE_URL}/api/rentals", headers=auth_headers,
            json={
                "customer_name": "Over Pickup Co", "job_site": "Test Site", "start_date": "2026-08-01T00:00:00Z",
                "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 6, "daily_rate": 0}],
            },
        )
        rental = r.json()
        r = api_client.post(
            f"{BASE_URL}/api/dispatches", headers=auth_headers,
            json={
                "direction": "inbound", "customer_name": "Over Pickup Co", "job_site": "Test Site",
                "rental_id": rental["id"],
                "lines": [{"equipment_id": eq["id"], "sku": eq["sku"], "name": eq["name"], "qty": 99}],
            },
        )
        assert r.status_code == 400, "pickup qty exceeding what's outstanding on the rental must be rejected"

    def test_booking_created_directly_confirmed_still_gets_staging_and_dispatch(self, api_client, auth_headers):
        """A booking created with status='confirmed' in one call (never
        transitioning through 'tentative') must get the same staging task +
        linked outbound Dispatch as one confirmed via PATCH — the frontend's
        New Booking form allows picking 'confirmed' directly."""
        eq = create_equipment(api_client, auth_headers, qty=10)
        bk = create_booking(api_client, auth_headers, eq, 4, status="confirmed")

        tasks = api_client.get(f"{BASE_URL}/api/shop-tasks", headers=auth_headers).json()
        staging = [t for t in tasks if t.get("related_booking_id") == bk["id"] and t["task_type"] == "staging"]
        assert len(staging) == 1, "directly-confirmed booking must get a staging task"

        dispatches = get_dispatches(api_client, auth_headers, booking_id=bk["id"])
        assert len(dispatches) == 1, "directly-confirmed booking must get a linked outbound dispatch"
        assert dispatches[0]["status"] == "scheduled"
        assert dispatches[0]["lines"][0]["qty"] == 4

    def test_equipment_breakdown_surfaces_standalone_dispatch_units(self, api_client, auth_headers):
        eq = create_equipment(api_client, auth_headers, qty=10)
        d = create_outbound_dispatch(api_client, auth_headers, eq, 3)
        advance(api_client, auth_headers, d["id"], "staging")

        r = api_client.get(f"{BASE_URL}/api/equipment/{eq['id']}/breakdown", headers=auth_headers)
        assert r.status_code == 200, r.text
        rows = r.json()["rows"]
        dispatch_rows = [row for row in rows if row.get("dispatch_id") == d["id"]]
        assert len(dispatch_rows) == 1, f"standalone dispatch must appear in the breakdown, got rows={rows}"
        assert dispatch_rows[0]["qty"] == 3

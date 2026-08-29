"""Regression coverage for the operational questions added to the main tabs.

Yard Count must update only physical yard availability while preserving the
bucket invariant. Rental contact details and communication entries must remain
tied to the rental and respect contact permission for outbound messages.
"""
import uuid

from conftest import BASE_URL


BUCKET_FIELDS = [
    "available", "reserved", "staged", "outbound", "on_rental", "inbound",
    "in_transit", "checked_out", "pending_inspection", "in_maintenance", "missing",
]


def assert_invariant(equipment: dict):
    assert equipment["quantity"] == sum(equipment[field] for field in BUCKET_FIELDS)


def equipment_by_id(api_client, auth_headers, equipment_id):
    response = api_client.get(f"{BASE_URL}/api/equipment", headers=auth_headers)
    assert response.status_code == 200, response.text
    equipment = next(item for item in response.json() if item["id"] == equipment_id)
    assert_invariant(equipment)
    return equipment


def test_authoritative_yard_count_preserves_non_yard_buckets(api_client, auth_headers):
    sku = f"TEST-YARD-{uuid.uuid4().hex[:8]}"
    response = api_client.post(
        f"{BASE_URL}/api/equipment", headers=auth_headers,
        json={"sku": sku, "name": "Yard Count Strongback", "category": "strongback", "quantity": 20, "available": 20, "location": "Main Yard"},
    )
    assert response.status_code == 201, response.text
    equipment = response.json()

    rental = api_client.post(
        f"{BASE_URL}/api/rentals", headers=auth_headers,
        json={
            "customer_name": "Yard Count Customer", "job_site": "Count Test Job",
            "start_date": "2026-08-20T00:00:00Z",
            "lines": [{"equipment_id": equipment["id"], "sku": sku, "name": equipment["name"], "qty": 5, "daily_rate": 0}],
        },
    )
    assert rental.status_code == 201, rental.text

    response = api_client.post(
        f"{BASE_URL}/api/yard-counts", headers=auth_headers,
        json={"equipment_id": equipment["id"], "equipment_type": equipment["name"], "quantity": 12, "condition": "fair", "yard_location": "Main Yard", "notes": "Physical walk"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["authoritative"] is True

    updated = equipment_by_id(api_client, auth_headers, equipment["id"])
    assert updated["available"] == 12
    assert updated["on_rental"] == 5
    assert updated["missing"] == 3
    assert updated["condition"] == "fair"
    assert updated["location_balances"]["Main Yard"] == 12


def test_rental_contact_fields_and_communication_permission(api_client, auth_headers):
    sku = f"TEST-CONTACT-{uuid.uuid4().hex[:8]}"
    equipment_response = api_client.post(
        f"{BASE_URL}/api/equipment", headers=auth_headers,
        json={"sku": sku, "name": "Contact Test Brace", "category": "strongback", "quantity": 2, "available": 2},
    )
    equipment = equipment_response.json()
    rental_response = api_client.post(
        f"{BASE_URL}/api/rentals", headers=auth_headers,
        json={
            "customer_name": "Contact Test Homeowner", "primary_contact": "Sam Customer",
            "customer_phone": "555-0100", "customer_email": "sam@example.test",
            "preferred_contact_method": "text", "contact_permission": False,
            "job_site": "100 Test Way", "gate_access_instructions": "Use north gate",
            "delivery_notes": "Call before backing in", "return_notes": "Pickup after 3 PM",
            "start_date": "2026-08-20T00:00:00Z", "due_date": "2026-08-21T00:00:00Z",
            "lines": [{"equipment_id": equipment["id"], "sku": sku, "name": equipment["name"], "qty": 1, "daily_rate": 0}],
        },
    )
    assert rental_response.status_code == 201, rental_response.text
    rental = rental_response.json()
    assert rental["primary_contact"] == "Sam Customer"
    assert rental["gate_access_instructions"] == "Use north gate"

    blocked = api_client.post(
        f"{BASE_URL}/api/rentals/{rental['id']}/communications", headers=auth_headers,
        json={"channel": "text", "direction": "outgoing", "summary": "Delivery reminder"},
    )
    assert blocked.status_code == 409

    incoming = api_client.post(
        f"{BASE_URL}/api/rentals/{rental['id']}/communications", headers=auth_headers,
        json={"channel": "call", "direction": "incoming", "summary": "Customer confirmed gate access", "outcome": "Confirmed"},
    )
    assert incoming.status_code == 201, incoming.text
    log = api_client.get(f"{BASE_URL}/api/rentals/{rental['id']}/communications", headers=auth_headers)
    assert log.status_code == 200, log.text
    assert log.json()[0]["summary"] == "Customer confirmed gate access"

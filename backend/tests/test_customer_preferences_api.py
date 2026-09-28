"""Persistence contract for customer equipment preferences.

These use the same configured API fixture as the existing MobileOps integration
suite and never insert production sample inventory.
"""
import uuid


def test_customer_equipment_preferences_persist(api_client, auth_headers, base_url):
    company = f"Forecast Preference Test {uuid.uuid4().hex[:8]}"
    created = api_client.post(
        f"{base_url}/api/contacts",
        headers=auth_headers,
        json={"company": company, "contact": "Test", "preferred_equipment": []},
    )
    assert created.status_code == 201, created.text
    customer_id = created.json()["id"]
    preferences = [{
        "category": "bracing", "equipment_family": "nudura_gen2",
        "equipment_id": None, "priority": 1, "preference_type": "preferred",
    }]
    try:
        updated = api_client.put(
            f"{base_url}/api/customers/{customer_id}/equipment-preferences",
            headers=auth_headers,
            json={"preferred_equipment": preferences},
        )
        assert updated.status_code == 200, updated.text
        fetched = api_client.get(
            f"{base_url}/api/customers/{customer_id}/equipment-preferences",
            headers=auth_headers,
        )
        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["preferred_equipment"] == preferences

        contacts = api_client.get(f"{base_url}/api/contacts", headers=auth_headers)
        persisted = next(item for item in contacts.json() if item["id"] == customer_id)
        assert persisted["preferred_equipment"] == preferences
    finally:
        api_client.delete(f"{base_url}/api/contacts/{customer_id}", headers=auth_headers)

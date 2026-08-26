"""Probe and API-root regression coverage."""

import requests

from conftest import BASE_URL


# These checks target the backend directly; the public root is the web app.
INTERNAL_BACKEND = "http://localhost:8001"


class TestProbes:
    def test_root_returns_200_json(self):
        response = requests.get(f"{INTERNAL_BACKEND}/", timeout=5)
        assert response.status_code == 200, response.text
        assert response.json().get("status") == "ok"

    def test_health_returns_200(self):
        response = requests.get(f"{INTERNAL_BACKEND}/health", timeout=5)
        assert response.status_code == 200, response.text
        assert response.json().get("status") == "ok"

    def test_api_root_backcompat(self, api_client):
        response = api_client.get(f"{BASE_URL}/api/")
        assert response.status_code == 200, response.text
        assert "Concrete Form" in response.json().get("service", "")

    def test_internal_api_root_also_ok(self):
        response = requests.get(f"{INTERNAL_BACKEND}/api/", timeout=5)
        assert response.status_code == 200
        assert "Concrete Form" in response.json().get("service", "")

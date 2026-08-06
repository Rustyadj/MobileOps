"""Probe (K8s liveness) + push-register regression.

Iteration 8 focus:
  - GET /           -> 200 JSON (K8s probe path)
  - GET /health     -> 200 JSON
  - GET /api/       -> 200 JSON (backward compat)
  - POST /api/register-push must NEVER 5xx and must NOT require auth.
    In preview EMERGENT_PUSH_KEY=placeholder -> upstream 401 -> we still
    return 201 with {status:'skipped', reason:'push_key_missing'}.
"""
import os
import requests
from conftest import BASE_URL

# K8s liveness/readiness probes hit the backend pod on its internal port (8001)
# at `/` and `/health` — NOT via the ingress. The public ingress routes non-/api
# paths to the Metro/Expo frontend. So we validate the probe paths against the
# internal backend directly.
INTERNAL_BACKEND = "http://localhost:8001"


# ---------- Probes ----------
class TestProbes:
    def test_root_returns_200_json(self):
        r = requests.get(f"{INTERNAL_BACKEND}/", timeout=5)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") == "ok", body

    def test_health_returns_200(self):
        r = requests.get(f"{INTERNAL_BACKEND}/health", timeout=5)
        assert r.status_code == 200, r.text
        assert r.json().get("status") == "ok"

    def test_api_root_backcompat(self, api_client):
        # `/api/` still resolves via the public ingress (backward-compat).
        r = api_client.get(f"{BASE_URL}/api/")
        assert r.status_code == 200, r.text
        assert "Concrete Form" in r.json().get("service", "")

    def test_internal_api_root_also_ok(self):
        r = requests.get(f"{INTERNAL_BACKEND}/api/", timeout=5)
        assert r.status_code == 200
        assert "Concrete Form" in r.json().get("service", "")


# ---------- register-push ----------
class TestRegisterPush:
    payload = {
        "user_id": "test-user-id",
        "platform": "ios",
        "device_token": "ExponentPushToken[TEST_TOKEN_iter8]",
    }

    def test_register_push_no_auth_required(self):
        # Fresh session, no Authorization header
        r = requests.post(f"{BASE_URL}/api/register-push", json=self.payload, timeout=15)
        assert r.status_code == 201, (
            f"expected 201, got {r.status_code}: {r.text[:400]}"
        )
        body = r.json()
        assert body.get("status") in ("registered", "skipped"), body
        # In preview EMERGENT_PUSH_KEY is 'placeholder' so upstream should 401
        # → backend should downgrade to skipped/push_key_missing.
        if body.get("status") == "skipped":
            assert body.get("reason") in (
                "push_key_missing",
                "upstream_unreachable",
            ) or body.get("reason", "").startswith("upstream_"), body

    def test_register_push_with_auth_still_ok(self, api_client, auth_headers):
        r = api_client.post(
            f"{BASE_URL}/api/register-push", headers=auth_headers, json=self.payload
        )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body.get("status") in ("registered", "skipped")

    def test_register_push_never_5xx_even_with_junk_body(self):
        # Even a malformed platform / token — 422 or 201 acceptable, never 5xx.
        r = requests.post(
            f"{BASE_URL}/api/register-push",
            json={"user_id": "u", "platform": "x", "device_token": ""},
            timeout=15,
        )
        assert r.status_code < 500, f"got 5xx: {r.status_code} {r.text[:200]}"

    def test_register_push_missing_field_is_422_not_500(self):
        r = requests.post(
            f"{BASE_URL}/api/register-push", json={"platform": "ios"}, timeout=15
        )
        # Pydantic validation -> 422; must not be 500
        assert r.status_code == 422, f"got {r.status_code}: {r.text[:200]}"

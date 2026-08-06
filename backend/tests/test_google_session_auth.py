"""Tests for Emergent Google Sign-in session exchange + dual-auth get_current_user."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

from conftest import BASE_URL

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


# ---------- POST /api/auth/session contract ----------
class TestSessionEndpointContract:
    def test_bogus_session_id_returns_401(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/session", json={"session_id": "bogus"})
        assert r.status_code == 401, r.text

    def test_session_token_field_rejected(self, api_client):
        # Must NOT accept `session_token` in lieu of `session_id`
        r = api_client.post(f"{BASE_URL}/api/auth/session", json={"session_token": "whatever"})
        assert r.status_code == 422, r.text

    def test_empty_body_returns_422(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/session", json={})
        assert r.status_code == 422

    def test_arbitrary_extra_field_no_session_id(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/session", json={"code": "abc", "token": "xyz"})
        assert r.status_code == 422


# ---------- Dual-auth get_current_user (JWT + session_token) ----------
class TestDualAuth:
    @pytest.fixture(scope="class")
    def synthetic_session(self, api_client, auth_headers):
        """Insert a synthetic user_sessions row for the admin user and yield the token."""
        import asyncio

        async def _seed():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            me = await db.users.find_one({"email": os.environ.get("ADMIN_EMAIL", "admin@concreteform.com")})
            assert me is not None, "admin user not found"
            token = f"TEST_sess_{uuid.uuid4().hex}"
            expires = datetime.now(timezone.utc) + timedelta(days=7)
            await db.user_sessions.insert_one({
                "session_token": token,
                "user_id": me["id"],
                "expires_at": expires,
                "created_at": datetime.now(timezone.utc),
                "provider": "emergent_google",
            })
            client.close()
            return token, me["id"]

        token, uid = asyncio.get_event_loop().run_until_complete(_seed())
        yield token, uid

        async def _cleanup():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            await db.user_sessions.delete_one({"session_token": token})
            client.close()

        asyncio.get_event_loop().run_until_complete(_cleanup())

    def test_me_works_with_session_token(self, api_client, synthetic_session):
        token, uid = synthetic_session
        r = api_client.get(f"{BASE_URL}/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["id"] == uid
        assert d["email"] == os.environ.get("ADMIN_EMAIL", "admin@concreteform.com")

    def test_me_works_with_jwt_regression(self, api_client, auth_headers):
        r = api_client.get(f"{BASE_URL}/api/auth/me", headers=auth_headers)
        assert r.status_code == 200

    def test_expired_session_token_rejected(self, api_client):
        import asyncio

        async def _seed_expired():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            me = await db.users.find_one({"email": os.environ.get("ADMIN_EMAIL", "admin@concreteform.com")})
            token = f"TEST_expired_{uuid.uuid4().hex}"
            await db.user_sessions.insert_one({
                "session_token": token,
                "user_id": me["id"],
                "expires_at": datetime.now(timezone.utc) - timedelta(days=1),
                "created_at": datetime.now(timezone.utc) - timedelta(days=8),
                "provider": "emergent_google",
            })
            client.close()
            return token

        token = asyncio.get_event_loop().run_until_complete(_seed_expired())
        try:
            r = api_client.get(f"{BASE_URL}/api/auth/me",
                               headers={"Authorization": f"Bearer {token}"})
            # Expired session should NOT authenticate; JWT decode of the random string
            # will also fail => 401
            assert r.status_code == 401, r.text
        finally:
            async def _cleanup():
                client = AsyncIOMotorClient(MONGO_URL)
                db = client[DB_NAME]
                await db.user_sessions.delete_one({"session_token": token})
                client.close()
            asyncio.get_event_loop().run_until_complete(_cleanup())

    def test_missing_bearer_returns_401(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 401


# ---------- MongoDB indexes ----------
class TestIndexes:
    def test_required_indexes_present(self):
        import asyncio

        async def _check():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            users_idx = await db.users.index_information()
            eq_idx = await db.equipment.index_information()
            sess_idx = await db.user_sessions.index_information()
            client.close()
            return users_idx, eq_idx, sess_idx

        users_idx, eq_idx, sess_idx = asyncio.get_event_loop().run_until_complete(_check())

        # users.email unique
        assert any(v.get("key") == [("email", 1)] and v.get("unique")
                   for v in users_idx.values()), f"users.email unique missing: {users_idx}"
        # equipment.sku unique
        assert any(v.get("key") == [("sku", 1)] and v.get("unique")
                   for v in eq_idx.values()), f"equipment.sku unique missing: {eq_idx}"
        # user_sessions.session_token unique
        assert any(v.get("key") == [("session_token", 1)] and v.get("unique")
                   for v in sess_idx.values()), f"user_sessions.session_token unique missing: {sess_idx}"
        # user_sessions.user_id
        assert any(v.get("key") == [("user_id", 1)] for v in sess_idx.values()), \
            f"user_sessions.user_id missing: {sess_idx}"
        # user_sessions.expires_at TTL (expireAfterSeconds=0)
        assert any(v.get("key") == [("expires_at", 1)] and v.get("expireAfterSeconds") == 0
                   for v in sess_idx.values()), f"user_sessions.expires_at TTL missing: {sess_idx}"

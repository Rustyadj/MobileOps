"""Temporary user suspension blocks new logins and already-issued tokens."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

import server


class SuspendedUsersTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.suspended = patch.object(
            server, "SUSPENDED_USER_IDENTIFIERS", {"tiffany", "jay"}
        )
        self.suspended.start()
        self.addCleanup(self.suspended.stop)

    def test_matches_exact_name_first_name_or_email(self):
        self.assertTrue(server.user_is_suspended({"name": "Tiffany"}))
        self.assertTrue(server.user_is_suspended({"name": "Jay Smith"}))
        self.assertTrue(server.user_is_suspended({"email": "JAY"}))
        self.assertFalse(server.user_is_suspended({"name": "Jayme"}))
        self.assertFalse(server.user_is_suspended({"name": "Rusty"}))

    async def test_login_rejects_suspended_user_before_password_check(self):
        user = {
            "id": "blocked-user",
            "email": "tiffany@example.com",
            "name": "Tiffany",
            "password_hash": "unused",
            "role": server.Role.crew.value,
        }

        async def find_one(*_args, **_kwargs):
            return user

        fake_db = SimpleNamespace(users=SimpleNamespace(find_one=find_one))
        with patch.object(server, "db", fake_db), patch.object(server, "verify_pwd") as verify:
            with self.assertRaises(HTTPException) as raised:
                await server.login(server.LoginReq(email=user["email"], password="anything"))
        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(raised.exception.detail, "Invalid credentials")
        verify.assert_not_called()

    async def test_existing_access_token_is_rejected(self):
        user = {
            "id": "blocked-user",
            "email": "jay@example.com",
            "name": "Jay",
            "role": server.Role.crew.value,
        }

        async def find_one(*_args, **_kwargs):
            return user

        fake_db = SimpleNamespace(users=SimpleNamespace(find_one=find_one))
        request = Request({
            "type": "http",
            "method": "GET",
            "path": "/api/auth/me",
            "headers": [(b"authorization", b"Bearer old-token")],
        })
        with patch.object(server, "db", fake_db), patch.object(
            server,
            "decode_token",
            return_value={"type": "access", "sub": user["id"]},
        ):
            with self.assertRaises(HTTPException) as raised:
                await server.get_current_user(request)
        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(raised.exception.detail, "Account disabled")


if __name__ == "__main__":
    unittest.main()

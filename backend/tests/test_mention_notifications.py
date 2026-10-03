"""Feed @mention notifications: recipient rules, idempotency, targeting, failure isolation."""
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from mention_notifications import build_notification, plan_recipients, preview_text

user = lambda uid, name=None: {"id": uid, "entity_type": "user", "display_name": name or uid}
EVERYONE = {"id": "everyone", "entity_type": "group", "display_name": "Everyone"}
NATHAN = {"id": "nathan2", "entity_type": "agent", "display_name": "Nathan"}
ELIGIBLE = ["rusty", "john", "sarah", "mike"]


class PlanRecipientsTest(unittest.TestCase):
    def plan(self, mentions, **kw):
        return plan_recipients(mentions, author_id=kw.pop("author", "rusty"), eligible_user_ids=kw.pop("eligible", ELIGIBLE), **kw)

    def test_single_and_multiple(self):
        self.assertEqual(self.plan([user("john")]), ["john"])
        self.assertEqual(self.plan([user("john"), user("sarah")]), ["john", "sarah"])

    def test_duplicate_mention_notifies_once(self):
        self.assertEqual(self.plan([user("john"), user("john")]), ["john"])

    def test_self_mention_is_silent(self):
        self.assertEqual(self.plan([user("rusty"), user("john")]), ["john"])

    def test_unknown_or_suspended_user_is_skipped(self):
        self.assertEqual(self.plan([user("ghost")]), [])
        self.assertEqual(self.plan([user("john")], eligible=["rusty"]), [])

    def test_agent_mention_does_not_notify(self):
        self.assertEqual(self.plan([NATHAN]), [])

    def test_everyone_expands_to_eligible_minus_author_and_dedupes(self):
        self.assertEqual(self.plan([user("john"), EVERYONE]), ["john", "sarah", "mike"])

    def test_edit_only_notifies_newly_added(self):
        self.assertEqual(self.plan([user("john"), user("sarah")], previously_mentioned=["john"]), ["sarah"])

    def test_edit_removing_mention_notifies_nobody(self):
        self.assertEqual(self.plan([user("john")], previously_mentioned=["john", "sarah"]), [])


class BuildNotificationTest(unittest.TestCase):
    def build(self, **message):
        msg = {"id": "m1", "thread_id": "dashboard", "body": "hi", **message}
        return build_notification(notification_id="n1", recipient_id="john", actor_id="rusty",
                                  actor_name="Rusty", message=msg, created_at=datetime.now(timezone.utc))

    def test_post_notification(self):
        n = self.build()
        self.assertEqual((n["type"], n["title"], n["read"]), ("feed_mention", "Rusty mentioned you in a feed post.", False))
        self.assertEqual(n["link"], "/whiteboard?message=m1&thread=m1")

    def test_comment_notification_links_to_parent_thread(self):
        n = self.build(parent_id="p9")
        self.assertIn("comment", n["title"])
        self.assertEqual(n["link"], "/whiteboard?message=m1&thread=p9")

    def test_preview_collapses_whitespace_and_truncates(self):
        self.assertEqual(preview_text("a \n  b"), "a b")
        self.assertEqual(len(preview_text("x" * 500)), 140)


class FakeNotifications:
    def __init__(self, fail=False):
        self.docs, self.fail = [], False
        self.fail = fail

    async def update_one(self, flt, update, upsert=False):
        if self.fail:
            raise RuntimeError("db down")
        if any(all(d.get(k) == v for k, v in flt.items()) for d in self.docs):
            return SimpleNamespace(upserted_id=None)
        self.docs.append(dict(update["$setOnInsert"]))
        return SimpleNamespace(upserted_id=update["$setOnInsert"]["id"])

    async def count_documents(self, flt):
        return sum(1 for d in self.docs if d["user_id"] == flt["user_id"] and d["read"] == flt["read"])


class FakeUsers:
    def __init__(self, users):
        self.users = users

    def find(self, *_a, **_k):
        users = self.users
        return SimpleNamespace(to_list=lambda _n: _coro(users))


async def _coro(value):
    return value


class FakeHub:
    def __init__(self, fail=False):
        self.sent, self.fail = [], fail

    async def send_to_user(self, uid, event):
        if self.fail:
            raise RuntimeError("socket gone")
        self.sent.append((uid, event))


class NotifyGlueTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        os.environ.setdefault("JWT_SECRET_KEY", "x")
        os.environ.setdefault("JWT_REFRESH_SECRET_KEY", "y")
        os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
        os.environ.setdefault("DB_NAME", "test")
        import server
        self.server = server
        self.notes = FakeNotifications()
        users = [{"id": u, "name": u.title(), "email": f"{u}@x.com"} for u in ELIGIBLE]
        self.db = SimpleNamespace(users=FakeUsers(users), notifications=self.notes)
        self.hub = FakeHub()
        self.author = server.UserPublic(id="rusty", email="rusty@x.com", name="Rusty", role=server.Role.admin)
        self.doc = {"id": "m1", "thread_id": "dashboard", "parent_id": None, "body": "@John review"}
        for target, value in (("db", self.db), ("whiteboard_hub", self.hub)):
            p = patch.object(server, target, value); p.start(); self.addCleanup(p.stop)

    async def test_creates_one_notification_and_pushes_only_to_recipient(self):
        n = await self.server.notify_whiteboard_mentions(self.doc, [user("john"), user("john")], self.author)
        self.assertEqual(n, 1)
        self.assertEqual([d["user_id"] for d in self.notes.docs], ["john"])
        self.assertEqual([(uid, e["type"], e["unread_count"]) for uid, e in self.hub.sent], [("john", "notification.created", 1)])

    async def test_repeat_processing_is_idempotent(self):
        await self.server.notify_whiteboard_mentions(self.doc, [user("john")], self.author)
        again = await self.server.notify_whiteboard_mentions(self.doc, [user("john")], self.author)
        self.assertEqual((again, len(self.notes.docs), len(self.hub.sent)), (0, 1, 1))

    async def test_suspended_user_not_notified(self):
        with patch.object(self.server, "SUSPENDED_USER_IDENTIFIERS", {"john"}):
            n = await self.server.notify_whiteboard_mentions(self.doc, [user("john")], self.author)
        self.assertEqual((n, self.notes.docs), (0, []))

    async def test_realtime_failure_keeps_persisted_notification(self):
        self.hub.fail = True
        n = await self.server.notify_whiteboard_mentions(self.doc, [user("john")], self.author)
        self.assertEqual((n, len(self.notes.docs)), (1, 1))

    async def test_db_failure_never_raises_into_the_post(self):
        self.notes.fail = True
        self.assertEqual(await self.server.notify_whiteboard_mentions(self.doc, [user("john")], self.author), 0)


class AmbiguousHandleTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        os.environ.setdefault("JWT_SECRET_KEY", "x")
        os.environ.setdefault("JWT_REFRESH_SECRET_KEY", "y")
        os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
        os.environ.setdefault("DB_NAME", "test")
        import server
        self.server = server
        self.users = [
            {"id": "u1", "name": "John Smith", "email": "john.s@x.com"},
            {"id": "u2", "name": "John Smith", "email": "jsmith2@x.com"},
            {"id": "u3", "name": "Sarah", "email": "sarah@x.com"},
        ]
        class Users:
            def __init__(self, users): self.users = users
            def find(self, *_a, **_k):
                cursor = SimpleNamespace(to_list=lambda _n: _coro(self.users))
                cursor.sort = lambda *_: cursor
                return cursor
        p = patch.object(server, "db", SimpleNamespace(users=Users(self.users))); p.start(); self.addCleanup(p.stop)

    async def test_shared_display_name_resolves_to_nobody(self):
        self.assertEqual(await self.server.resolve_whiteboard_mentions("hi @JohnSmith"), [])

    async def test_unique_email_handle_resolves_exact_user(self):
        got = await self.server.resolve_whiteboard_mentions("hi @jsmith2 and @sarah and @nobody")
        self.assertEqual([(m["id"], m["entity_type"]) for m in got], [("u2", "user"), ("u3", "user")])

    async def test_autocomplete_offers_disambiguated_handles_and_hides_suspended(self):
        entries = await self.server.list_whiteboard_mentionables(None)
        handles = {e["id"]: e["handle"] for e in entries if e["entity_type"] == "user"}
        self.assertEqual(handles, {"u1": "john.s", "u2": "jsmith2", "u3": "sarah"})
        with patch.object(self.server, "SUSPENDED_USER_IDENTIFIERS", {"sarah"}):
            entries = await self.server.list_whiteboard_mentionables(None)
        self.assertNotIn("u3", [e["id"] for e in entries])

    async def test_everyone_group_notifies_all_but_author_via_resolve(self):
        mentions = await self.server.resolve_whiteboard_mentions("@everyone standup")
        self.assertEqual(mentions[0]["id"], "everyone")


if __name__ == "__main__":
    unittest.main()

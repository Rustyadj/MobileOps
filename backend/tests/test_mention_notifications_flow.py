"""End-to-end Live Feed mention flow through the real FastAPI routes on an in-memory Mongo."""
import os

import pytest

pytest.importorskip("mongomock_motor")
from httpx import ASGITransport, AsyncClient  # noqa: E402
from mongomock_motor import AsyncMongoMockClient  # noqa: E402
from unittest.mock import patch  # noqa: E402

for _k, _v in dict(JWT_SECRET_KEY="x", JWT_REFRESH_SECRET_KEY="y", MONGO_URL="mongodb://localhost", DB_NAME="t").items():
    os.environ.setdefault(_k, _v)
import server  # noqa: E402

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


USERS = [("rusty", "Rusty", "admin"), ("john", "John", "crew"), ("sarah", "Sarah", "crew"), ("mike", "Mike", "foreman")]


@pytest.fixture
async def env():
    db = AsyncMongoMockClient()["flow"]
    await db.notifications.create_index([("type", 1), ("message_id", 1), ("user_id", 1)], unique=True)
    await db.users.insert_many([{"id": i, "name": n, "email": f"{n.lower()}@x.com", "role": r} for i, n, r in USERS])
    with patch.object(server, "db", db):
        transport = ASGITransport(app=server.app)
        async with AsyncClient(transport=transport, base_url="http://t") as client:
            yield client, db


def hdr(uid):
    role = {u[0]: u[2] for u in USERS}[uid]
    return {"Authorization": f"Bearer {server.make_token(uid, role)}"}


async def post(client, uid, body, **extra):
    r = await client.post("/api/whiteboard/messages", json={"body": body, "thread_id": "dashboard", **extra}, headers=hdr(uid))
    assert r.status_code == 201, r.text
    return r.json()


async def inbox(client, uid):
    return (await client.get("/api/notifications", headers=hdr(uid))).json()


async def test_post_mentions_dedupe_self_invalid_and_unread_count(env):
    client, _ = env
    msg = await post(client, "rusty", "@John please review. @John also check item 2. @Rusty note to self. @ghost?")
    assert [n["title"] for n in await inbox(client, "john")] == ["Rusty mentioned you in a feed post."]
    assert await inbox(client, "rusty") == []
    assert await inbox(client, "sarah") == []
    note = (await inbox(client, "john"))[0]
    assert note["type"] == "feed_mention" and note["read"] is False
    assert note["link"] == f"/whiteboard?message={msg['id']}&thread={msg['id']}"
    assert "please review" in note["preview"]
    assert (await client.get("/api/notifications/unread-count", headers=hdr("john"))).json() == {"count": 1}


async def test_edit_notifies_only_newly_added_mentions(env):
    client, _ = env
    msg = await post(client, "rusty", "@John review this")
    r = await client.patch(f"/api/whiteboard/messages/{msg['id']}", json={"body": "@John and @Sarah review this"}, headers=hdr("rusty"))
    assert r.status_code == 200, r.text
    assert len(await inbox(client, "john")) == 1  # not re-notified by the edit
    assert len(await inbox(client, "sarah")) == 1
    await client.patch(f"/api/whiteboard/messages/{msg['id']}", json={"body": "just @Sarah now"}, headers=hdr("rusty"))
    assert (len(await inbox(client, "john")), len(await inbox(client, "sarah"))) == (1, 1)  # removal never re-notifies


async def test_comment_mention_is_labelled_and_links_to_parent_thread(env):
    client, _ = env
    parent = await post(client, "rusty", "status?")
    reply = await post(client, "mike", "@Sarah on it", parent_id=parent["id"])
    note = (await inbox(client, "sarah"))[0]
    assert "comment" in note["title"] and note["actor_name"] == "Mike"
    assert note["link"] == f"/whiteboard?message={reply['id']}&thread={parent['id']}"


async def test_read_state_is_per_user_and_cannot_touch_others(env):
    client, _ = env
    await post(client, "rusty", "@John @Sarah hi")
    john_note = (await inbox(client, "john"))[0]
    r = await client.post(f"/api/notifications/{john_note['id']}/read", headers=hdr("sarah"))
    assert r.status_code == 404
    assert (await inbox(client, "john"))[0]["read"] is False
    r = await client.post(f"/api/notifications/{john_note['id']}/read", headers=hdr("john"))
    assert r.json() == {"count": 0}
    assert (await client.get("/api/notifications/unread-count", headers=hdr("sarah"))).json() == {"count": 1}
    await client.post("/api/notifications/read-all", headers=hdr("sarah"))
    assert (await client.get("/api/notifications/unread-count", headers=hdr("sarah"))).json() == {"count": 0}
    assert (await client.get("/api/notifications")).status_code in (401, 403)


async def test_everyone_notifies_all_but_author_and_suspended_are_skipped(env):
    client, _ = env
    with patch.object(server, "SUSPENDED_USER_IDENTIFIERS", {"mike"}):
        await post(client, "rusty", "@everyone standup at 7")
    got = {u: len(await inbox(client, u)) for u, _, _ in USERS}
    assert got == {"rusty": 0, "john": 1, "sarah": 1, "mike": 0}


async def test_post_succeeds_even_if_notification_processing_fails(env):
    client, db = env

    def boom(**_kwargs):
        raise RuntimeError("notification pipeline unavailable")
    with patch.object(server, "build_notification", boom):
        msg = await post(client, "rusty", "@John still posts")
    stored = await db.whiteboard_messages.find_one({"id": msg["id"]})
    assert stored and stored["body"] == "@John still posts"
    assert await inbox(client, "john") == []


async def test_mentions_survive_realtime_hub_targeting(env):
    client, _ = env
    sent = []

    async def capture(user_id, event):
        sent.append((user_id, event["type"], event["unread_count"]))
    with patch.object(server.whiteboard_hub, "send_to_user", capture):
        await post(client, "rusty", "@John @Sarah")
    assert sorted(sent) == [("john", "notification.created", 1), ("sarah", "notification.created", 1)]

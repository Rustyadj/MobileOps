import copy
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from mcp.server.fastmcp.exceptions import ToolError
from pymongo.errors import DuplicateKeyError

from backend.mcp_server import (
    AgentPrincipal,
    DEFAULT_HERMES_SCOPES,
    HERMES_AGENT_ID,
    MongoHermesTokenVerifier,
    configured_token_digest,
    create_mobileops_mcp,
    seed_hermes_agent,
    token_digest,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


class FakeResult:
    def __init__(self, matched_count=1, deleted_count=0):
        self.matched_count = matched_count
        self.deleted_count = deleted_count


class FakeCollection:
    def __init__(self, unique_key=None):
        self.docs = []
        self.unique_key = unique_key

    @staticmethod
    def _matches(doc, query):
        for key, expected in query.items():
            if isinstance(expected, dict) and "$type" in expected:
                if expected["$type"] == "string" and not isinstance(doc.get(key), str):
                    return False
            elif doc.get(key) != expected:
                return False
        return True

    async def find_one(self, query, projection=None):
        for doc in self.docs:
            if self._matches(doc, query):
                found = copy.deepcopy(doc)
                if projection and projection.get("_id") == 0:
                    found.pop("_id", None)
                return found
        return None

    async def insert_one(self, doc, **kwargs):
        candidate = copy.deepcopy(doc)
        if self.unique_key and any(
            existing.get(self.unique_key) == candidate.get(self.unique_key)
            for existing in self.docs
        ):
            raise DuplicateKeyError("duplicate")
        self.docs.append(candidate)
        return FakeResult()

    async def update_one(self, query, update, upsert=False, **kwargs):
        for doc in self.docs:
            if self._matches(doc, query):
                doc.update(copy.deepcopy(update.get("$set", {})))
                return FakeResult()
        if upsert:
            created = copy.deepcopy(query)
            created.update(copy.deepcopy(update.get("$setOnInsert", {})))
            created.update(copy.deepcopy(update.get("$set", {})))
            self.docs.append(created)
            return FakeResult(matched_count=0)
        return FakeResult(matched_count=0)

    async def create_index(self, *args, **kwargs):
        return "index"


class FakeDB:
    def __init__(self):
        self.mcp_agents = FakeCollection(unique_key="id")
        self.mcp_audit_log = FakeCollection(unique_key="id")
        self.mcp_confirmations = FakeCollection(unique_key="jti")


class Payload:
    def __init__(self, **values):
        self.__dict__.update(values)

    def model_dump(self):
        return dict(self.__dict__)


class FakeBackend:
    JWT_SECRET = "unit-test-confirmation-secret"
    Role = SimpleNamespace(foreman="foreman")
    UserPublic = Payload
    ToolCheckoutBody = Payload
    ToolCheckinBody = Payload
    RentalCreate = Payload
    ReturnLine = Payload
    SchedulePickupCreate = Payload
    BookingCreate = Payload
    BookingStatusUpdate = Payload
    DispatchCreate = Payload
    DispatchStatusUpdate = Payload
    DispatchAssignUpdate = Payload
    MaintenanceCreate = Payload
    ShopTaskCreate = Payload
    ShopTaskStatusUpdate = Payload

    def __init__(self):
        self.db = FakeDB()
        self.list_equipment_calls = 0
        self.checkout_calls = []

    async def list_equipment(self, user):
        self.list_equipment_calls += 1
        assert user.id == HERMES_AGENT_ID
        return [
            {
                "id": "eq-1",
                "sku": "HAM-1",
                "name": "Claw Hammer",
                "category": "tool",
                "condition": "good",
                "location": "Yard",
                "quantity": 4,
                "available": 3,
            },
            {
                "id": "eq-2",
                "sku": "DRL-1",
                "name": "Drill",
                "category": "tool",
                "condition": "fair",
                "location": "Truck 2",
                "quantity": 2,
                "available": 1,
            },
        ]

    async def checkout_tool(self, equipment_id, body, user, idempotency_key):
        self.checkout_calls.append(
            {
                "equipment_id": equipment_id,
                "body": body.model_dump(),
                "user_id": user.id,
                "idempotency_key": idempotency_key,
            }
        )
        return {"id": equipment_id, "available": 2, "checked_out": body.qty}


def make_integration(backend, scopes=DEFAULT_HERMES_SCOPES):
    principal = AgentPrincipal(HERMES_AGENT_ID, frozenset(scopes))
    return create_mobileops_mcp(backend, principal_provider=lambda: principal)


@pytest.mark.anyio
async def test_registry_covers_requested_domains_and_marks_mutations_destructive():
    integration = make_integration(FakeBackend())
    tools = integration.mcp._tool_manager._tools

    assert {
        "inventory_search",
        "inventory_transfer",
        "equipment_checkout",
        "equipment_inspect_return",
        "rentals_list",
        "rental_return",
        "bookings_list",
        "booking_dispatch",
        "dispatches_list",
        "dispatch_set_status",
        "dispatch_complete_ticket",
        "maintenance_list",
        "maintenance_create",
        "shop_tasks_list",
        "shop_task_set_status",
        "operational_status",
    }.issubset(tools)
    assert tools["inventory_search"].annotations.readOnlyHint is True
    assert tools["equipment_checkout"].annotations.destructiveHint is True


@pytest.mark.anyio
async def test_read_tool_reuses_domain_handler_and_writes_complete_audit_record():
    backend = FakeBackend()
    integration = make_integration(backend)

    result = await integration.mcp._tool_manager.call_tool(
        "inventory_search", {"query": "hammer", "limit": 10}
    )

    assert result["ok"] is True
    assert result["data"]["count"] == 1
    assert result["data"]["items"][0]["id"] == "eq-1"
    assert backend.list_equipment_calls == 1
    audit = backend.db.mcp_audit_log.docs[0]
    assert audit["agent_identity"] == HERMES_AGENT_ID
    assert audit["tool"] == "inventory_search"
    assert audit["action"] == "read"
    assert audit["parameters"]["query"] == "hammer"
    assert audit["status"] == "succeeded"
    assert audit["result"]["data"]["count"] == 1
    assert isinstance(audit["timestamp"], datetime)


@pytest.mark.anyio
async def test_scope_denial_is_audited_and_never_calls_domain_logic():
    backend = FakeBackend()
    integration = make_integration(backend, scopes=["operations:read"])

    with pytest.raises(ToolError, match="inventory:read"):
        await integration.mcp._tool_manager.call_tool(
            "inventory_search", {"query": "", "limit": 100}
        )

    assert backend.list_equipment_calls == 0
    audit = backend.db.mcp_audit_log.docs[0]
    assert audit["status"] == "failed"
    assert audit["result"]["error"] == "PermissionError"


@pytest.mark.anyio
async def test_mutation_requires_bound_one_time_confirmation_and_reuses_handler():
    backend = FakeBackend()
    integration = make_integration(backend)
    arguments = {"equipment_id": "eq-1", "checked_out_to": "Project Alpha", "qty": 1}

    preview = await integration.mcp._tool_manager.call_tool(
        "equipment_checkout", arguments
    )
    assert preview["confirmation_required"] is True
    assert backend.checkout_calls == []
    confirmation_token = preview["confirmation_token"]
    assert (
        backend.db.mcp_audit_log.docs[0]["result"]["confirmation_token"] == "<redacted>"
    )

    confirmed = await integration.mcp._tool_manager.call_tool(
        "equipment_checkout", {**arguments, "confirmation_token": confirmation_token}
    )
    assert confirmed["ok"] is True
    assert len(backend.checkout_calls) == 1
    assert backend.checkout_calls[0]["idempotency_key"]
    assert (
        backend.db.mcp_audit_log.docs[1]["parameters"]["confirmation_token"]
        == "<redacted>"
    )

    with pytest.raises(ToolError, match="already been used"):
        await integration.mcp._tool_manager.call_tool(
            "equipment_checkout",
            {**arguments, "confirmation_token": confirmation_token},
        )
    assert len(backend.checkout_calls) == 1
    assert backend.db.mcp_audit_log.docs[2]["status"] == "failed"


@pytest.mark.anyio
async def test_confirmation_is_bound_to_exact_parameters():
    backend = FakeBackend()
    integration = make_integration(backend)
    arguments = {"equipment_id": "eq-1", "checked_out_to": "Project Alpha", "qty": 1}
    preview = await integration.mcp._tool_manager.call_tool(
        "equipment_checkout", arguments
    )

    with pytest.raises(ToolError, match="Invalid or expired"):
        await integration.mcp._tool_manager.call_tool(
            "equipment_checkout",
            {
                **arguments,
                "qty": 2,
                "confirmation_token": preview["confirmation_token"],
            },
        )
    assert backend.checkout_calls == []


@pytest.mark.anyio
async def test_token_verifier_uses_hashed_enabled_service_identity():
    database = FakeDB()
    raw_token = "a-production-quality-random-token"
    database.mcp_agents.docs.append(
        {
            "id": HERMES_AGENT_ID,
            "token_hash": token_digest(raw_token),
            "enabled": True,
            "scopes": ["inventory:read"],
        }
    )
    verifier = MongoHermesTokenVerifier(database)

    access = await verifier.verify_token(raw_token)

    assert access is not None
    assert access.client_id == HERMES_AGENT_ID
    assert access.scopes == ["inventory:read"]
    assert await verifier.verify_token("wrong-token") is None
    assert "last_seen_at" in database.mcp_agents.docs[0]


@pytest.mark.anyio
async def test_seed_creates_dedicated_identity_without_raw_token(monkeypatch):
    database = FakeDB()
    monkeypatch.setenv("HERMES_MCP_TOKEN", "do-not-store-this")
    monkeypatch.setenv("HERMES_MCP_SCOPES", "inventory:read,operations:read")

    await seed_hermes_agent(database)

    agent = database.mcp_agents.docs[0]
    assert agent["id"] == HERMES_AGENT_ID
    assert agent["enabled"] is True
    assert agent["token_hash"] == token_digest("do-not-store-this")
    assert "do-not-store-this" not in repr(agent)
    assert agent["scopes"] == ["inventory:read", "operations:read"]
    assert agent["identity_type"] == "service_agent"


def test_configured_token_digest_supports_non_secret_deployment_hash(
    monkeypatch, tmp_path
):
    raw_token = "separate-secret-kept-only-in-hermes"
    digest_file = tmp_path / "hermes-agent-token.sha256"
    digest_file.write_text(token_digest(raw_token), encoding="ascii")
    monkeypatch.delenv("HERMES_MCP_TOKEN", raising=False)
    monkeypatch.delenv("HERMES_MCP_TOKEN_SHA256", raising=False)
    monkeypatch.setenv("HERMES_MCP_TOKEN_SHA256_FILE", str(digest_file))

    assert configured_token_digest() == token_digest(raw_token)


@pytest.mark.anyio
async def test_streamable_http_endpoint_requires_hermes_bearer_token(monkeypatch):
    backend = FakeBackend()
    monkeypatch.setenv("MCP_PUBLIC_URL", "http://test")
    raw_token = "valid-hermes-bearer-token"
    backend.db.mcp_agents.docs.append(
        {
            "id": HERMES_AGENT_ID,
            "token_hash": token_digest(raw_token),
            "enabled": True,
            "scopes": list(DEFAULT_HERMES_SCOPES),
        }
    )
    integration = create_mobileops_mcp(backend)
    app = FastAPI()
    app.mount("/api/mcp", integration.asgi_app)
    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test-client", "version": "1.0"},
        },
    }
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }

    await integration.start()
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            unauthorized = await client.post(
                "/api/mcp/", json=initialize, headers=headers
            )
            authorized = await client.post(
                "/api/mcp/",
                json=initialize,
                headers={**headers, "Authorization": f"Bearer {raw_token}"},
            )
    finally:
        await integration.stop()

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    assert authorized.json()["result"]["serverInfo"]["name"] == "MobileOps"

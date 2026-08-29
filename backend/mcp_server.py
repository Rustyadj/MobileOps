"""Hermes MCP integration for MobileOps.

This module is deliberately an adapter.  It owns MCP transport concerns,
service-account authentication, scoped authorization, confirmations, and audit
records, while every operational read and mutation delegates to the existing
handlers in :mod:`server`.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping
from urllib.parse import urlparse

from fastapi.encoders import jsonable_encoder
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import AnyHttpUrl
from pymongo.errors import DuplicateKeyError

HERMES_AGENT_ID = "hermes-agent"
HERMES_AGENT_NAME = "Hermes Agent"
HERMES_AGENT_EMAIL = "hermes-agent@icfops.srv1427612.hstgr.cloud"
CONFIRMATION_TTL_SECONDS = 300
AUDIT_RESULT_LIMIT_BYTES = 512_000
DEFAULT_TOKEN_HASH_FILE = Path(__file__).with_name("hermes-agent-token.sha256")

DEFAULT_HERMES_SCOPES = (
    "inventory:read",
    "inventory:write",
    "equipment:read",
    "equipment:write",
    "rentals:read",
    "rentals:write",
    "bookings:read",
    "bookings:write",
    "dispatch:read",
    "dispatch:write",
    "maintenance:read",
    "maintenance:write",
    "shop_tasks:read",
    "shop_tasks:write",
    "operations:read",
)

READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
MUTATING = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=False,
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def configured_token_digest() -> str | None:
    """Resolve a raw secret or a safe-to-deploy digest for the service identity."""
    raw_token = os.environ.get("HERMES_MCP_TOKEN", "").strip()
    if raw_token:
        return token_digest(raw_token)

    configured_digest = os.environ.get("HERMES_MCP_TOKEN_SHA256", "").strip()
    configured_path = os.environ.get("HERMES_MCP_TOKEN_SHA256_FILE")
    if not configured_digest and configured_path != "":
        digest_path = (
            Path(configured_path) if configured_path else DEFAULT_TOKEN_HASH_FILE
        )
        try:
            configured_digest = digest_path.read_text(encoding="ascii").strip()
        except FileNotFoundError:
            pass

    normalized = configured_digest.lower()
    if not normalized:
        return None
    if not re.fullmatch(r"[0-9a-f]{64}", normalized):
        raise ValueError(
            "Hermes MCP token digest must be exactly 64 hexadecimal characters"
        )
    return normalized


def configured_scopes() -> list[str]:
    raw = os.environ.get("HERMES_MCP_SCOPES", "")
    if not raw.strip():
        return list(DEFAULT_HERMES_SCOPES)
    return sorted({scope.strip() for scope in raw.split(",") if scope.strip()})


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        jsonable_encoder(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _redact(value: Any) -> Any:
    """Keep audit records useful without persisting bearer/confirmation secrets."""
    sensitive = {"authorization", "password", "secret", "token", "confirmation_token"}
    encoded = jsonable_encoder(value)
    if isinstance(encoded, Mapping):
        return {
            str(key): "<redacted>" if str(key).lower() in sensitive else _redact(item)
            for key, item in encoded.items()
        }
    if isinstance(encoded, list):
        return [_redact(item) for item in encoded]
    return encoded


def _bounded_result(value: Any) -> Any:
    """Protect the audit collection from Mongo's document-size limit."""
    encoded = jsonable_encoder(value)
    serialized = _canonical_json(encoded)
    if len(serialized) <= AUDIT_RESULT_LIMIT_BYTES:
        return encoded
    return {
        "truncated": True,
        "size_bytes": len(serialized),
        "sha256": hashlib.sha256(serialized).hexdigest(),
        "preview": serialized[:8_000].decode("utf-8", errors="replace"),
    }


@dataclass(frozen=True)
class AgentPrincipal:
    identity: str
    scopes: frozenset[str]


class MongoHermesTokenVerifier(TokenVerifier):
    """Verify opaque bearer tokens against the dedicated MCP agent store."""

    def __init__(self, database: Any) -> None:
        self._db = database

    async def verify_token(self, token: str) -> AccessToken | None:
        if not token:
            return None
        digest = token_digest(token)
        agent = await self._db.mcp_agents.find_one(
            {"token_hash": digest, "enabled": True}, {"_id": 0}
        )
        if not agent or not secrets.compare_digest(agent.get("token_hash", ""), digest):
            return None
        expires_at = agent.get("token_expires_at")
        if isinstance(expires_at, datetime):
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if expires_at <= utc_now():
                return None
        await self._db.mcp_agents.update_one(
            {"id": agent["id"]}, {"$set": {"last_seen_at": utc_now()}}
        )
        return AccessToken(
            token=token,
            client_id=agent["id"],
            scopes=list(agent.get("scopes") or []),
            expires_at=(
                int(expires_at.timestamp())
                if isinstance(expires_at, datetime)
                else None
            ),
        )


async def seed_hermes_agent(database: Any) -> None:
    """Create/update the service identity without ever storing its raw token."""
    digest = configured_token_digest()
    now = utc_now()
    await database.mcp_agents.update_one(
        {"id": HERMES_AGENT_ID},
        {
            "$set": {
                "display_name": HERMES_AGENT_NAME,
                "identity_type": "service_agent",
                "scopes": configured_scopes(),
                "enabled": bool(digest),
                "token_hash": digest,
                "updated_at": now,
            },
            "$setOnInsert": {"id": HERMES_AGENT_ID, "created_at": now},
        },
        upsert=True,
    )


class MobileOpsMCP:
    """MCP facade over the existing MobileOps backend module."""

    def __init__(
        self,
        backend: Any,
        *,
        principal_provider: Callable[
            [], AccessToken | AgentPrincipal | None
        ] = get_access_token,
    ) -> None:
        self.backend = backend
        self.db = backend.db
        self._principal_provider = principal_provider
        self._confirmation_secret = os.environ.get(
            "MCP_CONFIRMATION_SECRET", backend.JWT_SECRET
        ).encode("utf-8")
        public_url = os.environ.get(
            "MCP_PUBLIC_URL", "https://icfops.srv1427612.hstgr.cloud"
        ).rstrip("/")
        issuer_url = os.environ.get("MCP_ISSUER_URL", public_url)
        public_origin = urlparse(public_url)
        default_hosts = [public_origin.netloc, "127.0.0.1:*", "localhost:*"]
        allowed_hosts = [
            item.strip()
            for item in os.environ.get(
                "MCP_ALLOWED_HOSTS", ",".join(default_hosts)
            ).split(",")
            if item.strip()
        ]
        allowed_origins = [
            item.strip()
            for item in os.environ.get("MCP_ALLOWED_ORIGINS", public_url).split(",")
            if item.strip()
        ]
        self.mcp = FastMCP(
            name="MobileOps",
            instructions=(
                "Secure operational access to MobileOps for the hermes-agent identity. "
                "Read tools are immediately executable. Every mutating tool first returns "
                "confirmation_required; show its summary to the human and only repeat the "
                "same call with the returned confirmation_token after explicit approval."
            ),
            token_verifier=MongoHermesTokenVerifier(self.db),
            auth=AuthSettings(
                issuer_url=AnyHttpUrl(issuer_url),
                resource_server_url=AnyHttpUrl(f"{public_url}/api/mcp"),
                required_scopes=[],
            ),
            stateless_http=True,
            json_response=True,
            streamable_http_path="/",
            transport_security=TransportSecuritySettings(
                enable_dns_rebinding_protection=True,
                allowed_hosts=allowed_hosts,
                allowed_origins=allowed_origins,
            ),
        )
        self._session_context: Any = None
        self._register_tools()
        self.asgi_app = self.mcp.streamable_http_app()

    async def start(self) -> None:
        if self._session_context is None:
            self._session_context = self.mcp.session_manager.run()
            await self._session_context.__aenter__()

    async def stop(self) -> None:
        if self._session_context is not None:
            context, self._session_context = self._session_context, None
            await context.__aexit__(None, None, None)

    def _principal(self) -> AgentPrincipal:
        token = self._principal_provider()
        if token is None:
            raise PermissionError("Authenticated hermes-agent identity required")
        if isinstance(token, AgentPrincipal):
            principal = token
        else:
            principal = AgentPrincipal(token.client_id, frozenset(token.scopes))
        if principal.identity != HERMES_AGENT_ID:
            raise PermissionError("This MCP endpoint is restricted to hermes-agent")
        return principal

    def _domain_user(self) -> Any:
        # Existing handlers accept this same UserPublic contract. Tool scopes
        # provide the narrower authorization boundary before it reaches them.
        return self.backend.UserPublic(
            id=HERMES_AGENT_ID,
            email=HERMES_AGENT_EMAIL,
            name=HERMES_AGENT_NAME,
            role=self.backend.Role.foreman,
        )

    def _issue_confirmation(
        self, tool: str, parameters: dict[str, Any], identity: str
    ) -> str:
        payload = {
            "jti": str(uuid.uuid4()),
            "agent": identity,
            "tool": tool,
            "parameters_sha256": hashlib.sha256(
                _canonical_json(parameters)
            ).hexdigest(),
            "exp": int(time.time()) + CONFIRMATION_TTL_SECONDS,
        }
        encoded = _b64encode(_canonical_json(payload))
        signature = _b64encode(
            hmac.new(
                self._confirmation_secret, encoded.encode("ascii"), hashlib.sha256
            ).digest()
        )
        return f"{encoded}.{signature}"

    async def _verify_and_consume_confirmation(
        self, token: str, tool: str, parameters: dict[str, Any], identity: str
    ) -> str:
        try:
            encoded, signature = token.split(".", 1)
            expected = _b64encode(
                hmac.new(
                    self._confirmation_secret, encoded.encode("ascii"), hashlib.sha256
                ).digest()
            )
            if not secrets.compare_digest(signature, expected):
                raise ValueError("signature")
            payload = json.loads(_b64decode(encoded))
            if payload.get("agent") != identity or payload.get("tool") != tool:
                raise ValueError("binding")
            params_hash = hashlib.sha256(_canonical_json(parameters)).hexdigest()
            if not secrets.compare_digest(
                payload.get("parameters_sha256", ""), params_hash
            ):
                raise ValueError("parameters")
            if int(payload.get("exp", 0)) < int(time.time()):
                raise ValueError("expired")
            jti = str(payload["jti"])
            await self.db.mcp_confirmations.insert_one(
                {
                    "jti": jti,
                    "agent_identity": identity,
                    "tool": tool,
                    "consumed_at": utc_now(),
                    "expires_at": datetime.fromtimestamp(
                        int(payload["exp"]), tz=timezone.utc
                    ),
                }
            )
            return jti
        except DuplicateKeyError as exc:
            raise PermissionError("Confirmation token has already been used") from exc
        except PermissionError:
            raise
        except Exception as exc:
            raise PermissionError("Invalid or expired confirmation token") from exc

    async def invoke(
        self,
        *,
        tool: str,
        parameters: dict[str, Any],
        required_scope: str,
        action: str,
        operation: Callable[[AgentPrincipal, str | None], Awaitable[Any]],
        confirmation_token: str | None = None,
        confirmation_summary: str | None = None,
    ) -> dict[str, Any]:
        """Authorize, audit, confirm if needed, and invoke one domain handler."""
        started = time.perf_counter()
        principal = self._principal()
        audit_id = str(uuid.uuid4())
        audit_doc = {
            "id": audit_id,
            "timestamp": utc_now(),
            "agent_identity": principal.identity,
            "tool": tool,
            "action": action,
            "parameters": _redact(
                {**parameters, "confirmation_token": confirmation_token}
            ),
            "status": "started",
            "result": None,
        }
        # Fail closed: Hermes must not reach domain logic when an audit record
        # cannot be created.
        await self.db.mcp_audit_log.insert_one(audit_doc)

        async def finish(status: str, result: Any) -> None:
            await self.db.mcp_audit_log.update_one(
                {"id": audit_id},
                {
                    "$set": {
                        "status": status,
                        "result": _bounded_result(_redact(result)),
                        "completed_at": utc_now(),
                        "duration_ms": round((time.perf_counter() - started) * 1000, 3),
                    }
                },
            )

        try:
            if required_scope not in principal.scopes:
                raise PermissionError(f"Missing required scope: {required_scope}")

            idempotency_key: str | None = None
            if action == "write":
                if not confirmation_token:
                    token = self._issue_confirmation(
                        tool, parameters, principal.identity
                    )
                    result = {
                        "confirmation_required": True,
                        "summary": confirmation_summary
                        or f"Confirm execution of {tool}",
                        "expires_in_seconds": CONFIRMATION_TTL_SECONDS,
                        "confirmation_token": token,
                        "instructions": (
                            "Ask the human for explicit approval. After approval, repeat the exact "
                            "same tool call with this confirmation_token."
                        ),
                    }
                    await finish("confirmation_required", result)
                    return result
                idempotency_key = await self._verify_and_consume_confirmation(
                    confirmation_token, tool, parameters, principal.identity
                )

            value = await operation(principal, idempotency_key)
            result = {"ok": True, "data": jsonable_encoder(value)}
            await finish("succeeded", result)
            return result
        except Exception as exc:
            detail = getattr(exc, "detail", None) or str(exc) or exc.__class__.__name__
            error = {
                "ok": False,
                "error": exc.__class__.__name__,
                "detail": str(detail),
                "status_code": getattr(exc, "status_code", None),
            }
            await finish("failed", error)
            raise

    def _register_tools(self) -> None:
        mcp = self.mcp

        @mcp.tool(
            name="inventory_search",
            description="List/search current equipment inventory and all operational quantity buckets.",
            annotations=READ_ONLY,
        )
        async def inventory_search(
            query: str = "",
            category: str | None = None,
            location: str | None = None,
            condition: str | None = None,
            limit: int = 100,
        ) -> dict[str, Any]:
            params = {
                "query": query,
                "category": category,
                "location": location,
                "condition": condition,
                "limit": limit,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                equipment = jsonable_encoder(
                    await self.backend.list_equipment(self._domain_user())
                )
                needle = query.strip().lower()
                rows = []
                for item in equipment:
                    haystack = " ".join(
                        str(item.get(k, ""))
                        for k in (
                            "name",
                            "sku",
                            "qr_code",
                            "model",
                            "serial_number",
                            "notes",
                        )
                    ).lower()
                    if needle and needle not in haystack:
                        continue
                    if category and item.get("category") != category:
                        continue
                    if (
                        location
                        and location.lower()
                        not in str(item.get("location", "")).lower()
                    ):
                        continue
                    if condition and item.get("condition") != condition:
                        continue
                    rows.append(item)
                bounded_limit = max(1, min(limit, 500))
                return {
                    "items": rows[:bounded_limit],
                    "count": len(rows),
                    "limit": bounded_limit,
                }

            return await self.invoke(
                tool="inventory_search",
                parameters=params,
                required_scope="inventory:read",
                action="read",
                operation=operation,
            )

        @mcp.tool(
            name="equipment_get",
            description="Get the live inventory breakdown for one equipment record by MobileOps equipment id.",
            annotations=READ_ONLY,
        )
        async def equipment_get(equipment_id: str) -> dict[str, Any]:
            params = {"equipment_id": equipment_id}
            return await self.invoke(
                tool="equipment_get",
                parameters=params,
                required_scope="equipment:read",
                action="read",
                operation=lambda _p, _k: self.backend.equipment_breakdown(
                    equipment_id, self._domain_user()
                ),
            )

        @mcp.tool(
            name="inventory_capacity",
            description="Check equipment availability and commitments on an ISO date.",
            annotations=READ_ONLY,
        )
        async def inventory_capacity(target_date: str) -> dict[str, Any]:
            params = {"target_date": target_date}
            return await self.invoke(
                tool="inventory_capacity",
                parameters=params,
                required_scope="inventory:read",
                action="read",
                operation=lambda _p, _k: self.backend.capacity_check(
                    target_date, self._domain_user()
                ),
            )

        @mcp.tool(
            name="inventory_transfers_list",
            description="List inventory transfers between MobileOps locations.",
            annotations=READ_ONLY,
        )
        async def inventory_transfers_list(status: str | None = None) -> dict[str, Any]:
            params = {"status": status}

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                rows = jsonable_encoder(
                    await self.backend.list_transfers(self._domain_user())
                )
                if status:
                    rows = [row for row in rows if row.get("status") == status]
                return {"items": rows, "count": len(rows)}

            return await self.invoke(
                tool="inventory_transfers_list",
                parameters=params,
                required_scope="inventory:read",
                action="read",
                operation=operation,
            )

        @mcp.tool(
            name="rentals_list",
            description="List rentals and their return state.",
            annotations=READ_ONLY,
        )
        async def rentals_list(status: str | None = None) -> dict[str, Any]:
            params = {"status": status}

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                rows = jsonable_encoder(
                    await self.backend.list_rentals(self._domain_user())
                )
                if status:
                    rows = [row for row in rows if row.get("status") == status]
                return {"items": rows, "count": len(rows)}

            return await self.invoke(
                tool="rentals_list",
                parameters=params,
                required_scope="rentals:read",
                action="read",
                operation=operation,
            )

        @mcp.tool(
            name="rental_contact_actions",
            description="List unlogged status-driven customer follow-ups, including contact permission and preferred channel.",
            annotations=READ_ONLY,
        )
        async def rental_contact_actions() -> dict[str, Any]:
            return await self.invoke(
                tool="rental_contact_actions",
                parameters={},
                required_scope="rentals:read",
                action="read",
                operation=lambda _p, _k: self.backend.list_rental_contact_actions(
                    self._domain_user()
                ),
            )

        @mcp.tool(
            name="bookings_list",
            description="List bookings and reservation state.",
            annotations=READ_ONLY,
        )
        async def bookings_list(status: str | None = None) -> dict[str, Any]:
            params = {"status": status}

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                rows = jsonable_encoder(
                    await self.backend.list_bookings(self._domain_user())
                )
                if status:
                    rows = [row for row in rows if row.get("status") == status]
                return {"items": rows, "count": len(rows)}

            return await self.invoke(
                tool="bookings_list",
                parameters=params,
                required_scope="bookings:read",
                action="read",
                operation=operation,
            )

        @mcp.tool(
            name="dispatches_list",
            description="List outbound or inbound dispatch movements.",
            annotations=READ_ONLY,
        )
        async def dispatches_list(
            direction: str | None = None,
            status: str | None = None,
            rental_id: str | None = None,
            booking_id: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "direction": direction,
                "status": status,
                "rental_id": rental_id,
                "booking_id": booking_id,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                rows = await self.backend.list_dispatches(
                    direction=direction,
                    status=status,
                    rental_id=rental_id,
                    booking_id=booking_id,
                    _=self._domain_user(),
                )
                return {"items": jsonable_encoder(rows), "count": len(rows)}

            return await self.invoke(
                tool="dispatches_list",
                parameters=params,
                required_scope="dispatch:read",
                action="read",
                operation=operation,
            )

        @mcp.tool(
            name="maintenance_list",
            description="List maintenance records.",
            annotations=READ_ONLY,
        )
        async def maintenance_list(status: str | None = None) -> dict[str, Any]:
            params = {"status": status}

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                rows = jsonable_encoder(
                    await self.backend.list_maintenance(self._domain_user())
                )
                if status:
                    rows = [row for row in rows if row.get("status") == status]
                return {"items": rows, "count": len(rows)}

            return await self.invoke(
                tool="maintenance_list",
                parameters=params,
                required_scope="maintenance:read",
                action="read",
                operation=operation,
            )

        @mcp.tool(
            name="shop_tasks_list",
            description="List shop tasks and completion state.",
            annotations=READ_ONLY,
        )
        async def shop_tasks_list(status: str | None = None) -> dict[str, Any]:
            params = {"status": status}

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                rows = jsonable_encoder(
                    await self.backend.list_shop_tasks(self._domain_user())
                )
                if status:
                    rows = [row for row in rows if row.get("status") == status]
                return {"items": rows, "count": len(rows)}

            return await self.invoke(
                tool="shop_tasks_list",
                parameters=params,
                required_scope="shop_tasks:read",
                action="read",
                operation=operation,
            )

        @mcp.tool(
            name="operational_status",
            description="Get current MobileOps KPIs, recent activity, and upcoming inventory shortages.",
            annotations=READ_ONLY,
        )
        async def operational_status(shortage_days: int = 14) -> dict[str, Any]:
            params = {"shortage_days": shortage_days}

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                days = max(1, min(shortage_days, 90))
                stats = await self.backend.dashboard_stats(self._domain_user())
                shortages = await self.backend.dashboard_shortages(
                    days, self._domain_user()
                )
                return {
                    "service": await self.backend.health(),
                    "stats": stats,
                    "shortages": shortages,
                }

            return await self.invoke(
                tool="operational_status",
                parameters=params,
                required_scope="operations:read",
                action="read",
                operation=operation,
            )

        @mcp.tool(
            name="equipment_checkout",
            description="Check out equipment to a project/foreman. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def equipment_checkout(
            equipment_id: str,
            checked_out_to: str,
            qty: int = 1,
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "equipment_id": equipment_id,
                "checked_out_to": checked_out_to,
                "qty": qty,
            }

            async def operation(_: AgentPrincipal, key: str | None) -> Any:
                body = self.backend.ToolCheckoutBody(
                    checked_out_to=checked_out_to, qty=qty
                )
                return await self.backend.checkout_tool(
                    equipment_id, body, self._domain_user(), key
                )

            return await self.invoke(
                tool="equipment_checkout",
                parameters=params,
                required_scope="equipment:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Check out {qty} unit(s) of {equipment_id} to {checked_out_to}.",
            )

        @mcp.tool(
            name="equipment_checkin",
            description="Check equipment back into the yard. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def equipment_checkin(
            equipment_id: str, qty: int = 1, confirmation_token: str | None = None
        ) -> dict[str, Any]:
            params = {"equipment_id": equipment_id, "qty": qty}

            async def operation(_: AgentPrincipal, key: str | None) -> Any:
                return await self.backend.checkin_tool(
                    equipment_id,
                    self.backend.ToolCheckinBody(qty=qty),
                    self._domain_user(),
                    key,
                )

            return await self.invoke(
                tool="equipment_checkin",
                parameters=params,
                required_scope="equipment:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Check in {qty} unit(s) of {equipment_id}.",
            )

        @mcp.tool(
            name="equipment_inspect_return",
            description=(
                "Inspect returned equipment and release it to available stock or route it "
                "to maintenance. Requires explicit confirmation."
            ),
            annotations=MUTATING,
        )
        async def equipment_inspect_return(
            equipment_id: str,
            qty: int,
            outcome: str,
            note: str = "",
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "equipment_id": equipment_id,
                "qty": qty,
                "outcome": outcome,
                "note": note,
            }

            async def operation(_: AgentPrincipal, key: str | None) -> Any:
                body = self.backend.InspectBody(qty=qty, outcome=outcome, note=note)
                return await self.backend.inspect_equipment(
                    equipment_id, body, self._domain_user(), key
                )

            return await self.invoke(
                tool="equipment_inspect_return",
                parameters=params,
                required_scope="equipment:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=(
                    f"Mark {qty} returned unit(s) of {equipment_id} as {outcome}."
                ),
            )

        @mcp.tool(
            name="inventory_transfer",
            description=(
                "Move available equipment into transit to another MobileOps location. "
                "Requires explicit confirmation."
            ),
            annotations=MUTATING,
        )
        async def inventory_transfer(
            equipment_id: str,
            qty: int,
            to_location: str,
            note: str = "",
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "equipment_id": equipment_id,
                "qty": qty,
                "to_location": to_location,
                "note": note,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                body = self.backend.TransferCreate(
                    qty=qty, to_location=to_location, note=note
                )
                return await self.backend.create_transfer(
                    equipment_id, body, self._domain_user()
                )

            return await self.invoke(
                tool="inventory_transfer",
                parameters=params,
                required_scope="inventory:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=(
                    f"Transfer {qty} unit(s) of {equipment_id} to {to_location}."
                ),
            )

        @mcp.tool(
            name="inventory_receive_transfer",
            description="Receive an in-transit inventory transfer. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def inventory_receive_transfer(
            transfer_id: str, confirmation_token: str | None = None
        ) -> dict[str, Any]:
            params = {"transfer_id": transfer_id}

            async def operation(_: AgentPrincipal, key: str | None) -> Any:
                return await self.backend.receive_transfer(
                    transfer_id, self._domain_user(), key
                )

            return await self.invoke(
                tool="inventory_receive_transfer",
                parameters=params,
                required_scope="inventory:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Receive inventory transfer {transfer_id}.",
            )

        @mcp.tool(
            name="rental_create",
            description="Create an active rental using the existing inventory ledger. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def rental_create(
            customer_name: str,
            start_date: datetime,
            lines: list[dict[str, Any]],
            customer_phone: str = "",
            customer_email: str = "",
            primary_contact: str = "",
            preferred_contact_method: str = "call",
            delivery_notes: str = "",
            return_notes: str = "",
            gate_access_instructions: str = "",
            contact_permission: bool = False,
            job_site: str = "",
            deposit: float = 0.0,
            notes: str = "",
            due_date: datetime | None = None,
            lat: float | None = None,
            lng: float | None = None,
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "customer_name": customer_name,
                "start_date": start_date,
                "lines": lines,
                "customer_phone": customer_phone,
                "customer_email": customer_email,
                "primary_contact": primary_contact,
                "preferred_contact_method": preferred_contact_method,
                "delivery_notes": delivery_notes,
                "return_notes": return_notes,
                "gate_access_instructions": gate_access_instructions,
                "contact_permission": contact_permission,
                "job_site": job_site,
                "deposit": deposit,
                "notes": notes,
                "due_date": due_date,
                "lat": lat,
                "lng": lng,
            }

            async def operation(_: AgentPrincipal, key: str | None) -> Any:
                body = self.backend.RentalCreate(**params)
                return await self.backend.create_rental(body, self._domain_user(), key)

            return await self.invoke(
                tool="rental_create",
                parameters=params,
                required_scope="rentals:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Create a rental for {customer_name} with {len(lines)} line(s).",
            )

        @mcp.tool(
            name="rental_return",
            description=(
                "Record returned/damaged rental quantities through the inventory ledger. "
                "Requires explicit confirmation."
            ),
            annotations=MUTATING,
        )
        async def rental_return(
            rental_id: str,
            returns: list[dict[str, Any]],
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {"rental_id": rental_id, "returns": returns}

            async def operation(_: AgentPrincipal, key: str | None) -> Any:
                bodies = [self.backend.ReturnLine(**item) for item in returns]
                return await self.backend.partial_return(
                    rental_id, bodies, self._domain_user(), key
                )

            return await self.invoke(
                tool="rental_return",
                parameters=params,
                required_scope="rentals:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Record {len(returns)} return line(s) for rental {rental_id}.",
            )

        @mcp.tool(
            name="rental_schedule_pickup",
            description="Schedule an inbound pickup dispatch for a rental. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def rental_schedule_pickup(
            rental_id: str,
            scheduled_date: datetime | None = None,
            driver_name: str = "",
            truck: str = "",
            trailer: str = "",
            crew: str = "",
            notes: str = "",
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "rental_id": rental_id,
                "scheduled_date": scheduled_date,
                "driver_name": driver_name,
                "truck": truck,
                "trailer": trailer,
                "crew": crew,
                "notes": notes,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                body = self.backend.SchedulePickupCreate(
                    **{k: v for k, v in params.items() if k != "rental_id"}
                )
                return await self.backend.schedule_pickup(
                    rental_id, body, self._domain_user()
                )

            return await self.invoke(
                tool="rental_schedule_pickup",
                parameters=params,
                required_scope="rentals:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Schedule pickup for rental {rental_id}.",
            )

        @mcp.tool(
            name="rental_log_communication",
            description="Attach a call, text, email, in-person update, or other communication to a rental. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def rental_log_communication(
            rental_id: str,
            channel: str,
            summary: str,
            direction: str = "outgoing",
            outcome: str = "",
            trigger_key: str = "",
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "rental_id": rental_id,
                "channel": channel,
                "summary": summary,
                "direction": direction,
                "outcome": outcome,
                "trigger_key": trigger_key,
            }

            async def operation(_: AgentPrincipal, key: str | None) -> Any:
                body = self.backend.CommunicationLogCreate(
                    channel=channel,
                    summary=summary,
                    direction=direction,
                    outcome=outcome,
                    trigger_key=trigger_key,
                )
                return await self.backend.create_rental_communication(
                    rental_id, body, self._domain_user(), key
                )

            return await self.invoke(
                tool="rental_log_communication",
                parameters=params,
                required_scope="rentals:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Log a {channel} communication on rental {rental_id}.",
            )

        @mcp.tool(
            name="booking_create",
            description=(
                "Create a booking and reserve inventory with existing booking rules. "
                "Requires explicit confirmation."
            ),
            annotations=MUTATING,
        )
        async def booking_create(
            customer_name: str,
            start_date: datetime,
            end_date: datetime,
            items: list[dict[str, Any]],
            job_site: str = "",
            status: str = "tentative",
            notes: str = "",
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "customer_name": customer_name,
                "start_date": start_date,
                "end_date": end_date,
                "items": items,
                "job_site": job_site,
                "status": status,
                "notes": notes,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                return await self.backend.create_booking(
                    self.backend.BookingCreate(**params), self._domain_user()
                )

            return await self.invoke(
                tool="booking_create",
                parameters=params,
                required_scope="bookings:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Create {status} booking for {customer_name} with {len(items)} item line(s).",
            )

        @mcp.tool(
            name="booking_set_status",
            description=(
                "Change a booking status, including reserve/release side effects. "
                "Requires explicit confirmation."
            ),
            annotations=MUTATING,
        )
        async def booking_set_status(
            booking_id: str, status: str, confirmation_token: str | None = None
        ) -> dict[str, Any]:
            params = {"booking_id": booking_id, "status": status}

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                return await self.backend.update_booking_status(
                    booking_id,
                    self.backend.BookingStatusUpdate(status=status),
                    self._domain_user(),
                )

            return await self.invoke(
                tool="booking_set_status",
                parameters=params,
                required_scope="bookings:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Set booking {booking_id} status to {status}.",
            )

        @mcp.tool(
            name="booking_dispatch",
            description=(
                "Fast-forward a confirmed booking through dispatch into a rental. "
                "Requires explicit confirmation."
            ),
            annotations=MUTATING,
        )
        async def booking_dispatch(
            booking_id: str, confirmation_token: str | None = None
        ) -> dict[str, Any]:
            params = {"booking_id": booking_id}
            return await self.invoke(
                tool="booking_dispatch",
                parameters=params,
                required_scope="bookings:write",
                action="write",
                operation=lambda _p, _k: self.backend.dispatch_booking(
                    booking_id, self._domain_user()
                ),
                confirmation_token=confirmation_token,
                confirmation_summary=f"Dispatch booking {booking_id} and create its active rental.",
            )

        @mcp.tool(
            name="dispatch_create",
            description=(
                "Create an inbound or outbound dispatch using existing stock checks. "
                "Requires explicit confirmation."
            ),
            annotations=MUTATING,
        )
        async def dispatch_create(
            direction: str,
            customer_name: str,
            lines: list[dict[str, Any]],
            scheduled_date: datetime | None = None,
            job_site: str = "",
            rental_id: str | None = None,
            booking_id: str | None = None,
            driver_name: str = "",
            truck: str = "",
            trailer: str = "",
            crew: str = "",
            notes: str = "",
            lat: float | None = None,
            lng: float | None = None,
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "direction": direction,
                "customer_name": customer_name,
                "lines": lines,
                "scheduled_date": scheduled_date,
                "job_site": job_site,
                "rental_id": rental_id,
                "booking_id": booking_id,
                "driver_name": driver_name,
                "truck": truck,
                "trailer": trailer,
                "crew": crew,
                "notes": notes,
                "lat": lat,
                "lng": lng,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                return await self.backend.create_dispatch(
                    self.backend.DispatchCreate(**params), self._domain_user()
                )

            return await self.invoke(
                tool="dispatch_create",
                parameters=params,
                required_scope="dispatch:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Create {direction} dispatch for {customer_name} with {len(lines)} line(s).",
            )

        @mcp.tool(
            name="dispatch_set_status",
            description=(
                "Advance a dispatch by one validated workflow step or cancel it. "
                "Requires explicit confirmation."
            ),
            annotations=MUTATING,
        )
        async def dispatch_set_status(
            dispatch_id: str, status: str, confirmation_token: str | None = None
        ) -> dict[str, Any]:
            params = {"dispatch_id": dispatch_id, "status": status}

            async def operation(_: AgentPrincipal, key: str | None) -> Any:
                return await self.backend.update_dispatch_status(
                    dispatch_id,
                    self.backend.DispatchStatusUpdate(status=status),
                    self._domain_user(),
                    key,
                )

            return await self.invoke(
                tool="dispatch_set_status",
                parameters=params,
                required_scope="dispatch:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Advance dispatch {dispatch_id} to {status}.",
            )

        @mcp.tool(
            name="dispatch_assign",
            description="Assign driver/vehicle/crew details to a dispatch. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def dispatch_assign(
            dispatch_id: str,
            driver_name: str | None = None,
            truck: str | None = None,
            trailer: str | None = None,
            crew: str | None = None,
            scheduled_date: datetime | None = None,
            notes: str | None = None,
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "dispatch_id": dispatch_id,
                "driver_name": driver_name,
                "truck": truck,
                "trailer": trailer,
                "crew": crew,
                "scheduled_date": scheduled_date,
                "notes": notes,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                body = self.backend.DispatchAssignUpdate(
                    **{k: v for k, v in params.items() if k != "dispatch_id"}
                )
                return await self.backend.assign_dispatch(
                    dispatch_id, body, self._domain_user()
                )

            return await self.invoke(
                tool="dispatch_assign",
                parameters=params,
                required_scope="dispatch:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Update assignment details for dispatch {dispatch_id}.",
            )

        @mcp.tool(
            name="maintenance_create",
            description="Create a maintenance record. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def maintenance_create(
            equipment_id: str,
            issue: str,
            action_taken: str = "",
            cost: float = 0.0,
            qty: int = 1,
            status: str = "open",
            serviced_at: datetime | None = None,
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "equipment_id": equipment_id,
                "issue": issue,
                "action_taken": action_taken,
                "cost": cost,
                "qty": qty,
                "status": status,
                "serviced_at": serviced_at,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                return await self.backend.create_maintenance(
                    self.backend.MaintenanceCreate(**params), self._domain_user()
                )

            return await self.invoke(
                tool="maintenance_create",
                parameters=params,
                required_scope="maintenance:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Create {status} maintenance record for {equipment_id}: {issue}",
            )

        @mcp.tool(
            name="maintenance_update",
            description="Update a maintenance record through MobileOps. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def maintenance_update(
            maintenance_id: str,
            equipment_id: str,
            issue: str,
            action_taken: str = "",
            cost: float = 0.0,
            qty: int = 1,
            status: str = "open",
            serviced_at: datetime | None = None,
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "maintenance_id": maintenance_id,
                "equipment_id": equipment_id,
                "issue": issue,
                "action_taken": action_taken,
                "cost": cost,
                "qty": qty,
                "status": status,
                "serviced_at": serviced_at,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                body = self.backend.MaintenanceCreate(
                    **{k: v for k, v in params.items() if k != "maintenance_id"}
                )
                return await self.backend.update_maintenance(
                    maintenance_id, body, self._domain_user()
                )

            return await self.invoke(
                tool="maintenance_update",
                parameters=params,
                required_scope="maintenance:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Update maintenance record {maintenance_id} to {status}.",
            )

        @mcp.tool(
            name="shop_task_create",
            description="Create a shop task through MobileOps. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def shop_task_create(
            title: str,
            description: str = "",
            task_type: str = "general",
            status: str = "to_do",
            priority: str = "normal",
            assignee: str = "",
            due_date: datetime | None = None,
            notes: str = "",
            checklist: list[dict[str, Any]] | None = None,
            qty: int = 0,
            related_rental_id: str | None = None,
            related_booking_id: str | None = None,
            related_equipment_id: str | None = None,
            confirmation_token: str | None = None,
        ) -> dict[str, Any]:
            params = {
                "title": title,
                "description": description,
                "task_type": task_type,
                "status": status,
                "priority": priority,
                "assignee": assignee,
                "due_date": due_date,
                "notes": notes,
                "checklist": checklist or [],
                "qty": qty,
                "related_rental_id": related_rental_id,
                "related_booking_id": related_booking_id,
                "related_equipment_id": related_equipment_id,
            }

            async def operation(_: AgentPrincipal, __: str | None) -> Any:
                return await self.backend.create_shop_task(
                    self.backend.ShopTaskCreate(**params), self._domain_user()
                )

            return await self.invoke(
                tool="shop_task_create",
                parameters=params,
                required_scope="shop_tasks:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Create {priority} priority shop task: {title}",
            )

        @mcp.tool(
            name="shop_task_set_status",
            description="Change a shop task status and run completion side effects. Requires explicit confirmation.",
            annotations=MUTATING,
        )
        async def shop_task_set_status(
            task_id: str, status: str, confirmation_token: str | None = None
        ) -> dict[str, Any]:
            params = {"task_id": task_id, "status": status}

            async def operation(_: AgentPrincipal, key: str | None) -> Any:
                return await self.backend.update_shop_task_status(
                    task_id,
                    self.backend.ShopTaskStatusUpdate(status=status),
                    self._domain_user(),
                    key,
                )

            return await self.invoke(
                tool="shop_task_set_status",
                parameters=params,
                required_scope="shop_tasks:write",
                action="write",
                operation=operation,
                confirmation_token=confirmation_token,
                confirmation_summary=f"Set shop task {task_id} status to {status}.",
            )


def create_mobileops_mcp(
    backend: Any,
    *,
    principal_provider: Callable[
        [], AccessToken | AgentPrincipal | None
    ] = get_access_token,
) -> MobileOpsMCP:
    return MobileOpsMCP(backend, principal_provider=principal_provider)

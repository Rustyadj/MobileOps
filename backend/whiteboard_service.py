"""Whiteboard domain helpers and the narrow Hermes/Nathan gateway client.

This module deliberately knows nothing about Mongo or MobileOps inventory.  The
API layer supplies a bounded conversation/operations snapshot, and the gateway
only sends that snapshot to the configured Hermes profile.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.parse import quote, urlparse, urlunparse

import httpx
from websockets.asyncio.client import connect


MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z0-9._-]{1,64})")


def normalize_handle(value: str) -> str:
    """Return the case-insensitive canonical handle used by mention records."""
    return re.sub(r"[^a-z0-9._-]", "", value.strip().lower().lstrip("@"))


def mentioned_handles(body: str) -> list[str]:
    """Extract unique mentions in display order without hard-coding entities."""
    found: list[str] = []
    seen: set[str] = set()
    for match in MENTION_RE.finditer(body or ""):
        handle = normalize_handle(match.group(1))
        if handle and handle not in seen:
            seen.add(handle)
            found.append(handle)
    return found


@dataclass(frozen=True)
class HermesResult:
    text: str
    status: str


class HermesNathanGateway:
    """Minimal JSON-RPC client for one Hermes profile and one submitted turn."""

    def __init__(self) -> None:
        self.url = os.environ.get("HERMES_NATHAN_GATEWAY_URL", "").strip()
        self.token = os.environ.get("HERMES_NATHAN_GATEWAY_TOKEN", "").strip()
        self.basic_auth = os.environ.get(
            "HERMES_NATHAN_GATEWAY_BASIC_AUTH", "false"
        ).strip().lower() in {"1", "true", "yes", "on"}
        self.username = os.environ.get(
            "HERMES_NATHAN_GATEWAY_USERNAME", "mobileops"
        ).strip()
        # The legacy gateway token doubles as the dedicated dashboard password
        # unless a separate password is provisioned. This keeps one shared
        # service secret while supporting Hermes' current ticket-based WS auth.
        self.password = (
            os.environ.get("HERMES_NATHAN_GATEWAY_PASSWORD", "").strip()
            or self.token
        )
        self.connect_host = os.environ.get("HERMES_NATHAN_CONNECT_HOST", "").strip()
        self.connect_port = int(os.environ.get("HERMES_NATHAN_CONNECT_PORT", "0") or 0)
        self.profile = os.environ.get("HERMES_NATHAN_PROFILE", "nathan").strip() or "nathan"
        self.timeout_seconds = float(os.environ.get("HERMES_NATHAN_TIMEOUT_SECONDS", "180"))

    @property
    def configured(self) -> bool:
        if self.basic_auth:
            return bool(self.url and self.username and self.password)
        return bool(self.url and self.token)

    def _dashboard_http_url(self, endpoint: str) -> tuple[str, dict[str, str]]:
        """Build a dashboard HTTP URL while preserving its logical Host."""
        parsed = urlparse(self.url)
        scheme = "https" if parsed.scheme == "wss" else "http"
        logical_netloc = parsed.netloc
        connect_netloc = logical_netloc
        if self.connect_host:
            port = self.connect_port or parsed.port
            connect_netloc = f"{self.connect_host}:{port}" if port else self.connect_host

        base_path = parsed.path
        if base_path.endswith("/api/ws"):
            base_path = base_path[: -len("/api/ws")]
        path = f"{base_path.rstrip('/')}/{endpoint.lstrip('/')}"
        url = urlunparse((scheme, connect_netloc, path, "", "", ""))
        return url, {"Host": logical_netloc}

    async def _authenticated_ws_url(self) -> str:
        if not self.basic_auth:
            separator = "&" if "?" in self.url else "?"
            return f"{self.url}{separator}token={quote(self.token, safe='')}"

        login_url, headers = self._dashboard_http_url("auth/password-login")
        ticket_url, _ = self._dashboard_http_url("api/auth/ws-ticket")
        timeout = httpx.Timeout(self.timeout_seconds, connect=min(30.0, self.timeout_seconds))
        async with httpx.AsyncClient(
            headers=headers,
            timeout=timeout,
            follow_redirects=False,
            trust_env=False,
        ) as client:
            login = await client.post(
                login_url,
                json={
                    "provider": "basic",
                    "username": self.username,
                    "password": self.password,
                    "next": "/",
                },
            )
            if login.status_code != 200:
                raise RuntimeError(
                    f"Nathan dashboard authentication failed ({login.status_code})"
                )
            ticket_response = await client.post(ticket_url)
            if ticket_response.status_code != 200:
                raise RuntimeError(
                    f"Nathan WebSocket ticket failed ({ticket_response.status_code})"
                )
            ticket = str(ticket_response.json().get("ticket") or "").strip()
            if not ticket:
                raise RuntimeError("Nathan dashboard returned no WebSocket ticket")

        separator = "&" if "?" in self.url else "?"
        return f"{self.url}{separator}ticket={quote(ticket, safe='')}"

    async def invoke(self, *, title: str, prompt: str) -> HermesResult:
        if not self.configured:
            raise RuntimeError("Nathan gateway is not configured")
        async with asyncio.timeout(self.timeout_seconds):
            ws_url = await self._authenticated_ws_url()
            transport: dict[str, Any] = {}
            # A private TCP relay may be used while the WebSocket URI/Host must
            # stay loopback for Hermes' host validation.
            if self.connect_host:
                transport["host"] = self.connect_host
            if self.connect_port:
                transport["port"] = self.connect_port
            async with connect(ws_url, max_size=4 * 1024 * 1024, ping_interval=20, **transport) as socket:
                await socket.send(json.dumps({
                    "jsonrpc": "2.0",
                    "id": "create",
                    "method": "session.create",
                    "params": {
                        "title": title[:120],
                        "source": "mobileops-whiteboard",
                        "profile": self.profile,
                        "close_on_disconnect": True,
                    },
                }))
                session_id = ""
                while not session_id:
                    frame = json.loads(await socket.recv())
                    if frame.get("id") != "create":
                        continue
                    if frame.get("error"):
                        raise RuntimeError(str(frame["error"].get("message") or "Hermes session failed"))
                    session_id = str((frame.get("result") or {}).get("session_id") or "")
                    if not session_id:
                        raise RuntimeError("Hermes did not return a session")

                await socket.send(json.dumps({
                    "jsonrpc": "2.0",
                    "id": "submit",
                    "method": "prompt.submit",
                    "params": {"session_id": session_id, "text": prompt},
                }))
                while True:
                    frame = json.loads(await socket.recv())
                    if frame.get("id") == "submit" and frame.get("error"):
                        raise RuntimeError(str(frame["error"].get("message") or "Hermes prompt failed"))
                    if frame.get("method") != "event":
                        continue
                    params: dict[str, Any] = frame.get("params") or {}
                    if params.get("type") != "message.complete":
                        continue
                    if str(params.get("session_id") or "") != session_id:
                        continue
                    payload = params.get("payload") if isinstance(params.get("payload"), dict) else params
                    text = str(payload.get("text") or "").strip()
                    status = str(payload.get("status") or "complete")
                    if not text:
                        raise RuntimeError("Nathan returned an empty response")
                    return HermesResult(text=text, status=status)


def build_nathan_prompt(
    *,
    message: str,
    author: str,
    timestamp: str,
    thread_history: Iterable[dict[str, Any]],
    operations_context: dict[str, Any],
) -> str:
    """Build a bounded, labeled prompt; never let the gateway query arbitrary DB data."""
    history = [
        {
            "author": str(item.get("author_name") or "Unknown"),
            "author_type": str(item.get("author_type") or "user"),
            "timestamp": str(item.get("created_at") or ""),
            "message": str(item.get("body") or ""),
        }
        for item in thread_history
        if not item.get("is_deleted")
    ][-12:]
    envelope = {
        "instruction": "Reply as Nathan, the MobileOps internal operations agent. Be concise and action-oriented. Do not claim an operation was performed unless the provided context proves it.",
        "current_message": {"text": message, "author": author, "timestamp": timestamp},
        "recent_thread_history": history,
        "relevant_operations_context": operations_context,
    }
    return "MobileOps Whiteboard invocation:\n" + json.dumps(envelope, default=str, ensure_ascii=False)


# --------------------------------------------------------------------------
# Nathan2 rental availability review
# --------------------------------------------------------------------------
# Nathan2 sits *above* the deterministic forecast in rental_availability.py.
# The numbers are already decided before this code runs; Nathan2 only judges
# whether the situation those numbers describe is an operational problem.

REVIEW_STATES = ("green", "amber", "red")


def deterministic_review_state(forecast: dict[str, Any]) -> str:
    """The floor Nathan2 may never undercut, derived from the numbers alone."""
    lines = forecast.get("lines") or []
    if any(int(line.get("projected_shortage") or 0) > 0 for line in lines):
        return "red"
    if any(
        line.get("risky_returns")
        or int(line.get("requested_qty") or 0) > int(line.get("available_now") or 0)
        for line in lines
    ):
        return "amber"
    return "green"


def build_rental_review_prompt(
    *,
    order_text: str,
    notes: str,
    requested_date: str,
    date_confirmed: bool,
    forecast: dict[str, Any],
) -> str:
    """Bounded envelope. The forecast is supplied whole so Nathan2 never has to
    compute — or guess at — a quantity."""
    envelope = {
        "instruction": (
            "You are Nathan, the MobileOps operations agent, reviewing one outbound rental. "
            "The deterministic inventory forecast below is authoritative and already correct. "
            "Never restate a different number, never invent an expected return, and never "
            "assume inventory that is not in the forecast. Decide only whether the situation "
            "is a real operational problem. Reply as JSON: "
            '{"state": "green"|"amber"|"red", "reasoning": "one or two sentences"}. '
            "green = projected inventory covers the request. "
            "amber = it covers the request only if an uncertain, overdue, or unconfirmed "
            "dependency holds, or if turnaround between a return and this outbound is tight. "
            "red = projected inventory is short."
        ),
        "rental": {
            "order_text": order_text,
            "notes": notes,
            "requested_date": requested_date,
            "date_confirmed": date_confirmed,
            "date_note": (
                "Confirmed date." if date_confirmed
                else "Unconfirmed date (typed with '?') — tentative demand, not a firm commitment."
            ),
        },
        "deterministic_forecast": forecast,
        "floor_state": deterministic_review_state(forecast),
    }
    return "MobileOps rental availability review:\n" + json.dumps(envelope, default=str, ensure_ascii=False)


def parse_rental_review(text: str, forecast: dict[str, Any]) -> dict[str, Any]:
    """Read Nathan2's verdict, then clamp it to what the numbers allow.

    A model may only ever make the picture *worse* than the arithmetic does —
    it can raise green to amber on an uncertain dependency, but it can never
    talk a shortage down into an all-clear.
    """
    floor = deterministic_review_state(forecast)
    state, reasoning = floor, ""
    match = re.search(r"\{.*\}", text or "", re.DOTALL)
    if match:
        try:
            payload = json.loads(match.group(0))
            candidate = str(payload.get("state") or "").strip().lower()
            if candidate in REVIEW_STATES:
                state = candidate
            reasoning = str(payload.get("reasoning") or "").strip()
        except (ValueError, AttributeError):
            reasoning = ""
    if not reasoning:
        reasoning = (text or "").strip()[:400]
    if REVIEW_STATES.index(state) < REVIEW_STATES.index(floor):
        state = floor
    return {"state": state, "reasoning": reasoning, "floor_state": floor}

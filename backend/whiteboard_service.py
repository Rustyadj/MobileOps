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
from urllib.parse import quote

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
        self.connect_host = os.environ.get("HERMES_NATHAN_CONNECT_HOST", "").strip()
        self.connect_port = int(os.environ.get("HERMES_NATHAN_CONNECT_PORT", "0") or 0)
        self.profile = os.environ.get("HERMES_NATHAN_PROFILE", "nathan").strip() or "nathan"
        self.timeout_seconds = float(os.environ.get("HERMES_NATHAN_TIMEOUT_SECONDS", "180"))

    @property
    def configured(self) -> bool:
        return bool(self.url and self.token)

    async def invoke(self, *, title: str, prompt: str) -> HermesResult:
        if not self.configured:
            raise RuntimeError("Nathan gateway is not configured")
        separator = "&" if "?" in self.url else "?"
        ws_url = f"{self.url}{separator}token={quote(self.token, safe='')}"
        async with asyncio.timeout(self.timeout_seconds):
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

"""Generated-file storage, signed document links, and the import/export audit trail.

Generated exports are stored as immutable snapshots (so the file a user is handed is
exactly what was produced at request time, not a later regeneration) and expire. Files
are only ever served after an authenticated owner/admin check or a short-lived signed
link whose role is bound at issue time. Pure of FastAPI: callers pass the Mongo handle.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

GENERATED_FILE_TTL = timedelta(days=14)
MAX_GENERATED_BYTES = 12_000_000  # stays well under Mongo's 16 MB document limit
SIGNED_LINK_TTL_SECONDS = 600
UPLOAD_LINK_TTL_SECONDS = 600

MEDIA_TYPES = {
    "pdf": "application/pdf",
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class DocumentError(ValueError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


# ----------------------------- signed links --------------------------------
def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(secret: bytes, purpose: str, body: str) -> str:
    # The purpose is part of the MAC input, so a download link can never be replayed as an upload link.
    return _b64(hmac.new(secret, f"mobileops-{purpose}:".encode() + body.encode(), hashlib.sha256).digest())


def sign_token(secret: bytes, purpose: str, payload: dict[str, Any], *, ttl: int, now: Optional[float] = None) -> str:
    body_payload = {**payload, "jti": uuid.uuid4().hex, "exp": int((now if now is not None else time.time()) + ttl)}
    body = _b64(json.dumps(body_payload, sort_keys=True, separators=(",", ":")).encode())
    return f"{body}.{_mac(secret, purpose, body)}"


def verify_token(secret: bytes, purpose: str, token: str, *, now: Optional[float] = None) -> dict[str, Any]:
    try:
        body, signature = token.split(".", 1)
        if not hmac.compare_digest(signature, _mac(secret, purpose, body)):
            raise DocumentError("Invalid link")
        payload = json.loads(_unb64(body))
    except (ValueError, TypeError) as exc:
        raise DocumentError("Invalid link") from exc
    if not isinstance(payload, dict) or payload.get("exp", 0) < (now if now is not None else time.time()):
        raise DocumentError("Link expired")
    return payload


async def consume_token_once(db: Any, payload: dict[str, Any]) -> None:
    """Single-use links: the jti is the document _id, so a replay hits a duplicate-key error."""
    from pymongo.errors import DuplicateKeyError

    try:
        await db.document_token_uses.insert_one({"_id": payload["jti"], "used_at": utc_now(),
                                                 "expires_at": datetime.fromtimestamp(int(payload["exp"]), tz=timezone.utc)})
    except DuplicateKeyError as exc:
        raise DocumentError("Link has already been used") from exc


# ----------------------------- generated files -----------------------------
def _public(doc: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in doc.items() if k not in ("_id", "content")}


async def store_generated_file(
    db: Any, *, kind: str, filename: str, media_type: str, content: bytes, created_by_id: str,
    created_by_name: str, role: str, dataset: str = "", fmt: str = "", filters: Optional[dict[str, Any]] = None,
    record_count: int = 0, source_ref: Optional[str] = None,
) -> dict[str, Any]:
    if len(content) > MAX_GENERATED_BYTES:
        raise DocumentError("Generated file is too large; add a filter to narrow the report")
    now = utc_now()
    doc = {
        "id": str(uuid.uuid4()), "kind": kind, "filename": filename, "media_type": media_type, "format": fmt,
        "dataset": dataset, "filters": filters or {}, "record_count": record_count, "source_ref": source_ref,
        "size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(), "role": role,
        "created_by_id": created_by_id, "created_by_name": created_by_name, "created_at": now,
        "expires_at": now + GENERATED_FILE_TTL, "download_count": 0, "content": content,
    }
    await db.generated_files.insert_one(dict(doc))
    return _public(doc)


async def load_generated_file(db: Any, file_id: str) -> dict[str, Any]:
    doc = await db.generated_files.find_one({"id": file_id}, {"_id": 0})
    expires = doc.get("expires_at") if doc else None
    if not doc or (isinstance(expires, datetime) and _aware(expires) <= utc_now()):
        raise DocumentError("File not found or expired")
    return doc


async def mark_downloaded(db: Any, file_id: str) -> None:
    await db.generated_files.update_one({"id": file_id}, {"$inc": {"download_count": 1}, "$set": {"last_downloaded_at": utc_now()}})


async def list_generated_files(db: Any, *, user_id: str, is_admin: bool, limit: int = 50) -> list[dict[str, Any]]:
    query: dict[str, Any] = {"expires_at": {"$gt": utc_now()}}
    if not is_admin:
        query["created_by_id"] = user_id
    cursor = db.generated_files.find(query, {"_id": 0, "content": 0}).sort("created_at", -1)
    return await cursor.to_list(max(1, min(limit, 200)))


def can_access(doc: dict[str, Any], *, user_id: str, is_admin: bool) -> bool:
    return is_admin or doc.get("created_by_id") == user_id


# ----------------------------- audit trail ---------------------------------
async def record_activity(
    db: Any, *, source: str, event_type: str, actor_id: str, actor_name: str, parameters: dict[str, Any],
    result: dict[str, Any], audit_id: Optional[str] = None,
) -> None:
    """One summary row per import/export in `operational_activity` (same collection MCP writes use)."""
    await db.operational_activity.insert_one({
        "id": str(uuid.uuid4()), "timestamp": utc_now(), "source": source, "event_type": event_type,
        "bot": actor_id if actor_id.endswith("-agent") else None, "requesting_user": actor_id,
        "requesting_user_name": actor_name, "tool": event_type, "parameters": parameters, "result": result,
        "audit_id": audit_id,
    })

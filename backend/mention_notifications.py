"""Pure helpers for Live Feed @mention notifications.

No Mongo or FastAPI here: the API layer supplies resolved mentions and the set
of eligible users, and gets back who should be notified. Keeping the decisions
pure makes the dedupe / self-mention / edit-diff rules unit-testable.
"""
from __future__ import annotations

from typing import Any, Iterable

NOTIFICATION_TYPE_FEED_MENTION = "feed_mention"
PREVIEW_LIMIT = 140


def preview_text(body: str, limit: int = PREVIEW_LIMIT) -> str:
    text = " ".join((body or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def mentioned_user_ids(mentions: Iterable[dict[str, Any]], everyone_ids: Iterable[str]) -> list[str]:
    """Expand resolved mentions into unique user ids, preserving mention order.

    Only ``user`` entities and the ``everyone`` group notify anyone; the Nathan
    agent is invoked through its own path and is not a notification recipient.
    """
    seen: set[str] = set()
    ordered: list[str] = []

    def add(user_id: str) -> None:
        if user_id and user_id not in seen:
            seen.add(user_id)
            ordered.append(user_id)

    for item in mentions:
        kind = item.get("entity_type")
        if kind == "user":
            add(str(item["id"]))
        elif kind == "group" and item.get("id") == "everyone":
            for user_id in everyone_ids:
                add(str(user_id))
    return ordered


def plan_recipients(
    mentions: Iterable[dict[str, Any]],
    *,
    author_id: str,
    eligible_user_ids: Iterable[str],
    previously_mentioned: Iterable[str] = (),
) -> list[str]:
    """Who gets a *new* notification for this post or edit.

    - de-duplicated (``@John ... @John`` notifies once)
    - never the author (self-mentions are silent)
    - only users that exist and are not suspended (``eligible_user_ids``)
    - on edit, anyone already mentioned in the prior version is skipped, so
      only newly added mentions notify
    """
    eligible_order = [str(user_id) for user_id in eligible_user_ids]
    eligible = set(eligible_order)
    skip = {str(author_id), *(str(user_id) for user_id in previously_mentioned)}
    candidates = mentioned_user_ids(mentions, eligible_order)
    return [user_id for user_id in candidates if user_id in eligible and user_id not in skip]


def build_notification(
    *,
    notification_id: str,
    recipient_id: str,
    actor_id: str,
    actor_name: str,
    message: dict[str, Any],
    created_at: Any,
) -> dict[str, Any]:
    """Notification document. (type, message_id, user_id) is the idempotency key."""
    is_comment = bool(message.get("parent_id"))
    noun = "comment" if is_comment else "feed post"
    target_id = message.get("parent_id") or message["id"]
    return {
        "id": notification_id,
        "type": NOTIFICATION_TYPE_FEED_MENTION,
        "user_id": recipient_id,
        "actor_id": actor_id,
        "actor_name": actor_name,
        "message_id": message["id"],
        "thread_id": message.get("thread_id", "dashboard"),
        "parent_id": message.get("parent_id"),
        "title": f"{actor_name} mentioned you in a {noun}.",
        "preview": preview_text(message.get("body", "")),
        "link": f"/whiteboard?message={message['id']}&thread={target_id}",
        "read": False,
        "read_at": None,
        "created_at": created_at,
    }

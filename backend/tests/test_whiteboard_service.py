import json

from whiteboard_service import build_nathan_prompt, mentioned_handles, normalize_handle


def test_mentions_are_normalized_deduplicated_and_extensible():
    assert mentioned_handles("@Nathan check this with @Everyone, then @nathan again and email@test.com") == [
        "nathan", "everyone",
    ]
    assert normalize_handle(" @Shop-Foreman ") == "shop-foreman"


def test_nathan_prompt_contains_exact_message_metadata_and_bounded_history():
    history = [
        {"author_name": f"User {index}", "author_type": "user", "created_at": str(index), "body": f"message {index}"}
        for index in range(20)
    ]
    prompt = build_nathan_prompt(
        message="@Nathan what is due?",
        author="Rusty",
        timestamp="2026-08-29T12:00:00+00:00",
        thread_history=history,
        operations_context={"active_rentals": 3},
    )
    envelope = json.loads(prompt.split("\n", 1)[1])
    assert envelope["current_message"] == {
        "text": "@Nathan what is due?", "author": "Rusty", "timestamp": "2026-08-29T12:00:00+00:00",
    }
    assert len(envelope["recent_thread_history"]) == 12
    assert envelope["recent_thread_history"][0]["message"] == "message 8"
    assert envelope["relevant_operations_context"] == {"active_rentals": 3}

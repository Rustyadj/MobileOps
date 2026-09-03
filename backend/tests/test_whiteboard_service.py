import json

from whiteboard_service import (
    HermesNathanGateway,
    build_nathan_prompt,
    mentioned_handles,
    normalize_handle,
)


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


def test_current_dashboard_auth_reuses_the_provisioned_gateway_secret(monkeypatch):
    monkeypatch.setenv("HERMES_NATHAN_GATEWAY_URL", "ws://127.0.0.1:4864/api/ws")
    monkeypatch.setenv("HERMES_NATHAN_GATEWAY_TOKEN", "shared-secret")
    monkeypatch.setenv("HERMES_NATHAN_GATEWAY_BASIC_AUTH", "true")
    monkeypatch.setenv("HERMES_NATHAN_GATEWAY_USERNAME", "mobileops")
    monkeypatch.setenv("HERMES_NATHAN_CONNECT_HOST", "host.docker.internal")
    monkeypatch.setenv("HERMES_NATHAN_CONNECT_PORT", "4863")

    gateway = HermesNathanGateway()

    assert gateway.configured is True
    assert gateway.password == "shared-secret"
    assert gateway._dashboard_http_url("api/auth/ws-ticket") == (
        "http://host.docker.internal:4863/api/auth/ws-ticket",
        {"Host": "127.0.0.1:4864"},
    )

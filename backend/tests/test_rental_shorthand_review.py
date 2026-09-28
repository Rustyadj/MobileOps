"""Nathan2 interprets the rental forecast; it never edits the arithmetic."""
from whiteboard_service import (
    build_rental_review_prompt, deterministic_review_state, parse_rental_review,
)


def forecast(**line):
    base = {
        "requested_qty": 120, "available_now": 94, "projected_available": 144,
        "projected_shortage": 0, "risky_returns": [],
    }
    return {"lines": [{**base, **line}]}


def test_shortage_is_red_from_the_numbers_alone():
    assert deterministic_review_state(forecast(projected_available=104, projected_shortage=16)) == "red"


def test_dependency_on_a_return_is_amber():
    assert deterministic_review_state(forecast()) == "amber"


def test_stock_on_hand_today_is_green():
    assert deterministic_review_state(forecast(available_now=200, projected_available=200)) == "green"


def test_nathan2_may_escalate_green_to_amber():
    covered = forecast(available_now=200, projected_available=200)
    review = parse_rental_review('{"state": "amber", "reasoning": "Denton return is unreliable."}', covered)
    assert review["state"] == "amber"
    assert review["reasoning"] == "Denton return is unreliable."


def test_nathan2_cannot_talk_a_shortage_down_to_green():
    short = forecast(projected_available=104, projected_shortage=16)
    review = parse_rental_review('{"state": "green", "reasoning": "Looks fine to me."}', short)
    assert review["state"] == "red"
    assert review["floor_state"] == "red"


def test_unparseable_reply_falls_back_to_the_deterministic_state():
    short = forecast(projected_available=104, projected_shortage=16)
    review = parse_rental_review("the gateway said something odd", short)
    assert review["state"] == "red"
    assert review["reasoning"] == "the gateway said something odd"


def test_prompt_separates_order_from_notes_and_carries_the_forecast():
    prompt = build_rental_review_prompt(
        order_text="9.18.26? / Carrollton / 120 Gen 2 TB",
        notes="May substitute 12's for 16's",
        requested_date="2026-09-18", date_confirmed=False, forecast=forecast(),
    )
    assert '"order_text": "9.18.26? / Carrollton / 120 Gen 2 TB"' in prompt
    assert '"notes": "May substitute 12\'s for 16\'s"' in prompt
    assert '"floor_state": "amber"' in prompt
    assert "Unconfirmed date" in prompt
    assert "never invent an expected return" in prompt

from datetime import datetime, timedelta, timezone

from backend.rental_availability import forecast_availability


NOW = datetime(2026, 9, 12, tzinfo=timezone.utc)
REQUESTED = datetime(2026, 9, 28, tzinfo=timezone.utc)


def eq(**overrides):
    item = {
        "id": "gen2", "sku": "GEN2", "name": "Nudura Gen 2 braces",
        "category": "bracing", "equipment_family": "nudura_gen2",
        "quantity": 137, "available": 74, "reserved": 0, "staged": 0,
        "pending_inspection": 0, "in_maintenance": 5,
    }
    item.update(overrides)
    return item


def line(qty=120, equipment_id="gen2"):
    return {"equipment_id": equipment_id, "qty": qty}


def rental(qty=58, *, due=NOW + timedelta(days=12), returned=0, rental_id="184"):
    return {
        "id": rental_id, "status": "active", "customer_name": "Return Co", "due_date": due,
        "lines": [{"equipment_id": "gen2", "qty": qty, "delivered_qty": qty, "returned_qty": returned}],
    }


def booking(qty, when, *, booking_id="booking-a", status="confirmed"):
    return {
        "id": booking_id, "status": status, "customer_name": "Other Co", "job_site": "Other site",
        "start_date": when, "end_date": when + timedelta(days=7), "items": [line(qty)],
    }


def forecast(*, equipment=None, bookings=None, rentals=None, dispatches=None, maintenance=None, preferences=None, qty=120):
    return forecast_availability(
        requested_date=REQUESTED, requested_lines=[line(qty)], equipment=equipment or [eq()],
        bookings=bookings or [], rentals=rentals or [], dispatches=dispatches or [],
        maintenance=maintenance or [], customer_preferences=preferences or [], now=NOW,
    )["lines"][0]


def test_enough_inventory_available_today_is_green():
    result = forecast(equipment=[eq(available=143, in_maintenance=0)], qty=120)
    assert result["risk"] == "green"
    assert result["projected_available"] == 143


def test_enough_only_after_scheduled_return_is_yellow():
    result = forecast(rentals=[rental()])
    assert result["risk"] == "yellow"
    assert result["projected_available"] == 132
    assert result["projected_shortage"] == 0


def test_return_after_requested_date_is_not_counted():
    result = forecast(rentals=[rental(due=REQUESTED + timedelta(days=1))])
    assert result["projected_available"] == 74
    assert result["projected_shortage"] == 46
    assert any("after this outbound date" in warning for warning in result["warnings"])


def test_future_reservation_consumes_incoming_inventory():
    result = forecast(equipment=[eq(reserved=20)], rentals=[rental()], bookings=[booking(20, REQUESTED - timedelta(days=2))])
    assert result["projected_available"] == 132
    assert result["projected_shortage"] == 0


def test_multiple_future_outbounds_compete_chronologically():
    commitments = [booking(50, REQUESTED - timedelta(days=3), booking_id="a"), booking(40, REQUESTED - timedelta(days=1), booking_id="b")]
    result = forecast(equipment=[eq(available=20, reserved=90)], rentals=[rental()], bookings=commitments, qty=60)
    assert result["projected_available"] == 78
    assert [event["source_id"] for event in result["timeline"] if event["kind"] == "outbound"] == ["a", "b"]


def test_completed_future_booking_window_returns_supply_for_later_outbound():
    earlier = booking(40, NOW + timedelta(days=2), booking_id="earlier")
    earlier["end_date"] = NOW + timedelta(days=5)
    result = forecast(equipment=[eq(available=34, reserved=40)], bookings=[earlier], qty=70)
    assert result["projected_available"] == 74
    assert [event["kind"] for event in result["timeline"]] == ["outbound", "inbound"]


def test_partial_return_only_credits_outstanding_units():
    result = forecast(rentals=[rental(qty=58, returned=20)])
    assert result["inbound_dependency_qty"] == 38
    assert result["projected_available"] == 112


def test_damaged_returned_equipment_is_excluded():
    result = forecast(equipment=[eq(available=74, in_maintenance=5)], qty=75)
    assert result["projected_available"] == 74
    assert result["repair_qty"] == 5


def test_repair_pipeline_is_potential_not_guaranteed():
    repair = {"equipment_id": "gen2", "qty": 12, "status": "repairing", "estimated_ready_at": NOW + timedelta(days=10)}
    result = forecast(maintenance=[repair])
    assert result["potential_repair_qty"] == 12
    assert result["projected_available"] == 74


def test_preferred_equipment_available():
    prefs = [{"category": "bracing", "equipment_family": "nudura_gen2", "priority": 1, "preference_type": "preferred"}]
    result = forecast(equipment=[eq(available=130, in_maintenance=0)], preferences=prefs)
    assert result["preferred_equipment_match"] is True


def test_preferred_unavailable_but_alternate_is_identified_as_nonmatch():
    prefs = [
        {"category": "bracing", "equipment_family": "other_family", "priority": 1, "preference_type": "preferred"},
        {"category": "bracing", "equipment_family": "nudura_gen2", "priority": 2, "preference_type": "acceptable_alternate"},
    ]
    preferred = eq(id="preferred", sku="PREF", name="Preferred brace", equipment_family="other_family", available=0)
    result = forecast(equipment=[eq(available=130, in_maintenance=0), preferred], preferences=prefs)
    assert result["preferred_equipment_match"] is False
    assert result["projected_available"] == 130
    assert result["preference_type"] == "preferred"


def test_compatible_alternate_is_suggested_without_mutating_request():
    alternate = eq(id="alt", sku="ALT", name="Alternate braces", equipment_family="alternate", available=50, in_maintenance=0)
    prefs = [{"category": "bracing", "equipment_family": "alternate", "priority": 2, "preference_type": "acceptable_alternate"}]
    result = forecast(equipment=[eq(), alternate], preferences=prefs)
    assert result["compatible_alternates"][0]["equipment_id"] == "alt"
    assert any(action["type"] == "use_alternate" and action["requires_approval"] for action in result["suggested_actions"])


def test_projected_shortage_is_red():
    result = forecast()
    assert result["risk"] == "red"
    assert result["projected_shortage"] == 46


def test_overdue_inbound_is_not_credited_and_is_critical():
    result = forecast(rentals=[rental(due=NOW - timedelta(days=1))])
    assert result["risk"] == "critical"
    assert result["projected_available"] == 74
    assert result["risky_returns"][0]["overdue"] is True


def test_double_booking_prevention_signal_reports_shortage():
    result = forecast(equipment=[eq(available=10, reserved=100)], bookings=[booking(100, REQUESTED - timedelta(days=1))], qty=20)
    assert result["projected_available"] == 10
    assert result["projected_shortage"] == 10


def test_recalculation_after_inspected_return_uses_new_ledger_available():
    before = forecast(equipment=[eq(available=74, pending_inspection=10)], qty=80)
    after = forecast(equipment=[eq(available=84, pending_inspection=0)], qty=80)
    assert before["projected_shortage"] == 6
    assert after["risk"] == "green"


def test_recalculation_after_repair_completion_uses_new_ledger_available():
    before = forecast(equipment=[eq(available=74, in_maintenance=5)], qty=78)
    after = forecast(equipment=[eq(available=79, in_maintenance=0)], qty=78)
    assert before["projected_shortage"] == 4
    assert after["risk"] == "green"


def test_nathan_actions_are_advisory_and_reservation_requires_approval():
    result = forecast(equipment=[eq(available=130, in_maintenance=0)])
    reserve = next(action for action in result["suggested_actions"] if action["type"] == "review_reservation")
    assert reserve["requires_approval"] is True


def test_preference_priority_selects_most_specific_first_priority():
    prefs = [
        {"category": "bracing", "priority": 2, "preference_type": "acceptable_alternate"},
        {"category": "bracing", "equipment_family": "nudura_gen2", "priority": 1, "preference_type": "required"},
    ]
    result = forecast(equipment=[eq(available=130, in_maintenance=0)], preferences=prefs)
    assert result["preference_type"] == "required"
    assert result["preference_priority"] == 1


def test_forecast_explanation_matches_timeline_math():
    result = forecast(equipment=[eq(reserved=20)], rentals=[rental()], bookings=[booking(20, REQUESTED - timedelta(days=2))])
    explanation = result["explanation"]
    assert explanation["starting_available"] + explanation["replayable_reserved"] + explanation["dated_inbounds"] - explanation["dated_outbounds"] == explanation["projected_available"]


def test_waiting_inspection_never_counts_as_available():
    result = forecast(equipment=[eq(available=74, pending_inspection=20)], qty=80)
    assert result["projected_available"] == 74
    assert any("waiting inspection" in warning for warning in result["warnings"])


def test_existing_outbound_counts_its_already_staged_allocation_once():
    dispatch = {"id": "out-1", "direction": "outbound", "status": "ready", "lines": [line(60)], "scheduled_date": REQUESTED}
    result = forecast_availability(
        requested_date=REQUESTED, requested_lines=[line(60)],
        equipment=[eq(available=14, reserved=0, staged=60)], bookings=[], rentals=[],
        dispatches=[dispatch], maintenance=[], exclude_dispatch_id="out-1", now=NOW,
    )["lines"][0]
    assert result["projected_available"] == 74
    assert result["explanation"]["already_allocated_to_request"] == 60


def test_manual_unattributed_reservation_stays_unavailable():
    result = forecast(equipment=[eq(available=74, reserved=9)], qty=75)
    assert result["projected_available"] == 74
    assert result["explanation"]["unattributed_reserved"] == 9


# --- Tentative (unconfirmed "9.18.26?") demand -----------------------------
# Tentative rentals hold no stock but are real calendar demand. They must be
# replayed, and the forecast must also report what would be available if they
# fall through, so Nathan2 can tell the two situations apart.

def planning_dispatch(qty, when, *, dispatch_id="plan-a", planning_only=True, date_confirmed=False):
    return {
        "id": dispatch_id, "direction": "outbound", "status": "scheduled",
        "customer_name": "Carrollton", "job_site": "Carrollton",
        "scheduled_date": when, "planning_only": planning_only,
        "date_confirmed": date_confirmed, "reservation_state": "forecast",
        "lines": [line(qty)],
    }


def test_tentative_outbound_consumes_projected_inventory():
    result = forecast(dispatches=[planning_dispatch(40, NOW + timedelta(days=5))])
    assert result["projected_available"] == 34
    assert result["tentative_demand_qty"] == 40


def test_tentative_outbound_is_excluded_from_the_firm_projection():
    result = forecast(qty=70, dispatches=[planning_dispatch(40, NOW + timedelta(days=5))])
    assert result["projected_available"] == 34
    assert result["projected_available_excluding_tentative"] == 74
    assert result["projected_shortage"] == 36
    assert any("tentative/unconfirmed" in warning for warning in result["warnings"])


def test_a_tentative_booking_releases_its_reserved_stock_in_the_firm_projection():
    # Ends after the requested date, so nothing is credited back in between.
    when = REQUESTED - timedelta(days=2)
    result = forecast(
        equipment=[eq(available=34, reserved=40)],
        bookings=[booking(40, when, status="tentative")],
    )
    assert result["projected_available"] == 34
    assert result["projected_available_excluding_tentative"] == 74


def test_a_confirmed_booking_is_never_treated_as_tentative():
    when = REQUESTED - timedelta(days=2)
    result = forecast(
        equipment=[eq(available=34, reserved=40)],
        bookings=[booking(40, when, status="confirmed")],
    )
    assert result["projected_available"] == result["projected_available_excluding_tentative"] == 34
    assert result["tentative_demand_qty"] == 0


def test_a_confirmed_planning_free_dispatch_still_reserves_hard():
    result = forecast(dispatches=[planning_dispatch(
        40, NOW + timedelta(days=5), planning_only=False, date_confirmed=True,
    )])
    assert result["tentative_demand_qty"] == 0
    assert result["projected_available"] == result["projected_available_excluding_tentative"]

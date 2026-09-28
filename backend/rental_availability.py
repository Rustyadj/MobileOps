"""Deterministic rental availability forecasting.

The LLM never performs inventory arithmetic.  This module consumes snapshots
from MobileOps' existing ledger-backed equipment documents and operational
collections, then produces an auditable chronological timeline.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timezone
import re
from typing import Any, Iterable


OPEN_RENTAL_STATUSES = {"active", "partially_returned"}
OPEN_BOOKING_STATUSES = {"tentative", "confirmed"}
OPEN_DISPATCH_STATUSES = {"scheduled", "staging", "ready", "loaded", "dispatched", "arrived", "returning", "at_yard"}
REPAIR_READY_STATUSES = {"ready_for_inspection", "ready"}


def _dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def equipment_family(equipment: dict[str, Any]) -> str:
    """Stable compatibility key with a backwards-compatible derived fallback."""
    raw = equipment.get("equipment_family") or equipment.get("model") or equipment.get("name") or equipment.get("sku") or ""
    return re.sub(r"[^a-z0-9]+", "_", str(raw).lower()).strip("_")


def _line_qty(lines: Iterable[dict[str, Any]], equipment_id: str, *, outstanding: bool = False) -> int:
    total = 0
    for line in lines or []:
        if line.get("equipment_id") != equipment_id:
            continue
        qty = int(line.get("delivered_qty") or line.get("qty") or 0)
        if outstanding:
            qty -= int(line.get("returned_qty") or 0)
        total += max(0, qty)
    return total


def _preference_match(equipment: dict[str, Any], preference: dict[str, Any]) -> bool:
    if preference.get("equipment_id") and preference["equipment_id"] != equipment.get("id"):
        return False
    family = str(preference.get("equipment_family") or "").strip().lower()
    category = str(preference.get("category") or "").strip().lower()
    return (not family or family == equipment_family(equipment)) and (
        not category or category == str(equipment.get("category") or "").lower()
    )


def _preference_for(equipment: dict[str, Any], preferences: list[dict[str, Any]]) -> dict[str, Any] | None:
    matches = [item for item in preferences if _preference_match(equipment, item)]
    return min(matches, key=lambda item: int(item.get("priority") or 9999), default=None)


def forecast_availability(
    *,
    requested_date: datetime,
    requested_lines: list[dict[str, Any]],
    equipment: list[dict[str, Any]],
    bookings: list[dict[str, Any]],
    rentals: list[dict[str, Any]],
    dispatches: list[dict[str, Any]],
    maintenance: list[dict[str, Any]],
    customer_preferences: list[dict[str, Any]] | None = None,
    return_reliability: dict[str, dict[str, Any]] | None = None,
    customer_id: str | None = None,
    customer_name: str = "",
    exclude_booking_id: str | None = None,
    exclude_dispatch_id: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Forecast each requested SKU by replaying dated movements in order.

    ``available`` remains the authoritative usable-now count.  The ledger's
    current ``reserved`` bucket is added only so its attributed future
    commitments can be replayed at their actual dates. Any unattributed
    reserved quantity is immediately subtracted as a conservative manual
    commitment.
    """
    now = now or datetime.now(timezone.utc)
    now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    requested_date = requested_date if requested_date.tzinfo else requested_date.replace(tzinfo=timezone.utc)
    eq_by_id = {item["id"]: item for item in equipment}
    preferences = customer_preferences or []
    return_reliability = return_reliability or {}
    requested: dict[str, int] = defaultdict(int)
    for line in requested_lines:
        requested[str(line.get("equipment_id") or "")] += max(0, int(line.get("qty") or 0))

    line_results: list[dict[str, Any]] = []
    all_warnings: list[str] = []
    overall_rank = 0
    rank_to_risk = {0: "green", 1: "yellow", 2: "red", 3: "critical"}

    for equipment_id, requested_qty in requested.items():
        if not equipment_id or requested_qty <= 0:
            continue
        eq = eq_by_id.get(equipment_id)
        if not eq:
            line_results.append({
                "equipment_id": equipment_id, "requested_qty": requested_qty,
                "available_now": 0, "projected_available": 0,
                "projected_shortage": requested_qty, "risk": "critical",
                "warnings": ["Equipment record no longer exists."], "timeline": [],
            })
            overall_rank = 3
            continue

        available_now = max(0, int(eq.get("available") or 0))
        reserved_bucket = max(0, int(eq.get("reserved") or 0))
        physical_yard = sum(max(0, int(eq.get(bucket) or 0)) for bucket in (
            "available", "reserved", "staged", "pending_inspection", "in_maintenance"
        ))
        repair_qty = max(0, int(eq.get("in_maintenance") or 0))
        inspection_qty = max(0, int(eq.get("pending_inspection") or 0))
        events: list[dict[str, Any]] = []
        attributed_reserved = 0
        excluded_reserved = 0
        allocated_to_request = 0
        linked_outbound_by_booking = {
            str(item.get("booking_id")): item for item in dispatches
            if item.get("direction") == "outbound" and item.get("booking_id") and item.get("status") in OPEN_DISPATCH_STATUSES
        }

        # Bookings are the persistent future reservation records. Linked
        # dispatches are deliberately not added again.
        for booking in bookings:
            if booking.get("status") not in OPEN_BOOKING_STATUSES:
                continue
            qty = _line_qty(booking.get("items") or [], equipment_id)
            if booking.get("id") == exclude_booking_id:
                linked = linked_outbound_by_booking.get(str(booking.get("id")))
                if not linked or linked.get("status") in {"scheduled", "staging"}:
                    excluded_reserved += qty
                else:
                    allocated_to_request += qty
                continue
            when = _dt(booking.get("start_date"))
            if qty and when:
                linked = linked_outbound_by_booking.get(str(booking.get("id")))
                if not linked or linked.get("status") in {"scheduled", "staging"}:
                    attributed_reserved += qty
                    confirmed = booking.get("status") == "confirmed"
                    events.append({
                        "date": when, "kind": "outbound", "qty": -qty,
                        "source_type": "booking", "source_id": booking.get("id"),
                        "label": booking.get("job_site") or booking.get("customer_name") or "Reserved outbound",
                        "confirmed": confirmed, "tentative": not confirmed,
                    })
                expected_back = _dt(booking.get("end_date"))
                if expected_back and expected_back > when:
                    events.append({
                        "date": expected_back, "kind": "inbound", "qty": qty,
                        "source_type": "booking_return", "source_id": booking.get("id"),
                        "label": f"{booking.get('job_site') or booking.get('customer_name') or 'Booking'} expected return",
                        "confirmed": confirmed, "tentative": not confirmed,
                    })

        for dispatch in dispatches:
            if dispatch.get("direction") != "outbound" or dispatch.get("status") not in OPEN_DISPATCH_STATUSES:
                continue
            if dispatch.get("booking_id"):
                continue
            qty = _line_qty(dispatch.get("lines") or [], equipment_id)
            # Planning-only imports and unconfirmed ("9.18.26?") dates hold no
            # reserved stock, but they are still real demand on the calendar.
            # They are replayed as tentative so the forecast can answer both
            # "will this fit?" and "would it fit if the tentative jobs fall
            # through?" — see projected_available_excluding_tentative.
            if dispatch.get("planning_only") or not dispatch.get("date_confirmed", True):
                when = _dt(dispatch.get("scheduled_date"))
                if qty and when and dispatch.get("id") != exclude_dispatch_id:
                    events.append({
                        "date": when, "kind": "outbound", "qty": -qty,
                        "source_type": "dispatch", "source_id": dispatch.get("id"),
                        "label": dispatch.get("job_site") or dispatch.get("customer_name") or "Tentative outbound",
                        "confirmed": False, "tentative": True,
                    })
                continue
            if dispatch.get("id") == exclude_dispatch_id:
                if dispatch.get("status") in {"scheduled", "staging"} and dispatch.get("reservation_state", "hard") != "forecast":
                    excluded_reserved += qty
                elif dispatch.get("status") not in {"scheduled", "staging"}:
                    allocated_to_request += qty
                continue
            if dispatch.get("status") not in {"scheduled", "staging"}:
                continue  # already absent from available/reserved supply
            when = _dt(dispatch.get("scheduled_date"))
            if qty and when:
                # Only scheduled/staging units live in reserved. Later stages
                # are already outside the allocatable pool.
                if dispatch.get("status") in {"scheduled", "staging"} and dispatch.get("reservation_state", "hard") != "forecast":
                    attributed_reserved += qty
                events.append({
                    "date": when, "kind": "outbound", "qty": -qty,
                    "source_type": "dispatch", "source_id": dispatch.get("id"),
                    "label": dispatch.get("job_site") or dispatch.get("customer_name") or "Outbound",
                    "confirmed": True, "tentative": False,
                })

        scheduled_returns: list[dict[str, Any]] = []
        risky_returns: list[dict[str, Any]] = []
        inbound_by_rental: dict[str, dict[str, Any]] = {}
        for dispatch in dispatches:
            if dispatch.get("direction") == "inbound" and dispatch.get("rental_id") and dispatch.get("status") in OPEN_DISPATCH_STATUSES:
                inbound_by_rental[str(dispatch["rental_id"])] = dispatch

        for rental in rentals:
            if rental.get("status") not in OPEN_RENTAL_STATUSES:
                continue
            qty = _line_qty(rental.get("lines") or [], equipment_id, outstanding=True)
            if not qty:
                continue
            inbound = inbound_by_rental.get(str(rental.get("id")))
            when = _dt(inbound.get("scheduled_date")) if inbound else _dt(rental.get("due_date"))
            if not when:
                continue
            overdue = when < now
            reliability = return_reliability.get(str(rental.get("customer_id") or rental.get("customer_name") or ""), {})
            average_days_late = float(reliability.get("average_days_late") or 0)
            historical_risk = average_days_late > 0 or float(reliability.get("on_time_rate") or 1) < 0.8
            item = {
                "rental_id": rental.get("id"), "customer_name": rental.get("customer_name", ""),
                "expected_date": when.date().isoformat(), "qty": qty,
                "overdue": overdue, "scheduled_pickup": bool(inbound),
                "confidence": "low" if overdue or historical_risk else ("high" if inbound and inbound.get("date_confirmed", True) else "medium"),
                "reliability": reliability or None,
            }
            scheduled_returns.append(item)
            if overdue or historical_risk:
                risky_returns.append(item)
            if overdue:
                continue  # Never credit an overdue promise to usable supply.
            events.append({
                "date": when, "kind": "inbound", "qty": qty,
                "source_type": "rental", "source_id": rental.get("id"),
                "label": rental.get("customer_name") or "Scheduled return",
                "confirmed": bool(inbound and inbound.get("date_confirmed", True)),
            })

        potential_repair_qty = 0
        for repair in maintenance:
            if repair.get("equipment_id") != equipment_id:
                continue
            ready = _dt(repair.get("estimated_ready_at") or repair.get("serviced_at"))
            status = str(repair.get("status") or "")
            qty = max(0, int(repair.get("qty") or 0))
            if ready and now <= ready <= requested_date and status not in {"returned_to_inventory"}:
                potential_repair_qty += qty

        # Replay reserved stock. Unattributed/manual reservation remains
        # committed from today and is visible in the explanation.
        unattributed_reserved = max(0, reserved_bucket - attributed_reserved - excluded_reserved)
        running = available_now + reserved_bucket - unattributed_reserved + allocated_to_request
        start_balance = running
        timeline: list[dict[str, Any]] = []
        if unattributed_reserved:
            timeline.append({
                "date": now.date().isoformat(), "kind": "reservation", "qty": -unattributed_reserved,
                "balance": running, "label": "Existing/manual reservation", "source_id": None,
                "tentative": False,
            })

        # Past-due outbounds still consume their reservation. Overdue inbound
        # promises were intentionally omitted above and therefore never
        # inflate supply.
        relevant = [event for event in events if event["date"] <= requested_date]
        relevant.sort(key=lambda event: (event["date"], 0 if event["kind"] == "inbound" else 1, str(event.get("source_id") or "")))
        dependency_qty = 0
        conflicting_confirmed = False
        for event in relevant:
            before = running
            running = max(0, running + int(event["qty"]))
            if event["kind"] == "inbound":
                dependency_qty += int(event["qty"])
            elif event.get("confirmed") and before + int(event["qty"]) < 0:
                conflicting_confirmed = True
            timeline.append({
                "date": event["date"].date().isoformat(), "kind": event["kind"],
                "qty": int(event["qty"]), "balance": running,
                "label": event["label"], "source_type": event["source_type"],
                "source_id": event.get("source_id"), "confirmed": event.get("confirmed", False),
                "tentative": bool(event.get("tentative")),
            })

        projected_available = max(0, running)
        shortage = max(0, requested_qty - projected_available)

        # Replay again without tentative demand. A tentative booking's reserved
        # stock is already added back into the starting balance above, so simply
        # skipping its events leaves those units available — which is exactly the
        # question "would this fit if the tentative jobs fall through?".
        firm = start_balance
        for event in relevant:
            if event.get("tentative"):
                continue
            firm = max(0, firm + int(event["qty"]))
        projected_available_excluding_tentative = max(0, firm)
        tentative_demand_qty = sum(
            -int(event["qty"]) for event in relevant
            if event.get("tentative") and event["kind"] == "outbound"
        )
        pref = _preference_for(eq, preferences)
        category_preferences = sorted(
            [item for item in preferences if not item.get("category") or str(item.get("category")).lower() == str(eq.get("category") or "").lower()],
            key=lambda item: int(item.get("priority") or 9999),
        )
        desired_preferences = [item for item in category_preferences if item.get("preference_type") in {"preferred", "required"}]
        desired_match = next((item for item in desired_preferences if _preference_match(eq, item)), None)
        governing_preference = desired_match or (desired_preferences[0] if desired_preferences else pref)
        compatible_alternates = []
        for candidate in equipment:
            if candidate.get("id") == equipment_id or candidate.get("category") != eq.get("category"):
                continue
            candidate_pref = _preference_for(candidate, preferences)
            if candidate_pref and candidate_pref.get("preference_type") == "avoid":
                continue
            if int(candidate.get("available") or 0) <= 0:
                continue
            compatible_alternates.append({
                "equipment_id": candidate.get("id"), "name": candidate.get("name"),
                "equipment_family": equipment_family(candidate),
                "available_now": int(candidate.get("available") or 0),
                "preference_type": candidate_pref.get("preference_type") if candidate_pref else None,
                "priority": candidate_pref.get("priority") if candidate_pref else None,
            })
        compatible_alternates.sort(key=lambda item: (item["priority"] is None, item["priority"] or 9999, -item["available_now"]))
        warnings: list[str] = []
        if inspection_qty:
            warnings.append(f"{inspection_qty} at-yard unit(s) are waiting inspection and excluded.")
        if repair_qty:
            warnings.append(f"{repair_qty} unit(s) are in repair and excluded from guaranteed availability.")
        if potential_repair_qty:
            warnings.append(f"{potential_repair_qty} repair unit(s) may be ready before the outbound but are not guaranteed.")
        if risky_returns:
            warnings.append("One or more inbound dependencies are overdue or historically unreliable; overdue quantities were not credited.")
        if shortage and projected_available_excluding_tentative >= requested_qty:
            warnings.append(
                f"{tentative_demand_qty} unit(s) are held by tentative/unconfirmed rentals; "
                "this request fits only if those do not happen."
            )
        if desired_preferences and not desired_match:
            desired = desired_preferences[0]
            label = desired.get("equipment_family") or desired.get("category") or "different equipment"
            warnings.append(f"Customer preference conflict: {desired.get('preference_type')} {label}.")
        after_request_returns = [item for item in scheduled_returns if item["expected_date"] > requested_date.date().isoformat()]
        if after_request_returns:
            warnings.append(f"{sum(item['qty'] for item in after_request_returns)} unit(s) are expected back only after this outbound date.")

        if conflicting_confirmed or (risky_returns and requested_qty > available_now):
            risk, rank = "critical", 3
        elif shortage:
            risk, rank = "red", 2
        elif requested_qty > available_now:
            risk, rank = "yellow", 1
        else:
            risk, rank = "green", 0
        overall_rank = max(overall_rank, rank)

        if shortage:
            recommendation = f"Review a {shortage}-unit shortage before committing this outbound."
        elif requested_qty > available_now:
            dependency = next((item for item in scheduled_returns if not item["overdue"] and item["expected_date"] <= requested_date.date().isoformat()), None)
            recommendation = (
                f"Confirm Rental #{str(dependency['rental_id'])[-6:]} returns by {dependency['expected_date']} and reserve {requested_qty} units."
                if dependency else f"Confirm the dated inbound dependencies before reserving {requested_qty} units."
            )
        else:
            recommendation = f"{requested_qty} units are usable and uncommitted now; review and reserve them for this outbound."

        result = {
            "equipment_id": equipment_id, "sku": eq.get("sku"), "name": eq.get("name"),
            "category": eq.get("category"), "equipment_family": equipment_family(eq),
            "requested_qty": requested_qty, "physical_yard_qty": physical_yard,
            "available_now": available_now, "reserved_qty": reserved_bucket,
            "repair_qty": repair_qty, "inspection_qty": inspection_qty,
            "projected_available": projected_available, "projected_shortage": shortage,
            "projected_available_excluding_tentative": projected_available_excluding_tentative,
            "tentative_demand_qty": tentative_demand_qty,
            "potential_repair_qty": potential_repair_qty,
            "scheduled_returns": sorted(scheduled_returns, key=lambda item: item["expected_date"]),
            "returns_before_request": sorted(
                [item for item in scheduled_returns if not item["overdue"] and item["expected_date"] <= requested_date.date().isoformat()],
                key=lambda item: item["expected_date"],
            ),
            "risky_returns": risky_returns, "inbound_dependency_qty": dependency_qty,
            "preferred_equipment_match": bool(desired_match),
            "preference_type": governing_preference.get("preference_type") if governing_preference else None,
            "preference_priority": governing_preference.get("priority") if governing_preference else None,
            "compatible_alternates": compatible_alternates,
            "risk": risk, "confidence": "low" if risk == "critical" else ("medium" if risk == "yellow" else "high"),
            "recommendation": recommendation, "warnings": warnings, "timeline": timeline,
            "explanation": {
                "starting_available": available_now,
                "replayable_reserved": reserved_bucket - unattributed_reserved,
                "already_allocated_to_request": allocated_to_request,
                "dated_inbounds": sum(max(0, int(event["qty"])) for event in relevant),
                "dated_outbounds": sum(-min(0, int(event["qty"])) for event in relevant),
                "unattributed_reserved": unattributed_reserved,
                "projected_available": projected_available,
            },
            "suggested_actions": [
                {"type": "review_reservation", "label": "Review & Reserve", "requires_approval": True},
                {"type": "view_timeline", "label": "View Inventory Timeline", "requires_approval": False},
            ],
        }
        if result["returns_before_request"]:
            result["suggested_actions"].insert(0, {"type": "confirm_return", "label": "Confirm Inbound Return", "requires_approval": True, "rental_id": result["returns_before_request"][0]["rental_id"]})
        if compatible_alternates and (shortage or (desired_preferences and not desired_match)):
            result["suggested_actions"].append({"type": "use_alternate", "label": "Use Alternate Equipment", "requires_approval": True, "equipment_id": compatible_alternates[0]["equipment_id"]})
        line_results.append(result)
        all_warnings.extend(warnings)

    return {
        "requested_date": requested_date.date().isoformat(),
        "customer_id": customer_id, "customer_name": customer_name,
        "risk": rank_to_risk[overall_rank],
        "lines": line_results,
        "warnings": list(dict.fromkeys(all_warnings)),
        "generated_at": now.isoformat(),
        "calculation": "deterministic_inventory_timeline_v1",
    }

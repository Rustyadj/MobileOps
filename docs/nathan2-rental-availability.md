# Nathan2 rental availability

Nathan2 remains the existing Hermes agent. MobileOps now gives that integration deterministic rental forecasts and renders the same structured result contextually in Outbound and Dashboard > Needs Attention.

## Architecture and authoritative state

- `equipment.available` and the existing inventory bucket ledger remain authoritative for usable inventory now. Reserved, staged, waiting-inspection, repair, missing, transfer, and checked-out quantities are not currently available.
- `backend/rental_availability.py` is the reusable deterministic forecast engine. It has no database or LLM logic.
- `build_availability_forecast` loads scoped snapshots from equipment, bookings, rentals, dispatches, maintenance, and customer records.
- Nathan2 interprets the structured result. Inventory arithmetic and risk classification do not happen in a prompt or conversational memory.

## Forecast algorithm

For each requested line, the engine starts with ledger-backed `available`. It temporarily adds only attributable reserved stock so commitments can be replayed on their actual dates; unattributed/manual reservations remain unavailable. It processes scheduled inbound returns, bookings/reservations, standalone outbound commitments, and the request date chronologically.

Inbound and outbound movements on the same date are ordered inbound first and surfaced as a dependency. Returns after the request date and overdue returns are not credited. Damaged, repair, and waiting-inspection units remain excluded. A dated repair estimate is potential supply, never guaranteed, until the normal repair lifecycle returns it to `available`.

Every result includes its timeline and explanation fields for auditability.

The engine also accepts an optional customer return-reliability map (`on_time_rate`,
`average_days_late`, duration, and partial-return metrics). MobileOps does not
invent these values when history is unavailable; the empty interface keeps the
forecast neutral and allows reliability scoring to be added without rewriting
the timeline.

Risk is `green` when stock is available now, `yellow` when dated inbound movements are required, `red` when a shortage remains, and `critical` for confirmed conflicts or overdue/risky inbound dependencies.

## Customer preferences

Company/contact records persist an ordered `preferred_equipment` array:

```json
{
  "category": "bracing",
  "equipment_family": "nudura_gen2",
  "equipment_id": null,
  "priority": 1,
  "preference_type": "preferred"
}
```

Supported types are `preferred`, `acceptable_alternate`, `avoid`, and `required`. Preferences are editable on Contacts and available through `/api/customers/{customer_id}/equipment-preferences`. No customer is hard-coded.

## Endpoints and Nathan2 tools

New/updated HTTP reads:

- `POST /api/availability/forecast`
- `GET /api/dispatches/{dispatch_id}/forecast`
- `GET /api/dashboard/outbound-risks?days=30`
- `GET|PUT /api/customers/{customer_id}/equipment-preferences`
- `PUT /api/maintenance/{maintenance_id}/estimate`
- `GET /api/bookings/capacity` uses the shared timeline engine.

Focused Nathan2 MCP reads:

- `get_inventory_availability`
- `get_inventory_forecast`
- `get_inventory_timeline`
- `get_customer_preferences`
- `get_active_rentals`
- `get_scheduled_returns`
- `get_scheduled_outbounds`
- `get_rental_detail`
- `get_equipment_status`
- `get_repair_pipeline`
- `get_inventory_conflicts`
- `get_outbound_risk`

Existing MCP mutations remain the execution path with scopes, auditing, idempotency, and two-step human confirmation.

## Reservation and approval boundaries

An outbound with enough stock creates a normal hard ledger reservation. If it is supportable only by dated returns, MobileOps records a `forecast` reservation on the outbound. It participates in later forecasts and blocks overlapping commitments. Before staging becomes ready, the authenticated dispatch transition must harden it into the ledger `reserved` bucket.

Nathan2 never silently changes dates, quantities, inventory, reservations, repair priority, assignments, or communications. `Review & Reserve` shows a confirmation and uses the existing authenticated dispatch route. MCP writes still require a confirmation token and configured scope.

## Refresh behavior

The Outbound recommendation is debounced by 450 ms and stale responses are discarded. It refreshes for customer, date, equipment, and quantity changes and every 30 seconds while open. Dashboard risks are computed live only for dated outbounds in the requested horizon; no opaque AI conclusion is stored.

## Schema and migration

MongoDB is schemaless. Startup adds compound forecast indexes. Existing documents remain valid through defaults; no data backfill is required. Optional fields are `equipment.equipment_family`, `vendor.preferred_equipment[]`, `dispatch.reservation_state`, and `maintenance.estimated_ready_at`. Restart the API after deployment so startup creates indexes.

## Tests

`backend/tests/test_rental_availability.py` covers current supply, return dependency/timing, competing reservations, partial returns, damaged/repair/inspection exclusion, preferences/alternates, shortages, overdue inbound, double-booking signal, event recalculation, approval metadata, manual reservations, and explanation math. MCP tests cover scoped reads and confirmed writes.

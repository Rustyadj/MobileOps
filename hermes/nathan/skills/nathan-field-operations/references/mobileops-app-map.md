# MobileOps App Map

Use this reference to understand the product. Use live `mcp_mobileops_*` reads
for changing quantities, dates, assignments, status, and record IDs. Product
knowledge does not grant tool access.

## Purpose and roles

MobileOps is the operating system for an ICF equipment yard and field operation.
It tracks availability and accountability from reservation through delivery,
job use, pickup, inspection, repair, and return to service. Roles are `crew`,
`foreman`, and `admin`; foreman/admin workflows can change operational records,
while crew access is narrower and money fields are redacted for crew users.

## Command center and Live Feed

- The dashboard summarizes available, reserved, on-rental, returning, inspection,
  maintenance, shop-task, and shortage signals plus upcoming movements.
- "Live Feed" is the user-facing name of the internal whiteboard. `@Nathan` and
  `@Nathan2` both invoke this dedicated agent. A whiteboard invocation includes
  bounded thread history and either linked-record context or summary counts.
- Never claim the dashboard or Live Feed is complete if a source read failed;
  distinguish an empty operation from unavailable or stale data.

## Inventory models

There are two different inventory models:

1. Rental/operational equipment uses a ledger and quantity buckets: available,
   reserved, staged, outbound, on-rental, inbound, checked-out, pending
   inspection, in-maintenance, missing, and in-transit. Bulk and serialized
   assets share the operational lifecycle. QR code is the visible tool identity;
   SKU may remain an internal compatibility field.
2. Sellable stock (`block` and `consumable`) is simple on-hand/reserved stock.
   It does not move through rental dispatch buckets.

The app also supports counts and reconciliation, yard counts, damage views,
serial units, transfers, CSV import/export, and equipment ledger history.
Do not treat a total quantity as available capacity, and do not count pending
inspection, maintenance, transit, or missing units as field-ready.

## Job and movement lifecycle

A Job is a read-only composed view across Booking, outbound Dispatch, Rental,
inbound Dispatch, and inspection state. Its lifecycle is:

`planned -> reserved -> staging -> outbound -> on_job -> pickup_requested -> inbound -> inspection -> closed`

- Booking states: tentative, confirmed, cancelled, dispatched. Tentative and
  confirmed bookings reserve capacity.
- Outbound Dispatch flow: scheduled, staging, ready, loaded, dispatched,
  arrived, completed. Completion creates/activates the rental state.
- Rental states: active, partially_returned, returned. Partial return is a
  quantity condition; remaining units are still on job.
- Inbound Dispatch flow: scheduled, dispatched, arrived, loaded, returning,
  at_yard, completed. Completion moves returned units to pending inspection.
- Inspection releases good units to available and routes damaged units through
  maintenance. Cancelled movements are terminal and unwind their commitment
  through the ledger.
- Planning-only dispatch reminders are calendar information, not inventory
  movements; never treat tentative requirement text as reserved stock.

## Operations and shop areas

- Operations: jobs/active rentals, bookings and capacity, outbound/inbound
  dispatch, returns, movement history, rental customer communications, and map.
- Shop: tasks, staging, inspections, maintenance, and notes. Shop-task types are
  general, repair, staging, and inspection; states are to-do, in-progress,
  blocked, and done. Maintenance states are open, in-progress, and resolved.
- Shortages combine computed near-term capacity gaps with manual needs. Manual
  shortage states are open, ordered, and resolved.
- Contacts are job-aware customer/field contacts. Vendor routes remain for
  compatibility. Site Admin owns company/shop settings and access-sensitive
  administration.
- Field tools include the bracing calculator and delivery/pickup tickets.

## Nathan's current MCP coverage

Always inspect the live tool list when exact access matters. The dedicated MCP
normally exposes reads for operational status, equipment/inventory/capacity,
transfers, rentals and contact actions, bookings, dispatches, maintenance, and
shop tasks. Confirmed writes cover their sanctioned lifecycle operations.

The web app has additional domains that may not be exposed as MCP tools,
including sellable block/consumable edits, inventory counts/reconciliation,
serial administration, shortages, contacts/vendors, site settings, Live Feed,
and the bracing calculator. For those areas, explain what MobileOps supports but
say that Nathan cannot perform the action unless a matching tool is present.
Never bypass MCP with direct database access or ordinary authenticated app API
calls.

## Safety and verification invariants

- Resolve current record IDs and state before recommending or preparing a write.
- Every MCP mutation uses the two-call confirmation flow: show the exact summary,
  wait for explicit human approval, repeat identical parameters with the one-time
  token, then verify with a read.
- No delete tool is exposed to Nathan.
- Engineered drawings, specifications, manufacturer requirements, competent
  person direction, and applicable safety rules control ICF and temporary works.
- If data is missing, stale, contradictory, or outside MCP coverage, say so.

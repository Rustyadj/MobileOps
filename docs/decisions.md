# Architecture Decision Records

## ADR-001 — Sidebar holds major sections only; sub-workflows live in-page
**Date:** 2026-09-12

**Decision.** The left sidebar lists exactly seven destinations: Dashboard,
Live Feed, Rentals, Inventory, Shop, Utilities, Admin. Detailed workflows
(Inbound/Outbound/Active/History, Bracing, Tools, Yard Count, Repairs,
Contacts, …) are reached from inside their parent section — via a
`SectionTabs` bar or a landing-page row list — and never duplicated as
sidebar rows.

**Why.** The previous IA repeated every sub-workflow in the sidebar *and* in a
`ModuleRail` under the top bar, so the same destination appeared twice and the
sidebar grew unbounded as features landed.

**Consequences.** `ModuleRail` was deleted. `nav-config.ts` now exports
`NAV_ITEMS` (sidebar) and `SUB_NAV_ITEMS` (search/Menu targets only).
`Screen` gained a `tabs` slot so any section can pin its own tab bar.
Superseded routes (`/operations/active`, `/operations/returns`) became
redirects rather than deletions, so existing deep links keep resolving.

**Rejected.** Nested/expanding sidebar groups — they reproduce the same
duplication one level down and cost a click on every navigation.

---

## ADR-002 — One inventory rollup, derived from the ledger
**Date:** 2026-09-12

**Decision.** All Total / At Yard / Out / Reserved / Available / Repair /
Missing counts come from `src/utils/inventory-rollup.ts` (`rollupEquipment`,
`sumRollups`), read through the `useEquipmentLedger` hook. No screen computes
its own totals.

**Why.** Screens were each summing bucket fields their own way, and several
presented `available` under the label "at yard", which is wrong: units can be
at the yard but reserved, awaiting inspection, or in repair.

**Consequences.** `At Yard = available + reserved + staged + pending_inspection
+ in_maintenance`; `Available` remains the backend's `available` bucket, which
is exactly At Yard minus those deductions. The distinction is stated on-screen
via `AvailabilityNote` so it can't be misread. All bucket movements continue to
go through `apply_ledger_entry` on the backend — the ledger stays the single
authority and the Equipment doc's fields stay a cache of it.

---

## ADR-003 — Equipment is found by search and scan, never by browsing QR codes
**Date:** 2026-09-12

**Decision.** `src/components/equipment/EquipmentSearch.tsx` is the only
equipment selector. Every workflow that picks equipment (Repairs, tool
checkout, rentals, bookings, dispatch loadouts, shop tasks) uses
`EquipmentPicker` or `EquipmentSearchBar`.

**Why.** Repairs made operators horizontally scroll a strip of QR codes to
find a machine; rentals, bookings and dispatch rendered every equipment record
as an unbounded vertical list. Both are "read identifiers until you spot it",
which is the slowest possible lookup on a yard floor.

**Consequences.** Four ways in, in priority order: plain-language search across
name/model/serial/QR/SKU/category/notes; category chips; QR scan; recently
used. Results lead with the equipment's identity and status — QR is shown, not
browsed.

**Scanning.** No camera package is installed, so `ScanField` accepts input from
hardware/wedge scanners, which type the code and press Enter. A camera scanner
can be added later behind the same `onScan(code)` contract without touching
call sites.

---

## ADR-004 — Repairs are a work-order lifecycle, not an open/closed flag
**Date:** 2026-09-12

**Decision.** Repair tickets move through `reported → diagnosing →
waiting_parts → repairing → ready_for_inspection → ready →
returned_to_inventory`, with assignee, location, parts, photos and a full
append-only history.

**Why.** The old three-state flag (open/in_progress/resolved) couldn't answer
"what is this waiting on", which is the question the shop actually asks.

**Consequences.** Legacy statuses are normalized on read
(`open→reported`, `in_progress→repairing`, `resolved→ready`) so existing
tickets keep working; the API accepts them on input. Only the final
`returned_to_inventory` transition moves units `in_maintenance → available`,
so availability changes after inspection rather than when someone marks the
work done.

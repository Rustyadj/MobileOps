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

---

## ADR-005 — Mention notifications and exports extend existing services; Hermes stays MCP-only
**Date:** 2026-10-02

**Decision.** (1) Hermes/Nathan2 remains an external agent reaching MobileOps only
through the scoped, audited MCP server; no second in-app agent or tool router was
added. (2) @mention notifications live in a `notifications` collection written by
the backend when a Live Feed post/comment is saved, keyed unique on
`(type, message_id, user_id)`, and pushed only to the recipient's own sockets via
`WhiteboardRealtimeHub.send_to_user`. (3) PDF/CSV export is one role-aware
renderer (`backend/exports.py`) behind `/api/exports/{dataset}/{fmt}`; Hermes gets
a 10-minute HMAC-signed link (`export_report` MCP tool) whose token binds the role.

**Why.** MobileOps has no tickets/customers/tenants model and Nathan2 already has
67 audited tools, so the real gaps were notifications and exports. Per-user
delivery was needed because the hub previously broadcast every event to every
socket. Notification failure must never fail the post, so processing is guarded
and idempotent. Ambiguous @handles (two people, one name) resolve to nobody and
autocomplete offers each person's unique email handle.

**Rejected.** A second Hermes agent inside the API; user-admin tools for Hermes
(privilege boundary stays: admins manage users in the app); exposing `users` as an
export dataset; per-user notification preferences (none exist yet).

---

## ADR-006 — Excel/PDF import-export extends the export module; imports are staged, hash-confirmed and admin-only
**Date:** 2026-10-03

**Decision.** (1) XLSX is a third format of the existing role-aware export module, with new
datasets (tools, assignments, damaged, returns, outbound, shop tasks, consumables, block) and
single-record PDFs (rental agreement, dispatch ticket). (2) Generated files are stored as
14-day snapshots in Mongo (`generated_files`, following the whiteboard-blob precedent) and
served only to the owner/admins or via purpose-bound signed links. (3) Imports are a separate
stage -> review -> commit pipeline for `equipment`, `tools`, `consumables`, `block` only. Commit
needs the reviewed `plan_hash`, re-validates against live data, is all-or-nothing with
compensating rollback, and is `admin_only` over MCP (admin grant). (4) Updates never touch stock
buckets, quantity or location. (5) PDF import accepts one consistent table and only adds records.

**Why.** The legacy `POST /equipment/import.csv` upserts straight into production with no
preview, no ledger entry and no confirmation; that is exactly what must not be repeated.
Rentals/dispatches/returns carry reservation and ledger state machines, so they are exportable
but not importable. Mongo here is standalone (no transactions), hence undo-log rollback.

**Rejected.** Extending the CSV importer; per-row "partial success" commits; letting an import
change stock counts (use counts/transfers); free-form PDF text extraction; non-admin commits;
regenerating files on download (a stored snapshot is also the audit artifact).

**Open.** The legacy CSV import remains and still overwrites without a preview; it should be
retired or routed through the new pipeline. Rental agreement PDFs carry no legal terms text, so
add it to `pdf_documents.py` once the wording is supplied.


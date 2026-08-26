# Concrete Form — Product Requirements

## Overview
A mobile-first React Native (Expo) field-ops app for concrete/ICF contractors. Engineered for foremen and crews wearing gloves: large tap targets, high-contrast Swiss design, monospace numerics, safety-orange accents.

## Stack
- **Frontend:** Expo Router, React Native (Expo SDK 54), TypeScript
- **Backend:** FastAPI + Motor + MongoDB
- **Auth:** JWT (access + refresh) with bcrypt, RBAC (admin/foreman/crew)
- **AI:** None on mobile (Quote Analyzer/Leads/Quick Estimator deferred per user)
- **PDF:** Client-side HTML → PDF via expo-print + expo-sharing
- **Push:** legacy platform managed push (inert until native build + google-services.json supplied)

## Modules implemented
1. **Auth** — Login + silent refresh + seeded admin. Account lockout after 5 failures.
2. **Dashboard** — Utilization %, active rentals, upcoming returns ≤7d, open maintenance, quick actions, recent activity.
3. **Bracing Engine** — Multiple wall runs; 1 strongback/corner + 1 brace per 4 ft of wall (ceil). Brace length by height: ≤10′→10′, 10–12′→12′, 12–16′→16′, 16–20′→20′; >20′ flags engineer required. Outputs totals, per-run breakdown, braces-by-length order list.
4. **Construction Calculator** — 6 sub-tabs: ICF Wall Concrete, Ft-In ↔ Decimal, Area, ICF Blocks (presets: Standard/NUDURA/Fox/Amvic/BuildBlock/Custom), Rebar Takeoff (#3–#8), Dimension Math (running tape with scale ×/÷).
5. **Equipment Inventory** — SKUs with 6 categories (strongback, turnbuckle, walkboard bracket, hand rail, TB extension, crankup scaffold). CRUD + CSV import/export.
6. **Rentals** — Multi-SKU rentals, customer info, deposits, partial returns, HTML→PDF Delivery Ticket via share sheet. Auto-decrements equipment availability.
7. **Bookings & Capacity** — Tentative/confirmed pipeline + per-date capacity checker across all equipment.
8. **Maintenance** — Service log linked to equipment with status (open/in_progress/resolved) + cost.
9. **Vendors** — ICF block supplier directory with categories, freight terms, truck capacity, lead time. Tap to call/email.
10. **Site Admin** — Brand name, tagline, logo upload (base64), company contact for delivery tickets.

## No dollar amounts in the UI
The app tracks operational data, not pricing — crew and foreman users are not
in the business of quoting or invoicing from this tool. Dollar fields
(`daily_rate`, `deposit`, maintenance `cost`) still exist in the data model
for admin-only record-keeping, but:
- List/read API responses zero these fields out for `crew`-role users
  (`redact_money_for_crew` in `backend/server.py`) — the raw JSON never
  carries real figures to an account that shouldn't see them.
- No screen renders a dollar figure to a non-admin/foreman user. Where a cost
  is shown at all (e.g. maintenance history), it's gated the same way the
  corresponding edit action is gated.
- Design concepts, mockups, and screenshots must not show revenue, totals, or
  per-line pricing — see `design/concepts/README.md` for a past example that
  violated this and was removed.
This is a product requirement, not a style preference: don't reintroduce a
`$` figure, a revenue KPI, or an invoice-style breakdown into the crew/foreman
UI without checking with product first.

## Roadmap — next up (in order)
Per direct product decision: no new major features land until these three are
done, in this order. Each is a foundational change other work will build on
top of, not an independent feature — sequencing matters.
1. **Offline-first: local cache + queued sync.** Currently online-only (see
   "Pending native build" below) — every screen fetches live and a dead
   connection at a job site means the app just doesn't work. Needs a local
   store (SQLite via expo-sqlite or similar), a read path that serves from
   cache first, and a write path that queues mutations and syncs them when
   connectivity returns (with a conflict-resolution story — last-write-wins
   is probably not good enough for inventory buckets given the concurrency
   work already done in `apply_ledger_entry`).
2. **QR/barcode scanning** for equipment identification — feeding Equipment
   lookup, dispatch loadout confirmation, and rental returns. Equipment
   already carries a `qr_code` field (see `equipment_identifier_sku()` in
   `backend/server.py`) used as the internal identity key, so this is
   substantially wiring a scanner (e.g. expo-camera/expo-barcode-scanner) to
   existing lookups rather than a new data model.
3. **Backend router/service refactor.** `backend/server.py` is a single
   ~2500-line file. Split into routers + services along module lines:
   inventory (equipment/transfers/counts/ledger), rentals (rentals/bookings/
   returns), dispatch, shop (tasks/maintenance/inspections), auth. Do this
   *after* offline sync and scanning land so the refactor's shape reflects
   how those features actually used the code, not a guess made before they
   existed.

## Deferred (per user, not on mobile)
- Quote Analyzer (AI PDF parsing)
- Leads CRM
- Quick Estimator

## Pending native build (works only after Publish + Android/iOS build)
- Push notifications for upcoming rental returns
- Offline mode (currently online-only; data fetched live)

## Seeded admin
Email is set via `ADMIN_EMAIL`; password via `ADMIN_PASSWORD` — both required env vars, no default.
Set them in the deployment's secret store, never commit real values here. If this repo's history
still contains a previously-published password, treat it as compromised: rotate it in the live
deployment immediately (see SECURITY.md for the history-scrub procedure).

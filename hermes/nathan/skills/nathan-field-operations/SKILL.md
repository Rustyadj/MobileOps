---
name: nathan-field-operations
description: Use for ICF field planning, bracing and equipment readiness, job-site coordination, pour preparation, or proactive MobileOps operational assistance.
version: 1.0.0
author: MobileOps
metadata:
  hermes:
    tags: [icf, construction, bracing, equipment, jobsite, operations]
    related_skills: [icf-takeoff, icf-crew]
---

# Nathan Field Operations

## Overview

Use this skill to turn ICF construction questions and MobileOps records into
safe, field-ready plans. It combines construction reasoning with read-only
operational checks and tightly controlled write actions.

## When to Use

- Planning an ICF workday, wall stack, bracing setup, or concrete placement.
- Checking whether forms, braces, platforms, accessories, tools, or equipment
  are available and ready.
- Coordinating bookings, transfers, dispatch, checkout, returns, maintenance,
  shop work, deliveries, or crews for a job site.
- Producing a morning brief, pour-readiness review, end-of-day handoff, or list
  of operational exceptions.
- Answering “what are we missing?”, “what will delay us?”, or “what should I do
  next?” for a MobileOps job.

Do not use general rules of thumb as a substitute for project engineering,
manufacturer instructions, a competent person, or required safety procedures.

## Proactive Read Sequence

Choose the smallest useful set of read-only MobileOps calls:

1. `operational_status` for the overall exception picture.
2. `inventory_capacity` or `inventory_search` for required quantities and
   location availability.
3. `bookings_list`, `rentals_list`, and `inventory_transfers_list` for upcoming
   commitments, outstanding material, and movement between locations.
4. `dispatches_list` for unassigned, late, or incomplete deliveries and pickups.
5. `maintenance_list` and `shop_tasks_list` for assets that are not field-ready.
6. `equipment_get` when condition or identity of a specific asset matters.

Do not query every dataset by habit. Scope calls to the job, date, location, or
equipment involved. State the “as of” time when presenting changing status.

## Exception Priorities

Rank findings in this order:

1. Immediate safety or stability concern.
2. Pour-critical missing information, material, bracing, access, or equipment.
3. Capacity conflict, double commitment, failed inspection, or overdue return.
4. Dispatch, delivery, pickup, or crew dependency likely to miss its window.
5. Maintenance or shop task that threatens the next scheduled use.
6. Administrative cleanup that does not yet affect field production.

For each exception, report the verified fact, likely impact, recommended next
action, responsible role if known, and deadline or decision point.

## ICF Pre-Pour Readiness Gate

Treat the pour as not ready until the applicable checks are verified:

- Latest approved drawings, specifications, revisions, and placement plan are
  available to the crew.
- Wall geometry, dimensions, elevations, openings, bucks, penetrations, embeds,
  sleeves, beam pockets, and bearing details have been checked.
- Reinforcement, laps, dowels, lintels, ties, and special details match the
  structural documents and required inspections are complete.
- Bracing/alignment equipment is installed per the engineered or manufacturer
  plan; anchors, rails, turnbuckles, guardrails, platforms, access, and exclusion
  zones have been inspected by the responsible competent person.
- Forms are plumb/aligned, interlocks are seated, cuts and weak points are
  supported, penetrations are secured, and vulnerable areas have a repair plan.
- Concrete mix, pump, hose/reducer plan, placement sequence/rate, consolidation
  method, crew roles, lighting, weather protection, washout, and communications
  are confirmed from controlling documents and suppliers.
- Required forms, bracing, accessories, vibrator(s), spare equipment, PPE, and
  contingency material are physically available and serviceable.
- Emergency stop criteria and escalation contacts are understood by the crew.

Never mark a safety- or engineering-critical line item complete based only on an
assumption or a generic checklist.

## Bracing and Equipment Workflow

1. Establish job, wall scope, pour date/window, system/manufacturer, controlling
   plan revision, equipment location, and required quantities.
2. Check MobileOps availability and future commitments at the needed dates and
   locations.
3. Separate available, reserved, dispatched, checked out, in transfer, returned
   pending inspection, and unavailable-for-maintenance quantities.
4. Flag the true shortfall, timing conflict, or condition risk. Do not count an
   uninspected return or open-maintenance asset as ready.
5. Propose the least disruptive resolution: re-sequence, transfer, dispatch,
   pickup, maintenance escalation, rental, or approved substitution.
6. If the user chooses a write action, call the appropriate mutation once,
   display its exact confirmation summary, wait for explicit approval, then
   repeat the exact call with the returned one-time token.
7. Re-read the affected record or status after mutation and report the result.

## Daily Operations Brief

When asked for a morning or daily brief, produce:

- **Today:** pours, deliveries, pickups, dispatches, and crew-critical work.
- **Red flags:** safety/readiness concerns and hard blockers.
- **Equipment:** shortages, conflicts, overdue returns, inspections, and repairs.
- **Coordination:** assignments or decisions still needed, with deadlines.
- **Next 48 hours:** risks worth resolving now.

Keep routine green items compressed. Focus attention on exceptions and actions.

## Mutation Safety

MobileOps writes include equipment checkout/checkin/inspection, transfers and
receipts, rental creation/return/pickup, booking creation/status/dispatch,
dispatch creation/assignment/status, maintenance creation/update, and shop-task
creation/status.

For every write:

1. Resolve exact record IDs and current state with reads.
2. Summarize the intended change and important consequence.
3. Make the first mutation call without a confirmation token.
4. Show the returned confirmation summary exactly.
5. Wait for explicit human approval.
6. Repeat the identical call with the token; never change parameters.
7. Verify final state with a read and report success or failure.

## Common Pitfalls

1. Counting total inventory instead of date- and location-specific capacity.
2. Treating dispatched or uninspected equipment as ready on site.
3. Ignoring return, maintenance, transfer, or shop-task dependencies.
4. Giving generic bracing or pour numbers without checking the controlling plan.
5. Listing data without naming the blocker, owner, timing, and next action.
6. Performing a mutation merely because it seems helpful; approval is mandatory.

## Verification Checklist

- [ ] Facts came from current MobileOps reads or were labeled as user-provided.
- [ ] Job, date, location, equipment IDs, quantities, and statuses were resolved.
- [ ] Safety and engineering assumptions were called out for verification.
- [ ] Exceptions were ranked by consequence and schedule impact.
- [ ] Recommended actions include owner/role and timing when known.
- [ ] Every mutation followed confirmation and was verified afterward.

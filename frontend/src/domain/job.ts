// Canonical shape for the unified Booking + Rental + Dispatch lifecycle the
// future Jobs UI will present. Mirrors backend/server.py's Job/JobLine
// pydantic models and derive_job_status — keep the two in sync by hand.
//
// This is a *read composition* type, not a stored record — no /jobs
// endpoint exists yet (Phase 0 only defines the shape + derivation rule),
// and nothing in the app constructs a Job today. It's declared now so the
// backend and frontend agree on the contract before either side builds
// against it.
import { BookingStatusValue, DispatchStatusValue, RentalStatusValue, RENTAL_STATUS, BOOKING_STATUS, DISPATCH_STATUS } from "./status";

// Lifecycle: Planned -> Reserved -> Staging -> Outbound -> On Job ->
// Pickup Requested -> Inbound -> Inspection -> Closed. Always DERIVED from
// booking/dispatch/rental status — never stored.
export const JOB_STATUS = {
  planned: "planned",
  reserved: "reserved",
  staging: "staging",
  outbound: "outbound",
  onJob: "on_job",
  pickupRequested: "pickup_requested",
  inbound: "inbound",
  inspection: "inspection",
  closed: "closed",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export type JobLine = {
  equipment_id: string;
  sku: string;
  name: string;
  qty_ordered: number;
  qty_delivered: number;
  qty_on_site: number;
  qty_returned: number;
  qty_damaged: number;
};

// NOTE on `id`: there is no merged collection backing this, so nothing gives
// a job one stable identifier across its whole lifecycle — it's booking_id
// before dispatch and rental_id after. This type uses rental_id when one
// exists, else booking_id, as a provisional stand-in (mirrors the backend
// DTO's same caveat). Needs an explicit decision before this is used for
// anything that must survive the Outbound transition (a bookmarked URL, a
// push notification reference).
export type Job = {
  id: string;
  booking_id: string | null;
  rental_id: string | null;
  active_outbound_dispatch_id: string | null;
  active_inbound_dispatch_id: string | null;
  status: JobStatus;
  customer_name: string;
  job_site: string;
  start_date: string | null;
  end_date: string | null;
  lines: JobLine[];
  // Sum of qty_on_site across lines. >0 alongside rental_status ==
  // "partially_returned" is what "partial return" means here — a quantity
  // condition, not a lifecycle stage of its own.
  qty_outstanding: number;
  is_standalone_rental: boolean;
  cancelled: boolean;
  created_at: string | null;
};

/**
 * Pure mirror of backend/server.py's derive_job_status — same precedence,
 * same inputs, same nine outputs. Not called anywhere yet; it exists so the
 * rule is written down and typed on both sides before the composing /jobs
 * endpoint (and any client-side optimistic-update logic that needs it) gets
 * built against it.
 */
export function deriveJobStatus(args: {
  bookingStatus: BookingStatusValue | null;
  outboundStatus: DispatchStatusValue | null;
  rentalStatus: RentalStatusValue | null;
  inboundStatus: DispatchStatusValue | null;
  hasPendingInspection?: boolean;
}): JobStatus {
  const { bookingStatus, outboundStatus, rentalStatus, inboundStatus, hasPendingInspection = false } = args;

  if (rentalStatus !== null) {
    if (rentalStatus === RENTAL_STATUS.returned) {
      return hasPendingInspection ? JOB_STATUS.inspection : JOB_STATUS.closed;
    }
    // active or partially_returned — an open balance is a quantity
    // condition (qty_outstanding on the Job type), not a separate status.
    if (
      inboundStatus === DISPATCH_STATUS.dispatched ||
      inboundStatus === DISPATCH_STATUS.arrived ||
      inboundStatus === DISPATCH_STATUS.loaded ||
      inboundStatus === DISPATCH_STATUS.returning ||
      inboundStatus === DISPATCH_STATUS.atYard
    ) {
      return JOB_STATUS.inbound;
    }
    if (inboundStatus === DISPATCH_STATUS.scheduled) return JOB_STATUS.pickupRequested;
    return JOB_STATUS.onJob;
  }

  if (bookingStatus === BOOKING_STATUS.cancelled) return JOB_STATUS.closed;
  if (
    outboundStatus === DISPATCH_STATUS.ready ||
    outboundStatus === DISPATCH_STATUS.loaded ||
    outboundStatus === DISPATCH_STATUS.dispatched ||
    outboundStatus === DISPATCH_STATUS.arrived
  ) {
    return JOB_STATUS.outbound;
  }
  if (outboundStatus === DISPATCH_STATUS.scheduled || outboundStatus === DISPATCH_STATUS.staging) return JOB_STATUS.staging;
  if (bookingStatus === BOOKING_STATUS.confirmed) return JOB_STATUS.reserved;
  return JOB_STATUS.planned;
}

// Single source of truth for the Booking/Rental/Dispatch status literals —
// mirrors backend/server.py's RentalStatus/BookingStatus/DispatchStatus
// constant classes. Wire values are unchanged from what was previously
// hardcoded at each call site across the app; this is a pure refactor, not a
// status redesign. Keep the two files in sync by hand — there's no codegen
// tying them together yet.

export const RENTAL_STATUS = {
  active: "active",
  partiallyReturned: "partially_returned",
  returned: "returned",
} as const;
export type RentalStatusValue = (typeof RENTAL_STATUS)[keyof typeof RENTAL_STATUS];
// Still committing inventory (on_rental) — not yet fully back.
export const OPEN_RENTAL_STATUSES: readonly string[] = [RENTAL_STATUS.active, RENTAL_STATUS.partiallyReturned];
export const isRentalOpen = (status: string) => OPEN_RENTAL_STATUSES.includes(status);
export const isRentalReturned = (status: string) => status === RENTAL_STATUS.returned;

export const BOOKING_STATUS = {
  tentative: "tentative",
  confirmed: "confirmed",
  cancelled: "cancelled",
  dispatched: "dispatched",
} as const;
export type BookingStatusValue = (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];
// Still holding a reservation (units sit in the "reserved" bucket).
export const OPEN_BOOKING_STATUSES: readonly string[] = [BOOKING_STATUS.tentative, BOOKING_STATUS.confirmed];
export const isBookingCancelled = (status: string) => status === BOOKING_STATUS.cancelled;
export const isBookingActive = (status: string) => !isBookingCancelled(status);

export const DISPATCH_STATUS = {
  scheduled: "scheduled",
  staging: "staging",
  ready: "ready",
  loaded: "loaded",
  dispatched: "dispatched",
  arrived: "arrived",
  returning: "returning",
  atYard: "at_yard",
  completed: "completed",
  cancelled: "cancelled",
  // Planning-only reminder statuses — not part of either DISPATCH_FLOWS.
  activeRental: "active_rental",
  readyForPickup: "ready_for_pickup",
} as const;
export type DispatchStatusValue = (typeof DISPATCH_STATUS)[keyof typeof DISPATCH_STATUS];
export const TERMINAL_DISPATCH_STATUSES: readonly string[] = [DISPATCH_STATUS.completed, DISPATCH_STATUS.cancelled];
export const isDispatchLive = (status: string) => !TERMINAL_DISPATCH_STATUSES.includes(status);

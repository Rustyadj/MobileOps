// Single source of truth for how the ledger's bucket cache on an Equipment
// doc is presented as operational counts. Every screen that shows
// Total / Yard / Out / Reserved / Available / Repair MUST derive its numbers
// from here so no two pages can disagree.
//
// Backend contract (server.py BUCKET_FIELDS): every owned unit sits in
// exactly one bucket, and `quantity` == sum of all buckets.
//
//   available          at the yard and rentable right now
//   reserved           at the yard, promised to a booking
//   staged             at the yard, pulled onto a loadout
//   pending_inspection at the yard, back from a job, not yet inspected
//   in_maintenance     at the yard, damaged / open repair ticket
//   outbound           loaded, left the yard, not yet delivered
//   on_rental          with the customer
//   inbound            picked up from the job, en route back
//   checked_out        internal tool checkout
//   in_transit         yard-to-yard transfer
//   missing            unaccounted for at last count

export type EquipmentBuckets = {
  quantity?: number;
  available?: number;
  reserved?: number;
  staged?: number;
  outbound?: number;
  on_rental?: number;
  inbound?: number;
  checked_out?: number;
  in_transit?: number;
  pending_inspection?: number;
  in_maintenance?: number;
  missing?: number;
};

export type InventoryRollup = {
  total: number;
  atYard: number;
  out: number;
  reserved: number;
  available: number;
  repair: number;
  awaitingInspection: number;
  missing: number;
};

const n = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function rollupEquipment(item: EquipmentBuckets): InventoryRollup {
  const available = n(item.available);
  const reserved = n(item.reserved) + n(item.staged);
  const repair = n(item.in_maintenance);
  const awaitingInspection = n(item.pending_inspection);
  const missing = n(item.missing);
  const out = n(item.on_rental) + n(item.outbound) + n(item.inbound) + n(item.checked_out) + n(item.in_transit);

  // At Yard is everything physically standing in the yard — NOT the same as
  // Available. Available is what's left after reservations, repairs and
  // units still waiting on inspection are taken off the top.
  const atYard = available + reserved + repair + awaitingInspection;

  return {
    total: n(item.quantity) || atYard + out + missing,
    atYard,
    out,
    reserved,
    available,
    repair,
    awaitingInspection,
    missing,
  };
}

export const EMPTY_ROLLUP: InventoryRollup = {
  total: 0, atYard: 0, out: 0, reserved: 0, available: 0, repair: 0, awaitingInspection: 0, missing: 0,
};

export function sumRollups(items: EquipmentBuckets[]): InventoryRollup {
  return items.reduce<InventoryRollup>((acc, item) => {
    const r = rollupEquipment(item);
    return {
      total: acc.total + r.total,
      atYard: acc.atYard + r.atYard,
      out: acc.out + r.out,
      reserved: acc.reserved + r.reserved,
      available: acc.available + r.available,
      repair: acc.repair + r.repair,
      awaitingInspection: acc.awaitingInspection + r.awaitingInspection,
      missing: acc.missing + r.missing,
    };
  }, { ...EMPTY_ROLLUP });
}

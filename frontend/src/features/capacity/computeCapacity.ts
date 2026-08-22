// Shared demand-vs-supply computation — mirrors the backend's
// /bookings/capacity logic (active rentals + bookings overlapping a given
// date commit inventory) but keeps rented/booked as separate numbers so
// callers can show the breakdown. Used by the standalone Capacity screen
// and the booking detail drawer's inline conflict check.
export type CapEquipment = { id: string; sku: string; name: string; category: string; quantity: number };
export type CapRental = { id: string; status: string; lines: { equipment_id: string; qty: number; returned_qty: number }[] };
export type CapBooking = { id: string; status: string; start_date: string; end_date: string; items: { equipment_id: string; qty: number }[] };

export type CapacityRow = {
  equipment_id: string; sku: string; name: string; category: string;
  quantity: number; rented: number; booked: number; available: number; conflict: boolean;
};

function dayOnly(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function computeCapacity(
  equipment: CapEquipment[],
  rentals: CapRental[],
  bookings: CapBooking[],
  targetDateISO: string, // yyyy-mm-dd
  excludeBookingId?: string,
): CapacityRow[] {
  const rented: Record<string, number> = {};
  for (const r of rentals) {
    if (!["active", "partially_returned"].includes(r.status)) continue;
    for (const line of r.lines) {
      const rem = line.qty - line.returned_qty;
      if (rem > 0) rented[line.equipment_id] = (rented[line.equipment_id] || 0) + rem;
    }
  }

  const booked: Record<string, number> = {};
  const targetDay = dayOnly(new Date(targetDateISO + "T00:00:00"));
  for (const b of bookings) {
    if (b.id === excludeBookingId) continue;
    if (!["tentative", "confirmed"].includes(b.status)) continue;
    const sdDay = dayOnly(new Date(b.start_date));
    const edDay = dayOnly(new Date(b.end_date));
    if (sdDay <= targetDay && targetDay <= edDay) {
      for (const item of b.items) booked[item.equipment_id] = (booked[item.equipment_id] || 0) + item.qty;
    }
  }

  return equipment.map((e) => {
    const rq = rented[e.id] || 0;
    const bq = booked[e.id] || 0;
    const available = Math.max(e.quantity - rq - bq, 0);
    return {
      equipment_id: e.id, sku: e.sku, name: e.name, category: e.category,
      quantity: e.quantity, rented: rq, booked: bq, available,
      conflict: rq + bq > e.quantity,
    };
  });
}

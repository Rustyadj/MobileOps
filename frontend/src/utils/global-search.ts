// Frontend aggregation for global search — no dedicated backend endpoint
// exists, so we fan out to the existing list endpoints and rank matches
// client-side. Covers equipment/SKUs, rentals (+ embedded customer/job
// site), bookings, and vendors — every entity the nav surfaces.
import { api } from "@/src/api/client";

export type SearchResult = {
  id: string;
  type: "equipment" | "rental" | "booking" | "vendor";
  title: string;
  subtitle: string;
  route: string;
};

type Cache = { at: number; results: SearchResult[] } | null;
let cache: Cache = null;
const CACHE_MS = 30_000;

async function fetchAll(): Promise<SearchResult[]> {
  const [equipment, rentals, bookings, vendors] = await Promise.all([
    api<any[]>("/equipment").catch(() => []),
    api<any[]>("/rentals").catch(() => []),
    api<any[]>("/bookings").catch(() => []),
    api<any[]>("/vendors").catch(() => []),
  ]);

  const results: SearchResult[] = [];
  for (const e of equipment) {
    results.push({
      id: e.id,
      type: "equipment",
      title: e.name,
      subtitle: `${e.sku} · ${e.category?.replace(/_/g, " ") || ""}`,
      route: `/(app)/assets/equipment?open=${e.id}`,
    });
  }
  for (const r of rentals) {
    results.push({
      id: r.id,
      type: "rental",
      title: r.customer_name,
      subtitle: r.job_site ? `Rental · ${r.job_site}` : "Rental",
      route: `/(app)/operations/rentals?open=${r.id}`,
    });
  }
  for (const b of bookings) {
    results.push({
      id: b.id,
      type: "booking",
      title: b.customer_name,
      subtitle: b.job_site ? `Booking · ${b.job_site}` : "Booking",
      route: `/(app)/operations/bookings?open=${b.id}`,
    });
  }
  for (const v of vendors) {
    results.push({
      id: v.id,
      type: "vendor",
      title: v.name,
      subtitle: v.contact_name ? `Vendor · ${v.contact_name}` : "Vendor",
      route: `/(app)/vendors?open=${v.id}`,
    });
  }
  return results;
}

async function getIndex(): Promise<SearchResult[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.results;
  const results = await fetchAll();
  cache = { at: Date.now(), results };
  return results;
}

export function invalidateSearchCache() {
  cache = null;
}

export async function searchAll(query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  const index = await getIndex();
  if (!q) return index.slice(0, 8);
  return index
    .filter((r) => r.title.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q))
    .slice(0, 20);
}

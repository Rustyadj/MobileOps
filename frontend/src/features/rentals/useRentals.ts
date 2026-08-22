// Rentals data + mutations — extracted from the route file so the screen
// component only owns layout/UI state. Business logic (CRUD, returns, PDF
// generation, location patch) lives here, unchanged from the original
// inline implementation.
import { useCallback, useState } from "react";
import { Platform } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { api } from "@/src/api/client";

export type Line = { equipment_id: string; sku: string; name: string; qty: number; daily_rate: number; returned_qty: number };
export type Rental = {
  id: string; customer_name: string; customer_phone: string; customer_email: string;
  job_site: string; start_date: string; due_date?: string | null; deposit: number; notes: string;
  lines: Line[]; status: string; delivered_by: string; received_by: string;
  lat?: number | null; lng?: number | null;
};
export type Eq = { id: string; sku: string; name: string; daily_rate: number; available: number };
export type Site = { brand_name: string; tagline: string; logo_base64?: string; company_address: string; company_phone: string; company_email: string };

export function useRentals() {
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [equipment, setEquipment] = useState<Eq[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, e, s] = await Promise.all([
        api<Rental[]>("/rentals"),
        api<Eq[]>("/equipment"),
        api<Site>("/site"),
      ]);
      setRentals(r); setEquipment(e); setSite(s);
    } catch (err) { console.warn(err); }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const save = useCallback(async (draft: any) => {
    const body = {
      customer_name: draft.customer_name,
      customer_phone: draft.customer_phone || "",
      customer_email: draft.customer_email || "",
      job_site: draft.job_site || "",
      start_date: draft.start_date,
      deposit: Number(draft.deposit) || 0,
      notes: draft.notes || "",
      lines: draft.lines.map((l: Line) => ({
        equipment_id: l.equipment_id, sku: l.sku, name: l.name,
        qty: l.qty, daily_rate: l.daily_rate, returned_qty: l.returned_qty || 0,
      })),
      lat: draft.lat ?? null,
      lng: draft.lng ?? null,
    };
    if (draft.id) {
      await api(`/rentals/${draft.id}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      await api("/rentals", { method: "POST", body: JSON.stringify(body) });
    }
    await load();
  }, [load]);

  const del = useCallback(async (id: string) => {
    await api(`/rentals/${id}`, { method: "DELETE" });
    await load();
  }, [load]);

  const doReturn = useCallback(async (rental: Rental, line: Line, qty: number) => {
    await api(`/rentals/${rental.id}/return`, {
      method: "POST",
      body: JSON.stringify([{ equipment_id: line.equipment_id, qty }]),
    });
    await load();
  }, [load]);

  const patchLocation = useCallback(async (id: string, coords: { lat: number; lng: number }) => {
    await api(`/rentals/${id}/location`, { method: "PATCH", body: JSON.stringify(coords) });
    await load();
  }, [load]);

  const generatePDF = useCallback(async (r: Rental) => {
    const lineRows = r.lines.map((l) =>
      `<tr><td>${l.sku}</td><td>${l.name}</td><td style="text-align:right">${l.qty}</td></tr>`
    ).join("");

    const logoHtml = site?.logo_base64
      ? `<img src="${site.logo_base64}" style="max-height:72px;max-width:160px;object-fit:contain;margin-right:16px"/>`
      : `<div class="tile"></div>`;

    const html = `
<!doctype html><html><head><meta charset="utf-8"/><style>
body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial; color:#0F172A; padding: 40px; }
.brand { display:flex; align-items:center; border-bottom: 1px solid #E2E8F0; padding-bottom: 20px; margin-bottom: 28px; }
.tile { width:6px; height:40px; background:#1E3A8A; margin-right:14px; border-radius:2px; }
h1 { margin:0; font-size:22px; letter-spacing:-0.3px; font-weight:600; color:#0F172A; }
.label { font-size:10px; text-transform:uppercase; letter-spacing:0.8px; color:#94A3B8; font-weight:600; }
.box { border:1px solid #E2E8F0; padding:16px; margin-bottom:12px; border-radius:6px; background:#FFFFFF; }
table { width:100%; border-collapse:collapse; margin-top:8px; }
th, td { padding:12px 10px; border-bottom:1px solid #E2E8F0; font-size:13px; }
th { background:#F8FAFC; text-transform:uppercase; font-size:10px; letter-spacing:0.6px; text-align:left; color:#475569; font-weight:600; }
.sig { margin-top:56px; display:flex; gap:32px; }
.sig div { flex:1; border-top: 1px solid #0F172A; padding-top:8px; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:#475569; font-weight:600; }
.footer { margin-top:36px; font-size:11px; color:#94A3B8; }
</style></head><body>
<div class="brand">${logoHtml}<div><h1>${site?.brand_name || "Concrete Form"}</h1><div class="label" style="margin-top:4px">Delivery Ticket${site?.tagline ? " · " + site.tagline : ""}</div></div></div>
<div class="box">
  <div class="label">Customer</div>
  <div style="font-size:17px;font-weight:600;margin-top:4px">${r.customer_name}</div>
  <div style="font-size:13px;color:#475569;margin-top:2px">${r.customer_phone || ""} ${r.customer_email ? " · " + r.customer_email : ""}</div>
  <div style="font-size:13px;color:#475569">${r.job_site || ""}</div>
</div>
<div class="box">
  <div class="label">Start date</div>
  <div style="font-size:14px;margin-top:4px">${new Date(r.start_date).toLocaleDateString()}</div>
</div>
<table>
  <thead><tr><th>SKU</th><th>Description</th><th style="text-align:right">Qty</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
${r.notes ? `<div class="box" style="margin-top:24px"><div class="label">Notes</div><div style="font-size:13px;margin-top:4px">${r.notes}</div></div>` : ""}
<div class="sig"><div>Delivered by</div><div>Received by (signature)</div></div>
<div class="footer">${site?.company_address || ""}${site?.company_phone ? " · " + site.company_phone : ""}${site?.company_email ? " · " + site.company_email : ""}</div>
</body></html>`;

    if (Platform.OS === "web") {
      await Print.printAsync({ html });
    } else {
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: "application/pdf",
          UTI: "com.adobe.pdf",
          dialogTitle: "Delivery Ticket",
        });
      }
    }
  }, [site]);

  return { rentals, equipment, site, loading, refreshing, load, refresh, save, del, doReturn, patchLocation, generatePDF };
}

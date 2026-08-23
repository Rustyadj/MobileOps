import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity, Alert, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Pill, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { SearchInput } from "@/src/components/data/SearchInput";
import { FilterChips } from "@/src/components/data/FilterBar";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { LocationPicker, geocodeString, geocodeAddress, GeocodeResult } from "@/src/components/MapCanvas";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { usePermissions } from "@/src/hooks/use-permissions";
import { useCachedResource } from "@/src/hooks/use-cached-resource";
import { mutate } from "@/src/sync/mutate";
import { colors, spacing, type as typo, radii } from "@/src/theme";

type Eq = { id: string; sku: string; qr_code?: string | null; category?: string; name: string; daily_rate: number; available: number };
type Line = {
  equipment_id: string;
  sku: string;
  qr_code?: string | null;
  name: string;
  qty: number;
  daily_rate: number;
  delivered_qty: number;
  returned_qty: number;
  damaged_qty: number;
};
type Rental = {
  id: string; customer_name: string; customer_phone: string; customer_email: string;
  job_site: string; start_date: string; due_date?: string | null; deposit: number; notes: string;
  lines: Line[]; status: string; delivered_by: string; received_by: string;
  lat?: number | null; lng?: number | null;
};
type Site = { brand_name: string; tagline: string; logo_base64?: string; company_address: string; company_phone: string; company_email: string };
type Dispatch = { id: string; direction: "outbound" | "inbound"; status: string; rental_id?: string | null; scheduled_date?: string | null; driver_name: string };
type RentalSortKey = "status" | "customer_name" | "job_site" | "start_date" | "due_date" | "units" | "lines";
type RentalDirection = "outbound" | "inbound";
type ReturnPrompt = { rental: Rental; line: Line; qty: string; damagedQty: string };

const STATUS_OPTIONS = [
  { key: "all", label: "All statuses" },
  { key: "active", label: "Active" },
  { key: "partially_returned", label: "Partial return" },
  { key: "returned", label: "Returned" },
];

const lineLifecycle = (line: Line) => {
  const delivered = line.delivered_qty > 0 ? line.delivered_qty : line.qty;
  // returned_qty already counts every physically-returned unit, damaged or
  // not — damaged_qty is a subset marker, not an additional deduction.
  return {
    ordered: line.qty,
    delivered,
    onSite: Math.max(0, delivered - line.returned_qty),
    returned: line.returned_qty,
    damaged: line.damaged_qty,
  };
};
const rentalUnits = (rental: Rental) => rental.lines.reduce((total, line) => total + lineLifecycle(line).onSite, 0);
const shortDate = (value?: string | null) => value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

export default function RentalsScreen() {
  const { isShellWide, width } = useBreakpoint();
  const { canEdit, canAdmin } = usePermissions();
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const rentalsRes = useCachedResource<Rental>("rentals", () => api<Rental[]>("/rentals"));
  const equipmentRes = useCachedResource<Eq>("equipment", () => api<Eq[]>("/equipment"));
  const dispatchesRes = useCachedResource<Dispatch>("dispatches", () => api<Dispatch[]>("/dispatches").catch(() => []));
  const rentals = rentalsRes.data;
  const equipment = equipmentRes.data;
  const dispatches = dispatchesRes.data;
  // Site (brand/contact info for the PDF ticket) changes rarely and isn't a
  // phase-1 write flow — plain fetch, not cached.
  const [site, setSite] = useState<Site | null>(null);
  useEffect(() => { api<Site>("/site").then(setSite).catch((e) => console.warn(e)); }, []);
  const [pickupBusy, setPickupBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [pickerFor, setPickerFor] = useState<null | { mode: "draft" } | { mode: "existing"; id: string; initial?: { lat: number; lng: number } | null }>(null);
  const [addressQuery, setAddressQuery] = useState("");
  const [addressResults, setAddressResults] = useState<GeocodeResult[]>([]);
  const [addressBusy, setAddressBusy] = useState(false);
  const [qtyPrompt, setQtyPrompt] = useState<{ eq: Eq; qty: string } | null>(null);
  const [returnPrompt, setReturnPrompt] = useState<ReturnPrompt | null>(null);
  const [selectedRaw, setSelectedRaw] = useState<Rental | null>(null);
  const selected = selectedRaw ? rentals.find((r) => r.id === selectedRaw.id) || selectedRaw : null;
  const setSelected = setSelectedRaw;
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<RentalDirection>("outbound");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<RentalSortKey>("start_date");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    if (!params.open || rentals.length === 0) return;
    setSelected(rentals.find((rental) => rental.id === params.open) || null);
  }, [params.open, rentals.length]);

  const refreshing = rentalsRes.refreshing || equipmentRes.refreshing || dispatchesRes.refreshing;
  const onRefresh = () => { rentalsRes.onRefresh(); equipmentRes.onRefresh(); dispatchesRes.onRefresh(); };

  const draftGeocode = async () => {
    if (!draft?.job_site?.trim()) {
      Alert.alert("No address", "Enter a Job Site address first, then tap Geocode.");
      return;
    }
    const coords = await geocodeString(draft.job_site);
    if (coords) {
      setDraft({ ...draft, lat: coords.lat, lng: coords.lng });
    } else {
      Alert.alert("Geocode failed", "Couldn't resolve that address. Try 'Pick on map' or search a different address.");
    }
  };

  const searchAddress = async () => {
    const q = addressQuery.trim();
    if (!q) return;
    setAddressBusy(true);
    try {
      const results = await geocodeAddress(q);
      setAddressResults(results);
      if (results.length === 0) {
        Alert.alert("No matches", "Try a more specific address (street, city, state).");
      }
    } finally {
      setAddressBusy(false);
    }
  };

  const pickAddress = (r: GeocodeResult) => {
    setDraft((d: any) => ({
      ...d,
      lat: r.lat,
      lng: r.lng,
      job_site: d?.job_site?.trim() ? d.job_site : r.display_name,
    }));
    setAddressResults([]);
    setAddressQuery("");
  };

  const saveLocation = async (coords: { lat: number; lng: number }) => {
    if (!pickerFor) return;
    if (pickerFor.mode === "draft") {
      setDraft((d: any) => ({ ...d, lat: coords.lat, lng: coords.lng }));
    } else {
      try {
        await api(`/rentals/${pickerFor.id}/location`, {
          method: "PATCH",
          body: JSON.stringify(coords),
        });
        rentalsRes.onRefresh();
      } catch (e: any) {
        Alert.alert("Save failed", e.message);
      }
    }
    setPickerFor(null);
  };

  const newRental = () => {
    const now = new Date();
    setDraft({
      customer_name: "", customer_phone: "", customer_email: "", job_site: "",
      start_date: now.toISOString(),
      deposit: 0, notes: "", lines: [],
    });
    setCreating(true);
  };

  useEffect(() => {
    if (params.new) newRental();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.new]);

  const editRental = (r: Rental) => {
    setDraft({
      id: r.id,
      customer_name: r.customer_name,
      customer_phone: r.customer_phone,
      customer_email: r.customer_email,
      job_site: r.job_site,
      start_date: r.start_date,
      deposit: r.deposit,
      notes: r.notes,
      lines: r.lines.map((l) => ({ ...l })),
      lat: r.lat,
      lng: r.lng,
    });
    setCreating(true);
  };

  const addLine = (eq: Eq) => {
    // Open a quantity prompt so the foreman can type the exact qty.
    // Prefills with the current line qty if already added, else 1.
    const existing = draft?.lines?.find((l: Line) => l.equipment_id === eq.id);
    setQtyPrompt({ eq, qty: existing ? String(existing.qty) : "1" });
  };

  const confirmQty = () => {
    if (!qtyPrompt) return;
    const parsed = parseInt(qtyPrompt.qty, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      Alert.alert("Invalid quantity", "Enter a positive whole number.");
      return;
    }
    const eq = qtyPrompt.eq;
    const currentOnLine = draft?.lines?.find((l: Line) => l.equipment_id === eq.id)?.qty || 0;
    // The extra qty we're about to commit beyond what's already on this draft line.
    const extra = parsed - currentOnLine;
    if (extra > eq.available) {
      Alert.alert(
        "Not enough on hand",
        `Only ${eq.available} of ${eq.name} available. Reduce the quantity or free up inventory first.`,
      );
      return;
    }
    setDraft((d: any) => {
      const existingLine = d.lines.find((l: Line) => l.equipment_id === eq.id);
      if (existingLine) {
        return { ...d, lines: d.lines.map((l: Line) => l.equipment_id === eq.id ? { ...l, qty: parsed } : l) };
      }
      return { ...d, lines: [...d.lines, { equipment_id: eq.id, sku: eq.sku, qr_code: eq.qr_code, name: eq.name, qty: parsed, daily_rate: eq.daily_rate, delivered_qty: 0, returned_qty: 0, damaged_qty: 0 }] };
    });
    setQtyPrompt(null);
  };

  const updateQty = (id: string, qty: number) => {
    setDraft((d: any) => ({ ...d, lines: d.lines.map((l: Line) => l.equipment_id === id ? { ...l, qty: Math.max(0, qty) } : l).filter((l: Line) => l.qty > 0) }));
  };

  // Creating a new rental queues offline (delivered on-site); editing an
  // existing one (full replace, ledger-rebalancing PUT) stays online — it's
  // desk work and, unlike a fresh create, has no natural client-side id to
  // build an optimistic doc against safely.
  const save = async () => {
    if (!draft.customer_name || draft.lines.length === 0) {
      Alert.alert("Required", "Customer name and at least one line item.");
      return;
    }
    const body = {
      customer_name: draft.customer_name,
      customer_phone: draft.customer_phone || "",
      customer_email: draft.customer_email || "",
      job_site: draft.job_site || "",
      start_date: draft.start_date,
      deposit: Number(draft.deposit) || 0,
      notes: draft.notes || "",
      lines: draft.lines.map((l: Line) => ({
        equipment_id: l.equipment_id, sku: l.sku, qr_code: l.qr_code, name: l.name,
        qty: l.qty, daily_rate: l.daily_rate, delivered_qty: l.delivered_qty || 0,
        returned_qty: l.returned_qty || 0, damaged_qty: l.damaged_qty || 0,
      })),
      lat: draft.lat ?? null,
      lng: draft.lng ?? null,
    };
    if (draft.id) {
      try {
        await api(`/rentals/${draft.id}`, { method: "PUT", body: JSON.stringify(body) });
        rentalsRes.onRefresh();
        equipmentRes.onRefresh();
      } catch (e: any) { Alert.alert("Save failed", e.message); return; }
    } else {
      mutate<Rental>({
        kind: "create",
        entityType: "rentals",
        path: "/rentals",
        method: "POST",
        body,
        optimisticDoc: (tempId) => ({
          id: tempId,
          customer_name: body.customer_name, customer_phone: body.customer_phone, customer_email: body.customer_email,
          job_site: body.job_site, start_date: body.start_date, due_date: null, deposit: body.deposit, notes: body.notes,
          lines: body.lines, status: "active", delivered_by: "", received_by: "",
          lat: body.lat, lng: body.lng,
        }),
      });
    }
    setCreating(false); setDraft(null);
  };

  const del = async (id: string) => {
    try { await api(`/rentals/${id}`, { method: "DELETE" }); rentalsRes.onRefresh(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  const pickupFor = (rentalId: string) => dispatches.find(
    (d) => d.direction === "inbound" && d.rental_id === rentalId && d.status !== "completed" && d.status !== "cancelled"
  );

  // Queues offline — scheduled from the job site once the crew knows a
  // pickup is needed. The optimistic Dispatch doc is enough for the
  // dispatch list/detail to show it right away; the server fills in the
  // real lines (derived from what's actually outstanding) on sync.
  const schedulePickup = (rentalId: string) => {
    const rental = rentals.find((r) => r.id === rentalId);
    const dispatch = mutate<Dispatch>({
      kind: "create",
      entityType: "dispatches",
      path: `/rentals/${rentalId}/schedule-pickup`,
      method: "POST",
      body: {},
      optimisticDoc: (tempId) => ({
        id: tempId, direction: "inbound", status: "scheduled",
        rental_id: rentalId, scheduled_date: null,
        driver_name: "", customer_name: rental?.customer_name || "", job_site: rental?.job_site || "",
      } as Dispatch),
    });
    if (dispatch) router.push(`/(app)/operations/dispatch?open=${dispatch.id}` as any);
  };

  const openReturn = (rental: Rental, line: Line) => {
    const { onSite } = lineLifecycle(line);
    setReturnPrompt({ rental, line, qty: String(onSite), damagedQty: "0" });
  };

  // Queues offline — recorded standing at the truck/job site as units come
  // back. Optimistic patch mirrors the server's returned_qty/damaged_qty +
  // status recompute (partial_return in backend/server.py) for this one
  // line; other lines on the rental are untouched.
  const submitReturn = () => {
    if (!returnPrompt) return;
    const qty = Number.parseInt(returnPrompt.qty, 10);
    const damagedQty = Number.parseInt(returnPrompt.damagedQty || "0", 10);
    const { onSite } = lineLifecycle(returnPrompt.line);
    if (!Number.isInteger(qty) || qty <= 0 || qty > onSite) {
      Alert.alert("Invalid return quantity", `Enter between 1 and ${onSite}.`);
      return;
    }
    if (!Number.isInteger(damagedQty) || damagedQty < 0 || damagedQty > qty) {
      Alert.alert("Invalid damaged quantity", "Damaged units must be between 0 and the return quantity.");
      return;
    }
    const rental = returnPrompt.rental;
    const nextLines = rental.lines.map((l) =>
      l.equipment_id === returnPrompt.line.equipment_id
        ? { ...l, returned_qty: l.returned_qty + qty, damaged_qty: l.damaged_qty + damagedQty }
        : l,
    );
    const allReturned = nextLines.every((l) => l.returned_qty >= (l.delivered_qty > 0 ? l.delivered_qty : l.qty));
    const anyReturned = nextLines.some((l) => l.returned_qty > 0);
    mutate<Rental>({
      kind: "command",
      entityType: "rentals",
      entityId: rental.id,
      path: `/rentals/${rental.id}/return`,
      method: "POST",
      body: [{ equipment_id: returnPrompt.line.equipment_id, qty, damaged_qty: damagedQty }],
      optimisticPatch: {
        lines: nextLines,
        status: allReturned ? "returned" : anyReturned ? "partially_returned" : "active",
      },
    });
    setReturnPrompt(null);
  };

  const generatePDF = async (r: Rental) => {
    const lineRows = r.lines.map((l) =>
      `<tr><td>${l.qr_code || "Not assigned"}</td><td>${l.name}</td><td style="text-align:right">${l.qty}</td></tr>`
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
  <thead><tr><th>QR Code</th><th>Description</th><th style="text-align:right">Qty</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
${r.notes ? `<div class="box" style="margin-top:24px"><div class="label">Notes</div><div style="font-size:13px;margin-top:4px">${r.notes}</div></div>` : ""}
<div class="sig"><div>Delivered by</div><div>Received by (signature)</div></div>
<div class="footer">${site?.company_address || ""}${site?.company_phone ? " · " + site.company_phone : ""}${site?.company_email ? " · " + site.company_email : ""}</div>
</body></html>`;

    try {
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
    } catch (e: any) {
      Alert.alert("PDF failed", e?.message || "Unable to generate PDF");
    }
  };

  const directionCounts = useMemo(() => ({
    outbound: rentals.filter((rental) => !["partially_returned", "returned"].includes(rental.status)).length,
    inbound: rentals.filter((rental) => ["partially_returned", "returned"].includes(rental.status)).length,
  }), [rentals]);

  const directionRentals = useMemo(
    () => rentals.filter((rental) => direction === "inbound"
      ? ["partially_returned", "returned"].includes(rental.status)
      : !["partially_returned", "returned"].includes(rental.status)),
    [direction, rentals],
  );

  const filteredRentals = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rows = directionRentals.filter((rental) => {
      if (statusFilter !== "all" && rental.status !== statusFilter) return false;
      if (!query) return true;
      return [rental.id, rental.customer_name, rental.job_site, rental.customer_phone, rental.customer_email, ...rental.lines.flatMap((line) => [line.qr_code, line.name])]
        .some((value) => value?.toLowerCase().includes(query));
    });
    return [...rows].sort((a, b) => {
      const values: Record<RentalSortKey, [string | number, string | number]> = {
        status: [a.status, b.status],
        customer_name: [a.customer_name, b.customer_name],
        job_site: [a.job_site, b.job_site],
        start_date: [+new Date(a.start_date), +new Date(b.start_date)],
        due_date: [a.due_date ? +new Date(a.due_date) : Number.MAX_SAFE_INTEGER, b.due_date ? +new Date(b.due_date) : Number.MAX_SAFE_INTEGER],
        units: [rentalUnits(a), rentalUnits(b)],
        lines: [a.lines.length, b.lines.length],
      };
      const [left, right] = values[sortKey];
      const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
      return sortDirection === "asc" ? result : -result;
    });
  }, [directionRentals, search, sortDirection, sortKey, statusFilter]);

  const selectDirection = (next: RentalDirection) => {
    setDirection(next);
    setStatusFilter("all");
    setSelected(null);
  };

  const columns = useMemo<ColumnDef<Rental>[]>(() => {
    const identity: ColumnDef<Rental>[] = [
      { key: "status", label: "Status", width: width < 1280 ? 88 : 104, render: (rental) => <StatusBadge label={rental.status} /> },
      { key: "rental", label: "Rental", width: width < 1280 ? 96 : 116, render: (rental) => <Mono style={styles.tableLink}>{rental.id.slice(0, 12)}</Mono> },
      { key: "customer_name", label: "Customer", flex: 1.15, render: (rental) => rental.customer_name },
      { key: "job_site", label: "Job Site", flex: 1.35, render: (rental) => rental.job_site || "—" },
    ];
    if (width < 1280) {
      return [...identity, { key: "units", label: "Units", width: 54, align: "right", render: (rental) => <Mono style={styles.tableMono}>{rentalUnits(rental)}</Mono> }];
    }
    return [
      ...identity,
      { key: "start_date", label: "Start", width: 112, render: (rental) => shortDate(rental.start_date) },
      { key: "due_date", label: "Due", width: 112, render: (rental) => shortDate(rental.due_date) },
      { key: "units", label: "Units", width: 70, align: "right", render: (rental) => <Mono style={styles.tableMono}>{rentalUnits(rental)}</Mono> },
      { key: "lines", label: "Lines", width: 70, align: "right", render: (rental) => <Mono style={styles.tableMono}>{rental.lines.length}</Mono> },
    ];
  }, [width]);

  const handleSort = (key: string) => {
    const nextKey = key === "rental" ? "customer_name" : key as RentalSortKey;
    if (nextKey === sortKey) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else { setSortKey(nextKey); setSortDirection("asc"); }
  };

  return (
    <Screen title="Rentals" subtitle={`${rentals.length} total · ${rentals.filter(r => r.status === "active").length} active`} back
      rightAction={canEdit ? { icon: "add", onPress: newRental, testID: "new-rental-btn" } : undefined}
      onRefresh={onRefresh} refreshing={refreshing} testID="rentals-screen" scroll={!isShellWide}>

      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          <RentalDirectionTabs direction={direction} counts={directionCounts} onChange={selectDirection} desktop />
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search rental, customer, site, equipment…" testID="rentals-search" style={{ flex: 1, maxWidth: 420 }} />
            {canEdit ? <Button title="New Rental" onPress={newRental} fullWidth={false} style={styles.toolbarButton} testID="new-rental-desktop" /> : null}
          </PageToolbar>
          <View style={styles.filterRow}>
            <FilterChips options={STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} testIDPrefix="rentals-status-filter" />
            <Text style={styles.resultCount}>{filteredRentals.length} matching rentals</Text>
          </View>
          <View style={styles.tableWrap}>
            <DataTable
              columns={columns}
              rows={filteredRentals}
              keyExtractor={(rental) => rental.id}
              rowTestID={(rental) => `rental-${rental.id}`}
              onRowPress={setSelected}
              selectedId={selected?.id}
              sortKey={sortKey}
              sortDirection={sortDirection}
              onSort={handleSort}
              emptyLabel="No rentals match these filters."
            />
          </View>
        </View>
      ) : (
        <>
          <RentalDirectionTabs direction={direction} counts={directionCounts} onChange={selectDirection} />
          {directionRentals.length === 0 ? (
            <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No {direction} rentals.</Text></Card>
          ) : directionRentals.map((r) => {
        const totalQty = r.lines.reduce((s, l) => s + l.qty, 0);
        const returnedQty = r.lines.reduce((s, l) => s + l.returned_qty, 0);
        return (
          <Card key={r.id} style={{ marginBottom: spacing.sm }} testID={`rental-${r.id}`}>
            <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <View style={{ flex: 1 }}>
                <H3>{r.customer_name}</H3>
                <Text style={[typo.bodySmall, { marginTop: 2 }]}>{r.job_site || "—"}</Text>
              </View>
              <Pill color={r.status === "returned" ? colors.success : r.status === "active" ? colors.primary : colors.warning}
                    bg={r.status === "returned" ? colors.successSoft : r.status === "active" ? colors.primarySoft : colors.warningSoft}>
                {r.status}
              </Pill>
            </Row>
            <Row style={{ marginTop: spacing.sm, gap: spacing.md, flexWrap: "wrap" }}>
              <Text style={typo.label}>Start <Mono style={{ fontSize: 13 }}>{new Date(r.start_date).toLocaleDateString()}</Mono></Text>
              <Text style={typo.label}>Items <Mono style={{ fontSize: 13 }}>{returnedQty}/{totalQty}</Mono></Text>
              {r.lat != null && r.lng != null ? (
                <Row style={{ gap: 4 }}>
                  <Ionicons name="location" size={12} color={colors.primary} />
                  <Mono style={{ fontSize: 11 }}>{r.lat.toFixed(3)}, {r.lng.toFixed(3)}</Mono>
                </Row>
              ) : (
                <Row style={{ gap: 4 }}>
                  <Ionicons name="location-outline" size={12} color={colors.inkMuted} />
                  <Text style={[typo.caption, { textTransform: "none", letterSpacing: 0 }]}>No location</Text>
                </Row>
              )}
            </Row>
            {r.lines.map((l) => (
              <View key={l.equipment_id} style={styles.lineRow}>
                <Row>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={typo.body}>{l.name}</Text>
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{equipmentIdentifier(l)}</Mono>
                </View>
                {canEdit && lineLifecycle(l).onSite > 0 && r.status !== "returned" ? (
                  <TouchableOpacity onPress={() => openReturn(r, l)} style={styles.smallBtn} testID={`return-${r.id}-${l.equipment_id}`}>
                    <Text style={styles.smallBtnText}>Return</Text>
                  </TouchableOpacity>
                ) : null}
                </Row>
                <LifecycleStrip line={l} />
              </View>
            ))}
            <View style={{ marginTop: spacing.sm }}>
              <PickupStatus
                dispatch={pickupFor(r.id)}
                rentalReturned={r.status === "returned"}
                onOpen={(id) => router.push(`/(app)/operations/dispatch?open=${id}` as any)}
                onSchedule={() => schedulePickup(r.id)}
                busy={pickupBusy}
              />
            </View>
            {canEdit ? (
              <Row style={{ marginTop: spacing.sm, gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Button title="Edit" onPress={() => editRental(r)} variant="outline" testID={`edit-rental-${r.id}`} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title={r.lat != null ? "Update location" : "Set location"}
                    onPress={() => setPickerFor({ mode: "existing", id: r.id, initial: r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null })}
                    variant="outline"
                    testID={`set-location-${r.id}`}
                  />
                </View>
              </Row>
            ) : null}
            <View style={{ height: spacing.sm }} />
            <Row style={{ gap: spacing.sm }}>
              <View style={{ flex: 1 }}><Button title="Delivery PDF" onPress={() => generatePDF(r)} variant="outline" testID={`pdf-${r.id}`} /></View>
              {canAdmin ? <View style={{ flex: 1 }}><Button title="Delete" onPress={() => del(r.id)} variant="danger" testID={`delete-rental-${r.id}`} /></View> : null}
            </Row>
          </Card>
        );
          })}
        </>
      )}

      <DetailDrawer
        visible={isShellWide && !!selected}
        title={selected?.id || "Rental detail"}
        subtitle={selected ? `${selected.customer_name} · ${selected.job_site || "No job site"}` : undefined}
        onClose={() => setSelected(null)}
        width={460}
        testID="rental-detail-drawer"
      >
        {selected ? (
          <View>
            <View style={styles.detailStatusRow}>
              <StatusBadge label={selected.status} />
              <Text style={styles.detailMuted}>{rentalUnits(selected)} units currently deployed</Text>
            </View>
            <DetailSection label="Customer">
              <Text style={styles.detailTitle}>{selected.customer_name}</Text>
              <Text style={styles.detailText}>{selected.customer_phone || "No phone"}</Text>
              <Text style={styles.detailText}>{selected.customer_email || "No email"}</Text>
            </DetailSection>
            <DetailSection label="Job site">
              <Text style={styles.detailTitle}>{selected.job_site || "No job site"}</Text>
              <Text style={styles.detailText}>{selected.lat != null && selected.lng != null ? `${selected.lat.toFixed(5)}, ${selected.lng.toFixed(5)}` : "Location not mapped"}</Text>
            </DetailSection>
            <View style={styles.detailPair}>
              <DetailMetric label="Start" value={shortDate(selected.start_date)} />
              <DetailMetric label="Due" value={shortDate(selected.due_date)} />
              <DetailMetric label="Lines" value={String(selected.lines.length)} />
              <DetailMetric label="On site" value={String(rentalUnits(selected))} />
            </View>
            <DetailSection label={`Equipment (${selected.lines.length})`}>
              {selected.lines.map((line) => (
                <View key={line.equipment_id} style={styles.detailLine}>
                  <Row style={{ width: "100%" }}>
                    <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.detailTitle} numberOfLines={1}>{line.name}</Text><Mono style={styles.detailSku}>{equipmentIdentifier(line)}</Mono></View>
                    <Mono style={styles.detailAmount}>{line.qty} ordered</Mono>
                    {canEdit && lineLifecycle(line).onSite > 0 && selected.status !== "returned" ? (
                      <TouchableOpacity onPress={() => openReturn(selected, line)} style={styles.smallBtn} testID={`return-${selected.id}-${line.equipment_id}`}>
                        <Text style={styles.smallBtnText}>Return</Text>
                      </TouchableOpacity>
                    ) : null}
                  </Row>
                  <LifecycleStrip line={line} />
                </View>
              ))}
            </DetailSection>
            {selected.notes ? <DetailSection label="Notes"><Text style={styles.detailText}>{selected.notes}</Text></DetailSection> : null}
            <DetailSection label="Pickup">
              <PickupStatus
                dispatch={pickupFor(selected.id)}
                rentalReturned={selected.status === "returned"}
                onOpen={(id) => router.push(`/(app)/operations/dispatch?open=${id}` as any)}
                onSchedule={() => schedulePickup(selected.id)}
                busy={pickupBusy}
              />
            </DetailSection>
            <View style={styles.drawerActions}>
              {canEdit ? <Button title="Edit Rental" onPress={() => editRental(selected)} testID={`edit-rental-${selected.id}`} /> : null}
              <View style={styles.drawerActionRow}>
                {canEdit ? <View style={{ flex: 1 }}><Button title={selected.lat != null ? "Update location" : "Set location"} onPress={() => setPickerFor({ mode: "existing", id: selected.id, initial: selected.lat != null && selected.lng != null ? { lat: selected.lat, lng: selected.lng } : null })} variant="outline" testID={`set-location-${selected.id}`} /></View> : null}
                <View style={{ flex: 1 }}><Button title="Delivery PDF" onPress={() => generatePDF(selected)} variant="outline" testID={`pdf-${selected.id}`} /></View>
              </View>
              {canAdmin ? <Button title="Delete Rental" onPress={() => del(selected.id)} variant="danger" testID={`delete-rental-${selected.id}`} /> : null}
            </View>
          </View>
        ) : null}
      </DetailDrawer>

      <Modal visible={creating} animationType="slide" onRequestClose={() => setCreating(false)}>
        <Screen title={draft?.id ? "Edit Rental" : "New Rental"} back rightAction={{ icon: "close", onPress: () => { setCreating(false); setDraft(null); }, testID: "close-new-rental" }}>
          <Input label="Customer Name" value={draft?.customer_name || ""} onChangeText={(t) => setDraft({ ...draft, customer_name: t })} testID="cust-name" />
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}><Input label="Phone" value={draft?.customer_phone || ""} onChangeText={(t) => setDraft({ ...draft, customer_phone: t })} keyboardType="phone-pad" mono testID="cust-phone" /></View>
            <View style={{ flex: 1 }}><Input label="Email" value={draft?.customer_email || ""} onChangeText={(t) => setDraft({ ...draft, customer_email: t })} keyboardType="email-address" autoCapitalize="none" testID="cust-email" /></View>
          </Row>
          <Input label="Job Site" value={draft?.job_site || ""} onChangeText={(t) => setDraft({ ...draft, job_site: t })} testID="cust-site" />
          <Input
            label="Start date (yyyy-mm-dd)"
            value={draft?.start_date?.slice(0, 10) || ""}
            onChangeText={(t) => {
              const start = new Date(t);
              setDraft({ ...draft, start_date: start.toISOString() });
            }}
            mono
            autoCapitalize="none"
            testID="start-date"
          />
          <Input label="Notes" value={draft?.notes || ""} onChangeText={(t) => setDraft({ ...draft, notes: t })} testID="notes" />

          <SectionLabel>Job site location</SectionLabel>
          <Card style={{ marginBottom: spacing.md }}>
            {draft?.lat != null && draft?.lng != null ? (
              <Row style={{ gap: 6, marginBottom: spacing.sm }}>
                <Ionicons name="location" size={14} color={colors.primary} />
                <Mono style={{ fontSize: 13 }}>{Number(draft.lat).toFixed(5)}, {Number(draft.lng).toFixed(5)}</Mono>
              </Row>
            ) : (
              <Text style={[typo.bodySmall, { marginBottom: spacing.sm }]}>
                No location set. Search an address, use the Job Site field, or pick on map.
              </Text>
            )}

            <Input
              label="Search address"
              value={addressQuery}
              onChangeText={setAddressQuery}
              placeholder="123 Main St, Springfield, IL"
              autoCapitalize="words"
              returnKeyType="search"
              onSubmitEditing={searchAddress}
              testID="address-search-input"
            />
            <Button
              title={addressBusy ? "Searching…" : "Search address"}
              onPress={searchAddress}
              variant="outline"
              loading={addressBusy}
              testID="address-search-btn"
            />

            {addressResults.length > 0 ? (
              <View style={styles.resultsWrap} testID="address-results">
                {addressResults.map((r, idx) => (
                  <TouchableOpacity
                    key={`${r.lat}-${r.lng}-${idx}`}
                    onPress={() => pickAddress(r)}
                    style={styles.resultRow}
                    testID={`address-result-${idx}`}
                  >
                    <Ionicons name="location-outline" size={16} color={colors.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={[typo.body, { fontSize: 13 }]} numberOfLines={2}>{r.display_name}</Text>
                      <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{r.lat.toFixed(4)}, {r.lng.toFixed(4)}</Mono>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            <View style={{ height: spacing.sm }} />
            <Row style={{ gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Button title="Pick on map" onPress={() => setPickerFor({ mode: "draft" })} variant="outline" testID="draft-pick-map" />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Geocode job site" onPress={draftGeocode} variant="outline" testID="draft-geocode" />
              </View>
            </Row>
          </Card>

          <SectionLabel>Line items ({(draft?.lines || []).length})</SectionLabel>
          {(draft?.lines || []).map((l: Line) => (
            <Card key={l.equipment_id} style={{ marginBottom: spacing.sm }}>
              <Row style={{ justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body}>{l.name}</Text>
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{equipmentIdentifier(l)}</Mono>
                </View>
                <TouchableOpacity onPress={() => updateQty(l.equipment_id, l.qty - 1)} style={styles.qtyBtn} testID={`qty-minus-${l.sku}`}><Text style={styles.qtyText}>−</Text></TouchableOpacity>
                <Mono style={{ marginHorizontal: 12, fontSize: 18 }}>{l.qty}</Mono>
                <TouchableOpacity onPress={() => updateQty(l.equipment_id, l.qty + 1)} style={styles.qtyBtn} testID={`qty-plus-${l.sku}`}><Text style={styles.qtyText}>+</Text></TouchableOpacity>
              </Row>
            </Card>
          ))}

          <SectionLabel>Add equipment</SectionLabel>
          <View style={{ borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md }} testID="add-eq-list">
            {equipment.map((e) => (
              <TouchableOpacity key={e.id} onPress={() => addLine(e)} style={styles.eqRow} testID={`add-eq-${e.sku}`}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body}>{e.name}</Text>
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{equipmentIdentifier(e)} · {e.available} avail</Mono>
                </View>
                <Ionicons name="add-circle" size={26} color={colors.orange} />
              </TouchableOpacity>
            ))}
          </View>

          <Button title={draft?.id ? "Save Changes" : "Save Rental"} onPress={save} testID="save-rental-btn" />
        </Screen>
      </Modal>

      <LocationPicker
        visible={!!pickerFor}
        initial={
          pickerFor?.mode === "draft"
            ? (draft?.lat != null && draft?.lng != null ? { lat: draft.lat, lng: draft.lng } : null)
            : pickerFor?.mode === "existing"
              ? (pickerFor.initial ?? null)
              : null
        }
        onClose={() => setPickerFor(null)}
        onSave={saveLocation}
      />

      <Modal
        visible={!!qtyPrompt}
        transparent
        animationType="fade"
        onRequestClose={() => setQtyPrompt(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setQtyPrompt(null)}
          style={styles.qtyBackdrop}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.qtyDialog} testID="qty-dialog">
            {qtyPrompt ? (
              <>
                <H3>{qtyPrompt.eq.name}</H3>
                <Text style={[typo.bodySmall, { marginTop: 4, marginBottom: spacing.md }]}>
                  {equipmentIdentifier(qtyPrompt.eq)} · {qtyPrompt.eq.available} available
                </Text>
                <Input
                  label="Quantity"
                  value={qtyPrompt.qty}
                  onChangeText={(t) => setQtyPrompt({ ...qtyPrompt, qty: t.replace(/[^0-9]/g, "") })}
                  keyboardType="number-pad"
                  autoFocus
                  mono
                  returnKeyType="done"
                  onSubmitEditing={confirmQty}
                  testID="qty-dialog-input"
                />
                <Row style={{ gap: spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Button title="Cancel" onPress={() => setQtyPrompt(null)} variant="outline" testID="qty-dialog-cancel" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button title="Add" onPress={confirmQty} testID="qty-dialog-confirm" />
                  </View>
                </Row>
              </>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={!!returnPrompt} transparent animationType="fade" onRequestClose={() => setReturnPrompt(null)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setReturnPrompt(null)} style={styles.qtyBackdrop}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.returnDialog} testID="return-dialog">
            {returnPrompt ? (
              <>
                <H3>Receive returned equipment</H3>
                <Text style={[typo.bodySmall, { marginTop: 4 }]}>{returnPrompt.rental.customer_name}</Text>
                <Text style={[typo.body, { fontWeight: "700", marginTop: spacing.md }]}>{returnPrompt.line.name}</Text>
                <Mono style={styles.detailSku}>{equipmentIdentifier(returnPrompt.line)} · {lineLifecycle(returnPrompt.line).onSite} currently on site</Mono>
                <View style={styles.returnFields}>
                  <View style={{ flex: 1 }}>
                    <Input label="Return quantity" value={returnPrompt.qty} onChangeText={(qty) => setReturnPrompt({ ...returnPrompt, qty: qty.replace(/[^0-9]/g, "") })} keyboardType="number-pad" mono testID="return-qty" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Input label="Damaged quantity" value={returnPrompt.damagedQty} onChangeText={(damagedQty) => setReturnPrompt({ ...returnPrompt, damagedQty: damagedQty.replace(/[^0-9]/g, "") })} keyboardType="number-pad" mono testID="return-damaged-qty" />
                  </View>
                </View>
                <Text style={styles.returnHelp}>Damaged units are included in the return quantity and move directly to maintenance.</Text>
                <Row style={{ gap: spacing.sm, marginTop: spacing.md }}>
                  <View style={{ flex: 1 }}><Button title="Cancel" onPress={() => setReturnPrompt(null)} variant="outline" testID="return-cancel" /></View>
                  <View style={{ flex: 1 }}><Button title="Receive" onPress={submitReturn} testID="return-confirm" /></View>
                </Row>
              </>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </Screen>
  );
}

const LifecycleStrip: React.FC<{ line: Line }> = ({ line }) => {
  const values = lineLifecycle(line);
  return (
    <View style={styles.lifecycleStrip} testID={`line-lifecycle-${line.equipment_id}`}>
      {([
        ["Ordered", values.ordered],
        ["Delivered", values.delivered],
        ["On Site", values.onSite],
        ["Returned", values.returned],
        ["Damaged", values.damaged],
      ] as const).map(([label, value]) => (
        <View key={label} style={styles.lifecycleMetric}>
          <Text style={styles.lifecycleLabel}>{label}</Text>
          <Mono style={[styles.lifecycleValue, label === "Damaged" && value > 0 && styles.lifecycleDamaged]}>{value}</Mono>
        </View>
      ))}
    </View>
  );
};

const DetailSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <View style={styles.detailSection}><Text style={styles.detailLabel}>{label}</Text>{children}</View>
);

const DetailMetric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.detailMetric}><Text style={styles.detailLabel}>{label}</Text><Mono style={styles.detailMetricValue}>{value}</Mono></View>
);

const PickupStatus: React.FC<{
  dispatch?: Dispatch;
  rentalReturned: boolean;
  onOpen: (id: string) => void;
  onSchedule: () => void;
  busy: boolean;
}> = ({ dispatch, rentalReturned, onOpen, onSchedule, busy }) => {
  if (rentalReturned) {
    return <Text style={typo.bodySmall}>Fully returned — no pickup needed.</Text>;
  }
  if (dispatch) {
    return (
      <TouchableOpacity onPress={() => onOpen(dispatch.id)} testID="pickup-status-row">
        <Text style={styles.detailTitle}>
          {dispatch.scheduled_date ? new Date(dispatch.scheduled_date).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "Time not set"}
        </Text>
        <Text style={styles.detailText}>Driver: {dispatch.driver_name || "Unassigned"}</Text>
        <StatusBadge label={dispatch.status} />
      </TouchableOpacity>
    );
  }
  return <Button title="Schedule Pickup" onPress={onSchedule} loading={busy} variant="outline" testID="schedule-pickup-btn" />;
};

const RentalDirectionTabs: React.FC<{
  direction: RentalDirection;
  counts: Record<RentalDirection, number>;
  onChange: (direction: RentalDirection) => void;
  desktop?: boolean;
}> = ({ direction, counts, onChange, desktop = false }) => (
  <View style={[styles.directionTabs, desktop && styles.directionTabsDesktop]} testID="rentals-direction-tabs">
    {(["outbound", "inbound"] as RentalDirection[]).map((value) => {
      const active = direction === value;
      return (
        <TouchableOpacity
          key={value}
          onPress={() => onChange(value)}
          style={[styles.directionTab, active && styles.directionTabActive]}
          activeOpacity={0.72}
          testID={`rentals-direction-${value}`}
        >
          <Ionicons name={value === "outbound" ? "arrow-up-outline" : "arrow-down-outline"} size={15} color={active ? colors.primary : colors.inkMuted} />
          <Text style={[styles.directionTabText, active && styles.directionTabTextActive]}>{value === "outbound" ? "Outbound" : "Inbound"}</Text>
          <View style={[styles.directionCount, active && styles.directionCountActive]}><Text style={[styles.directionCountText, active && styles.directionCountTextActive]}>{counts[value]}</Text></View>
        </TouchableOpacity>
      );
    })}
  </View>
);

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg },
  directionTabs: { flexDirection: "row", gap: spacing.xs, marginBottom: spacing.md },
  directionTabsDesktop: { paddingHorizontal: spacing.xl },
  directionTab: { height: 38, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  directionTabActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  directionTabText: { fontSize: 13, fontWeight: "700", color: colors.inkSecondary },
  directionTabTextActive: { color: colors.primary },
  directionCount: { minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.bgTint },
  directionCountActive: { backgroundColor: colors.bg },
  directionCountText: { fontSize: 10.5, fontWeight: "800", color: colors.inkMuted },
  directionCountTextActive: { color: colors.primary },
  toolbarButton: { height: 40 },
  filterRow: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, paddingHorizontal: spacing.xl, paddingBottom: spacing.sm },
  resultCount: { ...typo.bodySmall, fontSize: 12 },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, marginBottom: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", backgroundColor: colors.bg },
  tableLink: { fontSize: 12, color: colors.primary, fontWeight: "700" },
  tableMono: { fontSize: 12 },
  lineRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border, marginTop: 8 },
  lifecycleStrip: { width: "100%", flexDirection: "row", marginTop: 10, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, overflow: "hidden" },
  lifecycleMetric: { flex: 1, minWidth: 0, alignItems: "center", paddingVertical: 7, paddingHorizontal: 2, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
  lifecycleLabel: { fontSize: 8.5, fontWeight: "700", color: colors.inkMuted, textTransform: "uppercase", letterSpacing: 0.25 },
  lifecycleValue: { fontSize: 13, fontWeight: "700", marginTop: 2 },
  lifecycleDamaged: { color: colors.error },
  smallBtn: { paddingHorizontal: 10, height: 32, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center" },
  smallBtnText: { fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6 },
  qtyBtn: { width: 36, height: 36, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center" },
  qtyText: { fontSize: 20, fontWeight: "800", color: colors.ink },
  eqRow: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  resultsWrap: { marginTop: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 6, overflow: "hidden" },
  resultRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bgMuted },
  qtyBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  qtyDialog: { backgroundColor: colors.bg, borderRadius: 8, padding: 20, width: "100%", maxWidth: 360 },
  returnDialog: { backgroundColor: colors.bg, borderRadius: radii.lg, padding: spacing.lg, width: "100%", maxWidth: 500 },
  returnFields: { flexDirection: "row", gap: spacing.md, marginTop: spacing.md },
  returnHelp: { ...typo.bodySmall, fontSize: 12 },
  detailStatusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  detailMuted: { ...typo.bodySmall, fontSize: 12 },
  detailSection: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  detailLabel: { ...typo.caption, color: colors.inkSecondary, marginBottom: 6 },
  detailTitle: { ...typo.body, fontWeight: "700" },
  detailText: { ...typo.bodySmall, marginTop: 2 },
  detailPair: { flexDirection: "row", flexWrap: "wrap", borderBottomWidth: 1, borderBottomColor: colors.border },
  detailMetric: { width: "50%", paddingVertical: spacing.md, paddingRight: spacing.sm },
  detailMetricValue: { fontSize: 13 },
  detailLine: { minHeight: 48, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  detailSku: { fontSize: 10.5, color: colors.inkMuted },
  detailAmount: { width: 74, textAlign: "right", fontSize: 12 },
  drawerActions: { paddingTop: spacing.lg, gap: spacing.sm },
  drawerActionRow: { flexDirection: "row", gap: spacing.sm },
});

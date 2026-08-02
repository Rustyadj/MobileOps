import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity, Alert, Platform } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Pill, Row, H3 } from "@/src/components/ui";
import { LocationPicker, geocodeString } from "@/src/components/MapCanvas";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo } from "@/src/theme";

type Eq = { id: string; sku: string; name: string; daily_rate: number; available: number };
type Line = { equipment_id: string; sku: string; name: string; qty: number; daily_rate: number; returned_qty: number };
type Rental = {
  id: string; customer_name: string; customer_phone: string; customer_email: string;
  job_site: string; start_date: string; deposit: number; notes: string;
  lines: Line[]; status: string; delivered_by: string; received_by: string;
  lat?: number | null; lng?: number | null;
};
type Site = { brand_name: string; tagline: string; company_address: string; company_phone: string; company_email: string };

export default function RentalsScreen() {
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [equipment, setEquipment] = useState<Eq[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [returning, setReturning] = useState<Rental | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pickerFor, setPickerFor] = useState<null | { mode: "draft" } | { mode: "existing"; id: string; initial?: { lat: number; lng: number } | null }>(null);

  const load = useCallback(async () => {
    try {
      const [r, e, s] = await Promise.all([
        api<Rental[]>("/rentals"),
        api<Eq[]>("/equipment"),
        api<Site>("/site"),
      ]);
      setRentals(r); setEquipment(e); setSite(s);
    } catch (err) { console.warn(err); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const draftGeocode = async () => {
    if (!draft?.job_site?.trim()) {
      Alert.alert("No address", "Enter a Job Site address first, then tap Geocode.");
      return;
    }
    const coords = await geocodeString(draft.job_site);
    if (coords) {
      setDraft({ ...draft, lat: coords.lat, lng: coords.lng });
    } else {
      Alert.alert("Geocode failed", "Couldn't resolve that address. Try 'Pick on map' or 'Use current location'.");
    }
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
        load();
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
    setDraft((d: any) => {
      const existing = d.lines.find((l: Line) => l.equipment_id === eq.id);
      if (existing) {
        return { ...d, lines: d.lines.map((l: Line) => l.equipment_id === eq.id ? { ...l, qty: l.qty + 1 } : l) };
      }
      return { ...d, lines: [...d.lines, { equipment_id: eq.id, sku: eq.sku, name: eq.name, qty: 1, daily_rate: eq.daily_rate, returned_qty: 0 }] };
    });
  };

  const updateQty = (id: string, qty: number) => {
    setDraft((d: any) => ({ ...d, lines: d.lines.map((l: Line) => l.equipment_id === id ? { ...l, qty: Math.max(0, qty) } : l).filter((l: Line) => l.qty > 0) }));
  };

  const save = async () => {
    if (!draft.customer_name || draft.lines.length === 0) {
      Alert.alert("Required", "Customer name and at least one line item.");
      return;
    }
    try {
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
      setCreating(false); setDraft(null); load();
    } catch (e: any) { Alert.alert("Save failed", e.message); }
  };

  const del = async (id: string) => {
    try { await api(`/rentals/${id}`, { method: "DELETE" }); load(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  const doReturn = async (rental: Rental, line: Line, qty: number) => {
    try {
      await api(`/rentals/${rental.id}/return`, {
        method: "POST",
        body: JSON.stringify([{ equipment_id: line.equipment_id, qty }]),
      });
      load();
    } catch (e: any) { Alert.alert("Return failed", e.message); }
  };

  const generatePDF = async (r: Rental) => {
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

  return (
    <Screen title="Rentals" subtitle={`${rentals.length} total · ${rentals.filter(r => r.status === "active").length} active`} back
      rightAction={{ icon: "add", onPress: newRental, testID: "new-rental-btn" }}
      onRefresh={onRefresh} refreshing={refreshing} testID="rentals-screen">

      {rentals.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No rentals yet. Tap + to create.</Text></Card>
      ) : rentals.map((r) => {
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
              <Row key={l.equipment_id} style={styles.lineRow}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body}>{l.name}</Text>
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{l.sku}</Mono>
                </View>
                <Mono style={{ marginRight: 12 }}>{l.returned_qty}/{l.qty}</Mono>
                {l.returned_qty < l.qty && r.status !== "returned" ? (
                  <TouchableOpacity onPress={() => doReturn(r, l, l.qty - l.returned_qty)} style={styles.smallBtn} testID={`return-${r.id}-${l.equipment_id}`}>
                    <Text style={styles.smallBtnText}>Return</Text>
                  </TouchableOpacity>
                ) : null}
              </Row>
            ))}
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
            <View style={{ height: spacing.sm }} />
            <Row style={{ gap: spacing.sm }}>
              <View style={{ flex: 1 }}><Button title="Delivery PDF" onPress={() => generatePDF(r)} variant="outline" testID={`pdf-${r.id}`} /></View>
              <View style={{ flex: 1 }}><Button title="Delete" onPress={() => del(r.id)} variant="danger" testID={`delete-rental-${r.id}`} /></View>
            </Row>
          </Card>
        );
      })}

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
          <Input label="Deposit ($)" value={String(draft?.deposit ?? 0)} onChangeText={(t) => setDraft({ ...draft, deposit: Number(t) || 0 })} keyboardType="decimal-pad" mono testID="deposit" />
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
                No location set. Add one so this rental appears on the Map.
              </Text>
            )}
            <Row style={{ gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Button title="Pick on map" onPress={() => setPickerFor({ mode: "draft" })} variant="outline" testID="draft-pick-map" />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Geocode address" onPress={draftGeocode} variant="outline" testID="draft-geocode" />
              </View>
            </Row>
          </Card>

          <SectionLabel>Line items ({(draft?.lines || []).length})</SectionLabel>
          {(draft?.lines || []).map((l: Line) => (
            <Card key={l.equipment_id} style={{ marginBottom: spacing.sm }}>
              <Row style={{ justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body}>{l.name}</Text>
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{l.sku} · ${l.daily_rate}/d</Mono>
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
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{e.sku} · {e.available} avail · ${e.daily_rate}/d</Mono>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  lineRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border, marginTop: 8 },
  smallBtn: { paddingHorizontal: 10, height: 32, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center" },
  smallBtnText: { fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6 },
  qtyBtn: { width: 36, height: 36, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center" },
  qtyText: { fontSize: 20, fontWeight: "800", color: colors.ink },
  eqRow: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
});

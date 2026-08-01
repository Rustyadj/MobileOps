import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity, Alert, Platform } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Pill, Row, H3 } from "@/src/components/ui";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo } from "@/src/theme";

type Eq = { id: string; sku: string; name: string; daily_rate: number; available: number };
type Line = { equipment_id: string; sku: string; name: string; qty: number; daily_rate: number; returned_qty: number };
type Rental = {
  id: string; customer_name: string; customer_phone: string; customer_email: string;
  job_site: string; start_date: string; due_date: string; deposit: number; notes: string;
  lines: Line[]; status: string; delivered_by: string; received_by: string;
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

  const newRental = () => {
    const now = new Date();
    const due = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    setDraft({
      customer_name: "", customer_phone: "", customer_email: "", job_site: "",
      start_date: now.toISOString(), due_date: due.toISOString(),
      deposit: 0, notes: "", lines: [],
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
      await api("/rentals", { method: "POST", body: JSON.stringify(draft) });
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
    const totalDays = Math.max(1, Math.ceil((+new Date(r.due_date) - +new Date(r.start_date)) / 86400000));
    const lineRows = r.lines.map((l) =>
      `<tr><td>${l.sku}</td><td>${l.name}</td><td style="text-align:right">${l.qty}</td></tr>`
    ).join("");

    const logoHtml = site?.logo_base64
      ? `<img src="${site.logo_base64}" style="max-height:72px;max-width:160px;object-fit:contain;margin-right:16px"/>`
      : `<div class="tile"></div>`;

    const html = `
<!doctype html><html><head><meta charset="utf-8"/><style>
body { font-family: -apple-system, Helvetica, Arial; color:#09090B; padding: 32px; }
.brand { display:flex; align-items:center; border-bottom: 2px solid #09090B; padding-bottom: 16px; margin-bottom: 24px; }
.tile { width:10px; height:36px; background:#FF6A00; margin-right:12px; }
h1 { margin:0; font-size:24px; letter-spacing:1px; text-transform:uppercase; }
.label { font-size:10px; text-transform:uppercase; letter-spacing:1.2px; color:#52525B; font-weight:700; }
.box { border:1px solid #E4E4E7; padding:14px; margin-bottom:12px; }
table { width:100%; border-collapse:collapse; margin-top:8px; }
th, td { padding:10px 8px; border-bottom:1px solid #E4E4E7; font-size:13px; }
th { background:#F4F4F5; text-transform:uppercase; font-size:10px; letter-spacing:1px; text-align:left; }
.sig { margin-top:48px; display:flex; gap:24px; }
.sig div { flex:1; border-top: 1px solid #09090B; padding-top:6px; font-size:11px; text-transform:uppercase; letter-spacing:1px; }
</style></head><body>
<div class="brand">${logoHtml}<div><h1>${site?.brand_name || "Concrete Form"} — Delivery Ticket</h1><div class="label">${site?.tagline || ""}</div></div></div>
<div class="box">
  <div class="label">Customer</div>
  <div style="font-size:18px;font-weight:800;margin-top:4px">${r.customer_name}</div>
  <div>${r.customer_phone || ""} ${r.customer_email ? " · " + r.customer_email : ""}</div>
  <div>${r.job_site || ""}</div>
</div>
<div class="box">
  <div class="label">Dates</div>
  <div>Start: ${new Date(r.start_date).toLocaleDateString()} · Due: ${new Date(r.due_date).toLocaleDateString()} · ${totalDays} day${totalDays>1?"s":""}</div>
</div>
<table>
  <thead><tr><th>SKU</th><th>Description</th><th style="text-align:right">Qty</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
${r.notes ? `<div class="box" style="margin-top:24px"><div class="label">Notes</div><div>${r.notes}</div></div>` : ""}
<div class="sig"><div>Delivered by</div><div>Received by (signature)</div></div>
<div style="margin-top:32px;font-size:10px;color:#A1A1AA">${site?.company_address || ""} · ${site?.company_phone || ""} · ${site?.company_email || ""}</div>
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
                <Text style={[typo.label, { marginTop: 2 }]}>{r.job_site || "—"}</Text>
              </View>
              <Pill color={r.status === "returned" ? colors.success : r.status === "active" ? colors.orange : colors.warning}
                    bg={r.status === "returned" ? "#DCFCE7" : r.status === "active" ? "#FFEDD5" : "#FEF3C7"}>
                {r.status}
              </Pill>
            </Row>
            <Row style={{ marginTop: spacing.sm, gap: spacing.md }}>
              <Text style={typo.label}>Due <Mono style={{ fontSize: 13 }}>{new Date(r.due_date).toLocaleDateString()}</Mono></Text>
              <Text style={typo.label}>Items <Mono style={{ fontSize: 13 }}>{returnedQty}/{totalQty}</Mono></Text>
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
              <View style={{ flex: 1 }}><Button title="Delivery PDF" onPress={() => generatePDF(r)} variant="outline" testID={`pdf-${r.id}`} /></View>
              <View style={{ flex: 1 }}><Button title="Delete" onPress={() => del(r.id)} variant="danger" testID={`delete-rental-${r.id}`} /></View>
            </Row>
          </Card>
        );
      })}

      <Modal visible={creating} animationType="slide" onRequestClose={() => setCreating(false)}>
        <Screen title="New Rental" back rightAction={{ icon: "close", onPress: () => setCreating(false), testID: "close-new-rental" }}>
          <Input label="Customer Name" value={draft?.customer_name || ""} onChangeText={(t) => setDraft({ ...draft, customer_name: t })} testID="cust-name" />
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}><Input label="Phone" value={draft?.customer_phone || ""} onChangeText={(t) => setDraft({ ...draft, customer_phone: t })} keyboardType="phone-pad" mono testID="cust-phone" /></View>
            <View style={{ flex: 1 }}><Input label="Email" value={draft?.customer_email || ""} onChangeText={(t) => setDraft({ ...draft, customer_email: t })} keyboardType="email-address" autoCapitalize="none" testID="cust-email" /></View>
          </Row>
          <Input label="Job Site" value={draft?.job_site || ""} onChangeText={(t) => setDraft({ ...draft, job_site: t })} testID="cust-site" />
          <Input
            label="Start (yyyy-mm-dd)"
            value={draft?.start_date?.slice(0, 10) || ""}
            onChangeText={(t) => {
              const start = new Date(t);
              const due = new Date(start.getTime() + 30 * 86400000);
              setDraft({ ...draft, start_date: start.toISOString(), due_date: due.toISOString() });
            }}
            mono
            autoCapitalize="none"
            testID="start-date"
          />
          <Input label="Deposit ($)" value={String(draft?.deposit ?? 0)} onChangeText={(t) => setDraft({ ...draft, deposit: Number(t) || 0 })} keyboardType="decimal-pad" mono testID="deposit" />
          <Input label="Notes" value={draft?.notes || ""} onChangeText={(t) => setDraft({ ...draft, notes: t })} testID="notes" />

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

          <Button title="Save Rental" onPress={save} testID="save-rental-btn" />
        </Screen>
      </Modal>
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

// New Booking — customer/job/dates/status plus an equipment picker (the
// original form silently saved every booking with an empty items list,
// which meant capacity/demand tracking never worked for anything created
// through the UI). Booking editing isn't supported by the backend (create +
// delete only), matching the original scope.
import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, Input, Button, Mono, SectionLabel, Row } from "@/src/components/ui";
import { SearchInput } from "@/src/components/data/SearchInput";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { CapEquipment } from "@/src/features/capacity/computeCapacity";
import type { BookingItem } from "./useBookings";

const STATUSES = ["tentative", "confirmed", "cancelled"];

export const BookingForm: React.FC<{
  visible: boolean;
  draft: any;
  setDraft: (updater: any) => void;
  equipment: CapEquipment[];
  onClose: () => void;
  onSave: () => Promise<void>;
}> = ({ visible, draft, setDraft, equipment, onClose, onSave }) => {
  const [eqSearch, setEqSearch] = useState("");
  const [saving, setSaving] = useState(false);

  const filteredEquipment = useMemo(() => {
    const q = eqSearch.trim().toLowerCase();
    if (!q) return equipment;
    return equipment.filter((e) => e.name.toLowerCase().includes(q) || e.sku.toLowerCase().includes(q));
  }, [equipment, eqSearch]);

  if (!visible || !draft) return null;

  const addLine = (eq: CapEquipment) => {
    setDraft((d: any) => {
      const existing = (d.items || []).find((l: BookingItem) => l.equipment_id === eq.id);
      if (existing) return { ...d, items: d.items.map((l: BookingItem) => l.equipment_id === eq.id ? { ...l, qty: l.qty + 1 } : l) };
      return { ...d, items: [...(d.items || []), { equipment_id: eq.id, sku: eq.sku, name: eq.name, qty: 1, daily_rate: 0, returned_qty: 0 }] };
    });
  };

  const updateQty = (id: string, qty: number) => {
    setDraft((d: any) => ({ ...d, items: (d.items || []).map((l: BookingItem) => l.equipment_id === id ? { ...l, qty: Math.max(0, qty) } : l).filter((l: BookingItem) => l.qty > 0) }));
  };

  const handleSave = async () => {
    if (!draft.customer_name) { Alert.alert("Required", "Customer name"); return; }
    setSaving(true);
    try { await onSave(); }
    catch (e: any) { Alert.alert("Save failed", e.message); }
    finally { setSaving(false); }
  };

  return (
    <DetailDrawer visible={visible} title="New Booking" subtitle={draft.customer_name || "New"} onClose={onClose} width={520} testID="booking-form-drawer">
      <Input label="Customer Name" value={draft.customer_name || ""} onChangeText={(t) => setDraft({ ...draft, customer_name: t })} testID="bk-cust" />
      <Input label="Job Site" value={draft.job_site || ""} onChangeText={(t) => setDraft({ ...draft, job_site: t })} testID="bk-site" />
      <Row style={{ gap: spacing.md }}>
        <View style={{ flex: 1 }}><Input label="Start" value={draft.start_date?.slice(0, 10) || ""} onChangeText={(t) => setDraft({ ...draft, start_date: new Date(t).toISOString() })} mono autoCapitalize="none" testID="bk-start" /></View>
        <View style={{ flex: 1 }}><Input label="End" value={draft.end_date?.slice(0, 10) || ""} onChangeText={(t) => setDraft({ ...draft, end_date: new Date(t).toISOString() })} mono autoCapitalize="none" testID="bk-end" /></View>
      </Row>

      <SectionLabel>Status</SectionLabel>
      <Row style={{ gap: spacing.sm, marginBottom: spacing.md }}>
        {STATUSES.map((s) => (
          <View key={s} style={{ flex: 1 }}>
            <Button title={s} onPress={() => setDraft({ ...draft, status: s })} variant={draft.status === s ? "primary" : "outline"} testID={`bk-status-${s}`} />
          </View>
        ))}
      </Row>

      <Input label="Notes" value={draft.notes || ""} onChangeText={(t) => setDraft({ ...draft, notes: t })} testID="bk-notes" />

      {(draft.items || []).length > 0 ? (
        <>
          <SectionLabel>Equipment requested ({draft.items.length})</SectionLabel>
          {draft.items.map((l: BookingItem) => (
            <Card key={l.equipment_id} style={{ marginBottom: spacing.sm }}>
              <Row style={{ justifyContent: "space-between" }}>
                <Text style={{ flex: 1 }}>{l.name}</Text>
                <TouchableOpacity onPress={() => updateQty(l.equipment_id, l.qty - 1)} style={styles.qtyBtn} testID={`bk-qty-minus-${l.sku}`}><Text style={styles.qtyText}>−</Text></TouchableOpacity>
                <Mono style={{ marginHorizontal: 12, fontSize: 18 }}>{l.qty}</Mono>
                <TouchableOpacity onPress={() => updateQty(l.equipment_id, l.qty + 1)} style={styles.qtyBtn} testID={`bk-qty-plus-${l.sku}`}><Text style={styles.qtyText}>+</Text></TouchableOpacity>
              </Row>
            </Card>
          ))}
          <View style={{ height: spacing.md }} />
        </>
      ) : null}

      <SectionLabel>Add equipment</SectionLabel>
      <SearchInput value={eqSearch} onChangeText={setEqSearch} placeholder="Search by name or SKU…" style={{ marginBottom: spacing.sm, width: "100%" }} testID="bk-eq-search" />
      <View style={{ borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md }}>
        {filteredEquipment.map((e) => (
          <TouchableOpacity key={e.id} onPress={() => addLine(e)} style={styles.eqRow} testID={`bk-add-eq-${e.sku}`}>
            <View style={{ flex: 1 }}>
              <Text style={typo.body}>{e.name}</Text>
              <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{e.sku} · {e.quantity} on hand</Mono>
            </View>
            <Ionicons name="add-circle" size={26} color={colors.accent} />
          </TouchableOpacity>
        ))}
      </View>

      <Button title="Save Booking" onPress={handleSave} loading={saving} testID="save-booking-btn" />
    </DetailDrawer>
  );
};

const styles = StyleSheet.create({
  qtyBtn: { width: 36, height: 36, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
  qtyText: { fontSize: 20, fontWeight: "800", color: colors.ink },
  eqRow: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
});

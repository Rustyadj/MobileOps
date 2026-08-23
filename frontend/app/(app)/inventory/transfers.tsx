// Transfers — move available stock from one yard to another. Initiating a
// transfer takes units out of Available into In Transit at the equipment's
// current (source) location; receiving it at the destination credits that
// destination's own balance. The backend tracks available stock per
// location (location_balances), so a partial transfer only moves the units
// that actually left — it doesn't relabel the whole SKU's pool.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { SearchInput } from "@/src/components/data/SearchInput";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { api } from "@/src/api/client";
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";
import { usePermissions } from "@/src/hooks/use-permissions";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type Equipment = { id: string; sku: string; qr_code?: string | null; category?: string; name: string; location: string; available: number; in_transit: number };
type Transfer = {
  id: string; equipment_id: string; equipment_name: string; qty: number;
  from_location: string; to_location: string; status: string; note: string;
  created_by: string; created_at: string; received_by?: string; received_at?: string | null;
};

const messageFor = (e: unknown) => e instanceof Error ? e.message : "Unexpected error";
const shortDate = (v: string) => new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function TransfersScreen() {
  const { canEdit } = usePermissions();
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [eqSearch, setEqSearch] = useState("");
  const [selectedEqId, setSelectedEqId] = useState("");
  const [qty, setQty] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, t] = await Promise.all([api<Equipment[]>("/equipment"), api<Transfer[]>("/transfers")]);
      setEquipment(e); setTransfers(t);
    } catch (error) { console.warn(error); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const selectedEq = equipment.find((e) => e.id === selectedEqId) || null;
  const eqMatches = useMemo(() => {
    const q = eqSearch.trim().toLowerCase();
    if (!q) return equipment.slice(0, 8);
    return equipment.filter((e) => `${e.qr_code || ""} ${e.name}`.toLowerCase().includes(q)).slice(0, 8);
  }, [equipment, eqSearch]);
  const inTransit = useMemo(() => transfers.filter((t) => t.status === "in_transit"), [transfers]);

  const submitTransfer = async () => {
    if (!selectedEq) { Alert.alert("Select equipment", "Choose equipment to transfer."); return; }
    const parsed = Number.parseInt(qty, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > selectedEq.available) {
      Alert.alert("Invalid quantity", `Enter between 1 and ${selectedEq.available}.`);
      return;
    }
    if (!toLocation.trim()) { Alert.alert("Destination required", "Enter the yard this stock is moving to."); return; }
    setSubmitting(true);
    try {
      await api(`/equipment/${selectedEq.id}/transfer`, { method: "POST", body: JSON.stringify({ qty: parsed, to_location: toLocation.trim(), note }) });
      setQty(""); setToLocation(""); setNote("");
      load();
    } catch (error: unknown) { Alert.alert("Transfer failed", messageFor(error)); }
    finally { setSubmitting(false); }
  };

  const receive = async (transfer: Transfer) => {
    try { await api(`/transfers/${transfer.id}/receive`, { method: "POST" }); load(); }
    catch (error: unknown) { Alert.alert("Receive failed", messageFor(error)); }
  };

  return (
    <Screen title="Transfers" subtitle={`${inTransit.length} in transit`} back onRefresh={onRefresh} refreshing={refreshing} testID="transfers-screen">
      {canEdit ? (
      <Card style={{ marginBottom: spacing.lg }} testID="new-transfer-form">
        <SectionLabel>MOVE STOCK</SectionLabel>
        <SearchInput value={eqSearch} onChangeText={setEqSearch} placeholder="Search QR code or equipment…" testID="transfer-eq-search" style={{ marginBottom: spacing.sm }} />
        <View style={styles.eqResults}>
          {eqMatches.map((item) => {
            const active = item.id === selectedEqId;
            return (
              <TouchableOpacity key={item.id} onPress={() => setSelectedEqId(item.id)} style={[styles.eqRow, active && styles.eqRowActive]} testID={`transfer-eq-${item.sku}`}>
                <View style={{ flex: 1, minWidth: 0 }}><Text style={typo.body} numberOfLines={1}>{item.name}</Text><Mono style={{ fontSize: 10.5, color: colors.inkMuted }}>{equipmentIdentifier(item)} · {item.location || "no location"}</Mono></View>
                <Mono style={{ fontSize: 13, fontWeight: "700" }}>{item.available} avail</Mono>
              </TouchableOpacity>
            );
          })}
        </View>
        {selectedEq ? (
          <>
            <Row style={{ gap: spacing.md, marginTop: spacing.md }}>
              <View style={{ flex: 1 }}><Input label={`Qty (max ${selectedEq.available})`} value={qty} onChangeText={(v) => setQty(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono testID="transfer-qty" /></View>
              <View style={{ flex: 1 }}><Input label="To location" value={toLocation} onChangeText={setToLocation} testID="transfer-to-location" /></View>
            </Row>
            <Input label="Note (optional)" value={note} onChangeText={setNote} testID="transfer-note" />
            <Button title="Start Transfer" onPress={submitTransfer} loading={submitting} testID="submit-transfer" />
          </>
        ) : null}
      </Card>
      ) : null}

      <SectionLabel>IN TRANSIT</SectionLabel>
      {inTransit.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>Nothing in transit.</Text></Card>
      ) : inTransit.map((t) => (
        <Card key={t.id} style={{ marginBottom: spacing.sm, flexDirection: "row", alignItems: "center" }} testID={`transfer-row-${t.id}`}>
          <View style={{ flex: 1 }}>
            <H3>{t.equipment_name}</H3>
            <Text style={[typo.label, { marginTop: 2 }]}>{t.from_location || "—"} → {t.to_location} · {t.qty} units · {shortDate(t.created_at)}</Text>
          </View>
          {canEdit ? <Button title="Receive" onPress={() => receive(t)} fullWidth={false} style={{ height: 36 }} testID={`receive-transfer-${t.id}`} /> : null}
        </Card>
      ))}

      {transfers.some((t) => t.status === "received") ? <>
        <SectionLabel>RECEIVED</SectionLabel>
        {transfers.filter((t) => t.status === "received").slice(0, 20).map((t) => (
          <Card key={t.id} style={{ marginBottom: spacing.sm, flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Text style={typo.body}>{t.equipment_name}</Text>
              <Text style={[typo.label, { marginTop: 2 }]}>{t.from_location || "—"} → {t.to_location} · {t.qty} units</Text>
            </View>
            <StatusBadge label="Received" tone="success" />
          </Card>
        ))}
      </> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  eqResults: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  eqRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  eqRowActive: { backgroundColor: colors.primarySoft },
});

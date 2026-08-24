// Inspections queue — every equipment item with units sitting in
// pending_inspection (returned from a rental, not yet cleared). Inspecting
// resolves units to available (pass) or in_maintenance (damaged, which
// auto-creates a repair task). Field-work done wherever a return just
// happened, so this queues offline (see plan: phase-1 flows).
import { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useCachedResource } from "@/src/hooks/use-cached-resource";
import { mutate } from "@/src/sync/mutate";
import { api } from "@/src/api/client";
import { equipmentIdentifier, qrCodeDisplay } from "@/src/utils/equipment-identifier";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type Equipment = {
  id: string; sku: string; qr_code?: string | null; name: string; category: string;
  pending_inspection: number; available: number; in_maintenance: number;
};

export default function InspectionsScreen() {
  const { isShellWide } = useBreakpoint();
  // Same cache resource key as inventory/equipment.tsx — both screens read
  // (and, for equipment.tsx, write) the same underlying equipment list.
  const equipmentRes = useCachedResource<Equipment>("equipment", () => api<Equipment[]>("/equipment"));
  const equipment = useMemo(
    () => equipmentRes.data.filter((e) => (e.pending_inspection || 0) > 0),
    [equipmentRes.data],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = equipment.find((e) => e.id === selectedId) || null;
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");

  const totalPending = useMemo(() => equipment.reduce((sum, e) => sum + e.pending_inspection, 0), [equipment]);

  const openInspect = (item: Equipment) => { setSelectedId(item.id); setQty(String(item.pending_inspection)); setNote(""); };

  const submit = (outcome: "available" | "damaged") => {
    if (!selected) return;
    const parsed = Number.parseInt(qty, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > selected.pending_inspection) {
      Alert.alert("Invalid quantity", `Enter 1–${selected.pending_inspection}.`);
      return;
    }
    mutate<Equipment>({
      kind: "command",
      entityType: "equipment",
      entityId: selected.id,
      path: `/equipment/${selected.id}/inspect`,
      method: "POST",
      body: { qty: parsed, outcome, note },
      optimisticPatch: {
        pending_inspection: selected.pending_inspection - parsed,
        available: outcome === "available" ? selected.available + parsed : selected.available,
        in_maintenance: outcome === "damaged" ? selected.in_maintenance + parsed : selected.in_maintenance,
      },
    });
    setSelectedId(null);
  };

  const columns: ColumnDef<Equipment>[] = [
    { key: "qr_code", label: "QR Code", width: 104, render: (i) => <Mono style={{ fontSize: 12 }}>{qrCodeDisplay(i)}</Mono> },
    { key: "name", label: "Equipment", flex: 1.4, render: (i) => i.name },
    { key: "category", label: "Category", flex: 1, render: (i) => i.category.replace(/_/g, " ") },
    { key: "pending_inspection", label: "Awaiting Inspection", width: 160, align: "right", render: (i) => <Mono style={{ fontSize: 13, fontWeight: "700", color: colors.warning }}>{i.pending_inspection}</Mono> },
  ];

  return (
    <Screen title="Inspections" subtitle={`${totalPending} units awaiting inspection`} back
      onRefresh={equipmentRes.onRefresh} refreshing={equipmentRes.refreshing} testID="inspections-screen" scroll={!isShellWide}>
      {isShellWide ? (
        <View style={styles.tableWrap}>
          <DataTable columns={columns} rows={equipment} keyExtractor={(i) => i.id} rowTestID={(i) => `inspection-row-${i.sku}`}
            onRowPress={openInspect} selectedId={selected?.id} emptyLabel="Nothing awaiting inspection." />
        </View>
      ) : equipment.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>Nothing awaiting inspection.</Text></Card>
      ) : equipment.map((item) => (
        <TouchableOpacity key={item.id} onPress={() => openInspect(item)} testID={`inspection-row-${item.sku}`}>
          <Card style={{ marginBottom: spacing.sm, flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}><H3>{item.name}</H3><Mono style={{ fontSize: 11, color: colors.inkMuted }}>{equipmentIdentifier(item)}</Mono></View>
            <Mono style={{ fontSize: 16, fontWeight: "700", color: colors.warning }}>{item.pending_inspection}</Mono>
          </Card>
        </TouchableOpacity>
      ))}

      <DetailDrawer visible={!!selected} title={selected?.name || "Inspect"} subtitle={selected ? `${equipmentIdentifier(selected)} · ${selected.pending_inspection} awaiting` : undefined} onClose={() => setSelectedId(null)} testID="inspect-drawer">
        {selected ? (
          <View>
            <SectionLabel>Inspect units</SectionLabel>
            <Input label={`Quantity (max ${selected.pending_inspection})`} value={qty} onChangeText={(v) => setQty(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono testID="inspect-qty" />
            <Input label="Note (optional)" value={note} onChangeText={setNote} testID="inspect-note" />
            <Row style={{ gap: spacing.sm, marginTop: spacing.md }}>
              <View style={{ flex: 1 }}><Button title="Pass → Available" onPress={() => submit("available")} testID="inspect-pass" /></View>
              <View style={{ flex: 1 }}><Button title="Damaged → Repair" onPress={() => submit("damaged")} variant="danger" testID="inspect-damaged" /></View>
            </Row>
          </View>
        ) : null}
      </DetailDrawer>
    </Screen>
  );
}

const styles = StyleSheet.create({
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, marginTop: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
});

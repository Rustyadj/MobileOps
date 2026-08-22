// Inspections queue — every equipment SKU with units sitting in
// pending_inspection (returned from a rental, not yet cleared). Inspecting
// resolves units to available (pass) or in_maintenance (damaged, which
// auto-creates a repair task).
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { api } from "@/src/api/client";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type Equipment = { id: string; sku: string; name: string; category: string; pending_inspection: number };

export default function InspectionsScreen() {
  const { isShellWide } = useBreakpoint();
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Equipment | null>(null);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await api<Equipment[]>("/equipment");
      setEquipment(all.filter((e) => (e.pending_inspection || 0) > 0));
      setSelected((cur) => cur ? all.find((e) => e.id === cur.id) || null : null);
    } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const totalPending = useMemo(() => equipment.reduce((sum, e) => sum + e.pending_inspection, 0), [equipment]);

  const openInspect = (item: Equipment) => { setSelected(item); setQty(String(item.pending_inspection)); setNote(""); };

  const submit = async (outcome: "available" | "damaged") => {
    if (!selected) return;
    const parsed = Number.parseInt(qty, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > selected.pending_inspection) {
      Alert.alert("Invalid quantity", `Enter 1–${selected.pending_inspection}.`);
      return;
    }
    setSubmitting(true);
    try {
      await api(`/equipment/${selected.id}/inspect`, { method: "POST", body: JSON.stringify({ qty: parsed, outcome, note }) });
      setSelected(null);
      load();
    } catch (e: any) { Alert.alert("Inspection failed", e.message); }
    finally { setSubmitting(false); }
  };

  const columns: ColumnDef<Equipment>[] = [
    { key: "sku", label: "SKU", width: 96, render: (i) => <Mono style={{ fontSize: 12 }}>{i.sku}</Mono> },
    { key: "name", label: "Equipment", flex: 1.4, render: (i) => i.name },
    { key: "category", label: "Category", flex: 1, render: (i) => i.category.replace(/_/g, " ") },
    { key: "pending_inspection", label: "Awaiting Inspection", width: 160, align: "right", render: (i) => <Mono style={{ fontSize: 13, fontWeight: "700", color: colors.warning }}>{i.pending_inspection}</Mono> },
  ];

  return (
    <Screen title="Inspections" subtitle={`${totalPending} units awaiting inspection`} back
      onRefresh={onRefresh} refreshing={refreshing} testID="inspections-screen" scroll={!isShellWide}>
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
            <View style={{ flex: 1 }}><H3>{item.name}</H3><Mono style={{ fontSize: 11, color: colors.inkMuted }}>{item.sku}</Mono></View>
            <Mono style={{ fontSize: 16, fontWeight: "700", color: colors.warning }}>{item.pending_inspection}</Mono>
          </Card>
        </TouchableOpacity>
      ))}

      <DetailDrawer visible={!!selected} title={selected?.name || "Inspect"} subtitle={selected ? `${selected.sku} · ${selected.pending_inspection} awaiting` : undefined} onClose={() => setSelected(null)} testID="inspect-drawer">
        {selected ? (
          <View>
            <SectionLabel>Inspect units</SectionLabel>
            <Input label={`Quantity (max ${selected.pending_inspection})`} value={qty} onChangeText={(v) => setQty(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono testID="inspect-qty" />
            <Input label="Note (optional)" value={note} onChangeText={setNote} testID="inspect-note" />
            <Row style={{ gap: spacing.sm, marginTop: spacing.md }}>
              <View style={{ flex: 1 }}><Button title="Pass → Available" onPress={() => submit("available")} loading={submitting} testID="inspect-pass" /></View>
              <View style={{ flex: 1 }}><Button title="Damaged → Repair" onPress={() => submit("damaged")} loading={submitting} variant="danger" testID="inspect-damaged" /></View>
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

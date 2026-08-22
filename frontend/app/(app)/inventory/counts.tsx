import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Button, Card, Input, Mono, SectionLabel, Row } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { SearchInput } from "@/src/components/data/SearchInput";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { api } from "@/src/api/client";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type Equipment = { id: string; sku: string; name: string; available: number };
type InventoryCount = {
  id: string;
  equipment_id: string;
  equipment_name: string;
  counted_qty: number;
  expected_qty: number;
  variance: number;
  status: "pending" | "reconciled";
  reason: string;
  counted_by: string;
  counted_at: string;
  reconciled_by?: string | null;
  reconciled_at?: string | null;
};

const messageFor = (error: unknown) => error instanceof Error ? error.message : "Unexpected error";
const shortDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function ReconciliationScreen() {
  const { isShellWide } = useBreakpoint();
  const params = useLocalSearchParams<{ open?: string }>();
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [counts, setCounts] = useState<InventoryCount[]>([]);
  const [equipmentSearch, setEquipmentSearch] = useState("");
  const [selectedEquipmentId, setSelectedEquipmentId] = useState("");
  const [countedQty, setCountedQty] = useState("");
  const [countResult, setCountResult] = useState<InventoryCount | null>(null);
  const [selectedCount, setSelectedCount] = useState<InventoryCount | null>(null);
  const [reason, setReason] = useState("");
  const [savingCount, setSavingCount] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextEquipment, nextCounts] = await Promise.all([
        api<Equipment[]>("/equipment"),
        api<InventoryCount[]>("/inventory-counts"),
      ]);
      setEquipment(nextEquipment);
      setCounts(nextCounts);
      setSelectedCount((current) => current ? nextCounts.find((count) => count.id === current.id) || null : null);
    } catch (error: unknown) {
      Alert.alert("Unable to load reconciliation", messageFor(error));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!params.open || counts.length === 0) return;
    setSelectedCount(counts.find((count) => count.id === params.open) || null);
  }, [counts, params.open]);

  const selectedEquipment = equipment.find((item) => item.id === selectedEquipmentId) || null;
  const equipmentMatches = useMemo(() => {
    const query = equipmentSearch.trim().toLowerCase();
    if (!query) return equipment.slice(0, 8);
    return equipment.filter((item) => `${item.sku} ${item.name}`.toLowerCase().includes(query)).slice(0, 8);
  }, [equipment, equipmentSearch]);
  const pendingCounts = useMemo(() => counts.filter((count) => count.status === "pending"), [counts]);

  const submitCount = async () => {
    if (!selectedEquipment) {
      Alert.alert("Select equipment", "Choose an equipment SKU before recording a count.");
      return;
    }
    const quantity = Number.parseInt(countedQty, 10);
    if (!Number.isInteger(quantity) || quantity < 0) {
      Alert.alert("Invalid count", "Enter a whole number of zero or more.");
      return;
    }
    setSavingCount(true);
    try {
      const created = await api<InventoryCount>(`/equipment/${selectedEquipment.id}/count`, {
        method: "POST",
        body: JSON.stringify({ counted_qty: quantity }),
      });
      setCounts((current) => [created, ...current]);
      setCountResult(created);
      setCountedQty("");
    } catch (error: unknown) {
      Alert.alert("Count failed", messageFor(error));
    } finally {
      setSavingCount(false);
    }
  };

  const reconcile = async () => {
    if (!selectedCount) return;
    const cleanReason = reason.trim();
    if (!cleanReason) {
      Alert.alert("Reason required", "Document why this inventory variance is being reconciled.");
      return;
    }
    setReconciling(true);
    try {
      const updated = await api<InventoryCount>(`/inventory-counts/${selectedCount.id}/reconcile`, {
        method: "POST",
        body: JSON.stringify({ reason: cleanReason }),
      });
      setCounts((current) => current.map((count) => count.id === updated.id ? updated : count));
      setSelectedCount(updated);
      setReason("");
    } catch (error: unknown) {
      Alert.alert("Reconciliation failed", messageFor(error));
    } finally {
      setReconciling(false);
    }
  };

  const openCount = (count: InventoryCount) => {
    setSelectedCount(count);
    setReason(count.reason || "");
  };

  const columns: ColumnDef<InventoryCount>[] = [
    { key: "equipment", label: "Equipment", flex: 1.6, render: (count) => <Text style={styles.tableName} numberOfLines={1}>{count.equipment_name}</Text> },
    { key: "expected", label: "Expected", width: 80, align: "right", render: (count) => <Mono style={styles.tableNumber}>{count.expected_qty}</Mono> },
    { key: "counted", label: "Counted", width: 80, align: "right", render: (count) => <Mono style={styles.tableNumber}>{count.counted_qty}</Mono> },
    { key: "variance", label: "Variance", width: 82, align: "right", render: (count) => <Mono style={[styles.tableNumber, count.variance !== 0 && styles.varianceText]}>{count.variance > 0 ? "+" : ""}{count.variance}</Mono> },
    { key: "counted_at", label: "Counted", width: 140, render: (count) => <Text style={styles.tableMuted}>{shortDate(count.counted_at)}</Text> },
    { key: "status", label: "Status", width: 90, render: (count) => <StatusBadge label={count.status} tone={count.variance === 0 ? "success" : "warning"} /> },
  ];

  return (
    <Screen title="Inventory Counts" subtitle="Physical counts · variance review" back scroll={!isShellWide} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} refreshing={refreshing} testID="reconciliation-screen">
      <View style={[styles.workspace, !isShellWide && styles.mobileWorkspace]}>
        <Card style={[styles.countPanel, !isShellWide && styles.countPanelMobile]} testID="physical-count-form">
          <SectionLabel>RECORD PHYSICAL COUNT</SectionLabel>
          <Text style={styles.panelTitle}>Select an equipment SKU</Text>
          <SearchInput value={equipmentSearch} onChangeText={setEquipmentSearch} placeholder="Search SKU or equipment…" testID="count-equipment-search" style={{ marginTop: spacing.sm }} />
          <View style={styles.equipmentResults}>
            {equipmentMatches.map((item) => {
              const active = item.id === selectedEquipmentId;
              return (
                <TouchableOpacity key={item.id} onPress={() => setSelectedEquipmentId(item.id)} style={[styles.equipmentRow, active && styles.equipmentRowActive]} testID={`count-equipment-${item.sku}`}>
                  <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.equipmentName} numberOfLines={1}>{item.name}</Text><Mono style={styles.equipmentSku}>{item.sku}</Mono></View>
                  <View style={{ alignItems: "flex-end" }}><Mono style={styles.availableNumber}>{item.available}</Mono><Text style={styles.availableLabel}>expected</Text></View>
                </TouchableOpacity>
              );
            })}
          </View>
          {selectedEquipment ? (
            <View style={styles.countEntry}>
              <View style={{ flex: 1 }}><Input label={`Physical count · ${selectedEquipment.sku}`} value={countedQty} onChangeText={(value) => setCountedQty(value.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono testID="physical-count-qty" /></View>
              <Button title="Record Count" onPress={submitCount} loading={savingCount} fullWidth={false} style={styles.recordButton} testID="record-count" />
            </View>
          ) : null}
          {countResult ? (
            <View style={[styles.resultSummary, countResult.variance === 0 ? styles.resultMatch : styles.resultVariance]} testID="count-result-summary">
              <Text style={styles.resultTitle}>{countResult.variance === 0 ? "Count matches" : "Variance recorded"}</Text>
              <Row style={{ gap: spacing.lg, marginTop: 6 }}><Text style={styles.resultMetric}>Expected <Mono>{countResult.expected_qty}</Mono></Text><Text style={styles.resultMetric}>Counted <Mono>{countResult.counted_qty}</Mono></Text><Text style={styles.resultMetric}>Variance <Mono>{countResult.variance > 0 ? "+" : ""}{countResult.variance}</Mono></Text></Row>
            </View>
          ) : null}
        </Card>

        <View style={styles.queuePanel}>
          <View style={styles.queueToolbar}><PageToolbar><View><Text style={styles.queueTitle}>Pending counts</Text><Text style={styles.queueMeta}>{pendingCounts.length} awaiting review</Text></View></PageToolbar></View>
          {isShellWide ? (
            <View style={styles.tableWrap}><DataTable columns={columns} rows={pendingCounts} keyExtractor={(count) => count.id} rowTestID={(count) => `inventory-count-${count.id}`} onRowPress={openCount} selectedId={selectedCount?.id} emptyLabel="No counts awaiting reconciliation." /></View>
          ) : pendingCounts.length === 0 ? (
            <Card><Text style={styles.tableMuted}>No counts awaiting reconciliation.</Text></Card>
          ) : pendingCounts.map((count) => (
            <TouchableOpacity key={count.id} onPress={() => openCount(count)} testID={`inventory-count-${count.id}`}>
              <Card style={styles.mobileCountCard}>
                <View style={{ flex: 1 }}><Text style={styles.tableName}>{count.equipment_name}</Text><Text style={styles.tableMuted}>{shortDate(count.counted_at)}</Text></View>
                <Mono style={count.variance !== 0 ? styles.varianceText : undefined}>{count.variance > 0 ? "+" : ""}{count.variance}</Mono>
              </Card>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <DetailDrawer visible={!!selectedCount} title={selectedCount?.equipment_name || "Count detail"} subtitle={selectedCount ? `Counted ${shortDate(selectedCount.counted_at)}` : undefined} onClose={() => { setSelectedCount(null); setReason(""); }} testID="reconciliation-drawer">
        {selectedCount ? (
          <View>
            <View style={styles.drawerMetrics}><CountMetric label="Expected" value={selectedCount.expected_qty} /><CountMetric label="Physical" value={selectedCount.counted_qty} /><CountMetric label="Variance" value={selectedCount.variance} signed /></View>
            <View style={styles.drawerMeta}><Text style={styles.tableMuted}>Counted by</Text><Text style={styles.tableName}>{selectedCount.counted_by || "Unknown"}</Text></View>
            {selectedCount.status === "pending" ? (
              <View style={{ marginTop: spacing.lg }}><Input label="Reconciliation reason (required)" value={reason} onChangeText={setReason} placeholder="Explain the variance and corrective action…" multiline style={styles.reasonInput} testID="reconciliation-reason" /><Button title="Reconcile Variance" onPress={reconcile} loading={reconciling} disabled={!reason.trim()} testID="reconcile-count" /></View>
            ) : (
              <View style={styles.reconciledSummary}><StatusBadge label="Reconciled" tone="success" /><Text style={[styles.tableName, { marginTop: spacing.sm }]}>{selectedCount.reason}</Text><Text style={[styles.tableMuted, { marginTop: 4 }]}>By {selectedCount.reconciled_by || "Unknown"}</Text></View>
            )}
          </View>
        ) : null}
      </DetailDrawer>
    </Screen>
  );
}

const CountMetric: React.FC<{ label: string; value: number; signed?: boolean }> = ({ label, value, signed }) => (
  <View style={styles.drawerMetric}><Text style={styles.availableLabel}>{label}</Text><Mono large style={signed && value !== 0 ? styles.varianceText : undefined}>{signed && value > 0 ? "+" : ""}{value}</Mono></View>
);

const styles = StyleSheet.create({
  workspace: { flex: 1, flexDirection: "row", gap: spacing.md, padding: spacing.lg, backgroundColor: colors.bgMuted },
  mobileWorkspace: { flexDirection: "column", padding: 0, backgroundColor: colors.bg },
  countPanel: { width: 390, alignSelf: "stretch" },
  countPanelMobile: { width: "100%" },
  panelTitle: { ...typo.h3 },
  equipmentResults: { marginTop: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  equipmentRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  equipmentRowActive: { backgroundColor: colors.primarySoft },
  equipmentName: { ...typo.body, fontSize: 13, fontWeight: "600" },
  equipmentSku: { fontSize: 10.5, color: colors.inkMuted },
  availableNumber: { fontSize: 13, fontWeight: "700" },
  availableLabel: { fontSize: 9.5, textTransform: "uppercase", letterSpacing: 0.4, color: colors.inkMuted },
  countEntry: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md },
  recordButton: { height: 48, marginTop: 3 },
  resultSummary: { borderWidth: 1, borderRadius: radii.md, padding: spacing.sm, marginTop: spacing.sm },
  resultMatch: { borderColor: colors.success, backgroundColor: colors.successSoft },
  resultVariance: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
  resultTitle: { fontSize: 12.5, fontWeight: "700", color: colors.ink },
  resultMetric: { ...typo.bodySmall, fontSize: 11 },
  queuePanel: { flex: 1, minWidth: 0, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  queueToolbar: { paddingHorizontal: spacing.md },
  queueTitle: { ...typo.h3, fontSize: 14 },
  queueMeta: { ...typo.bodySmall, fontSize: 11 },
  tableWrap: { flex: 1 },
  tableName: { ...typo.body, fontSize: 12.5, fontWeight: "600" },
  tableNumber: { fontSize: 12 },
  tableMuted: { ...typo.bodySmall, fontSize: 11.5 },
  varianceText: { color: colors.error, fontWeight: "700" },
  mobileCountCard: { marginBottom: spacing.sm, flexDirection: "row", alignItems: "center" },
  drawerMetrics: { flexDirection: "row", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  drawerMetric: { flex: 1, alignItems: "center", paddingVertical: spacing.md, borderRightWidth: 1, borderRightColor: colors.border },
  drawerMeta: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  reasonInput: { minHeight: 92, paddingTop: 12, textAlignVertical: "top" },
  reconciledSummary: { marginTop: spacing.lg, padding: spacing.md, backgroundColor: colors.successSoft, borderRadius: radii.md },
});

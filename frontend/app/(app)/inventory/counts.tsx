import { useEffect, useMemo, useState } from "react";
import { Alert, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Button, Card, Input, Mono, SectionLabel, Row } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { SearchInput } from "@/src/components/data/SearchInput";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { api } from "@/src/api/client";
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { usePermissions } from "@/src/hooks/use-permissions";
import { useCachedResource } from "@/src/hooks/use-cached-resource";
import { mutate } from "@/src/sync/mutate";
import { RequiresOnline } from "@/src/components/RequiresOnline";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type Equipment = { id: string; sku: string; qr_code?: string | null; category?: string; name: string; available: number; condition?: string; location?: string; notes?: string };
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
  condition?: string;
  yard_location?: string;
  notes?: string;
  authoritative?: boolean;
};

const messageFor = (error: unknown) => error instanceof Error ? error.message : "Unexpected error";
const shortDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const arrayResponse = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

export default function InventoryCountsScreen() {
  const { isShellWide } = useBreakpoint();
  const { canEdit } = usePermissions();
  const params = useLocalSearchParams<{ open?: string }>();
  const equipmentRes = useCachedResource<Equipment>("equipment", () => api<unknown>("/equipment").then(arrayResponse<Equipment>));
  const countsRes = useCachedResource<InventoryCount>("inventory_counts", () => api<unknown>("/inventory-counts").then(arrayResponse<InventoryCount>));
  const equipment = equipmentRes.data;
  const counts = countsRes.data;
  const [equipmentSearch, setEquipmentSearch] = useState("");
  const [selectedEquipmentId, setSelectedEquipmentId] = useState("");
  const [countedQty, setCountedQty] = useState("");
  const [countResult, setCountResult] = useState<InventoryCount | null>(null);
  const [selectedCountId, setSelectedCountId] = useState<string | null>(null);
  const selectedCount = counts.find((c) => c.id === selectedCountId) || null;
  const [reason, setReason] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [addingBracing, setAddingBracing] = useState(false);
  const [yardDraft, setYardDraft] = useState({ equipment_id: "", equipment_type: "", quantity: "", condition: "good", yard_location: "Yard", notes: "" });
  const [yardSaving, setYardSaving] = useState(false);

  const refreshing = equipmentRes.refreshing || countsRes.refreshing;
  const onRefresh = () => { equipmentRes.onRefresh(); countsRes.onRefresh(); };

  useEffect(() => {
    if (!params.open || counts.length === 0) return;
    setSelectedCountId(params.open);
  }, [counts.length, params.open]);

  const selectedEquipment = equipment.find((item) => item.id === selectedEquipmentId) || null;
  const equipmentMatches = useMemo(() => {
    const query = equipmentSearch.trim().toLowerCase();
    if (!query) return equipment.slice(0, 8);
    return equipment.filter((item) => `${item.qr_code || ""} ${item.name}`.toLowerCase().includes(query)).slice(0, 8);
  }, [equipment, equipmentSearch]);
  const pendingCounts = useMemo(() => counts.filter((count) => count.status === "pending"), [counts]);
  const yardEquipment = useMemo(() => equipment.filter((item) => item.available > 0).sort((a, b) => a.name.localeCompare(b.name)), [equipment]);
  const bracingMatches = useMemo(() => {
    const query = yardDraft.equipment_type.trim().toLowerCase();
    if (!query) return equipment.slice(0, 8);
    return equipment.filter((item) => `${item.name} ${item.category || ""}`.toLowerCase().includes(query)).slice(0, 8);
  }, [equipment, yardDraft.equipment_type]);

  const saveYardCount = async () => {
    const quantity = Number.parseInt(yardDraft.quantity, 10);
    if (!yardDraft.equipment_type.trim()) {
      Alert.alert("Type required", "Enter the bracing or scaffolding type you counted.");
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      Alert.alert("Invalid quantity", "Enter a whole number of zero or more.");
      return;
    }
    setYardSaving(true);
    try {
      await api<InventoryCount>("/yard-counts", {
        method: "POST",
        body: JSON.stringify({ ...yardDraft, equipment_id: yardDraft.equipment_id || null, quantity }),
      });
      setAddingBracing(false);
      setYardDraft({ equipment_id: "", equipment_type: "", quantity: "", condition: "good", yard_location: "Yard", notes: "" });
      equipmentRes.onRefresh();
      countsRes.onRefresh();
    } catch (error: unknown) {
      Alert.alert("Yard count failed", messageFor(error));
    } finally {
      setYardSaving(false);
    }
  };

  // Recording a physical count is the field-work half of this screen (an
  // actual walk of the yard) — queues offline. Reconciling is a desk
  // decision requiring a written reason and stays online-only (see
  // RequiresOnline wrapping it below).
  const submitCount = () => {
    if (!selectedEquipment) {
      Alert.alert("Select equipment", "Choose an equipment item before recording a count.");
      return;
    }
    const quantity = Number.parseInt(countedQty, 10);
    if (!Number.isInteger(quantity) || quantity < 0) {
      Alert.alert("Invalid count", "Enter a whole number of zero or more.");
      return;
    }
    const expected = selectedEquipment.available;
    const created = mutate<InventoryCount>({
      kind: "create",
      entityType: "inventory_counts",
      path: `/equipment/${selectedEquipment.id}/count`,
      method: "POST",
      body: { counted_qty: quantity },
      optimisticDoc: (tempId) => ({
        id: tempId,
        equipment_id: selectedEquipment.id,
        equipment_name: selectedEquipment.name,
        counted_qty: quantity,
        expected_qty: expected,
        variance: quantity - expected,
        status: "pending",
        reason: "",
        counted_by: "",
        counted_at: new Date().toISOString(),
        reconciled_by: null,
        reconciled_at: null,
      }),
    });
    if (created) setCountResult(created);
    setCountedQty("");
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
      await api<InventoryCount>(`/inventory-counts/${selectedCount.id}/reconcile`, {
        method: "POST",
        body: JSON.stringify({ reason: cleanReason }),
      });
      countsRes.onRefresh();
      equipmentRes.onRefresh();
      setReason("");
    } catch (error: unknown) {
      Alert.alert("Reconciliation failed", messageFor(error));
    } finally {
      setReconciling(false);
    }
  };

  const openCount = (count: InventoryCount) => {
    setSelectedCountId(count.id);
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
    <Screen title="Yard Count" subtitle={`${yardEquipment.reduce((sum, item) => sum + item.available, 0)} units physically available in the yard`} back scroll={!isShellWide} onRefresh={onRefresh} refreshing={refreshing} testID="inventory-counts-screen">
      <View style={[styles.workspace, !isShellWide && styles.mobileWorkspace]}>
        {canEdit ? (
        <Card style={[styles.countPanel, !isShellWide && styles.countPanelMobile]} testID="physical-count-form">
          <SectionLabel>AUTHORITATIVE PHYSICAL COUNT</SectionLabel>
          <RequiresOnline>
            <TouchableOpacity onPress={() => setAddingBracing(true)} style={styles.addBracingButton} testID="add-bracing-yard-count" accessibilityRole="button">
              <Text style={styles.addBracingPlus}>+</Text><Text style={styles.addBracingText}>Add Bracing</Text>
            </TouchableOpacity>
          </RequiresOnline>
          <Text style={styles.authoritativeHelp}>Sets what is physically at a yard location. Equipment on customer jobs or moving through dispatch stays untouched.</Text>
          <View style={styles.yardSnapshot} testID="yard-count-snapshot">
            {yardEquipment.slice(0, 10).map((item) => <View key={item.id} style={styles.snapshotRow}><View style={{ flex: 1 }}><Text style={styles.equipmentName}>{item.name}</Text><Text style={styles.tableMuted}>{item.location || "Yard"} · {item.condition || "good"}</Text></View><Mono style={styles.snapshotQty}>{item.available}</Mono></View>)}
          </View>
          <SectionLabel>VARIANCE CHECK</SectionLabel>
          <Text style={styles.panelTitle}>Select equipment</Text>
          <SearchInput value={equipmentSearch} onChangeText={setEquipmentSearch} placeholder="Search QR code or equipment…" testID="count-equipment-search" style={{ marginTop: spacing.sm }} />
          <View style={styles.equipmentResults}>
            {equipmentMatches.map((item) => {
              const active = item.id === selectedEquipmentId;
              return (
                <TouchableOpacity key={item.id} onPress={() => setSelectedEquipmentId(item.id)} style={[styles.equipmentRow, active && styles.equipmentRowActive]} testID={`count-equipment-${item.sku}`}>
                  <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.equipmentName} numberOfLines={1}>{item.name}</Text><Mono style={styles.equipmentSku}>{equipmentIdentifier(item)}</Mono></View>
                  <View style={{ alignItems: "flex-end" }}><Mono style={styles.availableNumber}>{item.available}</Mono><Text style={styles.availableLabel}>expected</Text></View>
                </TouchableOpacity>
              );
            })}
          </View>
          {selectedEquipment ? (
            <View style={styles.countEntry}>
              <View style={{ flex: 1 }}><Input label={`Physical count · ${equipmentIdentifier(selectedEquipment)}`} value={countedQty} onChangeText={(value) => setCountedQty(value.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono testID="physical-count-qty" /></View>
              <Button title="Record Count" onPress={submitCount} fullWidth={false} style={styles.recordButton} testID="record-count" />
            </View>
          ) : null}
          {countResult ? (
            <View style={[styles.resultSummary, countResult.variance === 0 ? styles.resultMatch : styles.resultVariance]} testID="count-result-summary">
              <Text style={styles.resultTitle}>{countResult.variance === 0 ? "Count matches" : "Variance recorded"}</Text>
              <Row style={{ gap: spacing.lg, marginTop: 6 }}><Text style={styles.resultMetric}>Expected <Mono>{countResult.expected_qty}</Mono></Text><Text style={styles.resultMetric}>Counted <Mono>{countResult.counted_qty}</Mono></Text><Text style={styles.resultMetric}>Variance <Mono>{countResult.variance > 0 ? "+" : ""}{countResult.variance}</Mono></Text></Row>
            </View>
          ) : null}
        </Card>
        ) : null}

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

      <DetailDrawer visible={!!selectedCount} title={selectedCount?.equipment_name || "Count detail"} subtitle={selectedCount ? `Counted ${shortDate(selectedCount.counted_at)}` : undefined} onClose={() => { setSelectedCountId(null); setReason(""); }} testID="reconciliation-drawer">
        {selectedCount ? (
          <View>
            <View style={styles.drawerMetrics}><CountMetric label="Expected" value={selectedCount.expected_qty} /><CountMetric label="Physical" value={selectedCount.counted_qty} /><CountMetric label="Variance" value={selectedCount.variance} signed /></View>
            <View style={styles.drawerMeta}><Text style={styles.tableMuted}>Counted by</Text><Text style={styles.tableName}>{selectedCount.counted_by || "Unknown"}</Text></View>
            {selectedCount.status === "pending" ? (
              canEdit ? <View style={{ marginTop: spacing.lg }}><Input label="Reconciliation reason (required)" value={reason} onChangeText={setReason} placeholder="Explain the variance and corrective action…" multiline style={styles.reasonInput} testID="reconciliation-reason" /><Button title="Reconcile Variance" onPress={reconcile} loading={reconciling} disabled={!reason.trim()} testID="reconcile-count" /></View> : null
            ) : (
              <View style={styles.reconciledSummary}><StatusBadge label="Reconciled" tone="success" /><Text style={[styles.tableName, { marginTop: spacing.sm }]}>{selectedCount.reason}</Text><Text style={[styles.tableMuted, { marginTop: 4 }]}>By {selectedCount.reconciled_by || "Unknown"}</Text></View>
            )}
          </View>
        ) : null}
      </DetailDrawer>

      <Modal visible={addingBracing} animationType="slide" onRequestClose={() => setAddingBracing(false)}>
        <Screen title="Add Bracing" subtitle="Authoritative yard count" back rightAction={{ icon: "close", onPress: () => setAddingBracing(false), testID: "close-add-bracing" }} testID="add-bracing-screen">
          <Input label="Type" value={yardDraft.equipment_type} onChangeText={(equipment_type) => setYardDraft((draft) => ({ ...draft, equipment_id: "", equipment_type }))} placeholder="10 ft steel stiffback, turnbuckle…" testID="yard-count-type" />
          <Text style={styles.tableMuted}>Select an existing type, or leave it as a new name to add a newly counted type.</Text>
          <View style={styles.equipmentResults}>
            {bracingMatches.map((item) => <TouchableOpacity key={item.id} onPress={() => setYardDraft((draft) => ({ ...draft, equipment_id: item.id, equipment_type: item.name, condition: item.condition || draft.condition, yard_location: item.location || draft.yard_location }))} style={[styles.equipmentRow, yardDraft.equipment_id === item.id && styles.equipmentRowActive]} testID={`yard-count-existing-${item.sku}`}><View style={{ flex: 1 }}><Text style={styles.equipmentName}>{item.name}</Text><Text style={styles.tableMuted}>{item.location || "Yard"}</Text></View><Mono>{item.available}</Mono></TouchableOpacity>)}
          </View>
          <Input label="Quantity" value={yardDraft.quantity} onChangeText={(quantity) => setYardDraft((draft) => ({ ...draft, quantity: quantity.replace(/[^0-9]/g, "") }))} keyboardType="number-pad" mono testID="yard-count-quantity" />
          <SectionLabel>Condition</SectionLabel>
          <Row style={{ gap: spacing.sm, flexWrap: "wrap", marginBottom: spacing.md }}>
            {(["good", "fair", "poor", "broken"] as const).map((conditionValue) => <TouchableOpacity key={conditionValue} onPress={() => setYardDraft((draft) => ({ ...draft, condition: conditionValue }))} style={[styles.conditionChip, yardDraft.condition === conditionValue && styles.conditionChipActive]} testID={`yard-count-condition-${conditionValue}`}><Text style={[styles.conditionText, yardDraft.condition === conditionValue && styles.conditionTextActive]}>{conditionValue}</Text></TouchableOpacity>)}
          </Row>
          <Input label="Yard Location" value={yardDraft.yard_location} onChangeText={(yard_location) => setYardDraft((draft) => ({ ...draft, yard_location }))} placeholder="Main Yard, North Rack…" testID="yard-count-location" />
          <Input label="Notes" value={yardDraft.notes} onChangeText={(notes) => setYardDraft((draft) => ({ ...draft, notes }))} multiline placeholder="Stack, bundle, count method, exceptions…" testID="yard-count-notes" />
          <Button title="Save Authoritative Count" onPress={saveYardCount} loading={yardSaving} testID="save-yard-count" />
        </Screen>
      </Modal>
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
  addBracingButton: { minHeight: 62, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, marginBottom: spacing.sm, borderRadius: radii.md, backgroundColor: colors.primary },
  addBracingPlus: { color: colors.inverse, fontSize: 30, lineHeight: 32, fontWeight: "500" },
  addBracingText: { color: colors.inverse, fontSize: 18, fontWeight: "800" },
  authoritativeHelp: { ...typo.bodySmall, marginBottom: spacing.md },
  yardSnapshot: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", marginBottom: spacing.lg },
  snapshotRow: { minHeight: 46, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  snapshotQty: { fontSize: 18, fontWeight: "800", color: colors.primary },
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
  conditionChip: { minHeight: 36, paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  conditionChipActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  conditionText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary, textTransform: "capitalize" },
  conditionTextActive: { color: colors.primary },
});

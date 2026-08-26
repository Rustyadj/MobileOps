// Dashboard "WHAT'S NEXT" panel — system dispatch movements plus concise,
// operator-entered reminders that do not mutate inventory or dispatch state.
import React, { useMemo, useState } from "react";
import { Alert, Modal, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { Button, Input } from "@/src/components/ui";
import { colors, spacing, radii } from "@/src/theme";

export type DispatchLine = { equipment_id: string; sku: string; name: string; qty: number };
export type NextMovement = {
  id: string;
  direction: "outbound" | "inbound";
  status: string;
  scheduled_date?: string | null;
  customer_name: string;
  job_site: string;
  driver_name: string;
  lines: DispatchLine[];
};

export type ManualNextKind = "delivery" | "important" | "order" | "note";
export type ManualNextItem = {
  id: string;
  kind: ManualNextKind;
  title: string;
  details: string;
  due_date?: string | null;
  status: "open" | "done";
  created_by: string;
  created_at: string;
};
export type ManualNextInput = Pick<ManualNextItem, "kind" | "title" | "details" | "due_date">;

const MANUAL_KINDS: { key: ManualNextKind; label: string; icon: keyof typeof Ionicons.glyphMap; color: string; bg: string }[] = [
  { key: "delivery", label: "Delivery", icon: "cube-outline", color: colors.primary, bg: colors.primarySoft },
  { key: "important", label: "Important", icon: "alert-circle-outline", color: colors.error, bg: colors.errorSoft },
  { key: "order", label: "Order", icon: "cart-outline", color: colors.warning, bg: colors.warningSoft },
  { key: "note", label: "Note", icon: "document-text-outline", color: colors.info, bg: colors.bgTint },
];

const equipmentSummary = (lines: DispatchLine[]) => {
  if (lines.length === 0) return "No equipment";
  if (lines.length === 1) return `${lines[0].qty} ${lines[0].name}`;
  const total = lines.reduce((sum, line) => sum + line.qty, 0);
  return `${total} units · ${lines.length} lines`;
};

const timeLabel = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Anytime";

export const WhatsNext: React.FC<{
  items: NextMovement[];
  manualItems: ManualNextItem[];
  canEdit: boolean;
  compact?: boolean;
  onPressItem: (item: NextMovement) => void;
  onViewAll: () => void;
  onCreateManual: (input: ManualNextInput) => Promise<void>;
  onCompleteManual: (item: ManualNextItem) => Promise<void>;
}> = ({ items, manualItems, canEdit, compact = false, onPressItem, onViewAll, onCreateManual, onCompleteManual }) => {
  const { width } = useWindowDimensions();
  const isCompact = compact || width < 480;
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<ManualNextKind>("important");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [dueDate, setDueDate] = useState("");

  const sortedManual = useMemo(() => [...manualItems].sort((a, b) => {
    const aTime = a.due_date ? +new Date(a.due_date) : Number.MAX_SAFE_INTEGER;
    const bTime = b.due_date ? +new Date(b.due_date) : Number.MAX_SAFE_INTEGER;
    return aTime - bTime || +new Date(b.created_at) - +new Date(a.created_at);
  }), [manualItems]);
  const visibleManual = sortedManual.slice(0, 6);
  const visibleMovements = items.slice(0, Math.max(0, 6 - visibleManual.length));
  const hasRows = visibleManual.length + visibleMovements.length > 0;

  const openCreate = () => {
    setKind("important");
    setTitle("");
    setDetails("");
    setDueDate("");
    setCreating(true);
  };

  const save = async () => {
    if (!title.trim()) {
      Alert.alert("Title required", "Enter what needs to happen next.");
      return;
    }
    const parsedDueDate = dueDate ? new Date(`${dueDate}T12:00:00`) : null;
    if (parsedDueDate && Number.isNaN(parsedDueDate.getTime())) {
      Alert.alert("Invalid date", "Use yyyy-mm-dd or leave the date blank.");
      return;
    }
    setBusy(true);
    try {
      await onCreateManual({
        kind,
        title: title.trim(),
        details: details.trim(),
        due_date: parsedDueDate?.toISOString() || null,
      });
      setCreating(false);
    } catch (error: any) {
      Alert.alert("Item not added", error?.message || "Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel} testID="dashboard-whats-next">
      <View style={styles.header}>
        <Text style={styles.title}>WHAT&apos;S NEXT</Text>
        <View style={styles.headerActions}>
          {canEdit ? (
            <TouchableOpacity onPress={openCreate} style={styles.addButton} testID="whats-next-add">
              <Ionicons name="add" size={14} color={colors.primary} />
              <Text style={styles.viewAll}>Add item</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={onViewAll} testID="whats-next-view-all"><Text style={styles.viewAll}>Open Dispatch</Text></TouchableOpacity>
        </View>
      </View>
      {!hasRows ? (
        <View style={styles.empty}>
          <Ionicons name="checkmark-circle-outline" size={20} color={colors.success} />
          <Text style={styles.emptyText}>Nothing scheduled and no manual items added.</Text>
        </View>
      ) : (
        <>
          {visibleManual.map((item) => {
            const config = MANUAL_KINDS.find((entry) => entry.key === item.kind) || MANUAL_KINDS[1];
            return (
              <View key={item.id} style={[styles.row, isCompact && styles.rowCompact]} testID={`whats-next-manual-${item.id}`}>
                <View style={[styles.timeCol, isCompact && styles.timeColCompact]}><Text style={styles.timeText}>{timeLabel(item.due_date)}</Text></View>
                <View style={[styles.kindTag, isCompact && styles.kindTagCompact, { backgroundColor: config.bg }]}>
                  <Ionicons name={config.icon} size={12} color={config.color} />
                  <Text style={[styles.dirText, { color: config.color }]}>{config.label.toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.rowSubtitle} numberOfLines={1}>{item.details || `Added by ${item.created_by || "operator"}`}</Text>
                </View>
                {canEdit ? (
                  <TouchableOpacity
                    onPress={() => onCompleteManual(item).catch((error) => Alert.alert("Item not completed", error?.message || "Try again."))}
                    style={styles.completeButton}
                    accessibilityLabel={`Complete ${item.title}`}
                    testID={`whats-next-complete-${item.id}`}
                  >
                    <Ionicons name="checkmark" size={17} color={colors.success} />
                  </TouchableOpacity>
                ) : <StatusBadge label="Open" tone="info" />}
              </View>
            );
          })}
          {visibleMovements.map((item) => (
            <TouchableOpacity key={item.id} style={[styles.row, isCompact && styles.rowCompact]} onPress={() => onPressItem(item)} activeOpacity={0.6} testID={`whats-next-${item.id}`}>
              <View style={[styles.timeCol, isCompact && styles.timeColCompact]}><Text style={styles.timeText}>{timeLabel(item.scheduled_date)}</Text></View>
              <View style={[styles.kindTag, isCompact && styles.kindTagCompact, item.direction === "outbound" ? styles.dirTagOut : styles.dirTagIn]}>
                <Ionicons name={item.direction === "outbound" ? "arrow-up-outline" : "arrow-down-outline"} size={12} color={item.direction === "outbound" ? colors.primary : colors.accent} />
                <Text style={[styles.dirText, { color: item.direction === "outbound" ? colors.primary : colors.accent }]}>{item.direction === "outbound" ? "OUTBOUND" : "INBOUND"}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.customer_name}</Text>
                <Text style={styles.rowSubtitle} numberOfLines={1}>{equipmentSummary(item.lines)}{item.driver_name ? ` · ${item.driver_name}` : ""}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </>
      )}

      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="whats-next-create-modal">
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Add to What&apos;s Next</Text>
                <Text style={styles.modalSubtitle}>Keep an operational reminder visible on the dashboard.</Text>
              </View>
              <TouchableOpacity onPress={() => setCreating(false)} style={styles.closeButton} testID="whats-next-create-close">
                <Ionicons name="close" size={20} color={colors.inkSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.fieldLabel}>TYPE</Text>
            <View style={styles.kindChoices}>
              {MANUAL_KINDS.map((entry) => (
                <TouchableOpacity
                  key={entry.key}
                  onPress={() => setKind(entry.key)}
                  style={[styles.kindChoice, kind === entry.key && { borderColor: entry.color, backgroundColor: entry.bg }]}
                  testID={`whats-next-kind-${entry.key}`}
                >
                  <Ionicons name={entry.icon} size={15} color={kind === entry.key ? entry.color : colors.inkSecondary} />
                  <Text style={[styles.kindChoiceText, kind === entry.key && { color: entry.color }]}>{entry.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Input label="What needs to happen?" value={title} onChangeText={setTitle} placeholder="Example: Order 40 Reechcraft extensions" testID="whats-next-title" />
            <Input label="Details (optional)" value={details} onChangeText={setDetails} placeholder="Vendor, job, quantities, phone number…" multiline testID="whats-next-details" />
            <Input label="Due date (optional · yyyy-mm-dd)" value={dueDate} onChangeText={setDueDate} placeholder="2026-08-28" mono autoCapitalize="none" testID="whats-next-due-date" />
            <View style={styles.modalActions}>
              <View style={{ flex: 1 }}><Button title="Cancel" variant="outline" onPress={() => setCreating(false)} testID="whats-next-create-cancel" /></View>
              <View style={{ flex: 1 }}><Button title="Add item" onPress={save} loading={busy} testID="whats-next-create-save" /></View>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", marginBottom: 12 },
  header: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  addButton: { flexDirection: "row", alignItems: "center", gap: 3, minHeight: 32 },
  title: { fontSize: 11, fontWeight: "800", color: colors.inkSecondary, letterSpacing: 0.5 },
  viewAll: { fontSize: 11.5, fontWeight: "700", color: colors.primary },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 9, minHeight: 52, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowCompact: { gap: 6 },
  timeCol: { width: 78 },
  timeColCompact: { width: 52 },
  timeText: { fontSize: 12, fontWeight: "700", color: colors.ink },
  kindTag: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 3, borderRadius: radii.sm, width: 92, justifyContent: "center" },
  kindTagCompact: { width: 84, paddingHorizontal: 4 },
  dirTagOut: { backgroundColor: colors.primarySoft },
  dirTagIn: { backgroundColor: colors.accentSoft },
  dirText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.3 },
  rowTitle: { fontSize: 12.5, fontWeight: "700", color: colors.ink },
  rowSubtitle: { fontSize: 11, color: colors.inkMuted, marginTop: 2 },
  completeButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 16, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft },
  empty: { alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, padding: spacing.lg },
  emptyText: { fontSize: 12, color: colors.inkSecondary },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.42)", alignItems: "center", justifyContent: "center", padding: spacing.md },
  modalCard: { width: "100%", maxWidth: 560, maxHeight: "92%", padding: spacing.lg, borderRadius: radii.xl, backgroundColor: colors.bg },
  modalHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, marginBottom: spacing.lg },
  modalTitle: { fontSize: 20, fontWeight: "700", color: colors.ink },
  modalSubtitle: { fontSize: 12.5, color: colors.inkSecondary, marginTop: 4 },
  closeButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md },
  fieldLabel: { fontSize: 10.5, fontWeight: "800", color: colors.inkMuted, letterSpacing: 0.6, marginBottom: spacing.sm },
  kindChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md },
  kindChoice: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 36, paddingHorizontal: 10, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgMuted },
  kindChoiceText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
  modalActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
});

// Unified dashboard timeline: live movements, rental returns, dated shop work,
// and operator reminders. Source records remain authoritative in their modules.
import React, { useMemo, useState } from "react";
import { Alert, Modal, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { Button, Input } from "@/src/components/ui";
import { colors, spacing, radii } from "@/src/theme";

export type DispatchLine = { equipment_id: string; sku: string; name: string; qty: number };
export type NextMovement = { id: string; direction: "outbound" | "inbound"; status: string; scheduled_date?: string | null; customer_name: string; job_site: string; driver_name: string; notes?: string; lines: DispatchLine[] };
export type UpcomingRental = { id: string; customer_name: string; job_site: string; due_date?: string | null; status: string; notes?: string };
export type UpcomingShopTask = { id: string; title: string; assignee: string; due_date?: string | null; status: string; notes?: string };
export type ManualNextKind = "delivery" | "important" | "order" | "note";
export type ManualNextItem = { id: string; kind: ManualNextKind; title: string; details: string; due_date?: string | null; status: "open" | "done"; created_by: string; created_at: string };
export type ManualNextInput = Pick<ManualNextItem, "kind" | "title" | "details" | "due_date">;

type UpcomingRow = { key: string; source: "dispatch" | "rental" | "task" | "manual"; sourceItem: any; customer: string; jobsite: string; action: string; date?: string | null; assigned: string; status: string; notes: string; tone: "primary" | "accent" | "warning" | "error" };

const MANUAL_KINDS: { key: ManualNextKind; label: string; icon: keyof typeof Ionicons.glyphMap; color: string; bg: string }[] = [
  { key: "delivery", label: "Delivery", icon: "cube-outline", color: colors.primary, bg: colors.primarySoft },
  { key: "important", label: "Important", icon: "alert-circle-outline", color: colors.error, bg: colors.errorSoft },
  { key: "order", label: "Order", icon: "cart-outline", color: colors.warning, bg: colors.warningSoft },
  { key: "note", label: "Note", icon: "document-text-outline", color: colors.info, bg: colors.bgTint },
];

const timeLabel = (value?: string | null) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Anytime";
const pretty = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const toneStyle = (tone: UpcomingRow["tone"]) => tone === "primary" ? styles.primaryTag : tone === "accent" ? styles.accentTag : tone === "error" ? styles.errorTag : styles.warningTag;
const toneColor = (tone: UpcomingRow["tone"]) => tone === "primary" ? colors.primary : tone === "accent" ? colors.accent : tone === "error" ? colors.error : colors.warning;

export const Upcoming: React.FC<{
  dispatches: NextMovement[]; rentals: UpcomingRental[]; shopTasks: UpcomingShopTask[]; manualItems: ManualNextItem[]; canEdit: boolean; compact?: boolean;
  onPressDispatch: (item: NextMovement) => void; onPressRental: (item: UpcomingRental) => void; onPressTask: (item: UpcomingShopTask) => void; onViewAll: () => void;
  onCreateManual: (input: ManualNextInput) => Promise<void>; onCompleteManual: (item: ManualNextItem) => Promise<void>;
}> = ({ dispatches, rentals, shopTasks, manualItems, canEdit, compact = false, onPressDispatch, onPressRental, onPressTask, onViewAll, onCreateManual, onCompleteManual }) => {
  const { width } = useWindowDimensions();
  const isCompact = compact || width < 480;
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<ManualNextKind>("important");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [dueDate, setDueDate] = useState("");

  const rows = useMemo<UpcomingRow[]>(() => [
    ...dispatches.map((item): UpcomingRow => {
      const prep = item.direction === "outbound" && ["scheduled", "staging"].includes(item.status);
      const action = prep ? "Prep deadline" : item.direction === "outbound" ? "Delivery" : ["scheduled", "ready_for_pickup"].includes(item.status) ? "Pickup" : "Return";
      return { key: `dispatch-${item.id}`, source: "dispatch", sourceItem: item, customer: item.customer_name || "Dispatch", jobsite: item.job_site || "—", action, date: item.scheduled_date, assigned: item.driver_name || "Unassigned", status: item.status, notes: item.notes || "", tone: item.direction === "outbound" ? "primary" : "accent" };
    }),
    ...rentals.filter((item) => item.due_date).map((item): UpcomingRow => ({ key: `rental-${item.id}`, source: "rental", sourceItem: item, customer: item.customer_name || "Rental", jobsite: item.job_site || "—", action: "Rental return", date: item.due_date, assigned: "Rental team", status: item.status, notes: item.notes || "", tone: "accent" })),
    ...shopTasks.filter((item) => item.due_date && item.status !== "done").map((item): UpcomingRow => ({ key: `task-${item.id}`, source: "task", sourceItem: item, customer: item.title, jobsite: "Shop", action: "Shop task", date: item.due_date, assigned: item.assignee || "Unassigned", status: item.status, notes: item.notes || "", tone: item.status === "blocked" ? "error" : "warning" })),
    ...manualItems.map((item): UpcomingRow => ({ key: `manual-${item.id}`, source: "manual", sourceItem: item, customer: item.title, jobsite: "Team", action: MANUAL_KINDS.find((entry) => entry.key === item.kind)?.label || "Reminder", date: item.due_date, assigned: item.created_by || "Operator", status: item.status, notes: item.details || "", tone: item.kind === "important" ? "error" : item.kind === "delivery" ? "primary" : "warning" })),
  ].sort((a, b) => {
    const left = a.date ? +new Date(a.date) : Number.MAX_SAFE_INTEGER;
    const right = b.date ? +new Date(b.date) : Number.MAX_SAFE_INTEGER;
    return left - right || a.key.localeCompare(b.key);
  }).slice(0, compact ? 5 : 7), [compact, dispatches, manualItems, rentals, shopTasks]);

  const openCreate = () => { setKind("important"); setTitle(""); setDetails(""); setDueDate(""); setCreating(true); };
  const save = async () => {
    if (!title.trim()) return Alert.alert("Title required", "Enter what needs to happen next.");
    const parsedDueDate = dueDate ? new Date(`${dueDate}T12:00:00`) : null;
    if (parsedDueDate && Number.isNaN(parsedDueDate.getTime())) return Alert.alert("Invalid date", "Use yyyy-mm-dd or leave the date blank.");
    setBusy(true);
    try { await onCreateManual({ kind, title: title.trim(), details: details.trim(), due_date: parsedDueDate?.toISOString() || null }); setCreating(false); }
    catch (error: any) { Alert.alert("Item not added", error?.message || "Try again."); }
    finally { setBusy(false); }
  };
  const openRow = (row: UpcomingRow) => {
    if (row.source === "dispatch") onPressDispatch(row.sourceItem);
    if (row.source === "rental") onPressRental(row.sourceItem);
    if (row.source === "task") onPressTask(row.sourceItem);
  };

  return <View style={styles.panel} testID="dashboard-upcoming">
    <View style={styles.header}><Text style={styles.title}>UPCOMING</Text><View style={styles.headerActions}>
      {canEdit ? <TouchableOpacity onPress={openCreate} style={styles.addButton} testID="upcoming-add"><Ionicons name="add" size={14} color={colors.primary} /><Text style={styles.viewAll}>Add item</Text></TouchableOpacity> : null}
      <TouchableOpacity onPress={onViewAll} testID="upcoming-view-all"><Text style={styles.viewAll}>Open Dispatch</Text></TouchableOpacity>
    </View></View>
    {!rows.length ? <View style={styles.empty}><Ionicons name="checkmark-circle-outline" size={20} color={colors.success} /><Text style={styles.emptyText}>Nothing due or scheduled.</Text></View> : rows.map((row) => <TouchableOpacity key={row.key} disabled={row.source === "manual"} onPress={() => openRow(row)} style={[styles.row, isCompact && styles.rowCompact]} testID={`upcoming-${row.key}`}>
      <View style={[styles.timeCol, isCompact && styles.timeColCompact]}><Text style={styles.timeText}>{timeLabel(row.date)}</Text></View>
      <View style={[styles.kindTag, isCompact && styles.kindTagCompact, toneStyle(row.tone)]}><Text style={[styles.dirText, { color: toneColor(row.tone) }]} numberOfLines={1}>{row.action.toUpperCase()}</Text></View>
      <View style={styles.rowMain}><Text style={styles.rowTitle} numberOfLines={1}>{row.customer}</Text><Text style={styles.rowSubtitle} numberOfLines={1}>{row.jobsite} · {row.assigned}{row.notes ? ` · ${row.notes}` : ""}</Text></View>
      {row.source === "manual" && canEdit ? <TouchableOpacity onPress={() => onCompleteManual(row.sourceItem).catch((error) => Alert.alert("Item not completed", error?.message || "Try again."))} style={styles.completeButton}><Ionicons name="checkmark" size={17} color={colors.success} /></TouchableOpacity> : <StatusBadge label={pretty(row.status)} tone={row.status === "blocked" ? "error" : row.status === "done" || row.status === "completed" ? "success" : "info"} />}
    </TouchableOpacity>)}
    <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}><View style={styles.modalBackdrop}><View style={styles.modalCard} testID="upcoming-create-modal">
      <View style={styles.modalHeader}><View style={{ flex: 1 }}><Text style={styles.modalTitle}>Add to Upcoming</Text><Text style={styles.modalSubtitle}>Keep an operational reminder visible on the dashboard.</Text></View><TouchableOpacity onPress={() => setCreating(false)} style={styles.closeButton}><Ionicons name="close" size={20} color={colors.inkSecondary} /></TouchableOpacity></View>
      <Text style={styles.fieldLabel}>TYPE</Text><View style={styles.kindChoices}>{MANUAL_KINDS.map((entry) => <TouchableOpacity key={entry.key} onPress={() => setKind(entry.key)} style={[styles.kindChoice, kind === entry.key && { borderColor: entry.color, backgroundColor: entry.bg }]}><Ionicons name={entry.icon} size={15} color={kind === entry.key ? entry.color : colors.inkSecondary} /><Text style={[styles.kindChoiceText, kind === entry.key && { color: entry.color }]}>{entry.label}</Text></TouchableOpacity>)}</View>
      <Input label="What needs to happen?" value={title} onChangeText={setTitle} placeholder="Example: Order 40 Reechcraft extensions" testID="upcoming-title" /><Input label="Notes (optional)" value={details} onChangeText={setDetails} placeholder="Customer, site, quantities, or contact details…" multiline testID="upcoming-details" /><Input label="Due date (optional · yyyy-mm-dd)" value={dueDate} onChangeText={setDueDate} placeholder="2026-08-30" mono autoCapitalize="none" testID="upcoming-due-date" />
      <View style={styles.modalActions}><View style={{ flex: 1 }}><Button title="Cancel" variant="outline" onPress={() => setCreating(false)} /></View><View style={{ flex: 1 }}><Button title="Add item" onPress={save} loading={busy} testID="upcoming-create-save" /></View></View>
    </View></View></Modal>
  </View>;
};

export const WhatsNext = Upcoming;

const styles = StyleSheet.create({
  panel: { flex: 1, minWidth: 0, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  header: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border }, headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.md }, addButton: { flexDirection: "row", alignItems: "center", gap: 3, minHeight: 32 },
  title: { fontSize: 11, fontWeight: "800", color: colors.inkSecondary, letterSpacing: 0.5 }, viewAll: { fontSize: 11.5, fontWeight: "700", color: colors.primary },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8, minHeight: 50, borderBottomWidth: 1, borderBottomColor: colors.border }, rowCompact: { gap: 5 }, timeCol: { width: 100 }, timeColCompact: { width: 72 }, timeText: { fontSize: 11, fontWeight: "700", color: colors.ink },
  kindTag: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: radii.sm, width: 92, alignItems: "center" }, kindTagCompact: { width: 82 }, primaryTag: { backgroundColor: colors.primarySoft }, accentTag: { backgroundColor: colors.accentSoft }, warningTag: { backgroundColor: colors.warningSoft }, errorTag: { backgroundColor: colors.errorSoft }, dirText: { fontSize: 9.5, fontWeight: "800", letterSpacing: 0.2 },
  rowMain: { flex: 1, minWidth: 0 }, rowTitle: { fontSize: 12.5, fontWeight: "700", color: colors.ink }, rowSubtitle: { fontSize: 10.5, color: colors.inkMuted, marginTop: 2 }, completeButton: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: 15, borderWidth: 1, borderColor: colors.success, backgroundColor: colors.successSoft },
  empty: { alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, padding: spacing.lg }, emptyText: { fontSize: 12, color: colors.inkSecondary },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.42)", alignItems: "center", justifyContent: "center", padding: spacing.md }, modalCard: { width: "100%", maxWidth: 560, maxHeight: "92%", padding: spacing.lg, borderRadius: radii.xl, backgroundColor: colors.bg }, modalHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, marginBottom: spacing.lg }, modalTitle: { fontSize: 20, fontWeight: "700", color: colors.ink }, modalSubtitle: { fontSize: 12.5, color: colors.inkSecondary, marginTop: 4 }, closeButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md },
  fieldLabel: { fontSize: 10.5, fontWeight: "800", color: colors.inkMuted, letterSpacing: 0.6, marginBottom: spacing.sm }, kindChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md }, kindChoice: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 36, paddingHorizontal: 10, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgMuted }, kindChoiceText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary }, modalActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
});

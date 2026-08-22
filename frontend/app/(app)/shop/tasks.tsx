// Shop Tasks board — the day-to-day work queue for the shop: repairs,
// staging/loadout for upcoming jobs, and general to-dos. First-class,
// not buried inside Maintenance. Tasks link back to the equipment/rental/
// booking that generated them and, for repair tasks, completing the task
// moves the underlying units back to available in the inventory ledger.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, Alert } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { FilterChips } from "@/src/components/data/FilterBar";
import { SearchInput } from "@/src/components/data/SearchInput";
import { StatusBadge, StatusTone } from "@/src/components/data/StatusBadge";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type ChecklistItem = { text: string; done: boolean };
type ShopTask = {
  id: string; title: string; description: string; task_type: string;
  status: string; priority: string; assignee: string; due_date: string | null;
  notes: string; checklist: ChecklistItem[]; qty: number;
  related_rental_id: string | null; related_booking_id: string | null; related_equipment_id: string | null;
  created_by: string; completed_by: string; completed_at: string | null; created_at: string;
};
type Equipment = { id: string; sku: string; name: string };
type Rental = { id: string; customer_name: string; job_site: string };
type Booking = { id: string; customer_name: string; job_site: string };

const STATUSES = [
  { key: "all", label: "All" },
  { key: "to_do", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
];
const TYPES = [
  { key: "all", label: "All types" },
  { key: "general", label: "General" },
  { key: "repair", label: "Repair" },
  { key: "staging", label: "Staging" },
  { key: "inspection", label: "Inspection" },
];
const PRIORITIES = ["low", "normal", "high"];

const statusTone = (status: string): StatusTone =>
  status === "done" ? "success" : status === "blocked" ? "error" : status === "in_progress" ? "warning" : "neutral";
const priorityTone = (priority: string): StatusTone => priority === "high" ? "error" : priority === "low" ? "neutral" : "info";
const pretty = (v: string) => v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const shortDate = (v?: string | null) => v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";

const blank: Partial<ShopTask> = {
  title: "", description: "", task_type: "general", status: "to_do", priority: "normal",
  assignee: "", due_date: null, notes: "", checklist: [], qty: 0,
  related_rental_id: null, related_booking_id: null, related_equipment_id: null,
};

export default function ShopTasksScreen() {
  const { isShellWide } = useBreakpoint();
  const [tasks, setTasks] = useState<ShopTask[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [status, setStatus] = useState("all");
  const [taskType, setTaskType] = useState("all");
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<ShopTask | null>(null);
  const [editing, setEditing] = useState<Partial<ShopTask> | null>(null);
  const [deleting, setDeleting] = useState<ShopTask | null>(null);
  const [eqSearch, setEqSearch] = useState("");
  const [checklistDraft, setChecklistDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const [t, e, r, b] = await Promise.all([
        api<ShopTask[]>("/shop-tasks"), api<Equipment[]>("/equipment"),
        api<Rental[]>("/rentals"), api<Booking[]>("/bookings"),
      ]);
      setTasks(t); setEquipment(e); setRentals(r); setBookings(b);
      setSelected((cur) => cur ? t.find((x) => x.id === cur.id) || null : null);
    } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const eqById = useMemo(() => Object.fromEntries(equipment.map((e) => [e.id, e])), [equipment]);
  const rentalById = useMemo(() => Object.fromEntries(rentals.map((r) => [r.id, r])), [rentals]);
  const bookingById = useMemo(() => Object.fromEntries(bookings.map((b) => [b.id, b])), [bookings]);

  const relatedLabel = (t: ShopTask) => {
    if (t.related_equipment_id && eqById[t.related_equipment_id]) return eqById[t.related_equipment_id].name;
    if (t.related_rental_id && rentalById[t.related_rental_id]) return `Rental — ${rentalById[t.related_rental_id].customer_name}`;
    if (t.related_booking_id && bookingById[t.related_booking_id]) return `Booking — ${bookingById[t.related_booking_id].customer_name}`;
    return "—";
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tasks
      .filter((t) => status === "all" || t.status === status)
      .filter((t) => taskType === "all" || t.task_type === taskType)
      .filter((t) => !query || [t.title, t.assignee, t.notes].some((v) => v?.toLowerCase().includes(query)))
      .sort((a, b) => {
        const order: Record<string, number> = { to_do: 0, in_progress: 1, blocked: 2, done: 3 };
        const so = order[a.status] - order[b.status];
        if (so !== 0) return so;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [tasks, status, taskType, search]);

  const eqMatches = useMemo(() => {
    const q = eqSearch.trim().toLowerCase();
    if (!q) return equipment.slice(0, 6);
    return equipment.filter((e) => `${e.sku} ${e.name}`.toLowerCase().includes(q)).slice(0, 6);
  }, [equipment, eqSearch]);

  const save = async () => {
    if (!editing || !editing.title?.trim()) { Alert.alert("Title required", "Give the task a title."); return; }
    try {
      const body = {
        title: editing.title, description: editing.description || "", task_type: editing.task_type || "general",
        status: editing.status || "to_do", priority: editing.priority || "normal", assignee: editing.assignee || "",
        due_date: editing.due_date || null, notes: editing.notes || "", checklist: editing.checklist || [],
        qty: Number(editing.qty) || 0, related_rental_id: editing.related_rental_id || null,
        related_booking_id: editing.related_booking_id || null, related_equipment_id: editing.related_equipment_id || null,
      };
      if (editing.id) await api(`/shop-tasks/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/shop-tasks", { method: "POST", body: JSON.stringify(body) });
      setEditing(null); setSelected(null); load();
    } catch (e: any) { Alert.alert("Save failed", e.message); }
  };
  const setTaskStatus = async (task: ShopTask, next: string) => {
    try {
      const updated = await api<ShopTask>(`/shop-tasks/${task.id}/status`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      setTasks((cur) => cur.map((t) => t.id === updated.id ? updated : t));
      setSelected(updated);
    } catch (e: any) { Alert.alert("Status update failed", e.message); }
  };
  const toggleChecklistItem = async (task: ShopTask, idx: number) => {
    const checklist = task.checklist.map((item, i) => i === idx ? { ...item, done: !item.done } : item);
    try {
      const updated = await api<ShopTask>(`/shop-tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ ...task, checklist }) });
      setTasks((cur) => cur.map((t) => t.id === updated.id ? updated : t));
      setSelected(updated);
    } catch (e: any) { Alert.alert("Update failed", e.message); }
  };
  const del = async () => {
    if (!deleting) return;
    try { await api(`/shop-tasks/${deleting.id}`, { method: "DELETE" }); setDeleting(null); setSelected(null); load(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  const columns = useMemo<ColumnDef<ShopTask>[]>(() => [
    { key: "title", label: "Task", flex: 1.6, render: (t) => <Text style={typo.body} numberOfLines={1}>{t.title}</Text> },
    { key: "task_type", label: "Type", width: 90, render: (t) => pretty(t.task_type) },
    { key: "priority", label: "Priority", width: 84, render: (t) => <StatusBadge label={pretty(t.priority)} tone={priorityTone(t.priority)} /> },
    { key: "assignee", label: "Assignee", width: 110, render: (t) => t.assignee || "Unassigned" },
    { key: "related", label: "Related", flex: 1, render: (t) => relatedLabel(t) },
    { key: "due_date", label: "Due", width: 84, render: (t) => shortDate(t.due_date) },
    { key: "status", label: "Status", width: 100, render: (t) => <StatusBadge label={pretty(t.status)} tone={statusTone(t.status)} /> },
  ], [eqById, rentalById, bookingById]);

  return (
    <Screen title="Shop Tasks" subtitle={`${tasks.filter((t) => t.status !== "done").length} open`} back
      rightAction={{ icon: "add", onPress: () => setEditing({ ...blank }), testID: "add-task-btn" }}
      onRefresh={onRefresh} refreshing={refreshing} testID="shop-tasks-screen" scroll={!isShellWide}>
      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search tasks, assignee…" testID="task-search" style={{ flex: 1, maxWidth: 360 }} />
            <Button title="New Task" onPress={() => setEditing({ ...blank })} fullWidth={false} style={styles.toolbarButton} testID="add-task-btn-toolbar" />
          </PageToolbar>
          <View style={styles.filterStack}>
            <FilterChips options={STATUSES} value={status} onChange={setStatus} testIDPrefix="task-status" />
            <FilterChips options={TYPES} value={taskType} onChange={setTaskType} testIDPrefix="task-type" />
          </View>
          <View style={styles.tableWrap}>
            <DataTable columns={columns} rows={filtered} keyExtractor={(t) => t.id} rowTestID={(t) => `task-row-${t.id}`}
              onRowPress={setSelected} selectedId={selected?.id} emptyLabel="No shop tasks match these filters." />
          </View>
        </View>
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} style={{ marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg, marginBottom: spacing.sm }}>
            {STATUSES.map((s) => (
              <TouchableOpacity key={s.key} onPress={() => setStatus(s.key)} style={[styles.chip, status === s.key && styles.chipActive]} testID={`task-status-${s.key}`}>
                <Text style={[styles.chipText, status === s.key && { color: colors.inverse }]}>{s.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          {filtered.length === 0 ? <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No shop tasks in this view.</Text></Card> : filtered.map((t) => (
            <TouchableOpacity key={t.id} onPress={() => setSelected(t)} testID={`task-row-${t.id}`}>
              <Card style={{ marginBottom: spacing.sm }}>
                <Row style={{ gap: 8, alignItems: "flex-start" }}>
                  <View style={{ flex: 1 }}>
                    <H3>{t.title}</H3>
                    <Text style={[typo.label, { marginTop: 2 }]}>{pretty(t.task_type)} · {t.assignee || "Unassigned"} · Due {shortDate(t.due_date)}</Text>
                  </View>
                  <StatusBadge label={pretty(t.status)} tone={statusTone(t.status)} />
                </Row>
              </Card>
            </TouchableOpacity>
          ))}
        </>
      )}

      <DetailDrawer visible={!!selected} title={selected?.title || "Task"} subtitle={selected ? `${pretty(selected.task_type)} · ${pretty(selected.priority)} priority` : undefined}
        onClose={() => setSelected(null)} testID="task-detail-drawer"
        headerActions={selected ? <TouchableOpacity onPress={() => setEditing(selected)} style={styles.drawerEdit} testID="edit-task-btn"><Ionicons name="create-outline" size={18} color={colors.primary} /><Text style={styles.drawerEditText}>Edit</Text></TouchableOpacity> : null}>
        {selected ? <>
          <SectionLabel>Status</SectionLabel>
          <Row style={{ gap: spacing.xs, marginBottom: spacing.lg, flexWrap: "wrap" }}>
            {STATUSES.filter((s) => s.key !== "all").map((s) => (
              <TouchableOpacity key={s.key} onPress={() => setTaskStatus(selected, s.key)} style={[styles.statusChip, selected.status === s.key && styles.statusChipActive]} testID={`set-status-${s.key}`}>
                <Text style={[styles.statusChipText, selected.status === s.key && { color: colors.inverse }]}>{s.label}</Text>
              </TouchableOpacity>
            ))}
          </Row>

          <View style={styles.detailGrid}>
            <DetailStat label="Assignee" value={selected.assignee || "Unassigned"} />
            <DetailStat label="Due" value={shortDate(selected.due_date)} />
            <DetailStat label="Priority" value={pretty(selected.priority)} badge tone={priorityTone(selected.priority)} />
            <DetailStat label="Related" value={relatedLabel(selected)} />
          </View>

          {selected.description ? <><SectionLabel>Description</SectionLabel><Text style={[typo.body, styles.detailText]}>{selected.description}</Text></> : null}

          {selected.checklist.length ? <>
            <SectionLabel>Checklist</SectionLabel>
            {selected.checklist.map((item, idx) => (
              <TouchableOpacity key={idx} onPress={() => toggleChecklistItem(selected, idx)} style={styles.checklistRow} testID={`checklist-item-${idx}`}>
                <Ionicons name={item.done ? "checkbox" : "square-outline"} size={19} color={item.done ? colors.success : colors.inkMuted} />
                <Text style={[typo.body, { flex: 1 }, item.done && { textDecorationLine: "line-through", color: colors.inkMuted }]}>{item.text}</Text>
              </TouchableOpacity>
            ))}
          </> : null}

          {selected.notes ? <><SectionLabel>Notes</SectionLabel><Text style={[typo.body, styles.detailText]}>{selected.notes}</Text></> : null}

          {selected.status === "done" ? (
            <View style={styles.completedBox}>
              <Ionicons name="checkmark-circle" size={16} color={colors.success} />
              <Text style={styles.completedText}>Completed by {selected.completed_by || "—"}{selected.completed_at ? ` on ${new Date(selected.completed_at).toLocaleDateString()}` : ""}</Text>
            </View>
          ) : null}

          <Button title="Delete Task" onPress={() => setDeleting(selected)} variant="danger" testID="delete-task-btn" style={{ marginTop: spacing.lg }} />
        </> : null}
      </DetailDrawer>

      <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
        <Screen title={editing?.id ? "Edit Task" : "New Task"} back rightAction={{ icon: "close", onPress: () => setEditing(null), testID: "close-task-edit" }} testID="task-edit-screen">
          <Input label="Title" value={editing?.title || ""} onChangeText={(v) => setEditing((e) => ({ ...e!, title: v }))} testID="task-title" />
          <Input label="Description" value={editing?.description || ""} onChangeText={(v) => setEditing((e) => ({ ...e!, description: v }))} testID="task-description" />

          <SectionLabel>Type</SectionLabel>
          <Row style={{ gap: 8, marginBottom: spacing.md, flexWrap: "wrap" }}>
            {TYPES.filter((t) => t.key !== "all").map((t) => (
              <TouchableOpacity key={t.key} onPress={() => setEditing((e) => ({ ...e!, task_type: t.key }))} style={[styles.chip, editing?.task_type === t.key && styles.chipActive]} testID={`edit-type-${t.key}`}>
                <Text style={[styles.chipText, editing?.task_type === t.key && { color: colors.inverse }]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </Row>

          <SectionLabel>Priority</SectionLabel>
          <Row style={{ gap: 8, marginBottom: spacing.md }}>
            {PRIORITIES.map((p) => (
              <TouchableOpacity key={p} onPress={() => setEditing((e) => ({ ...e!, priority: p }))} style={[styles.chip, editing?.priority === p && styles.chipActive]} testID={`edit-priority-${p}`}>
                <Text style={[styles.chipText, editing?.priority === p && { color: colors.inverse }]}>{pretty(p)}</Text>
              </TouchableOpacity>
            ))}
          </Row>

          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}><Input label="Assignee" value={editing?.assignee || ""} onChangeText={(v) => setEditing((e) => ({ ...e!, assignee: v }))} testID="task-assignee" /></View>
            <View style={{ flex: 1 }}>
              <Input label="Due date (yyyy-mm-dd)" value={editing?.due_date?.slice(0, 10) || ""} onChangeText={(v) => { const d = new Date(v); setEditing((e) => ({ ...e!, due_date: isNaN(d.getTime()) ? null : d.toISOString() })); }} mono autoCapitalize="none" testID="task-due" />
            </View>
          </Row>

          {(editing?.task_type === "repair" || editing?.task_type === "staging") ? (
            <Input label="Qty (units this task represents)" value={String(editing?.qty ?? 0)} onChangeText={(v) => setEditing((e) => ({ ...e!, qty: Number(v.replace(/[^0-9]/g, "")) || 0 }))} keyboardType="number-pad" mono testID="task-qty" />
          ) : null}

          <SectionLabel>Related equipment</SectionLabel>
          <SearchInput value={eqSearch} onChangeText={setEqSearch} placeholder="Search SKU or equipment…" testID="task-eq-search" style={{ marginBottom: spacing.sm }} />
          <View style={styles.eqResults}>
            {eqMatches.map((item) => {
              const active = editing?.related_equipment_id === item.id;
              return (
                <TouchableOpacity key={item.id} onPress={() => setEditing((e) => ({ ...e!, related_equipment_id: active ? null : item.id }))} style={[styles.eqRow, active && styles.eqRowActive]} testID={`task-eq-${item.sku}`}>
                  <Text style={typo.body} numberOfLines={1}>{item.name}</Text>
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{item.sku}</Mono>
                </TouchableOpacity>
              );
            })}
          </View>

          <SectionLabel>Checklist</SectionLabel>
          {(editing?.checklist || []).map((item, idx) => (
            <Row key={idx} style={{ gap: spacing.sm, marginBottom: spacing.xs, alignItems: "center" }}>
              <Text style={[typo.body, { flex: 1 }]}>{item.text}</Text>
              <TouchableOpacity onPress={() => setEditing((e) => ({ ...e!, checklist: (e!.checklist || []).filter((_, i) => i !== idx) }))} testID={`remove-checklist-${idx}`}>
                <Ionicons name="close-circle-outline" size={20} color={colors.inkMuted} />
              </TouchableOpacity>
            </Row>
          ))}
          <Row style={{ gap: spacing.sm, marginBottom: spacing.md }}>
            <View style={{ flex: 1 }}><Input value={checklistDraft} onChangeText={setChecklistDraft} placeholder="Add checklist item…" testID="checklist-draft" /></View>
            <Button title="Add" variant="outline" fullWidth={false} style={{ height: 44 }} onPress={() => {
              if (!checklistDraft.trim()) return;
              setEditing((e) => ({ ...e!, checklist: [...(e!.checklist || []), { text: checklistDraft.trim(), done: false }] }));
              setChecklistDraft("");
            }} testID="add-checklist-item" />
          </Row>

          <Input label="Notes" value={editing?.notes || ""} onChangeText={(v) => setEditing((e) => ({ ...e!, notes: v }))} multiline testID="task-notes" />
          <Button title="Save" onPress={save} testID="save-task-btn" />
        </Screen>
      </Modal>
      <ConfirmDialog visible={!!deleting} title="Delete task?" message={deleting ? `"${deleting.title}" will be permanently removed.` : undefined} confirmLabel="Delete" onConfirm={del} onCancel={() => setDeleting(null)} testID="delete-task-confirm" />
    </Screen>
  );
}

const DetailStat = ({ label, value, badge, tone }: { label: string; value: string; badge?: boolean; tone?: StatusTone }) => (
  <View style={styles.detailStat}><Text style={typo.caption}>{label}</Text>{badge ? <StatusBadge label={value} tone={tone} /> : <Text style={typo.body}>{value}</Text>}</View>
);

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg }, toolbarButton: { height: 40 },
  filterStack: { paddingHorizontal: spacing.xl, gap: spacing.xs, paddingBottom: spacing.md },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  chip: { paddingHorizontal: 14, height: 36, justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, flexShrink: 0 },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink }, chipText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
  drawerEdit: { height: 32, paddingHorizontal: spacing.sm, flexDirection: "row", alignItems: "center", gap: 4 }, drawerEditText: { ...typo.label, color: colors.primary },
  statusChip: { paddingHorizontal: 12, height: 32, justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md },
  statusChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  statusChipText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
  detailGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -spacing.xs, marginBottom: spacing.lg }, detailStat: { width: "50%", padding: spacing.xs, gap: 4 },
  detailText: { marginBottom: spacing.lg },
  checklistRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  completedBox: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.successSoft, borderRadius: radii.md, padding: spacing.sm, marginTop: spacing.md },
  completedText: { ...typo.bodySmall, color: colors.success, fontWeight: "600" },
  eqResults: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", marginBottom: spacing.md },
  eqRow: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  eqRowActive: { backgroundColor: colors.primarySoft },
});

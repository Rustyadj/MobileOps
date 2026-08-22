// Staging / Loadout — curated view of staging-type shop tasks (auto-created
// when a booking is confirmed, with an itemized checklist pulled from the
// booking's line items). Crews check items off as they pull and load gear;
// full task editing lives in Shop > Tasks.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Card, Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { StatusBadge, StatusTone } from "@/src/components/data/StatusBadge";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type ChecklistItem = { text: string; done: boolean };
type ShopTask = {
  id: string; title: string; status: string; due_date: string | null;
  checklist: ChecklistItem[]; related_booking_id: string | null; created_at: string;
};
type Booking = { id: string; customer_name: string; job_site: string; start_date: string };

const statusTone = (status: string): StatusTone =>
  status === "done" ? "success" : status === "blocked" ? "error" : status === "in_progress" ? "warning" : "neutral";
const pretty = (v: string) => v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const shortDate = (v?: string | null) => v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";

export default function StagingScreen() {
  const router = useRouter();
  const [tasks, setTasks] = useState<ShopTask[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<ShopTask | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, b] = await Promise.all([api<ShopTask[]>("/shop-tasks"), api<Booking[]>("/bookings")]);
      const staging = t.filter((task) => (task as any).task_type === "staging");
      setTasks(staging); setBookings(b);
      setSelected((cur) => cur ? staging.find((x) => x.id === cur.id) || null : null);
    } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const bookingById = useMemo(() => Object.fromEntries(bookings.map((b) => [b.id, b])), [bookings]);
  const sorted = useMemo(() => [...tasks].sort((a, b) => {
    const order: Record<string, number> = { to_do: 0, in_progress: 1, blocked: 2, done: 3 };
    const so = order[a.status] - order[b.status];
    if (so !== 0) return so;
    return (a.due_date || "").localeCompare(b.due_date || "");
  }), [tasks]);

  const progress = (t: ShopTask) => t.checklist.length ? `${t.checklist.filter((i) => i.done).length}/${t.checklist.length} staged` : "No checklist";

  const toggleChecklistItem = async (task: ShopTask, idx: number) => {
    const checklist = task.checklist.map((item, i) => i === idx ? { ...item, done: !item.done } : item);
    try {
      const updated = await api<ShopTask>(`/shop-tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ ...task, task_type: "staging", priority: "normal", checklist }) });
      setTasks((cur) => cur.map((t) => t.id === updated.id ? updated : t));
      setSelected(updated);
    } catch (e: any) { Alert.alert("Update failed", e.message); }
  };
  const setTaskStatus = async (task: ShopTask, next: string) => {
    try {
      const updated = await api<ShopTask>(`/shop-tasks/${task.id}/status`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      setTasks((cur) => cur.map((t) => t.id === updated.id ? updated : t));
      setSelected(updated);
    } catch (e: any) { Alert.alert("Status update failed", e.message); }
  };

  return (
    <Screen title="Staging / Loadout" subtitle={`${tasks.filter((t) => t.status !== "done").length} jobs to stage`} back
      onRefresh={onRefresh} refreshing={refreshing} testID="staging-screen">
      {sorted.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No staging tasks. These are created automatically when a booking is confirmed.</Text></Card>
      ) : sorted.map((t) => {
        const booking = t.related_booking_id ? bookingById[t.related_booking_id] : null;
        return (
          <TouchableOpacity key={t.id} onPress={() => setSelected(t)} testID={`staging-row-${t.id}`}>
            <Card style={{ marginBottom: spacing.sm }}>
              <Row style={{ gap: 8, alignItems: "flex-start" }}>
                <View style={{ flex: 1 }}>
                  <H3>{t.title}</H3>
                  <Text style={[typo.label, { marginTop: 2 }]}>{booking?.job_site || booking?.customer_name || "No job linked"} · Due {shortDate(t.due_date)} · {progress(t)}</Text>
                </View>
                <StatusBadge label={pretty(t.status)} tone={statusTone(t.status)} />
              </Row>
            </Card>
          </TouchableOpacity>
        );
      })}

      <DetailDrawer visible={!!selected} title={selected?.title || "Staging task"} subtitle={selected ? progress(selected) : undefined} onClose={() => setSelected(null)} testID="staging-drawer">
        {selected ? (
          <View>
            <SectionLabel>Status</SectionLabel>
            <Row style={{ gap: spacing.xs, marginBottom: spacing.lg, flexWrap: "wrap" }}>
              {["to_do", "in_progress", "blocked", "done"].map((s) => (
                <TouchableOpacity key={s} onPress={() => setTaskStatus(selected, s)} style={[styles.statusChip, selected.status === s && styles.statusChipActive]} testID={`staging-set-status-${s}`}>
                  <Text style={[styles.statusChipText, selected.status === s && { color: colors.inverse }]}>{pretty(s)}</Text>
                </TouchableOpacity>
              ))}
            </Row>
            <SectionLabel>Load checklist</SectionLabel>
            {selected.checklist.map((item, idx) => (
              <TouchableOpacity key={idx} onPress={() => toggleChecklistItem(selected, idx)} style={styles.checklistRow} testID={`staging-checklist-${idx}`}>
                <Ionicons name={item.done ? "checkbox" : "square-outline"} size={19} color={item.done ? colors.success : colors.inkMuted} />
                <Text style={[typo.body, { flex: 1 }, item.done && { textDecorationLine: "line-through", color: colors.inkMuted }]}>{item.text}</Text>
              </TouchableOpacity>
            ))}
            <Button title="Open in Tasks" variant="outline" onPress={() => router.push("/(app)/shop/tasks" as any)} style={{ marginTop: spacing.lg }} testID="staging-open-tasks" />
          </View>
        ) : null}
      </DetailDrawer>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusChip: { paddingHorizontal: 12, height: 32, justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md },
  statusChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  statusChipText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
  checklistRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
});

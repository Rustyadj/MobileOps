// Approval queue for crew supply asks. Rows posted in the Live Feed ("I need
// 6 more turnbuckles") land here automatically as FEED rows; anyone can also
// add one by hand. Admins approve/deny inline; foreman+ marks approved
// requests received once they reach the site.
import React, { useMemo, useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { StatusBadge, StatusTone } from "@/src/components/data/StatusBadge";
import { Button, Input } from "@/src/components/ui";
import { SupplyRequest, SupplyRequestStatus, useSupplyRequests } from "@/src/hooks/use-supply-requests";
import { usePermissions } from "@/src/hooks/use-permissions";
import { colors, spacing, radii } from "@/src/theme";

type Filter = "pending" | "approved" | "closed" | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "closed", label: "Done" },
  { key: "all", label: "All" },
];
const matchesFilter = (row: SupplyRequest, filter: Filter) => filter === "all"
  || (filter === "closed" ? row.status === "fulfilled" || row.status === "denied" : row.status === filter);

const STATUS_TONE: Record<SupplyRequestStatus, StatusTone> = { pending: "warning", approved: "info", denied: "neutral", fulfilled: "success" };
const STATUS_LABEL: Record<SupplyRequestStatus, string> = { pending: "Pending", approved: "Approved", denied: "Denied", fulfilled: "Received" };

function ago(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SupplyRequestsCard({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { canEdit, canAdmin } = usePermissions();
  const requests = useSupplyRequests();
  const [filter, setFilter] = useState<Filter>("pending");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [itemName, setItemName] = useState("");
  const [qty, setQty] = useState("1");
  const [jobSite, setJobSite] = useState("");
  const [notes, setNotes] = useState("");

  // The dashboard card is a work queue: pending, then approved-but-not-yet-
  // received. History lives on the full page behind the filter tabs.
  const visible = useMemo(() => compact
    ? requests.rows.filter((row) => row.status === "pending" || row.status === "approved").slice(0, 6)
    : requests.rows.filter((row) => matchesFilter(row, filter)), [compact, filter, requests.rows]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(({ key }) => [key, requests.rows.filter((row) => matchesFilter(row, key)).length])) as Record<Filter, number>, [requests.rows]);

  const act = async (row: SupplyRequest, status: SupplyRequestStatus) => {
    setBusyId(row.id);
    try { await requests.setStatus(row.id, status); }
    catch (error: any) { Alert.alert("Requests", error?.message || "Try again."); }
    finally { setBusyId(null); }
  };

  const openCreate = () => { setItemName(""); setQty("1"); setJobSite(""); setNotes(""); setCreating(true); };
  const save = async () => {
    const name = itemName.trim();
    const quantity = parseInt(qty, 10);
    if (!name) return Alert.alert("Item required", "What's needed?");
    if (!Number.isFinite(quantity) || quantity <= 0) return Alert.alert("Invalid quantity", "Enter a quantity greater than zero.");
    setSaving(true);
    try { await requests.create({ item_name: name, qty: quantity, job_site: jobSite.trim(), notes: notes.trim() }); setCreating(false); }
    catch (error: any) { Alert.alert("Request not added", error?.message || "Try again."); }
    finally { setSaving(false); }
  };

  const emptyLabel = compact || filter === "pending" ? "No requests waiting on approval." : "Nothing here.";

  return (
    <View style={[styles.panel, compact && styles.compactPanel]} testID="supply-requests-card">
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Ionicons name="clipboard-outline" size={16} color={colors.warning} />
          <Text style={styles.title}>Requests</Text>
          {requests.pendingCount ? <View style={styles.countPill}><Text style={styles.countText}>{requests.pendingCount} pending</Text></View> : null}
        </View>
        {compact ? <TouchableOpacity onPress={() => router.push("/(app)/requests" as any)} testID="supply-requests-view-all"><Text style={styles.viewAll}>View All  →</Text></TouchableOpacity> : null}
      </View>

      {!compact ? (
        <View style={styles.filterRow} role="tablist">
          {FILTERS.map(({ key, label }) => (
            <TouchableOpacity key={key} onPress={() => setFilter(key)} style={[styles.filterTab, filter === key && styles.filterTabActive]} role="tab" aria-selected={filter === key} testID={`supply-requests-filter-${key}`}>
              <Text style={[styles.filterText, filter === key && styles.filterTextActive]}>{label} <Text style={styles.filterCount}>{counts[key]}</Text></Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} nestedScrollEnabled>
        {requests.loading ? <Text style={styles.empty}>Loading…</Text> : null}
        {requests.error ? <Text style={styles.error}>{requests.error}</Text> : null}
        {!requests.loading && !requests.error && !visible.length ? (
          <View style={styles.emptyState}>
            <Text style={styles.empty}>{emptyLabel}</Text>
            {compact ? <Text style={styles.hint}>Posts like “I need 6 more turnbuckles” in the Live Feed show up here automatically.</Text> : null}
          </View>
        ) : null}
        {visible.map((row) => {
          const busy = busyId === row.id;
          const open = expanded === row.id;
          return (
            <View key={row.id} style={[styles.row, compact && styles.rowCompact]} testID={`supply-request-${row.id}`}>
              <TouchableOpacity style={styles.rowTap} onPress={() => setExpanded(open ? null : row.id)} activeOpacity={0.6} accessibilityLabel={`${row.qty} ${row.item_name}, requested by ${row.requested_by}`}>
                <View style={styles.qtyBox}><Text style={styles.qtyValue} numberOfLines={1}>{row.qty}</Text></View>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{row.item_name}</Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {row.requested_by || "Someone"} · {ago(row.created_at)}{row.job_site ? ` · ${row.job_site}` : ""}{row.source === "live_feed" ? " · via Live Feed" : ""}
                  </Text>
                </View>
              </TouchableOpacity>
              {row.status === "pending" && canAdmin ? (
                <View style={styles.actions}>
                  <TouchableOpacity onPress={() => act(row, "denied")} disabled={busy} style={[styles.iconButton, styles.denyButton]} accessibilityLabel={`Deny ${row.item_name}`} testID={`supply-request-deny-${row.id}`}>
                    <Ionicons name="close" size={15} color={colors.inkSecondary} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => act(row, "approved")} disabled={busy} style={[styles.approveButton, busy && { opacity: 0.5 }]} accessibilityLabel={`Approve ${row.item_name}`} testID={`supply-request-approve-${row.id}`}>
                    <Ionicons name="checkmark" size={14} color={colors.inverse} />
                    {!compact ? <Text style={styles.approveText}>Approve</Text> : null}
                  </TouchableOpacity>
                </View>
              ) : row.status === "approved" && canEdit ? (
                <TouchableOpacity onPress={() => act(row, "fulfilled")} disabled={busy} style={[styles.receivedButton, busy && { opacity: 0.5 }]} accessibilityLabel={`Mark ${row.item_name} received`} testID={`supply-request-received-${row.id}`}>
                  <Ionicons name="checkmark-done" size={13} color={colors.success} />
                  <Text style={styles.receivedText}>Received</Text>
                </TouchableOpacity>
              ) : (
                <StatusBadge label={STATUS_LABEL[row.status]} tone={STATUS_TONE[row.status]} />
              )}
              {open ? (
                <View style={styles.detail}>
                  {row.source_text ? <Text style={styles.quote}>“{row.source_text}”</Text> : null}
                  {row.notes ? <Text style={styles.detailText}>{row.notes}</Text> : null}
                  {row.equipment_name ? <Text style={styles.detailText}>Matches inventory: {row.equipment_name}</Text> : null}
                  {row.decided_by ? <Text style={styles.detailText}>{STATUS_LABEL[row.status === "fulfilled" ? "approved" : row.status]} by {row.decided_by}{row.decided_at ? ` · ${ago(row.decided_at)}` : ""}</Text> : null}
                  {row.fulfilled_by ? <Text style={styles.detailText}>Received by {row.fulfilled_by}{row.fulfilled_at ? ` · ${ago(row.fulfilled_at)}` : ""}</Text> : null}
                  {row.status === "denied" && canAdmin ? (
                    <TouchableOpacity onPress={() => act(row, "pending")} disabled={busy}><Text style={styles.link}>Reopen</Text></TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <TouchableOpacity onPress={openCreate} style={styles.addRow} testID="supply-requests-add">
        <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
        <Text style={styles.addText}>Add Request</Text>
      </TouchableOpacity>

      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="supply-request-create-modal">
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}><Text style={styles.modalTitle}>Add Request</Text><Text style={styles.modalSubtitle}>Goes to an admin for approval.</Text></View>
              <TouchableOpacity onPress={() => setCreating(false)} style={styles.closeButton} accessibilityLabel="Close"><Ionicons name="close" size={20} color={colors.inkSecondary} /></TouchableOpacity>
            </View>
            <Input label="Item" value={itemName} onChangeText={setItemName} placeholder="Turnbuckles, shovel, 3/8&quot; bolts…" testID="supply-request-item" />
            <Input label="Quantity" value={qty} onChangeText={(t) => setQty(t.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono testID="supply-request-qty" />
            <Input label="Job site (optional)" value={jobSite} onChangeText={setJobSite} placeholder="Ferris, Crowley…" testID="supply-request-site" />
            <Input label="Notes (optional)" value={notes} onChangeText={setNotes} multiline testID="supply-request-notes" />
            <View style={styles.modalActions}>
              <View style={{ flex: 1 }}><Button title="Cancel" variant="outline" onPress={() => setCreating(false)} /></View>
              <View style={{ flex: 1 }}><Button title="Send for approval" onPress={save} loading={saving} testID="supply-request-save" /></View>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minWidth: 0, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, overflow: "hidden" },
  compactPanel: { minHeight: 178 },
  header: { minHeight: 36, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: colors.border },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: { fontSize: 13, fontWeight: "800", color: colors.ink, letterSpacing: -0.1 },
  countPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radii.sm, backgroundColor: colors.accentSoft },
  countText: { fontSize: 10, fontWeight: "800", color: colors.warning },
  viewAll: { fontSize: 11.5, color: colors.primary, fontWeight: "700" },
  filterRow: { flexDirection: "row", gap: 4, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  filterTab: { minHeight: 30, paddingHorizontal: 10, justifyContent: "center", borderRadius: radii.md },
  filterTabActive: { backgroundColor: colors.primarySoft },
  filterText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
  filterTextActive: { color: colors.primary },
  filterCount: { fontWeight: "600", color: colors.inkMuted },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 12 },
  emptyState: { paddingVertical: spacing.lg, alignItems: "center", gap: 4 },
  empty: { textAlign: "center", color: colors.inkMuted, fontSize: 12 },
  hint: { textAlign: "center", color: colors.inkMuted, fontSize: 11, maxWidth: 260 },
  error: { padding: spacing.md, color: colors.error, fontSize: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowCompact: { paddingVertical: 5 },
  rowTap: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 9 },
  qtyBox: { minWidth: 30, height: 28, paddingHorizontal: 5, borderRadius: radii.md, backgroundColor: colors.bgTint, alignItems: "center", justifyContent: "center" },
  qtyValue: { fontSize: 12.5, fontWeight: "800", color: colors.ink, fontVariant: ["tabular-nums"] },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 12.5, fontWeight: "700", color: colors.ink, textTransform: "capitalize" },
  rowMeta: { fontSize: 10.5, color: colors.inkMuted, marginTop: 1 },
  actions: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconButton: { width: 30, height: 30, borderRadius: radii.md, alignItems: "center", justifyContent: "center" },
  denyButton: { borderWidth: 1, borderColor: colors.border },
  approveButton: { minWidth: 30, height: 30, paddingHorizontal: 8, flexDirection: "row", gap: 4, borderRadius: radii.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.success },
  approveText: { fontSize: 11.5, fontWeight: "800", color: colors.inverse },
  receivedButton: { height: 30, paddingHorizontal: 8, flexDirection: "row", gap: 4, borderRadius: radii.md, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  receivedText: { fontSize: 11, fontWeight: "700", color: colors.success },
  detail: { width: "100%", paddingLeft: 39, paddingBottom: 2, gap: 3 },
  quote: { fontSize: 11.5, fontStyle: "italic", color: colors.inkSecondary },
  detailText: { fontSize: 11, color: colors.inkMuted },
  link: { fontSize: 11.5, fontWeight: "700", color: colors.primary, marginTop: 2 },
  addRow: { minHeight: 32, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderTopWidth: 1, borderTopColor: colors.border },
  addText: { fontSize: 12, fontWeight: "700", color: colors.primary },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.42)", alignItems: "center", justifyContent: "center", padding: spacing.md },
  modalCard: { width: "100%", maxWidth: 480, padding: spacing.lg, borderRadius: radii.xl, backgroundColor: colors.bg },
  modalHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, marginBottom: spacing.lg },
  modalTitle: { fontSize: 20, fontWeight: "700", color: colors.ink },
  modalSubtitle: { fontSize: 12.5, color: colors.inkSecondary, marginTop: 4 },
  closeButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md },
  modalActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
});

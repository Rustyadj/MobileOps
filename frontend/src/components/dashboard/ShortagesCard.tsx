// Single source of truth for "what does the operation currently need more
// of" — merges the existing auto-computed equipment capacity forecast (AUTO
// badge) with manually-added needs (MANUAL badge, no inventory record
// required). No dates or forecast-window details are shown here; that's an
// internal computation detail of the AUTO rows, not user-facing.
import React, { useMemo, useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { Button, Input } from "@/src/components/ui";
import { useShortages, ShortageInput, ShortageRow } from "@/src/hooks/use-shortages";
import { usePermissions } from "@/src/hooks/use-permissions";
import { colors, spacing, radii } from "@/src/theme";

const needLabel = (row: ShortageRow) => row.source === "auto"
  ? `Need ${row.qty_needed} · Available ${row.quantity_available ?? "—"} · Short ${row.quantity_short ?? row.qty_needed}`
  : `Qty ${row.qty_needed}${row.notes ? ` · ${row.notes}` : ""}`;

const STATUS_TONE: Record<string, "warning" | "info" | "success"> = { open: "warning", ordered: "info", resolved: "success" };

export function ShortagesCard({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { canEdit } = usePermissions();
  const shortages = useShortages();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [itemName, setItemName] = useState("");
  const [qty, setQty] = useState("1");
  const [notes, setNotes] = useState("");

  const visible = useMemo(() => compact ? shortages.rows.slice(0, 5) : shortages.rows, [compact, shortages.rows]);
  const openFull = () => router.push("/(app)/shortages" as any);

  const openCreate = () => { setItemName(""); setQty("1"); setNotes(""); setCreating(true); };
  const save = async () => {
    const name = itemName.trim();
    const qtyNeeded = parseInt(qty, 10);
    if (!name) return Alert.alert("Item required", "What do we need more of?");
    if (!Number.isFinite(qtyNeeded) || qtyNeeded <= 0) return Alert.alert("Invalid quantity", "Enter a quantity greater than zero.");
    const input: ShortageInput = { item_name: name, qty_needed: qtyNeeded, notes: notes.trim() };
    setBusy(true);
    try { await shortages.create(input); setCreating(false); }
    catch (error: any) { Alert.alert("Shortage not added", error?.message || "Try again."); }
    finally { setBusy(false); }
  };

  const advanceStatus = (row: ShortageRow) => {
    const next = row.status === "open" ? "ordered" : "resolved";
    shortages.setStatus(row.id, next).catch((error: any) => Alert.alert("Shortages", error?.message || "Try again."));
  };

  return (
    <View style={[styles.panel, compact && styles.compactPanel]} testID="dashboard-shortages-card">
      <View style={styles.header}>
        <Text style={styles.title}>SHORTAGES</Text>
        <TouchableOpacity onPress={openFull} testID="shortages-open-full"><Text style={styles.viewAll}>Open Shortages →</Text></TouchableOpacity>
      </View>

      <ScrollView style={[styles.list, compact && styles.compactList]} contentContainerStyle={styles.listContent} nestedScrollEnabled>
        {shortages.loading ? <Text style={styles.empty}>Loading…</Text> : null}
        {shortages.error ? <Text style={styles.error}>{shortages.error}</Text> : null}
        {!shortages.loading && !shortages.error && !visible.length ? <Text style={styles.empty}>Nothing short right now.</Text> : null}
        {visible.map((row) => (
          <TouchableOpacity
            key={row.id} style={styles.row} activeOpacity={row.source === "manual" && canEdit ? 0.6 : 1}
            onPress={row.source === "manual" && canEdit && row.status !== "resolved" ? () => advanceStatus(row) : undefined}
            testID={`shortage-row-${row.id}`}
          >
            <View style={[styles.sourceTag, row.source === "auto" ? styles.autoTag : styles.manualTag]}>
              <Text style={[styles.sourceText, row.source === "auto" ? styles.autoText : styles.manualText]}>{row.source === "auto" ? "AUTO" : "MANUAL"}</Text>
            </View>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} numberOfLines={1}>{row.item_name}</Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>{needLabel(row)}</Text>
            </View>
            <StatusBadge label={row.status} tone={STATUS_TONE[row.status]} />
          </TouchableOpacity>
        ))}
      </ScrollView>

      {canEdit ? (
        <TouchableOpacity onPress={openCreate} style={styles.addRow} testID="shortages-add">
          <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
          <Text style={styles.addText}>Add Shortage</Text>
        </TouchableOpacity>
      ) : null}

      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="shortage-create-modal">
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}><Text style={styles.modalTitle}>Add Shortage</Text><Text style={styles.modalSubtitle}>Anything the operation needs more of — no due date required.</Text></View>
              <TouchableOpacity onPress={() => setCreating(false)} style={styles.closeButton}><Ionicons name="close" size={20} color={colors.inkSecondary} /></TouchableOpacity>
            </View>
            <Input label="Item" value={itemName} onChangeText={setItemName} placeholder="Canopy, Nudura clips, 3/8&quot; bolts…" testID="shortage-item-name" />
            <Input label="Quantity" value={qty} onChangeText={(t) => setQty(t.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono testID="shortage-qty" />
            <Input label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Need one for shade at the yard…" multiline testID="shortage-notes" />
            <View style={styles.modalActions}>
              <View style={{ flex: 1 }}><Button title="Cancel" variant="outline" onPress={() => setCreating(false)} /></View>
              <View style={{ flex: 1 }}><Button title="Add" onPress={save} loading={busy} testID="shortage-create-save" /></View>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minWidth: 0, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  // Only the compact (dashboard) rendering is height-capped — the full page
  // (app/(app)/shortages.tsx) fills its own tall container instead.
  compactPanel: { maxHeight: 380 },
  header: { minHeight: 44, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 11, fontWeight: "800", color: colors.inkSecondary, letterSpacing: 0.5 },
  viewAll: { fontSize: 11.5, color: colors.primary, fontWeight: "700" },
  list: { flex: 1 },
  compactList: { maxHeight: 284 },
  listContent: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  empty: { paddingVertical: spacing.xl, textAlign: "center", color: colors.inkMuted, fontSize: 12 },
  error: { padding: spacing.md, color: colors.error, fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  sourceTag: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: radii.sm, width: 58, alignItems: "center" },
  autoTag: { backgroundColor: colors.bgTint }, manualTag: { backgroundColor: colors.primarySoft },
  sourceText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.3 },
  autoText: { color: colors.inkSecondary }, manualText: { color: colors.primary },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 12.5, fontWeight: "700", color: colors.ink },
  rowSubtitle: { fontSize: 10.5, color: colors.inkMuted, marginTop: 2 },
  addRow: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderTopWidth: 1, borderTopColor: colors.border },
  addText: { fontSize: 12, fontWeight: "700", color: colors.primary },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.42)", alignItems: "center", justifyContent: "center", padding: spacing.md },
  modalCard: { width: "100%", maxWidth: 480, padding: spacing.lg, borderRadius: radii.xl, backgroundColor: colors.bg },
  modalHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, marginBottom: spacing.lg },
  modalTitle: { fontSize: 20, fontWeight: "700", color: colors.ink },
  modalSubtitle: { fontSize: 12.5, color: colors.inkSecondary, marginTop: 4 },
  closeButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md },
  modalActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
});

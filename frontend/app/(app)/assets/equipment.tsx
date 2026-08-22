import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Pill, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { FilterChips } from "@/src/components/data/FilterBar";
import { SearchInput } from "@/src/components/data/SearchInput";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { Ionicons } from "@expo/vector-icons";
import { api, apiBaseUrl, getAccessToken } from "@/src/api/client";
import { colors, radii, spacing, type as typo } from "@/src/theme";

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "strongback", label: "Strongback" },
  { key: "turnbuckle", label: "Turnbuckle" },
  { key: "walkboard_bracket", label: "Walkboard" },
  { key: "hand_rail", label: "Hand Rail" },
  { key: "tb_extension", label: "TB Ext" },
  { key: "crankup_scaffold", label: "Scaffold" },
];

type Equipment = {
  id: string; sku: string; name: string; category: string;
  condition: string; location: string; daily_rate: number;
  quantity: number; available: number; notes: string; created_at?: string;
  reserved: number; on_rental: number; in_transit: number;
  pending_inspection: number; in_maintenance: number; missing: number;
  tracking_type: string;
};
type BreakdownRow = { qty: number; label: string; kind: string; rental_id?: string; booking_id?: string };
type Breakdown = { equipment_id: string; quantity: number; rows: BreakdownRow[] };
type Maintenance = {
  id: string; equipment_id: string; issue: string; action_taken: string;
  cost: number; status: string; serviced_at?: string | null; created_at: string;
};
type RentalLine = { equipment_id: string; qty: number; returned_qty: number };
type Rental = {
  id: string; customer_name: string; job_site: string; status: string;
  start_date: string; lines: RentalLine[];
};
type SortKey = "sku" | "name" | "category" | "location" | "quantity" | "available" | "condition" | "daily_rate";

const blank: Partial<Equipment> = {
  sku: "", name: "", category: "strongback", condition: "good",
  location: "", daily_rate: 0, quantity: 1, available: 1, notes: "",
};
const pretty = (value: string) => value.replace(/_/g, " ");

export default function EquipmentScreen() {
  const { isShellWide } = useBreakpoint();
  const [items, setItems] = useState<Equipment[]>([]);
  const [maintenance, setMaintenance] = useState<Maintenance[]>([]);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [cat, setCat] = useState("all");
  const [location, setLocation] = useState("all");
  const [condition, setCondition] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("sku");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Partial<Equipment> | null>(null);
  const [selected, setSelected] = useState<Equipment | null>(null);
  const [deleting, setDeleting] = useState<Equipment | null>(null);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [equipmentData, maintenanceData, rentalData] = await Promise.all([
        api<Equipment[]>("/equipment"),
        api<Maintenance[]>("/maintenance"),
        api<Rental[]>("/rentals"),
      ]);
      setItems(equipmentData);
      setMaintenance(maintenanceData);
      setRentals(rentalData);
    } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!selected) { setBreakdown(null); return; }
    let cancelled = false;
    setBreakdownLoading(true);
    api<Breakdown>(`/equipment/${selected.id}/breakdown`)
      .then((data) => { if (!cancelled) setBreakdown(data); })
      .catch((e) => console.warn(e))
      .finally(() => { if (!cancelled) setBreakdownLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const mobileItems = cat === "all" ? items : items.filter((item) => item.category === cat);
  const locationOptions = useMemo(() => [
    { key: "all", label: "All locations" },
    ...Array.from(new Set(items.map((item) => item.location).filter(Boolean))).sort().map((value) => ({ key: value, label: value })),
  ], [items]);
  const conditionOptions = useMemo(() => [
    { key: "all", label: "All conditions" },
    ...Array.from(new Set(items.map((item) => item.condition).filter(Boolean))).sort().map((value) => ({ key: value, label: pretty(value) })),
  ], [items]);
  const desktopItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rows = items.filter((item) => {
      if (cat !== "all" && item.category !== cat) return false;
      if (location !== "all" && item.location !== location) return false;
      if (condition !== "all" && item.condition !== condition) return false;
      if (availability === "available" && item.available <= 0) return false;
      if (availability === "unavailable" && item.available > 0) return false;
      if (!query) return true;
      return [item.sku, item.name, item.category, item.location, item.condition, item.notes]
        .some((value) => value?.toLowerCase().includes(query));
    });
    return rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const compared = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av || "").localeCompare(String(bv || ""), undefined, { numeric: true, sensitivity: "base" });
      return sortDirection === "asc" ? compared : -compared;
    });
  }, [availability, cat, condition, items, location, search, sortDirection, sortKey]);

  const handleSort = (key: string) => {
    if (key === sortKey) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else { setSortKey(key as SortKey); setSortDirection("asc"); }
  };

  const save = async () => {
    if (!editing) return;
    try {
      const body = {
        sku: editing.sku || "", name: editing.name || "", category: editing.category || "strongback",
        condition: editing.condition || "good", location: editing.location || "",
        daily_rate: Number(editing.daily_rate) || 0, quantity: Number(editing.quantity) || 1,
        available: Number(editing.available ?? editing.quantity ?? 1), notes: editing.notes || "",
      };
      if (editing.id) await api(`/equipment/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/equipment", { method: "POST", body: JSON.stringify(body) });
      setEditing(null); setSelected(null); load();
    } catch (e: any) { Alert.alert("Save failed", e.message); }
  };
  const del = async () => {
    if (!deleting) return;
    try {
      await api(`/equipment/${deleting.id}`, { method: "DELETE" });
      setDeleting(null); setSelected(null); load();
    } catch (e: any) { Alert.alert("Delete failed", e.message); }
  };
  const exportCSV = async () => {
    setShowFileMenu(false);
    try {
      const tok = getAccessToken();
      const resp = await fetch(`${apiBaseUrl()}/equipment/export.csv`, { headers: { Authorization: `Bearer ${tok}` } });
      const text = await resp.text();
      if (Platform.OS === "web") {
        const blob = new Blob([text], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "equipment.csv"; a.click(); URL.revokeObjectURL(url);
      } else {
        const path = (FileSystem.documentDirectory || "") + "equipment.csv";
        await FileSystem.writeAsStringAsync(path, text);
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
      }
    } catch (e: any) { Alert.alert("Export failed", e.message); }
  };
  const importCSV = async () => {
    setShowFileMenu(false);
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ["text/csv", "text/comma-separated-values", "application/csv", "*/*"] });
      if (res.canceled || !res.assets?.[0]) return;
      const file = res.assets[0];
      const form = new FormData();
      // @ts-ignore React Native file objects are accepted by FormData at runtime.
      form.append("file", { uri: file.uri, name: file.name || "equipment.csv", type: file.mimeType || "text/csv" } as any);
      const tok = getAccessToken();
      const resp = await fetch(`${apiBaseUrl()}/equipment/import.csv`, { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: form as any });
      const result = await resp.json();
      Alert.alert("Imported", `${result.imported} rows`); load();
    } catch (e: any) { Alert.alert("Import failed", e.message); }
  };

  const columns = useMemo<ColumnDef<Equipment>[]>(() => [
    { key: "sku", label: "SKU", width: 96, render: (item) => <Mono style={styles.tableMono}>{item.sku}</Mono> },
    { key: "name", label: "Equipment", flex: 1.4, render: (item) => item.name },
    { key: "quantity", label: "Owned", width: 58, align: "right", render: (item) => <Mono style={styles.tableMono}>{item.quantity}</Mono> },
    { key: "available", label: "Available", width: 62, align: "right", render: (item) => <Mono style={[styles.tableMono, { color: item.available > 0 ? colors.success : colors.error, fontWeight: "700" }]}>{item.available}</Mono> },
    { key: "reserved", label: "Reserved", width: 62, align: "right", render: (item) => <Mono style={styles.tableMono}>{item.reserved || 0}</Mono> },
    { key: "on_rental", label: "On Rental", width: 68, align: "right", render: (item) => <Mono style={styles.tableMono}>{item.on_rental || 0}</Mono> },
    { key: "in_transit", label: "In Transit", width: 62, align: "right", render: (item) => <Mono style={styles.tableMono}>{item.in_transit || 0}</Mono> },
    { key: "in_maintenance", label: "Maint.", width: 56, align: "right", render: (item) => <Mono style={[styles.tableMono, item.in_maintenance > 0 && { color: colors.warning }]}>{item.in_maintenance || 0}</Mono> },
    { key: "missing", label: "Missing", width: 60, align: "right", render: (item) => <Mono style={[styles.tableMono, item.missing > 0 && { color: colors.error, fontWeight: "700" }]}>{item.missing || 0}</Mono> },
    { key: "condition", label: "Condition", width: 90, render: (item) => <StatusBadge label={item.condition} /> },
  ], []);
  const selectedMaintenance = selected ? maintenance.filter((entry) => entry.equipment_id === selected.id) : [];
  const selectedRentals = selected ? rentals.filter((rental) => rental.lines.some((line) => line.equipment_id === selected.id)) : [];

  return (
    <Screen title="Equipment" subtitle={`${items.length} SKUs · ${items.reduce((sum, item) => sum + item.available, 0)} avail`} back
      rightAction={{ icon: "add", onPress: () => setEditing({ ...blank }), testID: "add-equipment-btn" }}
      onRefresh={onRefresh} refreshing={refreshing} testID="equipment-screen" scroll={!isShellWide}>
      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search SKU, equipment, location…" testID="equipment-search" style={{ flex: 1, maxWidth: 360 }} />
            <Button title="Add Equipment" onPress={() => setEditing({ ...blank })} fullWidth={false} style={styles.toolbarButton} testID="add-equipment-btn" />
            <View style={styles.menuWrap}>
              <TouchableOpacity onPress={() => setShowFileMenu((visible) => !visible)} style={styles.overflowButton} testID="equipment-file-menu"><Ionicons name="ellipsis-horizontal" size={20} color={colors.ink} /></TouchableOpacity>
              {showFileMenu ? (
                <View style={styles.fileMenu}>
                  <TouchableOpacity onPress={importCSV} style={styles.fileMenuItem} testID="import-csv-btn"><Ionicons name="cloud-upload-outline" size={17} color={colors.ink} /><Text style={typo.bodySmall}>Import CSV</Text></TouchableOpacity>
                  <TouchableOpacity onPress={exportCSV} style={styles.fileMenuItem} testID="export-csv-btn"><Ionicons name="download-outline" size={17} color={colors.ink} /><Text style={typo.bodySmall}>Export CSV</Text></TouchableOpacity>
                </View>
              ) : null}
            </View>
          </PageToolbar>
          <View style={styles.filterStack}>
            <FilterChips options={CATEGORIES} value={cat} onChange={setCat} testIDPrefix="cat" />
            <FilterChips options={locationOptions} value={location} onChange={setLocation} testIDPrefix="location" />
            <FilterChips options={conditionOptions} value={condition} onChange={setCondition} testIDPrefix="condition" />
            <FilterChips options={[{ key: "all", label: "Any availability" }, { key: "available", label: "Available" }, { key: "unavailable", label: "Unavailable" }]} value={availability} onChange={setAvailability} testIDPrefix="availability" />
          </View>
          <View style={styles.tableWrap}>
            <DataTable columns={columns} rows={desktopItems} keyExtractor={(item) => item.id} rowTestID={(item) => `equipment-row-${item.sku}`}
              onRowPress={setSelected} selectedId={selected?.id} sortKey={sortKey} sortDirection={sortDirection} onSort={handleSort}
              emptyLabel="No equipment matches these filters." />
          </View>
        </View>
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} style={{ marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
            {CATEGORIES.map((category) => (
              <TouchableOpacity key={category.key} onPress={() => setCat(category.key)} style={[styles.chip, cat === category.key && styles.chipActive]} testID={`cat-${category.key}`}>
                <Text style={[styles.chipText, cat === category.key && { color: colors.inverse }]}>{category.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <Row style={{ gap: spacing.sm, marginBottom: spacing.md }}>
            <View style={{ flex: 1 }}><Button title="Import CSV" onPress={importCSV} variant="outline" testID="import-csv-btn" /></View>
            <View style={{ flex: 1 }}><Button title="Export CSV" onPress={exportCSV} variant="outline" testID="export-csv-btn" /></View>
          </Row>
          {mobileItems.length === 0 ? <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No equipment in this category.</Text></Card> : mobileItems.map((item) => (
            <Card key={item.id} style={{ marginBottom: spacing.sm }} testID={`equipment-row-${item.sku}`}>
              <Row style={{ marginBottom: 4, gap: 8, alignItems: "flex-start" }}><View style={{ flex: 1 }}>
                <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{item.sku}</Mono><H3>{item.name}</H3>
                <Text style={[typo.label, { marginTop: 2 }]}>{pretty(item.category)} · {item.location || "—"}</Text>
              </View><Pill color={item.available > 0 ? colors.success : colors.error} bg={item.available > 0 ? colors.successSoft : colors.errorSoft}>{item.available}/{item.quantity}</Pill></Row>
              <Row style={{ gap: spacing.md, marginTop: 8 }}><Text style={typo.label}>Cond <Mono style={{ fontSize: 13 }}>{item.condition}</Mono></Text><Text style={typo.label}>Rate <Mono style={{ fontSize: 13 }}>${item.daily_rate}/d</Mono></Text></Row>
              <Row style={{ gap: spacing.md, marginTop: 6, flexWrap: "wrap" }}>
                <Text style={typo.label}>Resv <Mono style={{ fontSize: 13 }}>{item.reserved || 0}</Mono></Text>
                <Text style={typo.label}>Rental <Mono style={{ fontSize: 13 }}>{item.on_rental || 0}</Mono></Text>
                {item.in_maintenance > 0 ? <Text style={typo.label}>Maint <Mono style={{ fontSize: 13, color: colors.warning }}>{item.in_maintenance}</Mono></Text> : null}
                {item.missing > 0 ? <Text style={typo.label}>Missing <Mono style={{ fontSize: 13, color: colors.error }}>{item.missing}</Mono></Text> : null}
              </Row>
              <Row style={{ gap: spacing.sm, marginTop: spacing.sm }}><View style={{ flex: 1 }}><Button title="Edit" onPress={() => setEditing(item)} variant="outline" testID={`edit-${item.sku}`} /></View><View style={{ flex: 1 }}><Button title="Delete" onPress={() => setDeleting(item)} variant="danger" testID={`delete-${item.sku}`} /></View></Row>
            </Card>
          ))}
        </>
      )}

      <DetailDrawer visible={!!selected} title={selected?.name || "Equipment"} subtitle={selected ? `${selected.sku} · ${pretty(selected.category)}` : undefined}
        onClose={() => setSelected(null)} testID="equipment-detail-drawer"
        headerActions={selected ? <TouchableOpacity onPress={() => setEditing(selected)} style={styles.drawerEdit} testID={`edit-${selected.sku}`}><Ionicons name="create-outline" size={18} color={colors.primary} /><Text style={styles.drawerEditText}>Edit</Text></TouchableOpacity> : null}>
        {selected ? <>
          <SectionLabel>Inventory</SectionLabel>
          <View style={styles.detailGrid}><DetailStat label="Location" value={selected.location || "—"} /><DetailStat label="Condition" value={pretty(selected.condition)} badge /><DetailStat label="Owned" value={String(selected.quantity)} mono /><DetailStat label="Available" value={String(selected.available)} mono /><DetailStat label="Reserved" value={String(selected.reserved || 0)} mono /><DetailStat label="On rental" value={String(selected.on_rental || 0)} mono /><DetailStat label="In transit" value={String(selected.in_transit || 0)} mono /><DetailStat label="Pending inspection" value={String(selected.pending_inspection || 0)} mono /><DetailStat label="Maintenance" value={String(selected.in_maintenance || 0)} mono /><DetailStat label="Missing" value={String(selected.missing || 0)} mono /></View>
          <SectionLabel>Where these units are</SectionLabel>
          {breakdownLoading ? <Text style={[typo.bodySmall, styles.detailText]}>Loading…</Text>
            : breakdown && breakdown.rows.length ? breakdown.rows.map((row, idx) => (
              <View key={`${row.kind}-${row.rental_id || row.booking_id || idx}`} style={styles.breakdownRow}>
                <Mono style={styles.breakdownQty}>{row.qty}</Mono>
                <Text style={styles.breakdownDash}>—</Text>
                <Text style={[typo.body, { flex: 1 }]}>{row.label}</Text>
              </View>
            )) : <Text style={[typo.bodySmall, styles.detailText]}>No units accounted for.</Text>}
          <SectionLabel>Notes</SectionLabel><Text style={[typo.body, styles.detailText]}>{selected.notes || "No notes recorded."}</Text>
          <SectionLabel>Rental usage</SectionLabel>
          {selectedRentals.length ? selectedRentals.map((rental) => { const line = rental.lines.find((entry) => entry.equipment_id === selected.id)!; return <View key={rental.id} style={styles.historyRow}><View style={{ flex: 1 }}><Text style={typo.h3}>{rental.customer_name}</Text><Text style={typo.bodySmall}>{rental.job_site || "No job site"} · {new Date(rental.start_date).toLocaleDateString()}</Text></View><View style={{ alignItems: "flex-end", gap: 4 }}><StatusBadge label={rental.status} /><Mono style={styles.tableMono}>{line.qty - (line.returned_qty || 0)} out</Mono></View></View>; }) : <Text style={[typo.bodySmall, styles.detailText]}>No rental history for this item.</Text>}
          <SectionLabel>Maintenance history</SectionLabel>
          {selectedMaintenance.length ? selectedMaintenance.map((entry) => <View key={entry.id} style={styles.historyRow}><View style={{ flex: 1 }}><Text style={typo.h3}>{entry.issue}</Text><Text style={typo.bodySmall}>{entry.action_taken || "No action recorded"} · {new Date(entry.created_at).toLocaleDateString()}</Text></View><View style={{ alignItems: "flex-end", gap: 4 }}><StatusBadge label={entry.status} /><Mono style={styles.tableMono}>${entry.cost.toFixed(2)}</Mono></View></View>) : <Text style={[typo.bodySmall, styles.detailText]}>No maintenance history for this item.</Text>}
          <Button title="Delete Equipment" onPress={() => setDeleting(selected)} variant="danger" testID={`delete-${selected.sku}`} />
        </> : null}
      </DetailDrawer>

      <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
        <Screen title={editing?.id ? "Edit Equipment" : "Add Equipment"} back rightAction={{ icon: "close", onPress: () => setEditing(null), testID: "close-edit" }} testID="equipment-edit-screen">
          <Input label="SKU" value={editing?.sku || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, sku: text }))} mono testID="edit-sku" />
          <Input label="Name" value={editing?.name || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, name: text }))} testID="edit-name" />
          <SectionLabel>Category</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>{CATEGORIES.filter((category) => category.key !== "all").map((category) => <TouchableOpacity key={category.key} onPress={() => setEditing((entry) => ({ ...entry!, category: category.key }))} style={[styles.chip, editing?.category === category.key && styles.chipActive]} testID={`edit-cat-${category.key}`}><Text style={[styles.chipText, editing?.category === category.key && { color: colors.inverse }]}>{category.label}</Text></TouchableOpacity>)}</ScrollView>
          <Input label="Condition" value={editing?.condition || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, condition: text }))} testID="edit-condition" />
          <Input label="Location" value={editing?.location || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, location: text }))} testID="edit-location" />
          <Row style={{ gap: spacing.md }}><View style={{ flex: 1 }}><Input label="Daily Rate" value={String(editing?.daily_rate ?? "")} onChangeText={(text) => setEditing((entry) => ({ ...entry!, daily_rate: Number(text) || 0 }))} keyboardType="decimal-pad" mono testID="edit-rate" /></View><View style={{ flex: 1 }}><Input label="Quantity" value={String(editing?.quantity ?? "")} onChangeText={(text) => setEditing((entry) => ({ ...entry!, quantity: Number(text) || 0, available: Number(text) || 0 }))} keyboardType="number-pad" mono testID="edit-quantity" /></View></Row>
          <Input label="Available" value={String(editing?.available ?? "")} onChangeText={(text) => setEditing((entry) => ({ ...entry!, available: Number(text) || 0 }))} keyboardType="number-pad" mono testID="edit-available" />
          <Input label="Notes" value={editing?.notes || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, notes: text }))} testID="edit-notes" />
          <Button title="Save" onPress={save} testID="save-equipment-btn" />
        </Screen>
      </Modal>
      <ConfirmDialog visible={!!deleting} title="Delete equipment?" message={deleting ? `${deleting.sku} — ${deleting.name} will be permanently removed.` : undefined} confirmLabel="Delete" onConfirm={del} onCancel={() => setDeleting(null)} testID="delete-equipment-confirm" />
    </Screen>
  );
}

const DetailStat = ({ label, value, mono, badge }: { label: string; value: string; mono?: boolean; badge?: boolean }) => (
  <View style={styles.detailStat}><Text style={typo.caption}>{label}</Text>{badge ? <StatusBadge label={value} /> : mono ? <Mono style={{ fontSize: 16 }}>{value}</Mono> : <Text style={typo.body}>{value}</Text>}</View>
);
const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg }, toolbarButton: { height: 40 }, menuWrap: { position: "relative", zIndex: 10 },
  overflowButton: { width: 40, height: 40, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radii.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  fileMenu: { position: "absolute", top: 44, right: 0, width: 168, paddingVertical: spacing.xs, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.bg, zIndex: 20 },
  fileMenuItem: { minHeight: 40, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  filterStack: { paddingHorizontal: spacing.xl, gap: spacing.xs, paddingBottom: spacing.md },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" }, tableMono: { fontSize: 12 },
  chip: { paddingHorizontal: 14, height: 36, justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, flexShrink: 0 }, chipActive: { backgroundColor: colors.ink, borderColor: colors.ink }, chipText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
  drawerEdit: { height: 32, paddingHorizontal: spacing.sm, flexDirection: "row", alignItems: "center", gap: 4 }, drawerEditText: { ...typo.label, color: colors.primary },
  detailGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -spacing.xs, marginBottom: spacing.lg }, detailStat: { width: "50%", padding: spacing.xs, gap: 4 }, detailText: { marginBottom: spacing.lg },
  historyRow: { flexDirection: "row", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: spacing.sm },
  breakdownRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  breakdownQty: { fontSize: 14, fontWeight: "700", color: colors.ink, minWidth: 32, textAlign: "right" },
  breakdownDash: { fontSize: 13, color: colors.inkMuted },
});

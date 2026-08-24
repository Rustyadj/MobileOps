import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, Platform } from "react-native";
import { useLocalSearchParams } from "expo-router";
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
import { usePermissions } from "@/src/hooks/use-permissions";
import { useCachedResource } from "@/src/hooks/use-cached-resource";
import { mutate } from "@/src/sync/mutate";
import { RequiresOnline } from "@/src/components/RequiresOnline";
import { Ionicons } from "@expo/vector-icons";
import { api, apiBaseUrl, getAccessToken } from "@/src/api/client";
import { equipmentIdentifier, qrCodeDisplay } from "@/src/utils/equipment-identifier";
import { colors, radii, spacing, type as typo } from "@/src/theme";

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "tool", label: "Tools" },
  { key: "strongback", label: "Strongback" },
  { key: "turnbuckle", label: "Turnbuckle" },
  { key: "walkboard_bracket", label: "Walkboard" },
  { key: "hand_rail", label: "Hand Rail" },
  { key: "tb_extension", label: "TB Ext" },
  { key: "crankup_scaffold", label: "Scaffold" },
];

type Equipment = {
  id: string; sku: string; name: string; category: string;
  qr_code?: string | null; model: string; serial_number: string;
  condition: string; location: string; daily_rate: number;
  quantity: number; available: number; notes: string; created_at?: string;
  reserved: number; on_rental: number; in_transit: number;
  checked_out: number; checked_out_to: string;
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
type SortKey = "qr_code" | "name" | "category" | "location" | "quantity" | "available" | "condition";

const blank: Partial<Equipment> = {
  sku: "", qr_code: "", model: "", serial_number: "", name: "", category: "tool", condition: "good",
  location: "Yard", daily_rate: 0, quantity: 1, available: 1, tracking_type: "serialized", notes: "",
};
const pretty = (value: string) => value.replace(/_/g, " ");

export default function EquipmentScreen() {
  const { isShellWide } = useBreakpoint();
  const { canEdit, canAdmin } = usePermissions();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const equipmentRes = useCachedResource<Equipment>("equipment", () => api<Equipment[]>("/equipment"));
  const maintenanceRes = useCachedResource<Maintenance>("maintenance", () => api<Maintenance[]>("/maintenance"));
  const rentalsRes = useCachedResource<Rental>("rentals", () => api<Rental[]>("/rentals"));
  const items = equipmentRes.data;
  const maintenance = maintenanceRes.data;
  const rentals = rentalsRes.data;
  const [cat, setCat] = useState("all");
  const [location, setLocation] = useState("all");
  const [condition, setCondition] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("qr_code");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [editing, setEditing] = useState<Partial<Equipment> | null>(null);
  const [selected, setSelected] = useState<Equipment | null>(null);
  const [deleting, setDeleting] = useState<Equipment | null>(null);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [checkoutTarget, setCheckoutTarget] = useState<Equipment | null>(null);
  const [checkoutAssignee, setCheckoutAssignee] = useState("");

  const refreshing = equipmentRes.refreshing || maintenanceRes.refreshing || rentalsRes.refreshing;
  const onRefresh = () => { equipmentRes.onRefresh(); maintenanceRes.onRefresh(); rentalsRes.onRefresh(); };

  useEffect(() => {
    if (!params.open || items.length === 0) return;
    setSelected(items.find((item) => item.id === params.open) || null);
  }, [params.open, items]);
  useEffect(() => {
    if (params.new) setEditing({ ...blank });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.new]);
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
      return [item.qr_code, item.name, item.model, item.serial_number, item.category, item.location, item.checked_out_to, item.condition, item.notes]
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
        sku: editing.sku || "", qr_code: editing.qr_code || null, model: editing.model || "", serial_number: editing.serial_number || "",
        name: editing.name || "", category: editing.category || "tool",
        condition: editing.condition || "good", location: editing.location || "",
        daily_rate: Number(editing.daily_rate) || 0, quantity: Number(editing.quantity) || 1,
        available: Number(editing.available ?? editing.quantity ?? 1), tracking_type: editing.tracking_type || (editing.category === "tool" ? "serialized" : "bulk"), notes: editing.notes || "",
      };
      if (editing.id) await api(`/equipment/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/equipment", { method: "POST", body: JSON.stringify(body) });
      setEditing(null); setSelected(null); equipmentRes.onRefresh();
    } catch (e: any) { Alert.alert("Save failed", e.message); }
  };
  const del = async () => {
    if (!deleting) return;
    try {
      await api(`/equipment/${deleting.id}`, { method: "DELETE" });
      setDeleting(null); setSelected(null); equipmentRes.onRefresh();
    } catch (e: any) { Alert.alert("Delete failed", e.message); }
  };
  // Checkout/checkin queue offline (see plan: this is field-work, done where
  // signal is worst) — mutate() applies the bucket change to the local cache
  // immediately and enqueues the request; it doesn't await a round-trip, so
  // there's nothing to catch here and no loading state to show.
  const checkout = () => {
    if (!checkoutTarget || !checkoutAssignee.trim()) return;
    const assignee = checkoutAssignee.trim();
    const target = checkoutTarget;
    const updated = mutate<Equipment>({
      kind: "command",
      entityType: "equipment",
      entityId: target.id,
      path: `/equipment/${target.id}/checkout`,
      method: "POST",
      body: { checked_out_to: assignee, qty: 1 },
      optimisticPatch: {
        available: Math.max(0, target.available - 1),
        checked_out: (target.checked_out || 0) + 1,
        checked_out_to: assignee,
        location: "",
      },
    });
    setCheckoutTarget(null); setCheckoutAssignee("");
    if (updated) setSelected(updated);
  };
  const checkin = (item: Equipment) => {
    const remaining = Math.max(0, (item.checked_out || 0) - 1);
    const updated = mutate<Equipment>({
      kind: "command",
      entityType: "equipment",
      entityId: item.id,
      path: `/equipment/${item.id}/checkin`,
      method: "POST",
      body: { qty: 1 },
      optimisticPatch: {
        available: item.available + 1,
        checked_out: remaining,
        checked_out_to: remaining ? item.checked_out_to : "",
        location: remaining === 0 ? "Yard" : "",
      },
    });
    if (updated) setSelected(updated);
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
      Alert.alert("Imported", `${result.imported} rows`); equipmentRes.onRefresh();
    } catch (e: any) { Alert.alert("Import failed", e.message); }
  };

  const columns = useMemo<ColumnDef<Equipment>[]>(() => [
    { key: "qr_code", label: "QR Code", width: 104, render: (item) => <Mono style={[styles.tableMono, !item.qr_code && styles.unassigned]}>{qrCodeDisplay(item)}</Mono> },
    { key: "name", label: "Equipment", flex: 1.4, render: (item) => item.name },
    { key: "model", label: "Model", width: 104, render: (item) => <Mono style={styles.tableMono}>{item.model || "—"}</Mono> },
    { key: "serial_number", label: "Serial", width: 112, render: (item) => <Mono style={styles.tableMono}>{item.serial_number || "—"}</Mono> },
    { key: "quantity", label: "Owned", width: 58, align: "right", render: (item) => <Mono style={styles.tableMono}>{item.quantity}</Mono> },
    { key: "available", label: "Available", width: 62, align: "right", render: (item) => <Mono style={[styles.tableMono, { color: item.available > 0 ? colors.success : colors.error, fontWeight: "700" }]}>{item.available}</Mono> },
    { key: "checked_out", label: "Checked Out", width: 82, align: "right", render: (item) => <Mono style={[styles.tableMono, item.checked_out > 0 && { color: colors.info, fontWeight: "700" }]}>{item.checked_out || 0}</Mono> },
    { key: "checked_out_to", label: "Foreman / Project", width: 124, render: (item) => <Text style={typo.bodySmall} numberOfLines={1}>{item.checked_out_to || "—"}</Text> },
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
    <Screen title="Equipment" subtitle={`${items.length} assets · ${items.reduce((sum, item) => sum + item.available, 0)} available`} back
      rightAction={canEdit ? { icon: "add", onPress: () => setEditing({ ...blank }), testID: "add-equipment-btn" } : undefined}
      onRefresh={onRefresh} refreshing={refreshing} testID="equipment-screen" scroll={!isShellWide}>
      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search QR code, tool, model, serial…" testID="equipment-search" style={{ flex: 1, maxWidth: 380 }} />
            {canEdit ? <Button title="Add Equipment" onPress={() => setEditing({ ...blank })} fullWidth={false} style={styles.toolbarButton} testID="add-equipment-btn" /> : null}
            <View style={styles.menuWrap}>
              <TouchableOpacity onPress={() => setShowFileMenu((visible) => !visible)} style={styles.overflowButton} testID="equipment-file-menu" accessibilityLabel="More equipment actions" accessibilityRole="button"><Ionicons name="ellipsis-horizontal" size={20} color={colors.ink} /></TouchableOpacity>
              {showFileMenu ? (
                <View style={styles.fileMenu}>
                  {canEdit ? <RequiresOnline><TouchableOpacity onPress={importCSV} style={styles.fileMenuItem} testID="import-csv-btn"><Ionicons name="cloud-upload-outline" size={17} color={colors.ink} /><Text style={typo.bodySmall}>Import CSV</Text></TouchableOpacity></RequiresOnline> : null}
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
            {canEdit ? <RequiresOnline><View style={{ flex: 1 }}><Button title="Import CSV" onPress={importCSV} variant="outline" testID="import-csv-btn" /></View></RequiresOnline> : null}
            <View style={{ flex: 1 }}><Button title="Export CSV" onPress={exportCSV} variant="outline" testID="export-csv-btn" /></View>
          </Row>
          {mobileItems.length === 0 ? <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No equipment in this category.</Text></Card> : mobileItems.map((item) => (
            <Card key={item.id} style={{ marginBottom: spacing.sm }} testID={`equipment-row-${item.sku}`}>
              <Row style={{ marginBottom: 4, gap: 8, alignItems: "flex-start" }}><View style={{ flex: 1 }}>
                <Mono style={[{ fontSize: 11, color: colors.inkMuted }, !item.qr_code && styles.unassigned]}>{equipmentIdentifier(item)}</Mono><H3>{item.name}</H3>
                {item.model || item.serial_number ? <Text style={[typo.bodySmall, { marginTop: 2 }]}>{item.model || "No model"}{item.serial_number ? ` · S/N ${item.serial_number}` : ""}</Text> : null}
                <Text style={[typo.label, { marginTop: 2 }]}>{pretty(item.category)} · {item.location || "—"}</Text>
                {item.checked_out_to ? <Text style={[typo.bodySmall, { color: colors.info, marginTop: 2 }]}>Checked out to {item.checked_out_to}</Text> : null}
              </View><Pill color={item.available > 0 ? colors.success : colors.error} bg={item.available > 0 ? colors.successSoft : colors.errorSoft}>{item.available}/{item.quantity}</Pill></Row>
              <Row style={{ gap: spacing.md, marginTop: 8 }}><Text style={typo.label}>Cond <Mono style={{ fontSize: 13 }}>{item.condition}</Mono></Text><Text style={typo.label}>Owned <Mono style={{ fontSize: 13 }}>{item.quantity}</Mono></Text></Row>
              <Row style={{ gap: spacing.md, marginTop: 6, flexWrap: "wrap" }}>
                <Text style={typo.label}>Resv <Mono style={{ fontSize: 13 }}>{item.reserved || 0}</Mono></Text>
                <Text style={typo.label}>Rental <Mono style={{ fontSize: 13 }}>{item.on_rental || 0}</Mono></Text>
                {item.in_maintenance > 0 ? <Text style={typo.label}>Maint <Mono style={{ fontSize: 13, color: colors.warning }}>{item.in_maintenance}</Mono></Text> : null}
                {item.missing > 0 ? <Text style={typo.label}>Missing <Mono style={{ fontSize: 13, color: colors.error }}>{item.missing}</Mono></Text> : null}
              </Row>
              {canEdit || canAdmin ? (
                <Row style={{ gap: spacing.sm, marginTop: spacing.sm }}>
                  {canEdit ? <View style={{ flex: 1 }}><Button title="Edit" onPress={() => setEditing(item)} variant="outline" testID={`edit-${item.sku}`} /></View> : null}
                  {canAdmin ? <RequiresOnline><View style={{ flex: 1 }}><Button title="Delete" onPress={() => setDeleting(item)} variant="danger" testID={`delete-${item.sku}`} /></View></RequiresOnline> : null}
                </Row>
              ) : null}
              {canEdit && item.category === "tool" ? <View style={{ marginTop: spacing.sm }}>{item.checked_out > 0 ? <Button title="Check In to Yard" onPress={() => checkin(item)} variant="outline" testID={`checkin-${item.sku}`} /> : <Button title="Check Out to Foreman" onPress={() => { setCheckoutTarget(item); setCheckoutAssignee(""); }} variant="outline" disabled={item.available <= 0} testID={`checkout-${item.sku}`} />}</View> : null}
            </Card>
          ))}
        </>
      )}

      <DetailDrawer visible={!!selected} title={selected?.name || "Equipment"} subtitle={selected ? `${equipmentIdentifier(selected)} · ${pretty(selected.category)}` : undefined}
        onClose={() => { setSelected(null); setCheckoutTarget(null); }} testID="equipment-detail-drawer"
        headerActions={selected && canEdit ? <TouchableOpacity onPress={() => setEditing(selected)} style={styles.drawerEdit} testID={`edit-${selected.sku}`} accessibilityLabel="Edit equipment" accessibilityRole="button"><Ionicons name="create-outline" size={18} color={colors.primary} /><Text style={styles.drawerEditText}>Edit</Text></TouchableOpacity> : null}>
        {selected ? <>
          <SectionLabel>Tool identity</SectionLabel>
          <View style={styles.detailGrid}><DetailStat label="QR Code" value={qrCodeDisplay(selected)} mono /><DetailStat label="Model" value={selected.model || "—"} mono /><DetailStat label="Serial number" value={selected.serial_number || "—"} mono /></View>
          <SectionLabel>Inventory</SectionLabel>
          <View style={styles.detailGrid}><DetailStat label="Location" value={selected.location || (selected.checked_out ? "Field" : "—")} /><DetailStat label="Foreman / project" value={selected.checked_out_to || "Not checked out"} /><DetailStat label="Condition" value={pretty(selected.condition)} badge /><DetailStat label="Owned" value={String(selected.quantity)} mono /><DetailStat label="Available" value={String(selected.available)} mono /><DetailStat label="Checked out" value={String(selected.checked_out || 0)} mono /><DetailStat label="Reserved" value={String(selected.reserved || 0)} mono /><DetailStat label="On rental" value={String(selected.on_rental || 0)} mono /><DetailStat label="In transit" value={String(selected.in_transit || 0)} mono /><DetailStat label="Pending inspection" value={String(selected.pending_inspection || 0)} mono /><DetailStat label="Maintenance" value={String(selected.in_maintenance || 0)} mono /><DetailStat label="Missing" value={String(selected.missing || 0)} mono /></View>
          {canEdit && selected.category === "tool" ? selected.checked_out > 0 ? <Button title="Check In to Yard" onPress={() => checkin(selected)} variant="outline" testID={`checkin-${selected.sku}`} /> : checkoutTarget?.id === selected.id ? (
            <View style={styles.checkoutForm} testID="tool-checkout-form">
              <Input label="Project Foreman / Project" value={checkoutAssignee} onChangeText={setCheckoutAssignee} placeholder="Who is accountable for this tool?" testID="checkout-assignee" />
              <Row style={{ gap: spacing.sm }}><View style={{ flex: 1 }}><Button title="Cancel" onPress={() => setCheckoutTarget(null)} variant="outline" testID="cancel-tool-checkout" /></View><View style={{ flex: 1 }}><Button title="Confirm Checkout" onPress={checkout} disabled={!checkoutAssignee.trim()} testID="confirm-tool-checkout" /></View></Row>
            </View>
          ) : <Button title="Check Out to Foreman" onPress={() => { setCheckoutTarget(selected); setCheckoutAssignee(""); }} variant="outline" disabled={selected.available <= 0} testID={`checkout-${selected.sku}`} /> : null}
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
          {selectedMaintenance.length ? selectedMaintenance.map((entry) => <View key={entry.id} style={styles.historyRow}><View style={{ flex: 1 }}><Text style={typo.h3}>{entry.issue}</Text><Text style={typo.bodySmall}>{entry.action_taken || "No action recorded"} · {new Date(entry.created_at).toLocaleDateString()}</Text></View><View style={{ alignItems: "flex-end", gap: 4 }}><StatusBadge label={entry.status} />{canEdit ? <Mono style={styles.tableMono}>${entry.cost.toFixed(2)}</Mono> : null}</View></View>) : <Text style={[typo.bodySmall, styles.detailText]}>No maintenance history for this item.</Text>}
          {canAdmin ? <RequiresOnline><Button title="Delete Equipment" onPress={() => setDeleting(selected)} variant="danger" testID={`delete-${selected.sku}`} /></RequiresOnline> : null}
        </> : null}
      </DetailDrawer>

      <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
        <Screen title={editing?.id ? "Edit Equipment" : "Add Equipment"} back rightAction={{ icon: "close", onPress: () => setEditing(null), testID: "close-edit" }} testID="equipment-edit-screen">
          <Input label="QR Code" value={editing?.qr_code || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, qr_code: text }))} mono keyboardType="number-pad" testID="edit-sku" />
          <Input label="Name" value={editing?.name || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, name: text }))} testID="edit-name" />
          <Input label="Model" value={editing?.model || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, model: text }))} mono testID="edit-model" />
          <Input label="Serial Number" value={editing?.serial_number || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, serial_number: text }))} mono testID="edit-serial-number" />
          <SectionLabel>Category</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>{CATEGORIES.filter((category) => category.key !== "all").map((category) => <TouchableOpacity key={category.key} onPress={() => setEditing((entry) => ({ ...entry!, category: category.key }))} style={[styles.chip, editing?.category === category.key && styles.chipActive]} testID={`edit-cat-${category.key}`}><Text style={[styles.chipText, editing?.category === category.key && { color: colors.inverse }]}>{category.label}</Text></TouchableOpacity>)}</ScrollView>
          <Input label="Condition" value={editing?.condition || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, condition: text }))} testID="edit-condition" />
          <Input label="Location" value={editing?.location || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, location: text }))} testID="edit-location" />
          <Input label="Quantity" value={String(editing?.quantity ?? "")} onChangeText={(text) => setEditing((entry) => ({ ...entry!, quantity: Number(text) || 0, available: Number(text) || 0 }))} keyboardType="number-pad" mono testID="edit-quantity" />
          <Input label="Available" value={String(editing?.available ?? "")} onChangeText={(text) => setEditing((entry) => ({ ...entry!, available: Number(text) || 0 }))} keyboardType="number-pad" mono testID="edit-available" />
          <Input label="Notes" value={editing?.notes || ""} onChangeText={(text) => setEditing((entry) => ({ ...entry!, notes: text }))} testID="edit-notes" />
          <RequiresOnline><Button title="Save" onPress={save} testID="save-equipment-btn" /></RequiresOnline>
        </Screen>
      </Modal>
      <Modal visible={!!checkoutTarget && !isShellWide} animationType="slide" onRequestClose={() => setCheckoutTarget(null)}>
        <Screen title="Check Out Tool" subtitle={checkoutTarget ? `${equipmentIdentifier(checkoutTarget)} · ${checkoutTarget.name}` : undefined} back rightAction={{ icon: "close", onPress: () => setCheckoutTarget(null), testID: "close-checkout" }} testID="tool-checkout-screen">
          <Input label="Project Foreman / Project" value={checkoutAssignee} onChangeText={setCheckoutAssignee} placeholder="Who is accountable for this tool?" testID="checkout-assignee" />
          <Button title="Confirm Checkout" onPress={checkout} disabled={!checkoutAssignee.trim()} testID="confirm-tool-checkout" />
        </Screen>
      </Modal>
      <ConfirmDialog visible={!!deleting} title="Delete equipment?" message={deleting ? `${equipmentIdentifier(deleting)} — ${deleting.name} will be permanently removed.` : undefined} confirmLabel="Delete" onConfirm={del} onCancel={() => setDeleting(null)} testID="delete-equipment-confirm" />
    </Screen>
  );
}

const DetailStat = ({ label, value, mono, badge }: { label: string; value: string; mono?: boolean; badge?: boolean }) => (
  <View style={styles.detailStat}><Text style={typo.caption}>{label}</Text>{badge ? <StatusBadge label={value} /> : mono ? <Mono style={{ fontSize: 16 }}>{value}</Mono> : <Text style={typo.body}>{value}</Text>}</View>
);
const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg }, toolbarButton: { height: 40 }, menuWrap: { position: "relative", zIndex: 10 },
  checkoutForm: { marginTop: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.bgMuted },
  overflowButton: { width: 40, height: 40, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radii.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  fileMenu: { position: "absolute", top: 44, right: 0, width: 168, paddingVertical: spacing.xs, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.bg, zIndex: 20 },
  fileMenuItem: { minHeight: 40, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  filterStack: { paddingHorizontal: spacing.xl, gap: spacing.xs, paddingBottom: spacing.md },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" }, tableMono: { fontSize: 12 }, unassigned: { color: colors.warning, fontStyle: "italic" },
  chip: { paddingHorizontal: 14, height: 36, justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, flexShrink: 0 }, chipActive: { backgroundColor: colors.ink, borderColor: colors.ink }, chipText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
  drawerEdit: { height: 32, paddingHorizontal: spacing.sm, flexDirection: "row", alignItems: "center", gap: 4 }, drawerEditText: { ...typo.label, color: colors.primary },
  detailGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -spacing.xs, marginBottom: spacing.lg }, detailStat: { width: "50%", padding: spacing.xs, gap: 4 }, detailText: { marginBottom: spacing.lg },
  historyRow: { flexDirection: "row", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: spacing.sm },
  breakdownRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  breakdownQty: { fontSize: 14, fontWeight: "700", color: colors.ink, minWidth: 32, textAlign: "right" },
  breakdownDash: { fontSize: 13, color: colors.inkMuted },
});

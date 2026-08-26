import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, Platform, FlatList } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Screen } from "@/src/components/Screen";
import { Input, Button, Mono, SectionLabel, Row } from "@/src/components/ui";
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
import { api, apiUpload } from "@/src/api/client";
import { equipmentIdentifier, qrCodeDisplay } from "@/src/utils/equipment-identifier";
import { familyOptionsFor, matchesEquipmentFamily, matchesEquipmentTab } from "@/src/utils/equipment-taxonomy";
import type { EquipmentTab } from "@/src/utils/equipment-taxonomy";
import { colors, radii, spacing, type as typo } from "@/src/theme";

const EQUIPMENT_TABS = [
  { key: "all", label: "All" },
  { key: "tool", label: "Tools" },
  { key: "bracing", label: "Bracing" },
  { key: "icf_block", label: "ICF Block" },
];

const EQUIPMENT_CATEGORIES = [
  { key: "strongback", label: "SB · Stiffback" },
  { key: "turnbuckle", label: "TB · Turnbuckle" },
  { key: "walkboard_bracket", label: "WBB · Walk-Board Bracket" },
  { key: "hand_rail", label: "HR · Handrail" },
  { key: "tb_extension", label: "EXT · Extension" },
  { key: "crankup_scaffold", label: "Scaffold" },
  { key: "shoring_post", label: "Shoring Post" },
  { key: "tool", label: "Tools" },
  { key: "icf_block_nudura", label: "Nudura ICF Block" },
  { key: "icf_block_foxblocks", label: "FoxBlocks ICF Block" },
  { key: "icf_block_amvic", label: "Amvic ICF Block" },
  { key: "icf_block_buildblock", label: "BuildBlock ICF Block" },
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
  const [tab, setTab] = useState<EquipmentTab>("all");
  const [family, setFamily] = useState("all");
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

  const mobileItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      if (!matchesEquipmentTab(item, tab) || !matchesEquipmentFamily(item, tab, family)) return false;
      if (!query) return true;
      return [item.qr_code, item.name, item.model, item.serial_number, item.category, item.location, item.checked_out_to, item.condition, item.notes]
        .some((value) => value?.toLowerCase().includes(query));
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  }, [family, items, search, tab]);
  const conditionOptions = useMemo(() => [
    { key: "all", label: "All conditions" },
    ...Array.from(new Set(items.map((item) => item.condition).filter(Boolean))).sort().map((value) => ({ key: value, label: pretty(value) })),
  ], [items]);
  const desktopItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rows = items.filter((item) => {
      if (!matchesEquipmentTab(item, tab) || !matchesEquipmentFamily(item, tab, family)) return false;
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
  }, [availability, condition, family, items, search, sortDirection, sortKey, tab]);

  const changeTab = (nextTab: string) => {
    setTab(nextTab as EquipmentTab);
    setFamily("all");
  };

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
      const text = await api<string>("/equipment/export.csv");
      if (Platform.OS === "web") {
        const blob = new Blob([text], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "equipment.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      } else {
        const directory = FileSystem.cacheDirectory || FileSystem.documentDirectory;
        if (!directory) throw new Error("A writable export folder is not available on this device.");
        const path = `${directory}equipment.csv`;
        await FileSystem.writeAsStringAsync(path, text, { encoding: FileSystem.EncodingType.UTF8 });
        if (!(await Sharing.isAvailableAsync())) throw new Error("File sharing is not available on this device.");
        await Sharing.shareAsync(path, { mimeType: "text/csv", dialogTitle: "Export equipment CSV" });
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
      if (Platform.OS === "web") {
        let webFile: Blob | undefined = file.file;
        if (!webFile) webFile = await fetch(file.uri).then((response) => response.blob());
        if (!webFile) throw new Error("The selected CSV could not be read.");
        form.append("file", webFile, file.name || "equipment.csv");
      } else {
        // React Native FormData accepts a local URI descriptor for native uploads.
        form.append("file", { uri: file.uri, name: file.name || "equipment.csv", type: file.mimeType || "text/csv" } as any);
      }
      const result = await apiUpload<{ imported: number; skipped?: number; errors?: string[] }>("/equipment/import.csv", form);
      const skipped = result.skipped || 0;
      Alert.alert(
        skipped ? "Imported with warnings" : "Import complete",
        `${result.imported} row${result.imported === 1 ? "" : "s"} imported${skipped ? `; ${skipped} skipped.\n${result.errors?.[0] || ""}` : ""}`,
      );
      equipmentRes.onRefresh();
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
      onRefresh={onRefresh} refreshing={refreshing} testID="equipment-screen" scroll={false}>
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
            <FilterChips options={EQUIPMENT_TABS} value={tab} onChange={changeTab} testIDPrefix="equipment-tab" />
            {tab !== "all" ? <FilterChips options={familyOptionsFor(tab)} value={family} onChange={setFamily} testIDPrefix={`${tab}-family`} /> : null}
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
        <FlatList<Equipment>
          data={mobileItems}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.mobileListContent}
          refreshing={refreshing}
          onRefresh={onRefresh}
          ListHeaderComponent={<View style={styles.mobileListHeader}>
            <View style={styles.mobileTabs}>
              {EQUIPMENT_TABS.map((option) => (
                <TouchableOpacity key={option.key} onPress={() => changeTab(option.key)} style={[styles.mobileTab, tab === option.key && styles.mobileTabActive]} testID={`equipment-tab-${option.key}`} accessibilityRole="tab" accessibilityState={{ selected: tab === option.key }}>
                  <Text style={[styles.mobileTabText, tab === option.key && styles.mobileTabTextActive]}>{option.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {tab !== "all" ? <FilterChips options={familyOptionsFor(tab)} value={family} onChange={setFamily} testIDPrefix={`${tab}-family`} /> : null}
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search equipment…" testID="equipment-search" style={styles.mobileSearch} />
            <Row style={{ gap: spacing.sm }}>
              {canEdit ? <RequiresOnline><View style={{ flex: 1 }}><Button title="Import CSV" onPress={importCSV} variant="outline" testID="import-csv-btn" /></View></RequiresOnline> : null}
              <View style={{ flex: 1 }}><Button title="Export CSV" onPress={exportCSV} variant="outline" testID="export-csv-btn" /></View>
            </Row>
          </View>}
          ListEmptyComponent={<View style={styles.mobileEmpty}><Ionicons name="construct-outline" size={24} color={colors.inkMuted} /><Text style={styles.mobileEmptyText}>No equipment matches this view.</Text></View>}
          ItemSeparatorComponent={() => <View style={styles.mobileSeparator} />}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => setSelected(item)} style={styles.mobileRow} testID={`equipment-row-${item.sku}`} accessibilityRole="button" accessibilityLabel={`Open ${item.name}`}>
              <View style={styles.mobileIdentity}>
                <Text style={styles.mobileName} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.mobileMeta} numberOfLines={1}>{item.model || "No model"} · {item.location || "No location"} · {equipmentIdentifier(item)}</Text>
                {item.checked_out_to ? <Text style={styles.mobileAssignment} numberOfLines={1}>Checked out to {item.checked_out_to}</Text> : null}
              </View>
              <View style={styles.mobileCounts}>
                <Mono style={[styles.mobileAvailable, { color: item.available > 0 ? colors.success : colors.inkMuted }]}>{item.available}</Mono>
                <Text style={styles.mobileCountLabel}>available</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.inkMuted} />
            </TouchableOpacity>
          )}
        />
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
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>{EQUIPMENT_CATEGORIES.map((category) => <TouchableOpacity key={category.key} onPress={() => setEditing((entry) => ({ ...entry!, category: category.key }))} style={[styles.chip, editing?.category === category.key && styles.chipActive]} testID={`edit-cat-${category.key}`}><Text style={[styles.chipText, editing?.category === category.key && { color: colors.inverse }]}>{category.label}</Text></TouchableOpacity>)}</ScrollView>
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
  mobileListContent: { paddingHorizontal: spacing.lg, paddingBottom: 80, flexGrow: 1 },
  mobileListHeader: { paddingTop: spacing.md, paddingBottom: spacing.md, gap: spacing.md },
  mobileTabs: { flexDirection: "row", padding: 3, backgroundColor: colors.bgMuted, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border },
  mobileTab: { flex: 1, minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
  mobileTabActive: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.borderStrong },
  mobileTabText: { ...typo.label, color: colors.inkSecondary }, mobileTabTextActive: { color: colors.primary },
  mobileSearch: { minWidth: 0, width: "100%" },
  mobileRow: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm },
  mobileIdentity: { flex: 1, minWidth: 0 }, mobileName: { ...typo.h3, fontSize: 15 },
  mobileMeta: { ...typo.bodySmall, marginTop: 3 }, mobileAssignment: { ...typo.bodySmall, color: colors.info, marginTop: 2 },
  mobileCounts: { minWidth: 62, alignItems: "flex-end" }, mobileAvailable: { fontSize: 18, fontWeight: "700" },
  mobileCountLabel: { ...typo.caption, fontSize: 9, letterSpacing: 0.3 }, mobileRental: { ...typo.label, color: colors.info, marginTop: 2 },
  mobileSeparator: { height: 1, backgroundColor: colors.border },
  mobileEmpty: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", gap: spacing.sm }, mobileEmptyText: { ...typo.body, color: colors.inkMuted },
  drawerEdit: { height: 32, paddingHorizontal: spacing.sm, flexDirection: "row", alignItems: "center", gap: 4 }, drawerEditText: { ...typo.label, color: colors.primary },
  detailGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -spacing.xs, marginBottom: spacing.lg }, detailStat: { width: "50%", padding: spacing.xs, gap: 4 }, detailText: { marginBottom: spacing.lg },
  historyRow: { flexDirection: "row", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: spacing.sm },
  breakdownRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  breakdownQty: { fontSize: 14, fontWeight: "700", color: colors.ink, minWidth: 32, textAlign: "right" },
  breakdownDash: { fontSize: 13, color: colors.inkMuted },
});

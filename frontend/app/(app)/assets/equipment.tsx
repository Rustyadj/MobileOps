// Equipment — searchable/sortable DataTable + DetailDrawer on desktop,
// cards on phone. CSV import/export moved into a toolbar overflow menu
// instead of consuming prime page real estate.
import { useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card, Mono, Row, H3, Button } from "@/src/components/ui";
import { PageHeader } from "@/src/components/layout/PageHeader";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { PageBody } from "@/src/components/layout/PageBody";
import { SearchInput } from "@/src/components/data/SearchInput";
import { FilterChips } from "@/src/components/data/FilterBar";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { EmptyState } from "@/src/components/feedback/EmptyState";
import { LoadingState } from "@/src/components/feedback/LoadingState";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useEquipment, Equipment, CATEGORIES, blankEquipment } from "@/src/features/equipment/useEquipment";
import { EquipmentDetailDrawer } from "@/src/features/equipment/EquipmentDetailDrawer";
import { EquipmentForm } from "@/src/features/equipment/EquipmentForm";
import { colors, spacing, type as typo, radii } from "@/src/theme";

type AvailFilter = "all" | "available" | "out";
const AVAIL_FILTERS: { key: AvailFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "available", label: "Available" },
  { key: "out", label: "Out of stock" },
];

export default function EquipmentScreen() {
  const { isShellWide } = useBreakpoint();
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const { items, maintenance, rentalUsage, loading, refreshing, load, refresh, save, del, exportCSV, importCSV } = useEquipment();

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [availFilter, setAvailFilter] = useState<AvailFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Equipment> | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (params.open) setSelectedId(String(params.open));
    if (params.new === "1") openNew();
  }, [params.open, params.new]);

  const openNew = () => { setEditing({ ...blankEquipment }); setFormOpen(true); };
  const openEdit = (it: Equipment) => { setSelectedId(null); setEditing(it); setFormOpen(true); };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (category !== "all" && it.category !== category) return false;
      if (availFilter === "available" && it.available <= 0) return false;
      if (availFilter === "out" && it.available > 0) return false;
      if (q && !it.name.toLowerCase().includes(q) && !it.sku.toLowerCase().includes(q) && !it.location.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, category, availFilter, search]);

  const selected = items.find((i) => i.id === selectedId) || null;
  const hasOpenService = (id: string) => maintenance.some((m) => m.equipment_id === id && m.status !== "resolved");

  const handleImport = async () => {
    setMenuOpen(false);
    setImporting(true);
    try {
      const n = await importCSV();
      if (n != null) Alert.alert("Imported", `${n} rows`);
    } catch (e: any) { Alert.alert("Import failed", e.message); }
    finally { setImporting(false); }
  };
  const handleExport = async () => {
    setMenuOpen(false);
    try { await exportCSV(); }
    catch (e: any) { Alert.alert("Export failed", e.message); }
  };

  const columns: ColumnDef<Equipment>[] = [
    { key: "sku", label: "SKU", width: 100, render: (it) => <Mono style={{ fontSize: 12 }}>{it.sku}</Mono> },
    { key: "name", label: "Equipment", flex: 2, render: (it) => (
      <View>
        <Text style={typo.body} numberOfLines={1}>{it.name}</Text>
        <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{it.category.replace(/_/g, " ")}</Text>
      </View>
    ) },
    { key: "location", label: "Location", flex: 1, render: (it) => it.location || "—" },
    { key: "quantity", label: "Total", width: 70, align: "right", render: (it) => <Mono>{it.quantity}</Mono> },
    { key: "available", label: "Available", width: 90, align: "right", render: (it) => (
      <Mono style={{ color: it.available > 0 ? colors.success : colors.error, fontWeight: "700" }}>{it.available}</Mono>
    ) },
    { key: "rate", label: "Rate", width: 80, align: "right", render: (it) => <Mono>${it.daily_rate}</Mono> },
    { key: "maint", label: "Service", width: 90, align: "center", render: (it) => hasOpenService(it.id) ? <Ionicons name="build" size={15} color={colors.warning} /> : null },
  ];

  if (loading) {
    return <Screen title="Equipment" back testID="equipment-screen"><LoadingState label="Loading equipment…" /></Screen>;
  }

  const desktopHeader = (
    <PageHeader
      title="Equipment"
      subtitle={`${items.length} SKUs · ${items.reduce((s, i) => s + i.available, 0)} avail`}
      actions={
        <Row style={{ gap: spacing.sm }}>
          <View>
            <Button title="⋯" onPress={() => setMenuOpen((o) => !o)} variant="outline" fullWidth={false} style={{ width: 44, height: 38 }} testID="equipment-menu-btn" />
            {menuOpen ? (
              <>
                <TouchableOpacity style={{ position: "absolute", top: 44, right: 0, width: 400, height: 0 }} activeOpacity={1} onPress={() => setMenuOpen(false)} />
                <View style={styles.menu} testID="equipment-menu">
                  <TouchableOpacity onPress={handleImport} style={styles.menuItem} testID="import-csv-btn"><Ionicons name="cloud-upload-outline" size={16} color={colors.ink} /><Text style={styles.menuText}>{importing ? "Importing…" : "Import CSV"}</Text></TouchableOpacity>
                  <TouchableOpacity onPress={handleExport} style={styles.menuItem} testID="export-csv-btn"><Ionicons name="cloud-download-outline" size={16} color={colors.ink} /><Text style={styles.menuText}>Export CSV</Text></TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>
          <Button title="+ New Equipment" onPress={openNew} testID="add-equipment-btn" fullWidth={false} style={{ backgroundColor: colors.accent, borderColor: colors.accent, height: 38, paddingHorizontal: 16 }} />
        </Row>
      }
    />
  );

  return (
    <Screen
      title="Equipment"
      subtitle={`${items.length} SKUs · ${items.reduce((s, i) => s + i.available, 0)} avail`}
      back
      rightAction={{ icon: "add", onPress: openNew, testID: "add-equipment-btn" }}
      onRefresh={refresh}
      refreshing={refreshing}
      scroll={isShellWide ? false : true}
      desktopHeader={desktopHeader}
      testID="equipment-screen"
    >
      <PageToolbar>
        <SearchInput value={search} onChangeText={setSearch} placeholder="Search SKU, name, location…" testID="equipment-search" />
        <FilterChips options={CATEGORIES} value={category} onChange={setCategory} testIDPrefix="cat" />
        <FilterChips options={AVAIL_FILTERS} value={availFilter} onChange={(k) => setAvailFilter(k as AvailFilter)} testIDPrefix="avail" />
      </PageToolbar>

      {!isShellWide ? (
        <PageToolbar>
          <View style={{ flex: 1 }}><Button title="Import CSV" onPress={handleImport} variant="outline" loading={importing} testID="import-csv-btn" /></View>
          <View style={{ flex: 1 }}><Button title="Export CSV" onPress={handleExport} variant="outline" testID="export-csv-btn" /></View>
        </PageToolbar>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState icon="cube-outline" title="No equipment matches" subtitle={items.length === 0 ? "Add your first SKU to get started." : "Try a different filter or search."} actionLabel={items.length === 0 ? "Add Equipment" : undefined} onAction={items.length === 0 ? openNew : undefined} testID="equipment-empty" />
      ) : isShellWide ? (
        <View style={{ flex: 1, paddingHorizontal: spacing.xl }}>
          <DataTable columns={columns} rows={filtered} keyExtractor={(it) => it.id} onRowPress={(it) => setSelectedId(it.id)} rowTestID={(it) => `equipment-row-${it.sku}`} selectedId={selectedId} />
        </View>
      ) : (
        <PageBody scroll={false} testID="equipment-list">
          {filtered.map((it) => (
            <TouchableOpacity key={it.id} onPress={() => setSelectedId(it.id)} activeOpacity={0.7} testID={`equipment-row-${it.sku}`}>
              <Card style={{ marginBottom: spacing.sm }}>
                <Row style={{ marginBottom: 4, gap: 8, alignItems: "flex-start" }}>
                  <View style={{ flex: 1 }}>
                    <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{it.sku}</Mono>
                    <H3>{it.name}</H3>
                    <Text style={[typo.label, { marginTop: 2 }]}>{it.category.replace(/_/g, " ")} · {it.location || "—"}</Text>
                  </View>
                  <StatusBadge label={it.available > 0 ? `${it.available}/${it.quantity}` : "0 avail"} tone={it.available > 0 ? "success" : "error"} />
                </Row>
                <Row style={{ gap: spacing.md, marginTop: 8 }}>
                  <Text style={typo.label}>Cond <Mono style={{ fontSize: 13 }}>{it.condition}</Mono></Text>
                  <Text style={typo.label}>Rate <Mono style={{ fontSize: 13 }}>${it.daily_rate}/d</Mono></Text>
                  {hasOpenService(it.id) ? <Row style={{ gap: 4 }}><Ionicons name="build" size={13} color={colors.warning} /><Text style={{ fontSize: 11, color: colors.warning, fontWeight: "700" }}>Service</Text></Row> : null}
                </Row>
              </Card>
            </TouchableOpacity>
          ))}
        </PageBody>
      )}

      <EquipmentDetailDrawer
        item={selected}
        maintenance={maintenance}
        rentalUsage={selected ? rentalUsage[selected.id] || [] : []}
        onClose={() => { setSelectedId(null); if (params.open) router.setParams({ open: undefined }); }}
        onEdit={openEdit}
        onDelete={del}
      />

      <EquipmentForm
        visible={formOpen}
        editing={editing}
        setEditing={setEditing}
        onClose={() => { setFormOpen(false); setEditing(null); if (params.new) router.setParams({ new: undefined }); }}
        onSave={async () => { await save(editing!); setFormOpen(false); setEditing(null); }}
      />
    </Screen>
  );
}

const styles = {
  menu: {
    position: "absolute" as const, top: 44, right: 0, width: 180, zIndex: 100,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    paddingVertical: 4,
  },
  menuItem: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  menuText: { fontSize: 13, color: colors.ink, fontWeight: "600" as const },
};

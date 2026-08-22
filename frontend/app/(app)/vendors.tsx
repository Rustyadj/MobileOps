import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, Modal, Alert, ScrollView, TouchableOpacity, Linking, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Pill, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { SearchInput } from "@/src/components/data/SearchInput";
import { FilterChips } from "@/src/components/data/FilterBar";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo, radii } from "@/src/theme";

type Vendor = {
  id: string; name: string; contact_name: string; phone: string; email: string; address: string;
  categories: string[]; freight_terms: string; truck_capacity: string; lead_time_days: number; notes: string;
};
type VendorSortKey = "name" | "contact_name" | "lead_time_days" | "freight_terms";

const CAT_OPTIONS = ["NUDURA", "Fox", "Amvic", "BuildBlock", "Standard"];

export default function VendorsScreen() {
  const { isShellWide } = useBreakpoint();
  const params = useLocalSearchParams<{ open?: string }>();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [editing, setEditing] = useState<Partial<Vendor> | null>(null);
  const [selected, setSelected] = useState<Vendor | null>(null);
  const [deleting, setDeleting] = useState<Vendor | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [sortKey, setSortKey] = useState<VendorSortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setVendors(await api<Vendor[]>("/vendors")); } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!params.open) return;
    const match = vendors.find((vendor) => vendor.id === params.open);
    if (match) setSelected(match);
  }, [params.open, vendors]);

  const categoryOptions = useMemo(() => [
    { key: "all", label: "All categories" },
    ...Array.from(new Set(vendors.flatMap((vendor) => vendor.categories))).sort().map((value) => ({ key: value, label: value })),
  ], [vendors]);
  const visibleVendors = useMemo(() => {
    const query = search.trim().toLowerCase();
    return vendors.filter((vendor) => {
      if (category !== "all" && !vendor.categories.includes(category)) return false;
      if (!query) return true;
      return [vendor.name, vendor.contact_name, vendor.phone, vendor.email, vendor.address, vendor.freight_terms, vendor.notes, ...vendor.categories].some((value) => value?.toLowerCase().includes(query));
    }).sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const compared = typeof av === "number" && typeof bv === "number" ? av - bv : String(av || "").localeCompare(String(bv || ""), undefined, { numeric: true, sensitivity: "base" });
      return sortDirection === "asc" ? compared : -compared;
    });
  }, [category, search, sortDirection, sortKey, vendors]);

  const handleSort = (key: string) => {
    if (key === sortKey) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else { setSortKey(key as VendorSortKey); setSortDirection("asc"); }
  };

  const save = async () => {
    if (!editing?.name) { Alert.alert("Required", "Vendor name"); return; }
    try {
      const body = {
        name: editing.name || "", contact_name: editing.contact_name || "", phone: editing.phone || "", email: editing.email || "", address: editing.address || "",
        categories: editing.categories || [], freight_terms: editing.freight_terms || "", truck_capacity: editing.truck_capacity || "", lead_time_days: Number(editing.lead_time_days) || 0,
        notes: editing.notes || "",
      };
      if (editing.id) await api(`/vendors/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/vendors", { method: "POST", body: JSON.stringify(body) });
      setEditing(null); setSelected(null); load();
    } catch (e: any) { Alert.alert("Save failed", e.message); }
  };

  const del = async () => {
    if (!deleting) return;
    try { await api(`/vendors/${deleting.id}`, { method: "DELETE" }); setDeleting(null); setSelected(null); load(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  const toggleCat = (value: string) => {
    setEditing((vendor) => {
      const current = vendor?.categories || [];
      return { ...vendor!, categories: current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value] };
    });
  };

  const columns = useMemo<ColumnDef<Vendor>[]>(() => [
    { key: "name", label: "Vendor", flex: 1.35, render: (vendor) => <Text style={styles.primaryCell} numberOfLines={1}>{vendor.name}</Text> },
    { key: "contact_name", label: "Contact", flex: 1, render: (vendor) => vendor.contact_name || "—" },
    { key: "categories", label: "Categories", flex: 1.35, render: (vendor) => <Text style={styles.tableText} numberOfLines={1}>{vendor.categories.join(", ") || "—"}</Text> },
    { key: "phone", label: "Phone / Email", flex: 1.45, render: (vendor) => <View><Mono style={styles.tableMono}>{vendor.phone || "—"}</Mono><Text style={styles.secondaryCell} numberOfLines={1}>{vendor.email}</Text></View> },
    { key: "freight_terms", label: "Freight", flex: 1, render: (vendor) => vendor.freight_terms || "—" },
    { key: "truck_capacity", label: "Truck cap.", width: 105, render: (vendor) => <Mono style={styles.tableMono}>{vendor.truck_capacity || "—"}</Mono> },
    { key: "lead_time_days", label: "Lead", width: 78, align: "right", render: (vendor) => <StatusBadge label={`${vendor.lead_time_days}d`} tone={vendor.lead_time_days > 14 ? "warning" : "neutral"} /> },
  ], []);

  return (
    <Screen title="Vendors" subtitle={`${vendors.length} ICF suppliers`} back rightAction={{ icon: "add", onPress: () => setEditing({ name: "", categories: [] }), testID: "new-vendor-btn" }}
      onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} refreshing={refreshing} testID="vendors-screen" scroll={!isShellWide}>
      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search vendor, contact, category…" testID="vendors-search" style={{ flex: 1, maxWidth: 390 }} />
            <Button title="New Vendor" onPress={() => setEditing({ name: "", categories: [] })} fullWidth={false} style={styles.toolbarButton} testID="new-vendor-btn" />
          </PageToolbar>
          <View style={styles.filters}><FilterChips options={categoryOptions} value={category} onChange={setCategory} testIDPrefix="vendor-category" /></View>
          <View style={styles.tableWrap}><DataTable columns={columns} rows={visibleVendors} keyExtractor={(vendor) => vendor.id} rowTestID={(vendor) => `vendor-${vendor.id}`} onRowPress={setSelected} selectedId={selected?.id} sortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} emptyLabel="No vendors match these filters." /></View>
        </View>
      ) : vendors.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No vendors yet.</Text></Card>
      ) : vendors.map((vendor) => (
        <Card key={vendor.id} style={{ marginBottom: spacing.sm }} testID={`vendor-${vendor.id}`}>
          <H3>{vendor.name}</H3>{vendor.contact_name ? <Text style={[typo.label, { marginTop: 2 }]}>{vendor.contact_name}</Text> : null}
          <Row style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>{vendor.categories.map((value) => <Pill key={value}>{value}</Pill>)}</Row>
          {(vendor.phone || vendor.email) ? <Row style={{ marginTop: 10, gap: spacing.md }}>{vendor.phone ? <TouchableOpacity onPress={() => Linking.openURL(`tel:${vendor.phone}`)} testID={`call-${vendor.id}`}><Row style={{ gap: 4 }}><Ionicons name="call-outline" size={14} color={colors.accent} /><Mono style={{ fontSize: 12 }}>{vendor.phone}</Mono></Row></TouchableOpacity> : null}{vendor.email ? <TouchableOpacity onPress={() => Linking.openURL(`mailto:${vendor.email}`)} testID={`email-${vendor.id}`}><Row style={{ gap: 4 }}><Ionicons name="mail-outline" size={14} color={colors.accent} /><Mono style={{ fontSize: 12 }}>{vendor.email}</Mono></Row></TouchableOpacity> : null}</Row> : null}
          <Row style={{ gap: spacing.sm, marginTop: spacing.sm }}><View style={{ flex: 1 }}><Button title="Edit" onPress={() => setEditing(vendor)} variant="outline" testID={`edit-vendor-${vendor.id}`} /></View><View style={{ flex: 1 }}><Button title="Delete" onPress={() => setDeleting(vendor)} variant="danger" testID={`del-vendor-${vendor.id}`} /></View></Row>
        </Card>
      ))}

      <DetailDrawer visible={!!selected} title={selected?.name || "Vendor"} subtitle={selected?.contact_name || "Supplier"} onClose={() => setSelected(null)} testID="vendor-detail-drawer"
        headerActions={selected ? <TouchableOpacity onPress={() => setEditing(selected)} style={styles.drawerAction} testID={`edit-vendor-${selected.id}`}><Ionicons name="create-outline" size={17} color={colors.primary} /><Text style={styles.drawerActionText}>Edit</Text></TouchableOpacity> : null}>
        {selected ? <><SectionLabel>Supplier profile</SectionLabel><View style={styles.detailGrid}><Detail label="Lead time" value={`${selected.lead_time_days} days`} /><Detail label="Truck capacity" value={selected.truck_capacity || "—"} /><Detail label="Freight terms" value={selected.freight_terms || "—"} wide /><Detail label="Categories" value={selected.categories.join(", ") || "—"} wide /></View><SectionLabel>Contact</SectionLabel><View style={styles.contactBlock}>{selected.phone ? <TouchableOpacity onPress={() => Linking.openURL(`tel:${selected.phone}`)} testID={`call-${selected.id}`}><Text style={styles.contactLink}>{selected.phone}</Text></TouchableOpacity> : null}{selected.email ? <TouchableOpacity onPress={() => Linking.openURL(`mailto:${selected.email}`)} testID={`email-${selected.id}`}><Text style={styles.contactLink}>{selected.email}</Text></TouchableOpacity> : null}<Text style={typo.bodySmall}>{selected.address || "No address recorded."}</Text></View><SectionLabel>Notes</SectionLabel><Text style={[typo.body, { marginBottom: spacing.lg }]}>{selected.notes || "No notes."}</Text><Button title="Delete Vendor" onPress={() => setDeleting(selected)} variant="danger" testID={`del-vendor-${selected.id}`} /></> : null}
      </DetailDrawer>

      <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}><Screen title={editing?.id ? "Edit Vendor" : "New Vendor"} back rightAction={{ icon: "close", onPress: () => setEditing(null), testID: "close-vendor-edit" }}><Input label="Name" value={editing?.name || ""} onChangeText={(text) => setEditing({ ...editing!, name: text })} testID="v-name" /><Input label="Contact" value={editing?.contact_name || ""} onChangeText={(text) => setEditing({ ...editing!, contact_name: text })} testID="v-contact" /><Row style={{ gap: spacing.md }}><View style={{ flex: 1 }}><Input label="Phone" value={editing?.phone || ""} onChangeText={(text) => setEditing({ ...editing!, phone: text })} keyboardType="phone-pad" mono testID="v-phone" /></View><View style={{ flex: 1 }}><Input label="Email" value={editing?.email || ""} onChangeText={(text) => setEditing({ ...editing!, email: text })} keyboardType="email-address" autoCapitalize="none" testID="v-email" /></View></Row><Input label="Address" value={editing?.address || ""} onChangeText={(text) => setEditing({ ...editing!, address: text })} testID="v-address" /><SectionLabel>Categories</SectionLabel><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>{CAT_OPTIONS.map((value) => <View key={value} style={{ flexShrink: 0 }}><Button title={value} onPress={() => toggleCat(value)} variant={(editing?.categories || []).includes(value) ? "primary" : "outline"} fullWidth={false} testID={`v-cat-${value}`} /></View>)}</ScrollView><Input label="Freight Terms" value={editing?.freight_terms || ""} onChangeText={(text) => setEditing({ ...editing!, freight_terms: text })} testID="v-freight" /><Row style={{ gap: spacing.md }}><View style={{ flex: 1 }}><Input label="Truck Capacity" value={editing?.truck_capacity || ""} onChangeText={(text) => setEditing({ ...editing!, truck_capacity: text })} mono testID="v-truck" /></View><View style={{ flex: 1 }}><Input label="Lead (days)" value={String(editing?.lead_time_days ?? 0)} onChangeText={(text) => setEditing({ ...editing!, lead_time_days: Number(text) || 0 })} keyboardType="number-pad" mono testID="v-lead" /></View></Row><Input label="Notes" value={editing?.notes || ""} onChangeText={(text) => setEditing({ ...editing!, notes: text })} testID="v-notes" /><Button title="Save" onPress={save} testID="save-vendor-btn" /></Screen></Modal>
      <ConfirmDialog visible={!!deleting} title="Delete vendor?" message={deleting ? `${deleting.name} will be permanently removed from the supplier directory.` : undefined} confirmLabel="Delete" onConfirm={del} onCancel={() => setDeleting(null)} testID="delete-vendor-confirm" />
    </Screen>
  );
}

const Detail = ({ label, value, wide }: { label: string; value: string; wide?: boolean }) => <View style={[styles.detail, wide && { width: "100%" }]}><Text style={typo.caption}>{label}</Text><Text style={typo.body}>{value}</Text></View>;

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.md, minHeight: 0 },
  toolbarButton: { height: 40 },
  filters: { paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
  tableWrap: { flex: 1, minHeight: 360, marginHorizontal: spacing.xl, marginBottom: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  primaryCell: { ...typo.body, fontWeight: "600" },
  secondaryCell: { fontSize: 10.5, color: colors.inkMuted, marginTop: 2 },
  tableText: { ...typo.body, fontSize: 13 },
  tableMono: { fontSize: 11.5 },
  drawerAction: { height: 32, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: spacing.sm },
  drawerActionText: { ...typo.label, color: colors.primary },
  detailGrid: { flexDirection: "row", flexWrap: "wrap", marginBottom: spacing.lg },
  detail: { width: "50%", paddingVertical: spacing.sm, gap: 4 },
  contactBlock: { gap: spacing.sm, marginBottom: spacing.lg },
  contactLink: { ...typo.body, color: colors.primary, fontWeight: "600" },
});

// Vendors — searchable DataTable + DetailDrawer on desktop, cards on phone.
// Matches the Equipment/Maintenance master-detail pattern with deep-link
// support for ?open=<id> and ?new=1.
import { useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Card, Mono, Row, H3, Pill } from "@/src/components/ui";
import { PageHeader } from "@/src/components/layout/PageHeader";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { PageBody } from "@/src/components/layout/PageBody";
import { SearchInput } from "@/src/components/data/SearchInput";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { EmptyState } from "@/src/components/feedback/EmptyState";
import { LoadingState } from "@/src/components/feedback/LoadingState";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useVendors, Vendor } from "@/src/features/vendors/useVendors";
import { VendorDetailDrawer } from "@/src/features/vendors/VendorDetailDrawer";
import { VendorForm } from "@/src/features/vendors/VendorForm";
import { colors, spacing, type as typo } from "@/src/theme";

export default function VendorsScreen() {
  const { isShellWide } = useBreakpoint();
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const { vendors, loading, refreshing, load, refresh, save, del } = useVendors();

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Vendor> | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (params.open) setSelectedId(String(params.open));
    if (params.new === "1") openNew();
  }, [params.open, params.new]);

  const openNew = () => { setEditing({ name: "", categories: [] }); setFormOpen(true); };
  const openEdit = (v: Vendor) => { setSelectedId(null); setEditing(v); setFormOpen(true); };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vendors.filter((v) => {
      if (!q) return true;
      return v.name.toLowerCase().includes(q)
        || v.contact_name.toLowerCase().includes(q)
        || v.categories.some((c) => c.toLowerCase().includes(q));
    });
  }, [vendors, search]);

  const selected = vendors.find((v) => v.id === selectedId) || null;

  const columns: ColumnDef<Vendor>[] = [
    { key: "name", label: "Vendor", flex: 2, render: (v) => (
      <View>
        <Text style={typo.body} numberOfLines={1}>{v.name}</Text>
        {v.contact_name ? <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{v.contact_name}</Text> : null}
      </View>
    ) },
    { key: "categories", label: "Categories", flex: 2, render: (v) => (
      <Row style={{ gap: 4, flexWrap: "wrap" }}>
        {v.categories.map((c) => <Pill key={c}>{c}</Pill>)}
      </Row>
    ) },
    { key: "phone", label: "Phone", width: 130, render: (v) => v.phone ? <Mono style={{ fontSize: 12 }}>{v.phone}</Mono> : "—" },
    { key: "lead", label: "Lead", width: 80, align: "right", render: (v) => v.lead_time_days > 0 ? <Mono>{v.lead_time_days}d</Mono> : "—" },
  ];

  if (loading) {
    return <Screen title="Vendors" back testID="vendors-screen"><LoadingState label="Loading vendors…" /></Screen>;
  }

  const desktopHeader = (
    <PageHeader
      title="Vendors"
      subtitle={`${vendors.length} suppliers`}
      actions={
        <TouchableOpacity onPress={openNew} testID="add-vendor-btn" style={{ backgroundColor: colors.accent, borderColor: colors.accent, height: 38, paddingHorizontal: 16, justifyContent: "center", borderRadius: 6 }}>
          <Text style={{ color: "#FFF", fontWeight: "700", fontSize: 13 }}>+ New Vendor</Text>
        </TouchableOpacity>
      }
    />
  );

  return (
    <Screen
      title="Vendors"
      subtitle={`${vendors.length} suppliers`}
      back
      rightAction={{ icon: "add", onPress: openNew, testID: "add-vendor-btn" }}
      onRefresh={refresh}
      refreshing={refreshing}
      scroll={isShellWide ? false : true}
      desktopHeader={desktopHeader}
      testID="vendors-screen"
    >
      <PageToolbar>
        <SearchInput value={search} onChangeText={setSearch} placeholder="Search name, contact, category…" testID="vendors-search" />
      </PageToolbar>

      {filtered.length === 0 ? (
        <EmptyState icon="business-outline" title="No vendors match" subtitle={vendors.length === 0 ? "Add your first supplier to get started." : "Try a different search."} actionLabel={vendors.length === 0 ? "Add Vendor" : undefined} onAction={vendors.length === 0 ? openNew : undefined} testID="vendors-empty" />
      ) : isShellWide ? (
        <View style={{ flex: 1, paddingHorizontal: spacing.xl }}>
          <DataTable columns={columns} rows={filtered} keyExtractor={(v) => v.id} onRowPress={(v) => setSelectedId(v.id)} rowTestID={(v) => `vendor-row-${v.id}`} selectedId={selectedId} />
        </View>
      ) : (
        <PageBody scroll={false} testID="vendors-list">
          {filtered.map((v) => (
            <TouchableOpacity key={v.id} onPress={() => setSelectedId(v.id)} activeOpacity={0.7} testID={`vendor-row-${v.id}`}>
              <Card style={{ marginBottom: spacing.sm }}>
                <H3>{v.name}</H3>
                {v.contact_name ? <Text style={[typo.label, { marginTop: 2 }]}>{v.contact_name}</Text> : null}
                <Row style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
                  {v.categories.map((c) => <Pill key={c}>{c}</Pill>)}
                </Row>
                <Row style={{ gap: spacing.md, marginTop: 8 }}>
                  {v.phone ? <Text style={typo.label}>Phone <Mono style={{ fontSize: 12 }}>{v.phone}</Mono></Text> : null}
                  {v.lead_time_days > 0 ? <Text style={typo.label}>Lead <Mono style={{ fontSize: 12 }}>{v.lead_time_days}d</Mono></Text> : null}
                </Row>
              </Card>
            </TouchableOpacity>
          ))}
        </PageBody>
      )}

      <VendorDetailDrawer
        vendor={selected}
        onClose={() => { setSelectedId(null); if (params.open) router.setParams({ open: undefined }); }}
        onEdit={openEdit}
        onDelete={del}
      />

      <VendorForm
        visible={formOpen}
        editing={editing}
        setEditing={setEditing}
        onClose={() => { setFormOpen(false); setEditing(null); if (params.new) router.setParams({ new: undefined }); }}
        onSave={async () => { await save(editing!); setFormOpen(false); setEditing(null); }}
      />
    </Screen>
  );
}

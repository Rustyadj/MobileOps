// Maintenance — a real operations queue: status-grouped, searchable,
// oldest-open-first, with DataTable + DetailDrawer on desktop and cards on
// phone, instead of an isolated flat CRUD list.
import { useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
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
import { useMaintenance, MaintItem, ageDays } from "@/src/features/maintenance/useMaintenance";
import { MaintenanceDetailDrawer } from "@/src/features/maintenance/MaintenanceDetailDrawer";
import { MaintenanceForm } from "@/src/features/maintenance/MaintenanceForm";
import { colors, spacing, type as typo } from "@/src/theme";

type StatusFilter = "all" | "open" | "in_progress" | "resolved";
const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In Progress" },
  { key: "resolved", label: "Resolved" },
];

export default function MaintenanceScreen() {
  const { isShellWide } = useBreakpoint();
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const { items, equipment, loading, refreshing, load, refresh, save, del } = useMaintenance();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<any>(null);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (params.open) setSelectedId(String(params.open));
    if (params.new === "1") openNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deep-link params should only re-trigger on their own change
  }, [params.open, params.new]);

  const openNew = () => { setEditing({ equipment_id: equipment[0]?.id || "", issue: "", action_taken: "", cost: 0, status: "open" }); setFormOpen(true); };
  const openEdit = (m: MaintItem) => { setSelectedId(null); setEditing(m); setFormOpen(true); };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((m) => {
        if (statusFilter !== "all" && m.status !== statusFilter) return false;
        if (q && !m.issue.toLowerCase().includes(q) && !(m.equipment_name || "").toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => ageDays(b.created_at) - ageDays(a.created_at));
  }, [items, statusFilter, search]);

  const selected = items.find((m) => m.id === selectedId) || null;
  const openCount = items.filter((m) => m.status !== "resolved").length;

  const columns: ColumnDef<MaintItem>[] = [
    { key: "equipment", label: "Equipment", flex: 1.5, render: (m) => <Text style={typo.body} numberOfLines={1}>{m.equipment_name || "—"}</Text> },
    { key: "issue", label: "Issue", flex: 2, render: (m) => <Text style={typo.body} numberOfLines={1}>{m.issue}</Text> },
    { key: "age", label: "Age", width: 70, align: "right", render: (m) => <Mono>{ageDays(m.created_at)}d</Mono> },
    { key: "cost", label: "Cost", width: 90, align: "right", render: (m) => <Mono>${m.cost.toFixed(2)}</Mono> },
    { key: "status", label: "Status", width: 120, align: "right", render: (m) => <StatusBadge label={m.status} /> },
  ];

  if (loading) {
    return <Screen title="Maintenance" back testID="maintenance-screen"><LoadingState label="Loading maintenance…" /></Screen>;
  }

  const desktopHeader = (
    <PageHeader
      title="Maintenance"
      subtitle={`${items.length} entries · ${openCount} open`}
      actions={<Button title="+ New Service" onPress={openNew} testID="new-maint-btn" fullWidth={false} style={{ backgroundColor: colors.accent, borderColor: colors.accent, height: 38, paddingHorizontal: 16 }} />}
    />
  );

  return (
    <Screen
      title="Maintenance"
      subtitle={`${items.length} entries · ${openCount} open`}
      back
      rightAction={{ icon: "add", onPress: openNew, testID: "new-maint-btn" }}
      onRefresh={refresh}
      refreshing={refreshing}
      scroll={isShellWide ? false : true}
      desktopHeader={desktopHeader}
      testID="maintenance-screen"
    >
      <PageToolbar>
        <SearchInput value={search} onChangeText={setSearch} placeholder="Search issue or equipment…" testID="maintenance-search" />
        <FilterChips options={STATUS_FILTERS} value={statusFilter} onChange={(k) => setStatusFilter(k as StatusFilter)} testIDPrefix="maint-filter" />
      </PageToolbar>

      {filtered.length === 0 ? (
        <EmptyState icon="build-outline" title="No service entries match" subtitle={items.length === 0 ? "Log your first service entry." : "Try a different filter or search."} actionLabel={items.length === 0 ? "New Service" : undefined} onAction={items.length === 0 ? openNew : undefined} testID="maintenance-empty" />
      ) : isShellWide ? (
        <View style={{ flex: 1, paddingHorizontal: spacing.xl }}>
          <DataTable columns={columns} rows={filtered} keyExtractor={(m) => m.id} onRowPress={(m) => setSelectedId(m.id)} rowTestID={(m) => `maint-row-${m.id}`} selectedId={selectedId} />
        </View>
      ) : (
        <PageBody scroll={false} testID="maintenance-list">
          {filtered.map((m) => (
            <TouchableOpacity key={m.id} onPress={() => setSelectedId(m.id)} activeOpacity={0.7} testID={`maint-${m.id}`}>
              <Card style={{ marginBottom: spacing.sm }}>
                <Row style={{ justifyContent: "space-between" }}>
                  <View style={{ flex: 1 }}>
                    <H3>{m.equipment_name || "Equipment"}</H3>
                    <Text style={[typo.body, { marginTop: 4 }]}>{m.issue}</Text>
                  </View>
                  <StatusBadge label={m.status} />
                </Row>
                <Row style={{ marginTop: 8, gap: spacing.md }}>
                  <Text style={typo.label}>Cost <Mono style={{ fontSize: 13 }}>${m.cost.toFixed(2)}</Mono></Text>
                  <Text style={typo.label}>Age <Mono style={{ fontSize: 13 }}>{ageDays(m.created_at)}d</Mono></Text>
                </Row>
              </Card>
            </TouchableOpacity>
          ))}
        </PageBody>
      )}

      <MaintenanceDetailDrawer item={selected} onClose={() => { setSelectedId(null); if (params.open) router.setParams({ open: undefined }); }} onEdit={openEdit} onDelete={del} />

      <MaintenanceForm
        visible={formOpen}
        editing={editing}
        setEditing={setEditing}
        equipment={equipment}
        onClose={() => { setFormOpen(false); setEditing(null); if (params.new) router.setParams({ new: undefined }); }}
        onSave={async () => { await save(editing); setFormOpen(false); setEditing(null); }}
      />
    </Screen>
  );
}

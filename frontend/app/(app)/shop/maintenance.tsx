import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, Modal, Alert, ScrollView, StyleSheet } from "react-native";
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
import { RequiresOnline } from "@/src/components/RequiresOnline";
import { api } from "@/src/api/client";
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type Eq = { id: string; sku: string; qr_code?: string | null; category?: string; name: string };
type Maintenance = {
  id: string; equipment_id: string; equipment_name: string; issue: string;
  action_taken: string; cost: number; status: string;
  serviced_at?: string | null; created_at: string;
};
type Draft = Partial<Maintenance> & { equipment_id: string; issue: string; status: string };

const STATUSES = [
  { key: "all", label: "All statuses" },
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In Progress" },
  { key: "resolved", label: "Resolved" },
];
const AGE_OPTIONS = [
  { key: "all", label: "Any age" },
  { key: "week", label: "0–7 days" },
  { key: "month", label: "8–30 days" },
  { key: "older", label: "30+ days" },
];
const STATUS_GROUPS = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In Progress" },
  { key: "resolved", label: "Resolved" },
];
const ageDays = (createdAt?: string) => createdAt ? Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000)) : 0;
const serviceDate = (value?: string | null) => value ? new Date(value).toLocaleDateString() : "—";

export default function MaintenanceScreen() {
  const { isShellWide } = useBreakpoint();
  const { canEdit } = usePermissions();
  const [items, setItems] = useState<Maintenance[]>([]);
  const [equipment, setEquipment] = useState<Eq[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Maintenance | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [equipmentId, setEquipmentId] = useState("all");
  const [age, setAge] = useState("all");

  const load = useCallback(async () => {
    try {
      const [maintenanceData, equipmentData] = await Promise.all([api<Maintenance[]>("/maintenance"), api<Eq[]>("/equipment")]);
      setItems(maintenanceData); setEquipment(equipmentData);
    } catch (err) { console.warn(err); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const newService = () => setEditing({ equipment_id: equipment[0]?.id || "", issue: "", action_taken: "", cost: 0, status: "open" });
  const save = async () => {
    if (!editing?.equipment_id || !editing.issue) { Alert.alert("Required", "Equipment + issue"); return; }
    try {
      const body = {
        equipment_id: editing.equipment_id, issue: editing.issue,
        action_taken: editing.action_taken || "", cost: Number(editing.cost) || 0,
        status: editing.status || "open", serviced_at: editing.serviced_at || null,
      };
      if (editing.id) await api(`/maintenance/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/maintenance", { method: "POST", body: JSON.stringify(body) });
      setEditing(null); load();
    } catch (e: any) { Alert.alert("Save failed", e.message); }
  };
  const del = async () => {
    if (!deleting) return;
    try { await api(`/maintenance/${deleting.id}`, { method: "DELETE" }); setDeleting(null); setEditing(null); load(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      const days = ageDays(item.created_at);
      if (status !== "all" && item.status !== status) return false;
      if (equipmentId !== "all" && item.equipment_id !== equipmentId) return false;
      if (age === "week" && days > 7) return false;
      if (age === "month" && (days <= 7 || days > 30)) return false;
      if (age === "older" && days <= 30) return false;
      if (!query) return true;
      return [item.equipment_name, item.issue, item.action_taken, item.status].some((value) => value?.toLowerCase().includes(query));
    });
  }, [age, equipmentId, items, search, status]);

  const columns = useMemo<ColumnDef<Maintenance>[]>(() => [
    { key: "equipment", label: "Equipment", flex: 1.2, render: (item) => item.equipment_name || equipment.find((entry) => entry.id === item.equipment_id)?.name || "Equipment" },
    { key: "issue", label: "Issue", flex: 2, render: (item) => item.issue },
    { key: "status", label: "Status", width: 112, render: (item) => <StatusBadge label={item.status} /> },
    { key: "age", label: "Age", width: 74, align: "right", render: (item) => <Mono style={styles.tableMono}>{ageDays(item.created_at)}d</Mono> },
    { key: "service", label: "Service Date", width: 108, align: "right", render: (item) => <Text style={typo.bodySmall}>{serviceDate(item.serviced_at)}</Text> },
  ], [equipment]);
  const equipmentOptions = useMemo(() => [{ key: "all", label: "All equipment" }, ...equipment.map((item) => ({ key: item.id, label: equipmentIdentifier(item) }))], [equipment]);

  return (
    <Screen title="Maintenance" subtitle={`${items.length} entries`} back
      rightAction={canEdit ? { icon: "add", onPress: newService, testID: "new-maint-btn" } : undefined}
      onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
      refreshing={refreshing} testID="maintenance-screen" scroll={!isShellWide}>
      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search equipment, issue, action…" testID="maintenance-search" style={{ flex: 1, maxWidth: 380 }} />
            {canEdit ? <Button title="New Service" onPress={newService} fullWidth={false} style={styles.toolbarButton} testID="new-maint-btn" /> : null}
          </PageToolbar>
          <View style={styles.filterStack}>
            <FilterChips options={STATUSES} value={status} onChange={setStatus} testIDPrefix="maintenance-status-filter" />
            <FilterChips options={equipmentOptions} value={equipmentId} onChange={setEquipmentId} testIDPrefix="maintenance-equipment-filter" />
            <FilterChips options={AGE_OPTIONS} value={age} onChange={setAge} testIDPrefix="maintenance-age-filter" />
          </View>
          <View style={styles.tableWrap}>
            <DataTable columns={columns} rows={filtered} keyExtractor={(item) => item.id} rowTestID={(item) => `maint-${item.id}`}
              onRowPress={(item) => setEditing(item)} selectedId={editing?.id} emptyLabel="No maintenance entries match these filters." />
          </View>
        </View>
      ) : items.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No service entries.</Text></Card>
      ) : (
        STATUS_GROUPS.map((group) => {
          const groupItems = items.filter((item) => item.status === group.key);
          if (!groupItems.length) return null;
          return <View key={group.key} style={styles.mobileGroup}><Row style={styles.groupHeader}><SectionLabel style={{ marginBottom: 0 }}>{group.label}</SectionLabel><Pill>{groupItems.length}</Pill></Row>{groupItems.map((item) => (
            <Card key={item.id} style={{ marginBottom: spacing.sm }} testID={`maint-${item.id}`}>
              <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}><View style={{ flex: 1 }}><H3>{item.equipment_name || "Equipment"}</H3><Text style={[typo.body, { marginTop: 4 }]}>{item.issue}</Text></View><Pill color={item.status === "resolved" ? colors.success : item.status === "in_progress" ? colors.warning : colors.error} bg={item.status === "resolved" ? colors.successSoft : item.status === "in_progress" ? colors.warningSoft : colors.errorSoft}>{item.status}</Pill></Row>
              {item.action_taken ? <Text style={[typo.body, { color: colors.inkSecondary, marginTop: 4 }]}>↪ {item.action_taken}</Text> : null}
              <Row style={{ marginTop: 8, gap: spacing.md }}><Text style={typo.label}>Age <Mono style={{ fontSize: 13 }}>{ageDays(item.created_at)}d</Mono></Text><Text style={typo.label}>Serviced <Mono style={{ fontSize: 13 }}>{serviceDate(item.serviced_at)}</Mono></Text></Row>
              <Row style={{ gap: spacing.sm, marginTop: spacing.sm }}><View style={{ flex: 1 }}><Button title="Edit" onPress={() => setEditing(item)} variant="outline" testID={`edit-maint-${item.id}`} /></View><View style={{ flex: 1 }}><Button title="Delete" onPress={() => setDeleting(item)} variant="danger" testID={`del-maint-${item.id}`} /></View></Row>
            </Card>
          ))}</View>;
        })
      )}

      {isShellWide ? (
        <DetailDrawer visible={!!editing} title={editing?.id ? "Edit Service" : "New Service"} subtitle={editing?.id ? editing.equipment_name : "Create a maintenance entry"} onClose={() => setEditing(null)} testID="maintenance-detail-drawer">
          {editing ? <ServiceForm editing={editing} setEditing={setEditing} equipment={equipment} onSave={save} canEdit={canEdit} /> : null}
          {editing?.id && canEdit ? <Button title="Delete Service" onPress={() => setDeleting(editing as Maintenance)} variant="danger" testID={`del-maint-${editing.id}`} /> : null}
        </DetailDrawer>
      ) : (
        <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
          <Screen title={editing?.id ? "Edit Service" : "New Service"} back rightAction={{ icon: "close", onPress: () => setEditing(null), testID: "close-maint-edit" }}>
            {editing ? <ServiceForm editing={editing} setEditing={setEditing} equipment={equipment} onSave={save} canEdit={canEdit} /> : null}
          </Screen>
        </Modal>
      )}
      <ConfirmDialog visible={!!deleting} title="Delete service entry?" message={deleting ? `${deleting.equipment_name || "Equipment"}: ${deleting.issue}` : undefined} confirmLabel="Delete" onConfirm={del} onCancel={() => setDeleting(null)} testID="delete-maintenance-confirm" />
    </Screen>
  );
}

const ServiceForm = ({ editing, setEditing, equipment, onSave, canEdit }: { editing: Draft; setEditing: (draft: Draft) => void; equipment: Eq[]; onSave: () => void; canEdit: boolean }) => (
  <>
    <SectionLabel>Equipment</SectionLabel>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>
      {equipment.map((item) => <View key={item.id} style={{ flexShrink: 0 }}><Button title={`${equipmentIdentifier(item)} — ${item.name}`} onPress={() => canEdit && setEditing({ ...editing, equipment_id: item.id, equipment_name: item.name })} variant={editing.equipment_id === item.id ? "primary" : "outline"} fullWidth={false} disabled={!canEdit} testID={`eq-pick-${item.sku}`} /></View>)}
    </ScrollView>
    <Input label="Issue" value={editing.issue || ""} onChangeText={(text) => setEditing({ ...editing, issue: text })} editable={canEdit} testID="maint-issue" />
    <Input label="Action Taken" value={editing.action_taken || ""} onChangeText={(text) => setEditing({ ...editing, action_taken: text })} editable={canEdit} testID="maint-action" />
    <SectionLabel>Status</SectionLabel>
    <Row style={{ gap: spacing.sm, marginBottom: spacing.md }}>{["open", "in_progress", "resolved"].map((value) => <View key={value} style={{ flex: 1 }}><Button title={value.replace("_", " ")} onPress={() => canEdit && setEditing({ ...editing, status: value })} variant={editing.status === value ? "primary" : "outline"} disabled={!canEdit} testID={`maint-status-${value}`} /></View>)}</Row>
    {canEdit ? <RequiresOnline><Button title="Save" onPress={onSave} testID="save-maint-btn" /></RequiresOnline> : null}
  </>
);

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg }, toolbarButton: { height: 40 },
  filterStack: { paddingHorizontal: spacing.xl, gap: spacing.xs, paddingBottom: spacing.md },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  tableMono: { fontSize: 12 }, mobileGroup: { marginBottom: spacing.md },
  groupHeader: { justifyContent: "space-between", marginBottom: spacing.sm, paddingHorizontal: spacing.xs },
});

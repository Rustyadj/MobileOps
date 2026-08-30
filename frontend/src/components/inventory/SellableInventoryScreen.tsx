// Shared screen for the two new sellable-inventory nav items (Consumables,
// Block) — simple stock, no rental lifecycle (no reserve/stage/dispatch/
// return), unlike EquipmentScreen's bracing/scaffolding/tools/damaged views.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, Modal, Alert, StyleSheet } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { SearchInput } from "@/src/components/data/SearchInput";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { usePermissions } from "@/src/hooks/use-permissions";
import { RequiresOnline } from "@/src/components/RequiresOnline";
import { api } from "@/src/api/client";
import { colors, radii, spacing, type as typo } from "@/src/theme";

export type SellableKind = "consumable" | "block";

type SellableItem = {
  id: string; kind: SellableKind; product: string; manufacturer: string; sku: string;
  unit: string; core_size: string; form_type: string;
  quantity_on_hand: number; quantity_reserved: number; reorder_point?: number | null;
  cost?: number | null; price?: number | null; notes: string;
};

type Draft = Partial<SellableItem> & { product: string };

const KIND_LABEL: Record<SellableKind, string> = { consumable: "Consumable", block: "Block" };
const numOrNull = (text: string) => text.trim() === "" ? null : Number(text.replace(/[^0-9.]/g, ""));

export function SellableInventoryScreen({ kind }: { kind: SellableKind }) {
  const { isShellWide } = useBreakpoint();
  const { canEdit, canAdmin } = usePermissions();
  const [items, setItems] = useState<SellableItem[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<SellableItem | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try { setItems(await api<SellableItem[]>(`/sellable-items?kind=${kind}`)); }
    catch (err) { console.warn(err); }
  }, [kind]);
  useEffect(() => { load(); }, [load]);

  const newItem = () => setEditing({
    kind, product: "", manufacturer: "", sku: "", unit: "", core_size: "", form_type: "",
    quantity_on_hand: 0, reorder_point: null, cost: null, price: null, notes: "",
  });

  const save = async () => {
    if (!editing?.product?.trim()) { Alert.alert("Required", "Product name is required."); return; }
    try {
      const body = {
        kind, product: editing.product.trim(), manufacturer: editing.manufacturer || "", sku: editing.sku || "",
        unit: editing.unit || "", core_size: editing.core_size || "", form_type: editing.form_type || "",
        quantity_on_hand: Number(editing.quantity_on_hand) || 0,
        reorder_point: editing.reorder_point != null ? Number(editing.reorder_point) : null,
        cost: editing.cost != null ? Number(editing.cost) : null,
        price: editing.price != null ? Number(editing.price) : null,
        notes: editing.notes || "",
      };
      if (editing.id) await api(`/sellable-items/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/sellable-items", { method: "POST", body: JSON.stringify(body) });
      setEditing(null); load();
    } catch (e: any) { Alert.alert("Save failed", e.message); }
  };
  const del = async () => {
    if (!deleting) return;
    try { await api(`/sellable-items/${deleting.id}`, { method: "DELETE" }); setDeleting(null); setEditing(null); load(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => [item.product, item.manufacturer, item.sku, item.core_size, item.form_type].some((v) => v?.toLowerCase().includes(query)));
  }, [items, search]);

  const columns = useMemo<ColumnDef<SellableItem>[]>(() => {
    const base: ColumnDef<SellableItem>[] = [
      { key: "product", label: "Product", flex: 1.6, render: (i) => (
        <View><Text style={typo.body} numberOfLines={1}>{i.product}</Text>
          <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{[i.manufacturer, i.sku].filter(Boolean).join(" · ") || "—"}</Mono></View>
      ) },
    ];
    if (kind === "block") base.push({ key: "spec", label: "Spec", flex: 1, render: (i) => <Text style={typo.bodySmall}>{[i.core_size, i.form_type].filter(Boolean).join(" · ") || "—"}</Text> });
    base.push(
      { key: "on_hand", label: "On hand", width: 90, align: "right", render: (i) => <Mono>{i.quantity_on_hand}</Mono> },
      { key: "reserved", label: "Reserved", width: 90, align: "right", render: (i) => <Mono>{i.quantity_reserved}</Mono> },
      { key: "available", label: "Available", width: 90, align: "right", render: (i) => <Mono style={{ color: colors.success, fontWeight: "700" }}>{Math.max(0, i.quantity_on_hand - i.quantity_reserved)}</Mono> },
    );
    return base;
  }, [kind]);

  return (
    <Screen title={`${KIND_LABEL[kind]}s`} subtitle={`${items.length} items`} back
      rightAction={canEdit ? { icon: "add", onPress: newItem, testID: `new-${kind}-btn` } : undefined}
      onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
      refreshing={refreshing} testID={`${kind}-screen`} scroll={!isShellWide}>
      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder={`Search ${KIND_LABEL[kind].toLowerCase()}s…`} testID={`${kind}-search`} style={{ flex: 1, maxWidth: 380 }} />
            {canEdit ? <Button title={`New ${KIND_LABEL[kind]}`} onPress={newItem} fullWidth={false} style={styles.toolbarButton} testID={`new-${kind}-desktop`} /> : null}
          </PageToolbar>
          <View style={styles.tableWrap}>
            <DataTable columns={columns} rows={filtered} keyExtractor={(i) => i.id} rowTestID={(i) => `${kind}-${i.id}`}
              onRowPress={(i) => setEditing(i)} selectedId={editing?.id} emptyLabel={`No ${KIND_LABEL[kind].toLowerCase()}s match this search.`} />
          </View>
        </View>
      ) : items.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No {KIND_LABEL[kind].toLowerCase()}s yet.</Text></Card>
      ) : (
        filtered.map((item) => (
          <Card key={item.id} style={{ marginBottom: spacing.sm }} testID={`${kind}-${item.id}`}>
            <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <View style={{ flex: 1 }}><H3>{item.product}</H3><Mono style={{ fontSize: 11, color: colors.inkMuted, marginTop: 2 }}>{[item.manufacturer, item.sku].filter(Boolean).join(" · ") || "—"}</Mono></View>
            </Row>
            <Row style={{ marginTop: 8, gap: spacing.md }}>
              <Text style={typo.label}>On hand <Mono style={{ fontSize: 13 }}>{item.quantity_on_hand}</Mono></Text>
              <Text style={typo.label}>Available <Mono style={{ fontSize: 13 }}>{Math.max(0, item.quantity_on_hand - item.quantity_reserved)}</Mono></Text>
            </Row>
            {canEdit ? <Row style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              <View style={{ flex: 1 }}><Button title="Edit" onPress={() => setEditing(item)} variant="outline" testID={`edit-${kind}-${item.id}`} /></View>
              {canAdmin ? <View style={{ flex: 1 }}><Button title="Delete" onPress={() => setDeleting(item)} variant="danger" testID={`del-${kind}-${item.id}`} /></View> : null}
            </Row> : null}
          </Card>
        ))
      )}

      {isShellWide ? (
        <DetailDrawer visible={!!editing} title={editing?.id ? `Edit ${KIND_LABEL[kind]}` : `New ${KIND_LABEL[kind]}`} onClose={() => setEditing(null)} testID={`${kind}-detail-drawer`}>
          {editing ? <ItemForm kind={kind} editing={editing} setEditing={setEditing} onSave={save} canEdit={canEdit} /> : null}
          {editing?.id && canAdmin ? <Button title="Delete" onPress={() => setDeleting(editing as SellableItem)} variant="danger" testID={`del-${kind}-${editing.id}`} /> : null}
        </DetailDrawer>
      ) : (
        <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
          <Screen title={editing?.id ? `Edit ${KIND_LABEL[kind]}` : `New ${KIND_LABEL[kind]}`} back rightAction={{ icon: "close", onPress: () => setEditing(null), testID: `close-${kind}-edit` }}>
            {editing ? <ItemForm kind={kind} editing={editing} setEditing={setEditing} onSave={save} canEdit={canEdit} /> : null}
          </Screen>
        </Modal>
      )}
      <ConfirmDialog visible={!!deleting} title={`Delete ${KIND_LABEL[kind].toLowerCase()}?`} message={deleting?.product} confirmLabel="Delete" onConfirm={del} onCancel={() => setDeleting(null)} testID={`delete-${kind}-confirm`} />
    </Screen>
  );
}

const ItemForm = ({ kind, editing, setEditing, onSave, canEdit }: { kind: SellableKind; editing: Draft; setEditing: (d: Draft) => void; onSave: () => void; canEdit: boolean }) => (
  <>
    <Input label="Product" value={editing.product || ""} onChangeText={(t) => setEditing({ ...editing, product: t })} editable={canEdit} testID={`${kind}-product`} />
    <Input label="Manufacturer" value={editing.manufacturer || ""} onChangeText={(t) => setEditing({ ...editing, manufacturer: t })} editable={canEdit} testID={`${kind}-manufacturer`} />
    <Input label="SKU (optional)" value={editing.sku || ""} onChangeText={(t) => setEditing({ ...editing, sku: t })} editable={canEdit} testID={`${kind}-sku`} />
    {kind === "consumable" ? (
      <Input label="Unit (box, each, tube…)" value={editing.unit || ""} onChangeText={(t) => setEditing({ ...editing, unit: t })} editable={canEdit} testID="consumable-unit" />
    ) : (
      <>
        <Input label="Core size" value={editing.core_size || ""} onChangeText={(t) => setEditing({ ...editing, core_size: t })} editable={canEdit} testID="block-core-size" />
        <Input label="Form type" value={editing.form_type || ""} onChangeText={(t) => setEditing({ ...editing, form_type: t })} editable={canEdit} testID="block-form-type" />
      </>
    )}
    <Input label="Quantity on hand" value={String(editing.quantity_on_hand ?? 0)} onChangeText={(t) => setEditing({ ...editing, quantity_on_hand: Number(t.replace(/[^0-9]/g, "")) || 0 })} keyboardType="number-pad" mono editable={canEdit} testID={`${kind}-qty`} />
    <Input label="Reorder point (optional)" value={editing.reorder_point != null ? String(editing.reorder_point) : ""} onChangeText={(t) => setEditing({ ...editing, reorder_point: numOrNull(t) })} keyboardType="number-pad" mono editable={canEdit} testID={`${kind}-reorder`} />
    <Input label="Cost (optional)" value={editing.cost != null ? String(editing.cost) : ""} onChangeText={(t) => setEditing({ ...editing, cost: numOrNull(t) })} keyboardType="decimal-pad" mono editable={canEdit} testID={`${kind}-cost`} />
    <Input label="Price (optional)" value={editing.price != null ? String(editing.price) : ""} onChangeText={(t) => setEditing({ ...editing, price: numOrNull(t) })} keyboardType="decimal-pad" mono editable={canEdit} testID={`${kind}-price`} />
    <Input label="Notes (optional)" value={editing.notes || ""} onChangeText={(t) => setEditing({ ...editing, notes: t })} multiline editable={canEdit} testID={`${kind}-notes`} />
    {canEdit ? <RequiresOnline><Button title="Save" onPress={onSave} testID={`save-${kind}-btn`} /></RequiresOnline> : null}
  </>
);

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg }, toolbarButton: { height: 40 },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
});

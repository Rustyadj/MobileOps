import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Modal, Alert, ScrollView, TouchableOpacity } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
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
import { usePermissions } from "@/src/hooks/use-permissions";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo, radii } from "@/src/theme";
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";

type BookingLine = { equipment_id: string; sku: string; qr_code?: string | null; name: string; qty: number; returned_qty: number; daily_rate: number };
type Booking = { id: string; customer_name: string; job_site: string; start_date: string; end_date: string; status: string; items?: BookingLine[]; notes: string; dispatched_rental_id?: string | null };
type CapacityRow = { equipment_id: string; sku: string; qr_code?: string | null; name: string; category: string; quantity: number; committed: number; available: number };
type Eq = { id: string; sku: string; qr_code?: string | null; name: string };
type BookingSortKey = "customer_name" | "job_site" | "start_date" | "end_date" | "status";

const STATUS_OPTIONS = [
  { key: "all", label: "All statuses" },
  { key: "tentative", label: "Tentative" },
  { key: "confirmed", label: "Confirmed" },
  { key: "dispatched", label: "Dispatched" },
  { key: "cancelled", label: "Cancelled" },
];

export default function BookingsScreen() {
  const { isShellWide } = useBreakpoint();
  const { canEdit } = usePermissions();
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const [tab, setTab] = useState<"pipeline" | "capacity">("pipeline");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [equipment, setEquipment] = useState<Eq[]>([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [eqSearch, setEqSearch] = useState("");
  const [availability, setAvailability] = useState<Record<string, CapacityRow>>({});
  const [selected, setSelected] = useState<Booking | null>(null);
  const [deleting, setDeleting] = useState<Booking | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<BookingSortKey>("start_date");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [capDate, setCapDate] = useState(new Date().toISOString().slice(0, 10));
  const [capRows, setCapRows] = useState<CapacityRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, e] = await Promise.all([api<Booking[]>("/bookings"), api<Eq[]>("/equipment")]);
      setBookings(b); setEquipment(e);
    } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!params.open) return;
    const match = bookings.find((booking) => booking.id === params.open);
    if (match) setSelected(match);
  }, [bookings, params.open]);

  // Availability for the draft's start date — refreshed whenever the create
  // form is open and the start date changes, so "Available" / "Conflict"
  // reflect what's actually committed that day.
  useEffect(() => {
    if (!creating || !draft?.start_date) return;
    const target = draft.start_date.slice(0, 10) + "T00:00:00";
    api<{ rows: CapacityRow[] }>(`/bookings/capacity?target_date=${target}`)
      .then((res) => setAvailability(Object.fromEntries(res.rows.map((row) => [row.equipment_id, row]))))
      .catch(() => setAvailability({}));
  }, [creating, draft?.start_date]);

  const loadCapacity = useCallback(async () => {
    try {
      const res = await api<{ rows: CapacityRow[] }>(`/bookings/capacity?target_date=${capDate}T00:00:00`);
      setCapRows(res.rows);
    } catch (e: any) { Alert.alert("Error", e.message); }
  }, [capDate]);
  useEffect(() => { if (tab === "capacity") loadCapacity(); }, [tab, loadCapacity]);

  const visibleBookings = useMemo(() => {
    const query = search.trim().toLowerCase();
    return bookings.filter((booking) => {
      if (statusFilter !== "all" && booking.status !== statusFilter) return false;
      if (!query) return true;
      return [booking.customer_name, booking.job_site, booking.status, booking.notes].some((value) => value?.toLowerCase().includes(query));
    }).sort((a, b) => {
      const compared = String(a[sortKey] || "").localeCompare(String(b[sortKey] || ""), undefined, { numeric: true, sensitivity: "base" });
      return sortDirection === "asc" ? compared : -compared;
    });
  }, [bookings, search, sortDirection, sortKey, statusFilter]);

  const handleSort = (key: string) => {
    if (key === sortKey) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else { setSortKey(key as BookingSortKey); setSortDirection("asc"); }
  };

  const newBooking = () => {
    const now = new Date();
    const end = new Date(now.getTime() + 3 * 86400000);
    setDraft({ customer_name: "", job_site: "", start_date: now.toISOString(), end_date: end.toISOString(), status: "tentative", items: [], notes: "" });
    setEqSearch("");
    setCreating(true);
  };

  useEffect(() => {
    if (params.new) newBooking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.new]);

  const addItem = (eq: Eq) => {
    setDraft((d: any) => {
      if (d.items.some((i: BookingLine) => i.equipment_id === eq.id)) return d;
      return { ...d, items: [...d.items, { equipment_id: eq.id, sku: eq.sku, qr_code: eq.qr_code, name: eq.name, qty: 1, returned_qty: 0, daily_rate: 0 }] };
    });
  };
  const updateItemQty = (equipmentId: string, qty: number) => {
    setDraft((d: any) => ({
      ...d,
      items: qty <= 0
        ? d.items.filter((i: BookingLine) => i.equipment_id !== equipmentId)
        : d.items.map((i: BookingLine) => i.equipment_id === equipmentId ? { ...i, qty } : i),
    }));
  };

  const save = async () => {
    if (!draft.customer_name) { Alert.alert("Required", "Customer name"); return; }
    try { await api("/bookings", { method: "POST", body: JSON.stringify(draft) }); setCreating(false); load(); }
    catch (e: any) { Alert.alert("Save failed", e.message); }
  };

  const del = async () => {
    if (!deleting) return;
    try { await api(`/bookings/${deleting.id}`, { method: "DELETE" }); setDeleting(null); setSelected(null); load(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  const dispatch = async (booking: Booking) => {
    try {
      const rental = await api<{ id: string }>(`/bookings/${booking.id}/dispatch`, { method: "POST" });
      setSelected(null);
      await load();
      router.push(`/(app)/operations/rentals?open=${rental.id}` as any);
    } catch (e: any) { Alert.alert("Dispatch failed", e.message); }
  };

  const columns = useMemo<ColumnDef<Booking>[]>(() => [
    { key: "customer_name", label: "Customer", flex: 1.35, render: (booking) => <Text style={styles.primaryCell} numberOfLines={1}>{booking.customer_name}</Text> },
    { key: "job_site", label: "Job site", flex: 1.5, render: (booking) => booking.job_site || "—" },
    { key: "start_date", label: "Start", width: 100, render: (booking) => <Mono style={styles.tableMono}>{new Date(booking.start_date).toLocaleDateString()}</Mono> },
    { key: "end_date", label: "End", width: 100, render: (booking) => <Mono style={styles.tableMono}>{new Date(booking.end_date).toLocaleDateString()}</Mono> },
    { key: "items", label: "Units", width: 72, align: "right", render: (booking) => <Mono style={styles.tableMono}>{(booking.items || []).reduce((sum, item) => sum + item.qty, 0)}</Mono> },
    { key: "status", label: "Status", width: 106, render: (booking) => <StatusBadge label={booking.status} /> },
  ], []);

  const capacityColumns = useMemo<ColumnDef<CapacityRow>[]>(() => [
    { key: "qr_code", label: "QR Code", width: 130, render: (row) => <Mono style={styles.tableMono}>{equipmentIdentifier(row)}</Mono> },
    { key: "name", label: "Equipment", flex: 1.5, render: (row) => row.name },
    { key: "category", label: "Category", flex: 1, render: (row) => row.category.replace(/_/g, " ") },
    { key: "quantity", label: "Total", width: 80, align: "right", render: (row) => <Mono style={styles.tableMono}>{row.quantity}</Mono> },
    { key: "committed", label: "Committed", width: 92, align: "right", render: (row) => <Mono style={styles.tableMono}>{row.committed}</Mono> },
    { key: "available", label: "Available", width: 98, align: "right", render: (row) => <StatusBadge label={String(row.available)} tone={row.available > 0 ? "success" : "error"} /> },
  ], []);

  return (
    <Screen title="Bookings" subtitle="Pipeline · Capacity" back rightAction={tab === "pipeline" && canEdit ? { icon: "add", onPress: newBooking, testID: "new-booking-btn" } : undefined}
      onRefresh={async () => { setRefreshing(true); await (tab === "pipeline" ? load() : loadCapacity()); setRefreshing(false); }} refreshing={refreshing}
      testID="bookings-screen" scroll={!isShellWide}>
      <View style={[styles.tabs, isShellWide && styles.desktopTabs]}>
        <SegBtn label="Pipeline" active={tab === "pipeline"} onPress={() => setTab("pipeline")} testID="tab-pipeline" />
        <SegBtn label="Capacity" active={tab === "capacity"} onPress={() => setTab("capacity")} testID="tab-capacity" />
      </View>

      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          {tab === "pipeline" ? (
            <>
              <PageToolbar>
                <SearchInput value={search} onChangeText={setSearch} placeholder="Search customer, job site, notes…" testID="bookings-search" style={{ flex: 1, maxWidth: 390 }} />
                {canEdit ? <Button title="New Booking" onPress={newBooking} fullWidth={false} style={styles.toolbarButton} testID="new-booking-btn" /> : null}
              </PageToolbar>
              <View style={styles.filters}><FilterChips options={STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} testIDPrefix="booking-status" /></View>
              <View style={styles.tableWrap}><DataTable columns={columns} rows={visibleBookings} keyExtractor={(booking) => booking.id} rowTestID={(booking) => `booking-${booking.id}`} onRowPress={setSelected} selectedId={selected?.id} sortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} emptyLabel="No bookings match these filters." /></View>
            </>
          ) : (
            <>
              <PageToolbar>
                <Input label="Check date" value={capDate} onChangeText={setCapDate} mono autoCapitalize="none" testID="capacity-date" style={{ width: 180 }} />
                <Button title="Check Capacity" onPress={loadCapacity} fullWidth={false} style={styles.toolbarButton} testID="check-capacity-btn" />
              </PageToolbar>
              <View style={styles.tableWrap}><DataTable columns={capacityColumns} rows={capRows} keyExtractor={(row) => row.equipment_id} rowTestID={(row) => `cap-row-${row.sku}`} emptyLabel="No equipment data for this date." /></View>
            </>
          )}
        </View>
      ) : tab === "pipeline" ? (
        bookings.length === 0 ? <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No bookings. Tap + to add.</Text></Card> : bookings.map((booking) => (
          <Card key={booking.id} style={{ marginBottom: spacing.sm }} testID={`booking-${booking.id}`}>
            <Row style={{ justifyContent: "space-between" }}><View style={{ flex: 1 }}><H3>{booking.customer_name}</H3><Text style={[typo.label, { marginTop: 2 }]}>{booking.job_site || "—"}</Text></View><Pill color={booking.status === "confirmed" ? colors.success : booking.status === "cancelled" ? colors.error : colors.warning} bg={booking.status === "confirmed" ? colors.successSoft : booking.status === "cancelled" ? colors.errorSoft : colors.warningSoft}>{booking.status}</Pill></Row>
            <Mono style={{ fontSize: 12, marginTop: 8 }}>{new Date(booking.start_date).toLocaleDateString()} → {new Date(booking.end_date).toLocaleDateString()}</Mono>
            {canEdit ? <Button title="Delete" onPress={() => setDeleting(booking)} variant="outline" testID={`del-booking-${booking.id}`} /> : null}
          </Card>
        ))
      ) : (
        <><Card style={{ marginBottom: spacing.md }}><Input label="Check date (yyyy-mm-dd)" value={capDate} onChangeText={setCapDate} mono autoCapitalize="none" testID="capacity-date" /><Button title="Check Capacity" onPress={loadCapacity} testID="check-capacity-btn" /></Card>{capRows.map((row) => <Card key={row.equipment_id} style={{ marginBottom: spacing.sm }} testID={`cap-row-${row.sku}`}><Row style={{ justifyContent: "space-between" }}><View style={{ flex: 1 }}><Text style={typo.body}>{row.name}</Text><Mono style={{ fontSize: 11, color: colors.inkMuted }}>{equipmentIdentifier(row)}</Mono></View><Pill color={row.available > 0 ? colors.success : colors.error} bg={row.available > 0 ? colors.successSoft : colors.errorSoft}>{row.available}/{row.quantity}</Pill></Row></Card>)}</>
      )}

      <DetailDrawer visible={!!selected} title={selected?.customer_name || "Booking"} subtitle={selected?.job_site || "No job site"} onClose={() => setSelected(null)} testID="booking-detail-drawer">
        {selected ? <>
          <View style={styles.detailGrid}><Detail label="Status" value={selected.status} badge /><Detail label="Start" value={new Date(selected.start_date).toLocaleDateString()} /><Detail label="End" value={new Date(selected.end_date).toLocaleDateString()} /><Detail label="Units" value={String((selected.items || []).reduce((sum, item) => sum + item.qty, 0))} /></View>
          <SectionLabel>Reserved equipment</SectionLabel>
          {(selected.items || []).length ? (selected.items || []).map((item) => <View key={item.equipment_id} style={styles.detailRow}><View style={{ flex: 1 }}><Text style={typo.body}>{item.name}</Text><Mono style={styles.tableMono}>{equipmentIdentifier(item)}</Mono></View><Mono>{item.qty}</Mono></View>) : <Text style={[typo.bodySmall, { marginBottom: spacing.lg }]}>No equipment reserved.</Text>}
          <SectionLabel>Notes</SectionLabel>
          <Text style={[typo.body, { marginBottom: spacing.lg }]}>{selected.notes || "No notes."}</Text>
          {selected.status === "confirmed" ? (
            <Button title="Dispatch → Start Rental" onPress={() => dispatch(selected)} testID={`dispatch-booking-${selected.id}`} style={{ marginBottom: spacing.sm }} />
          ) : null}
          {selected.status === "dispatched" && selected.dispatched_rental_id ? (
            <Button title="View Rental" variant="outline" onPress={() => router.push(`/(app)/operations/rentals?open=${selected.dispatched_rental_id}` as any)} testID={`view-dispatched-rental-${selected.id}`} style={{ marginBottom: spacing.sm }} />
          ) : null}
          {canEdit ? <Button title="Delete Booking" onPress={() => setDeleting(selected)} variant="danger" testID={`del-booking-${selected.id}`} /> : null}
        </> : null}
      </DetailDrawer>

      <Modal visible={creating} animationType="slide" onRequestClose={() => setCreating(false)}>
        <Screen title="New Booking" back rightAction={{ icon: "close", onPress: () => setCreating(false), testID: "close-new-booking" }}>
          <Input label="Customer Name" value={draft?.customer_name || ""} onChangeText={(text) => setDraft({ ...draft, customer_name: text })} testID="bk-cust" />
          <Input label="Job Site" value={draft?.job_site || ""} onChangeText={(text) => setDraft({ ...draft, job_site: text })} testID="bk-site" />
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}><Input label="Start" value={draft?.start_date?.slice(0, 10) || ""} onChangeText={(text) => setDraft({ ...draft, start_date: new Date(text).toISOString() })} mono autoCapitalize="none" testID="bk-start" /></View>
            <View style={{ flex: 1 }}><Input label="End" value={draft?.end_date?.slice(0, 10) || ""} onChangeText={(text) => setDraft({ ...draft, end_date: new Date(text).toISOString() })} mono autoCapitalize="none" testID="bk-end" /></View>
          </Row>
          <SectionLabel>Status</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>
            {["tentative", "confirmed", "cancelled"].map((status) => <SegBtn key={status} label={status} active={draft?.status === status} onPress={() => setDraft({ ...draft, status })} testID={`bk-status-${status}`} />)}
          </ScrollView>

          <SectionLabel>Equipment ({(draft?.items || []).length})</SectionLabel>
          {(draft?.items || []).map((item: BookingLine) => {
            const cap = availability[item.equipment_id];
            const conflict = cap ? item.qty > cap.available : false;
            return (
              <Card key={item.equipment_id} style={{ marginBottom: spacing.sm }} testID={`bk-item-${item.sku}`}>
                <Row style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={typo.body} numberOfLines={1}>{item.name}</Text>
                    <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{equipmentIdentifier(item)} · {cap ? `${cap.available} available` : "—"}</Mono>
                  </View>
                  <TouchableOpacity onPress={() => updateItemQty(item.equipment_id, item.qty - 1)} style={styles.qtyBtn} testID={`bk-qty-minus-${item.sku}`}><Text style={styles.qtyText}>−</Text></TouchableOpacity>
                  <Mono style={{ marginHorizontal: 12, fontSize: 18 }}>{item.qty}</Mono>
                  <TouchableOpacity onPress={() => updateItemQty(item.equipment_id, item.qty + 1)} style={styles.qtyBtn} testID={`bk-qty-plus-${item.sku}`}><Text style={styles.qtyText}>+</Text></TouchableOpacity>
                </Row>
                {conflict ? <StatusBadge label={`Conflict — only ${cap!.available} available`} tone="error" /> : null}
              </Card>
            );
          })}

          <SectionLabel>Add equipment</SectionLabel>
          <SearchInput value={eqSearch} onChangeText={setEqSearch} placeholder="Search SKU or equipment…" testID="bk-eq-search" style={{ marginBottom: spacing.sm }} />
          <View style={{ borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md }} testID="bk-add-eq-list">
            {equipment
              .filter((e) => !(draft?.items || []).some((i: BookingLine) => i.equipment_id === e.id))
              .filter((e) => !eqSearch.trim() || `${e.qr_code || ""} ${e.sku} ${e.name}`.toLowerCase().includes(eqSearch.trim().toLowerCase()))
              .slice(0, 8)
              .map((e) => (
                <TouchableOpacity key={e.id} onPress={() => addItem(e)} style={styles.eqRow} testID={`bk-add-eq-${e.sku}`}>
                  <View style={{ flex: 1 }}><Text style={typo.body}>{e.name}</Text><Mono style={{ fontSize: 11, color: colors.inkMuted }}>{equipmentIdentifier(e)}{availability[e.id] ? ` · ${availability[e.id].available} available` : ""}</Mono></View>
                  <Ionicons name="add-circle" size={26} color={colors.primary} />
                </TouchableOpacity>
              ))}
          </View>

          <Input label="Notes" value={draft?.notes || ""} onChangeText={(text) => setDraft({ ...draft, notes: text })} testID="bk-notes" />
          <Button title="Save Booking" onPress={save} testID="save-booking-btn" />
        </Screen>
      </Modal>
      <ConfirmDialog visible={!!deleting} title="Delete booking?" message={deleting ? `${deleting.customer_name}'s booking will be permanently removed.` : undefined} confirmLabel="Delete" onConfirm={del} onCancel={() => setDeleting(null)} testID="delete-booking-confirm" />
    </Screen>
  );
}

const SegBtn: React.FC<{ label: string; active: boolean; onPress: () => void; testID?: string }> = ({ label, active, onPress, testID }) => <View testID={testID} style={{ flexGrow: 1 }}><Button title={label} onPress={onPress} variant={active ? "primary" : "outline"} /></View>;
const Detail = ({ label, value, badge }: { label: string; value: string; badge?: boolean }) => <View style={styles.detail}><Text style={typo.caption}>{label}</Text>{badge ? <StatusBadge label={value} /> : <Text style={typo.body}>{value}</Text>}</View>;

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", gap: 8, marginBottom: spacing.md },
  desktopTabs: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, marginBottom: 0, maxWidth: 360 },
  desktopWorkspace: { flex: 1, minHeight: 0 },
  toolbarButton: { height: 40 },
  filters: { paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
  tableWrap: { flex: 1, minHeight: 320, marginHorizontal: spacing.xl, marginBottom: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  tableMono: { fontSize: 12 },
  primaryCell: { ...typo.body, fontWeight: "600" },
  detailGrid: { flexDirection: "row", flexWrap: "wrap", marginBottom: spacing.lg },
  detail: { width: "50%", paddingVertical: spacing.sm, gap: 5 },
  detailRow: { flexDirection: "row", alignItems: "center", paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  qtyBtn: { width: 36, height: 36, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center" },
  qtyText: { fontSize: 20, fontWeight: "800", color: colors.ink },
  eqRow: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
});

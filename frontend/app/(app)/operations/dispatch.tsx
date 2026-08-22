import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity, Alert } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { SearchInput } from "@/src/components/data/SearchInput";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { PageHeader } from "@/src/components/layout/PageHeader";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, spacing, type as typo, radii } from "@/src/theme";

type Direction = "outbound" | "inbound";
type DLine = { equipment_id: string; sku: string; name: string; qty: number };
type Eq = { id: string; sku: string; name: string; available: number };
type RentalLite = { id: string; customer_name: string; job_site: string; status: string };
type Dispatch = {
  id: string; direction: Direction; status: string;
  scheduled_date?: string | null; customer_name: string; job_site: string;
  lat?: number | null; lng?: number | null;
  rental_id?: string | null; booking_id?: string | null;
  driver_name: string; truck: string; trailer: string; crew: string;
  lines: DLine[]; notes: string; created_by: string;
  started_at?: string | null; arrived_at?: string | null; completed_at?: string | null;
};

// Mirrors backend DISPATCH_FLOWS — each entry maps the *current* status to
// the action button that advances it, and the status that action produces.
const OUTBOUND_STEPS: Record<string, { label: string; next: string }> = {
  scheduled: { label: "Start Staging", next: "staging" },
  staging: { label: "Mark Ready", next: "ready" },
  ready: { label: "Mark Loaded", next: "loaded" },
  loaded: { label: "Dispatch", next: "dispatched" },
  dispatched: { label: "Mark Arrived", next: "arrived" },
  arrived: { label: "Complete Delivery", next: "completed" },
};
const INBOUND_STEPS: Record<string, { label: string; next: string }> = {
  scheduled: { label: "Dispatch Driver", next: "dispatched" },
  dispatched: { label: "Arrived at Job", next: "arrived" },
  arrived: { label: "Mark Loaded", next: "loaded" },
  loaded: { label: "Returning to Yard", next: "returning" },
  returning: { label: "Arrived at Yard", next: "at_yard" },
  at_yard: { label: "Check In", next: "completed" },
};
const nextStep = (d: Dispatch) => (d.direction === "outbound" ? OUTBOUND_STEPS : INBOUND_STEPS)[d.status];
const isLive = (d: Dispatch) => d.status !== "completed" && d.status !== "cancelled";

const equipmentSummary = (lines: DLine[]) => {
  if (lines.length === 0) return "No equipment";
  if (lines.length === 1) return `${lines[0].qty} ${lines[0].name}`;
  const total = lines.reduce((s, l) => s + l.qty, 0);
  return `${total} units · ${lines.length} lines`;
};
const shortDateTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Unscheduled";

type Tab = "all" | "outbound" | "inbound" | "completed";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "outbound", label: "Outbound" },
  { key: "inbound", label: "Inbound" },
  { key: "completed", label: "Completed" },
];

export default function DispatchScreen() {
  const { isShellWide, width } = useBreakpoint();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [equipment, setEquipment] = useState<Eq[]>([]);
  const [rentals, setRentals] = useState<RentalLite[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Dispatch | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignDraft, setAssignDraft] = useState<{ driver_name: string; truck: string; trailer: string; crew: string } | null>(null);

  const [creating, setCreating] = useState(false);
  const [newDirection, setNewDirection] = useState<Direction>("outbound");
  const [outboundDraft, setOutboundDraft] = useState({ customer_name: "", job_site: "", scheduled_date: "" });
  const [outboundLines, setOutboundLines] = useState<DLine[]>([]);
  const [qtyPrompt, setQtyPrompt] = useState<{ eq: Eq; qty: string } | null>(null);
  const [pickupRentalId, setPickupRentalId] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const [d, e, r] = await Promise.all([
        api<Dispatch[]>("/dispatches"),
        api<Eq[]>("/equipment"),
        api<RentalLite[]>("/rentals"),
      ]);
      setDispatches(d); setEquipment(e); setRentals(r);
      setSelected((current) => current ? d.find((x) => x.id === current.id) || null : null);
    } catch (err) { console.warn(err); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!params.open || dispatches.length === 0) return;
    setSelected(dispatches.find((d) => d.id === params.open) || null);
  }, [params.open, dispatches]);

  const openNew = () => {
    setNewDirection("outbound");
    setOutboundDraft({ customer_name: "", job_site: "", scheduled_date: "" });
    setOutboundLines([]);
    setPickupRentalId("");
    setCreating(true);
  };
  useEffect(() => {
    if (params.new) openNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.new]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  useEffect(() => {
    if (selected) setAssignDraft({ driver_name: selected.driver_name, truck: selected.truck, trailer: selected.trailer, crew: selected.crew });
  }, [selected?.id]);

  const advance = async (d: Dispatch, status: string) => {
    setBusy(true);
    try {
      await api(`/dispatches/${d.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      await load();
    } catch (e: any) {
      Alert.alert("Update failed", e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancelDispatch = (d: Dispatch) => {
    Alert.alert("Cancel dispatch", "This releases any equipment this dispatch reserved or moved. Continue?", [
      { text: "Keep it", style: "cancel" },
      { text: "Cancel dispatch", style: "destructive", onPress: () => advance(d, "cancelled") },
    ]);
  };

  const saveAssignment = async () => {
    if (!selected || !assignDraft) return;
    setBusy(true);
    try {
      await api(`/dispatches/${selected.id}/assign`, { method: "PATCH", body: JSON.stringify(assignDraft) });
      await load();
    } catch (e: any) {
      Alert.alert("Save failed", e.message);
    } finally {
      setBusy(false);
    }
  };

  const addOutboundLine = (eq: Eq) => {
    const existing = outboundLines.find((l) => l.equipment_id === eq.id);
    setQtyPrompt({ eq, qty: existing ? String(existing.qty) : "1" });
  };
  const confirmQty = () => {
    if (!qtyPrompt) return;
    const parsed = parseInt(qtyPrompt.qty, 10);
    if (Number.isNaN(parsed) || parsed <= 0) { Alert.alert("Invalid quantity", "Enter a positive whole number."); return; }
    const eq = qtyPrompt.eq;
    const currentOnLine = outboundLines.find((l) => l.equipment_id === eq.id)?.qty || 0;
    if (parsed - currentOnLine > eq.available) {
      Alert.alert("Not enough on hand", `Only ${eq.available} of ${eq.name} available.`);
      return;
    }
    setOutboundLines((lines) => {
      const exists = lines.find((l) => l.equipment_id === eq.id);
      if (exists) return lines.map((l) => l.equipment_id === eq.id ? { ...l, qty: parsed } : l);
      return [...lines, { equipment_id: eq.id, sku: eq.sku, name: eq.name, qty: parsed }];
    });
    setQtyPrompt(null);
  };
  const removeOutboundLine = (id: string) => setOutboundLines((lines) => lines.filter((l) => l.equipment_id !== id));

  const saveNewDispatch = async () => {
    try {
      if (newDirection === "outbound") {
        if (!outboundDraft.customer_name.trim() || outboundLines.length === 0) {
          Alert.alert("Required", "Customer name and at least one equipment line.");
          return;
        }
        await api("/dispatches", {
          method: "POST",
          body: JSON.stringify({
            direction: "outbound",
            customer_name: outboundDraft.customer_name,
            job_site: outboundDraft.job_site,
            scheduled_date: outboundDraft.scheduled_date ? new Date(outboundDraft.scheduled_date).toISOString() : null,
            lines: outboundLines,
          }),
        });
      } else {
        if (!pickupRentalId) { Alert.alert("Required", "Pick a rental to schedule the pickup for."); return; }
        await api(`/rentals/${pickupRentalId}/schedule-pickup`, { method: "POST", body: JSON.stringify({}) });
      }
      setCreating(false);
      await load();
    } catch (e: any) {
      Alert.alert("Create failed", e.message);
    }
  };

  const pickupEligibleRentals = useMemo(() => rentals.filter((r) => r.status !== "returned"), [rentals]);

  const counts = useMemo(() => ({
    all: dispatches.filter(isLive).length,
    outbound: dispatches.filter((d) => d.direction === "outbound" && isLive(d)).length,
    inbound: dispatches.filter((d) => d.direction === "inbound" && isLive(d)).length,
    completed: dispatches.filter((d) => !isLive(d)).length,
  }), [dispatches]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    let rows = dispatches.filter((d) => {
      if (tab === "outbound") return d.direction === "outbound" && isLive(d);
      if (tab === "inbound") return d.direction === "inbound" && isLive(d);
      if (tab === "completed") return !isLive(d);
      return isLive(d);
    });
    if (query) {
      rows = rows.filter((d) =>
        [d.id, d.customer_name, d.job_site, d.driver_name, d.truck, ...d.lines.flatMap((l) => [l.sku, l.name])]
          .some((v) => v?.toLowerCase().includes(query))
      );
    }
    return [...rows].sort((a, b) => {
      if (tab === "completed") return +new Date(b.completed_at || 0) - +new Date(a.completed_at || 0);
      return +new Date(a.scheduled_date || 0) - +new Date(b.scheduled_date || 0);
    });
  }, [dispatches, tab, search]);

  const columns = useMemo<ColumnDef<Dispatch>[]>(() => {
    const identity: ColumnDef<Dispatch>[] = [
      { key: "scheduled_date", label: "Time", width: 100, render: (d) => <Mono style={styles.tableMono}>{shortDateTime(d.scheduled_date)}</Mono> },
      { key: "direction", label: "Direction", width: 92, render: (d) => <DirectionTag direction={d.direction} /> },
      { key: "customer_name", label: "Customer / Job", flex: 1.2, render: (d) => (
        <View><Text numberOfLines={1}>{d.customer_name}</Text><Text style={styles.subCell} numberOfLines={1}>{d.job_site || "—"}</Text></View>
      ) },
    ];
    if (width < 1280) {
      return [...identity, { key: "status", label: "Status", width: 100, render: (d) => <StatusBadge label={d.status} /> }];
    }
    return [
      ...identity,
      { key: "equipment", label: "Equipment", flex: 1, render: (d) => <Text numberOfLines={1}>{equipmentSummary(d.lines)}</Text> },
      { key: "driver_name", label: "Driver", width: 110, render: (d) => d.driver_name || "—" },
      { key: "truck", label: "Truck", width: 90, render: (d) => d.truck || "—" },
      { key: "status", label: "Status", width: 110, render: (d) => <StatusBadge label={d.status} /> },
    ];
  }, [width]);

  return (
    <Screen title="Dispatch" subtitle={`${counts.outbound} outbound · ${counts.inbound} inbound scheduled`} back
      rightAction={{ icon: "add", onPress: openNew, testID: "new-dispatch-btn" }}
      onRefresh={onRefresh} refreshing={refreshing} testID="dispatch-screen" scroll={!isShellWide}>

      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          <View style={styles.tabRow}>
            <DispatchTabs tab={tab} counts={counts} onChange={setTab} />
          </View>
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search customer, job, driver, equipment…" testID="dispatch-search" style={{ flex: 1, maxWidth: 420 }} />
            <Button title="New Dispatch" onPress={openNew} fullWidth={false} style={styles.toolbarButton} testID="new-dispatch-desktop" />
          </PageToolbar>
          <View style={styles.tableWrap}>
            <DataTable
              columns={columns}
              rows={filtered}
              keyExtractor={(d) => d.id}
              rowTestID={(d) => `dispatch-${d.id}`}
              onRowPress={setSelected}
              selectedId={selected?.id}
              emptyLabel="No movements match these filters."
            />
          </View>
        </View>
      ) : (
        <>
          <DispatchTabs tab={tab} counts={counts} onChange={setTab} />
          {filtered.length === 0 ? (
            <Card><Text style={[typo.body, { color: colors.inkMuted }]}>Nothing here.</Text></Card>
          ) : filtered.map((d) => (
            <TouchableOpacity key={d.id} onPress={() => setSelected(d)} testID={`dispatch-${d.id}`}>
              <Card style={{ marginBottom: spacing.sm }}>
                <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <View style={{ flex: 1 }}>
                    <Row style={{ gap: 6 }}><DirectionTag direction={d.direction} /><Mono style={{ fontSize: 11, color: colors.inkMuted }}>{shortDateTime(d.scheduled_date)}</Mono></Row>
                    <H3 style={{ marginTop: 4 }}>{d.customer_name}</H3>
                    <Text style={[typo.bodySmall, { marginTop: 2 }]}>{d.job_site || "—"}</Text>
                  </View>
                  <StatusBadge label={d.status} />
                </Row>
                <Text style={[typo.bodySmall, { marginTop: spacing.sm }]}>{equipmentSummary(d.lines)}</Text>
                {d.driver_name ? <Text style={[typo.caption, { marginTop: 4 }]}>Driver: {d.driver_name}{d.truck ? ` · ${d.truck}` : ""}</Text> : null}
              </Card>
            </TouchableOpacity>
          ))}
        </>
      )}

      <DetailDrawer
        visible={isShellWide && !!selected}
        title={selected ? (selected.direction === "outbound" ? "Outbound" : "Inbound") : "Dispatch detail"}
        subtitle={selected ? `${selected.customer_name} · ${shortDateTime(selected.scheduled_date)}` : undefined}
        onClose={() => setSelected(null)}
        width={460}
        testID="dispatch-detail-drawer"
      >
        {selected ? (
          <View>
            <View style={styles.detailStatusRow}>
              <StatusBadge label={selected.status} />
              <DirectionTag direction={selected.direction} />
            </View>
            <DetailSection label="Job site">
              <Text style={styles.detailTitle}>{selected.job_site || "No job site"}</Text>
            </DetailSection>
            <DetailSection label={`Equipment (${selected.lines.length})`}>
              {selected.lines.map((l) => (
                <Row key={l.equipment_id} style={{ justifyContent: "space-between", paddingVertical: 4 }}>
                  <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.detailTitle} numberOfLines={1}>{l.name}</Text><Mono style={styles.detailSku}>{l.sku}</Mono></View>
                  <Mono style={styles.detailAmount}>{l.qty}</Mono>
                </Row>
              ))}
            </DetailSection>
            <DetailSection label="Assignment">
              <Input label="Driver" value={assignDraft?.driver_name || ""} onChangeText={(t) => setAssignDraft((a) => a ? { ...a, driver_name: t } : a)} testID="assign-driver" />
              <Row style={{ gap: spacing.md }}>
                <View style={{ flex: 1 }}><Input label="Truck" value={assignDraft?.truck || ""} onChangeText={(t) => setAssignDraft((a) => a ? { ...a, truck: t } : a)} testID="assign-truck" /></View>
                <View style={{ flex: 1 }}><Input label="Trailer" value={assignDraft?.trailer || ""} onChangeText={(t) => setAssignDraft((a) => a ? { ...a, trailer: t } : a)} testID="assign-trailer" /></View>
              </Row>
              <Button title="Save assignment" onPress={saveAssignment} variant="outline" loading={busy} testID="save-assignment-btn" />
            </DetailSection>
            {selected.notes ? <DetailSection label="Notes"><Text style={styles.detailText}>{selected.notes}</Text></DetailSection> : null}
            {selected.rental_id ? <DetailSection label="Linked rental"><Mono style={styles.detailText}>{selected.rental_id.slice(0, 12)}</Mono></DetailSection> : null}
            <View style={styles.drawerActions}>
              {isLive(selected) && nextStep(selected) ? (
                <Button title={nextStep(selected)!.label} onPress={() => advance(selected, nextStep(selected)!.next)} loading={busy} testID="dispatch-advance-btn" />
              ) : null}
              {isLive(selected) ? (
                <Button title="Cancel Dispatch" onPress={() => cancelDispatch(selected)} variant="danger" testID="dispatch-cancel-btn" />
              ) : null}
            </View>
          </View>
        ) : null}
      </DetailDrawer>

      <Modal visible={creating} animationType="slide" onRequestClose={() => setCreating(false)}>
        <Screen
          title="New Dispatch"
          back
          rightAction={{ icon: "close", onPress: () => setCreating(false), testID: "close-new-dispatch" }}
          desktopHeader={
            <PageHeader
              title="New Dispatch"
              actions={<Button title="Close" onPress={() => setCreating(false)} variant="outline" fullWidth={false} style={{ height: 38 }} testID="close-new-dispatch" />}
            />
          }
        >
          <SectionLabel>Direction</SectionLabel>
          <Row style={{ gap: spacing.sm, marginBottom: spacing.md }}>
            <View style={{ flex: 1 }}><Button title="Outbound" onPress={() => setNewDirection("outbound")} variant={newDirection === "outbound" ? "primary" : "outline"} testID="new-dispatch-outbound" /></View>
            <View style={{ flex: 1 }}><Button title="Inbound" onPress={() => setNewDirection("inbound")} variant={newDirection === "inbound" ? "primary" : "outline"} testID="new-dispatch-inbound" /></View>
          </Row>

          {newDirection === "outbound" ? (
            <>
              <Input label="Customer Name" value={outboundDraft.customer_name} onChangeText={(t) => setOutboundDraft((d) => ({ ...d, customer_name: t }))} testID="dispatch-cust-name" />
              <Input label="Job Site" value={outboundDraft.job_site} onChangeText={(t) => setOutboundDraft((d) => ({ ...d, job_site: t }))} testID="dispatch-job-site" />
              <Input label="Scheduled date (yyyy-mm-dd)" value={outboundDraft.scheduled_date} onChangeText={(t) => setOutboundDraft((d) => ({ ...d, scheduled_date: t }))} mono autoCapitalize="none" testID="dispatch-sched-date" />

              <SectionLabel>Equipment ({outboundLines.length})</SectionLabel>
              {outboundLines.map((l) => (
                <Card key={l.equipment_id} style={{ marginBottom: spacing.sm }}>
                  <Row style={{ justifyContent: "space-between" }}>
                    <View style={{ flex: 1 }}><Text style={typo.body}>{l.name}</Text><Mono style={{ fontSize: 11, color: colors.inkMuted }}>{l.sku} · {l.qty}</Mono></View>
                    <TouchableOpacity onPress={() => removeOutboundLine(l.equipment_id)} testID={`remove-dispatch-line-${l.sku}`}><Ionicons name="close-circle" size={22} color={colors.inkMuted} /></TouchableOpacity>
                  </Row>
                </Card>
              ))}
              <SectionLabel>Add equipment</SectionLabel>
              <View style={{ borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md }} testID="dispatch-add-eq-list">
                {equipment.map((e) => (
                  <TouchableOpacity key={e.id} onPress={() => addOutboundLine(e)} style={styles.eqRow} testID={`dispatch-add-eq-${e.sku}`}>
                    <View style={{ flex: 1 }}><Text style={typo.body}>{e.name}</Text><Mono style={{ fontSize: 11, color: colors.inkMuted }}>{e.sku} · {e.available} avail</Mono></View>
                    <Ionicons name="add-circle" size={26} color={colors.orange} />
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : (
            <>
              <SectionLabel>Rental to pick up from</SectionLabel>
              <Text style={[typo.bodySmall, { marginBottom: spacing.sm }]}>Schedules a pickup for whatever's still outstanding on that rental.</Text>
              <View style={{ borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md }} testID="pickup-rental-list">
                {pickupEligibleRentals.map((r) => (
                  <TouchableOpacity key={r.id} onPress={() => setPickupRentalId(r.id)} style={[styles.eqRow, pickupRentalId === r.id && styles.eqRowSelected]} testID={`pickup-rental-${r.id}`}>
                    <View style={{ flex: 1 }}><Text style={typo.body}>{r.customer_name}</Text><Mono style={{ fontSize: 11, color: colors.inkMuted }}>{r.job_site || "No job site"} · {r.status}</Mono></View>
                    {pickupRentalId === r.id ? <Ionicons name="checkmark-circle" size={22} color={colors.primary} /> : null}
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          <Button title="Create Dispatch" onPress={saveNewDispatch} testID="save-dispatch-btn" />
        </Screen>
      </Modal>

      <Modal visible={!!qtyPrompt} transparent animationType="fade" onRequestClose={() => setQtyPrompt(null)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setQtyPrompt(null)} style={styles.qtyBackdrop}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.qtyDialog} testID="dispatch-qty-dialog">
            {qtyPrompt ? (
              <>
                <H3>{qtyPrompt.eq.name}</H3>
                <Text style={[typo.bodySmall, { marginTop: 4, marginBottom: spacing.md }]}>{qtyPrompt.eq.sku} · {qtyPrompt.eq.available} available</Text>
                <Input label="Quantity" value={qtyPrompt.qty} onChangeText={(t) => setQtyPrompt({ ...qtyPrompt, qty: t.replace(/[^0-9]/g, "") })} keyboardType="number-pad" autoFocus mono returnKeyType="done" onSubmitEditing={confirmQty} testID="dispatch-qty-input" />
                <Row style={{ gap: spacing.sm }}>
                  <View style={{ flex: 1 }}><Button title="Cancel" onPress={() => setQtyPrompt(null)} variant="outline" testID="dispatch-qty-cancel" /></View>
                  <View style={{ flex: 1 }}><Button title="Add" onPress={confirmQty} testID="dispatch-qty-confirm" /></View>
                </Row>
              </>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </Screen>
  );
}

const DirectionTag: React.FC<{ direction: Direction }> = ({ direction }) => (
  <Row style={[styles.directionTag, direction === "outbound" ? styles.directionTagOut : styles.directionTagIn]}>
    <Ionicons name={direction === "outbound" ? "arrow-up-outline" : "arrow-down-outline"} size={12} color={direction === "outbound" ? colors.primary : colors.accent} />
    <Text style={[styles.directionTagText, { color: direction === "outbound" ? colors.primary : colors.accent }]}>{direction === "outbound" ? "Outbound" : "Inbound"}</Text>
  </Row>
);

const DispatchTabs: React.FC<{ tab: Tab; counts: Record<Tab, number>; onChange: (t: Tab) => void }> = ({ tab, counts, onChange }) => (
  <View style={styles.tabsWrap} testID="dispatch-tabs">
    {TABS.map(({ key, label }) => {
      const active = tab === key;
      return (
        <TouchableOpacity key={key} onPress={() => onChange(key)} style={[styles.tabItem, active && styles.tabItemActive]} testID={`dispatch-tab-${key}`}>
          <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
          <View style={[styles.tabCount, active && styles.tabCountActive]}><Text style={[styles.tabCountText, active && styles.tabCountTextActive]}>{counts[key]}</Text></View>
        </TouchableOpacity>
      );
    })}
  </View>
);

const DetailSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <View style={styles.detailSection}><Text style={styles.detailLabel}>{label}</Text>{children}</View>
);

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg },
  tabRow: { paddingHorizontal: spacing.xl, marginBottom: spacing.sm },
  tabsWrap: { flexDirection: "row", gap: spacing.xs, marginBottom: spacing.md, paddingHorizontal: spacing.xl },
  tabItem: { height: 38, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  tabItemActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  tabText: { fontSize: 13, fontWeight: "700", color: colors.inkSecondary },
  tabTextActive: { color: colors.primary },
  tabCount: { minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.bgTint },
  tabCountActive: { backgroundColor: colors.bg },
  tabCountText: { fontSize: 10.5, fontWeight: "800", color: colors.inkMuted },
  tabCountTextActive: { color: colors.primary },
  toolbarButton: { height: 40 },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, marginBottom: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", backgroundColor: colors.bg },
  tableMono: { fontSize: 12 },
  subCell: { ...typo.caption, marginTop: 2, textTransform: "none", letterSpacing: 0 },
  directionTag: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radii.sm },
  directionTagOut: { backgroundColor: colors.primarySoft },
  directionTagIn: { backgroundColor: colors.accentSoft },
  directionTagText: { fontSize: 11, fontWeight: "700" },
  detailStatusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  detailSection: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  detailLabel: { ...typo.caption, color: colors.inkSecondary, marginBottom: 6 },
  detailTitle: { ...typo.body, fontWeight: "700" },
  detailText: { ...typo.bodySmall, marginTop: 2 },
  detailSku: { fontSize: 10.5, color: colors.inkMuted },
  detailAmount: { width: 50, textAlign: "right", fontSize: 12 },
  drawerActions: { paddingTop: spacing.lg, gap: spacing.sm },
  eqRow: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  eqRowSelected: { backgroundColor: colors.primarySoft },
  qtyBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  qtyDialog: { backgroundColor: colors.bg, borderRadius: 8, padding: 20, width: "100%", maxWidth: 360 },
});

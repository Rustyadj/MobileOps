import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { SearchInput } from "@/src/components/data/SearchInput";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { PageHeader } from "@/src/components/layout/PageHeader";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { usePermissions } from "@/src/hooks/use-permissions";
import { useCachedResource } from "@/src/hooks/use-cached-resource";
import { mutate } from "@/src/sync/mutate";
import { colors, spacing, type as typo, radii } from "@/src/theme";
import { DISPATCH_STATUS, TERMINAL_DISPATCH_STATUSES, isDispatchLive, isRentalReturned } from "@/src/domain/status";

type Direction = "outbound" | "inbound";
type DLine = {
  equipment_id: string; sku: string; name: string; qty: number;
  delivered_qty?: number | null; pickup_confirmed?: boolean;
};
type Eq = { id: string; sku: string; name: string; available: number };
type RentalLite = { id: string; customer_name: string; job_site: string; status: string };
type Dispatch = {
  id: string; direction: Direction; status: string;
  scheduled_date?: string | null; customer_name: string; job_site: string;
  lat?: number | null; lng?: number | null;
  rental_id?: string | null; booking_id?: string | null;
  driver_name: string; truck: string; trailer: string; crew: string;
  lines: DLine[]; notes: string; created_by: string;
  planning_only?: boolean; requirements?: string[]; source_date_text?: string;
  date_confirmed?: boolean; raw_text?: string;
  started_at?: string | null; arrived_at?: string | null; completed_at?: string | null;
};

// Mirrors backend DISPATCH_FLOWS — each entry maps the *current* status to
// the action button that advances it, and the status that action produces.
const OUTBOUND_STEPS: Record<string, { label: string; next: string }> = {
  [DISPATCH_STATUS.scheduled]: { label: "Start Staging", next: DISPATCH_STATUS.staging },
  [DISPATCH_STATUS.staging]: { label: "Mark Ready", next: DISPATCH_STATUS.ready },
  [DISPATCH_STATUS.ready]: { label: "Mark Loaded", next: DISPATCH_STATUS.loaded },
  [DISPATCH_STATUS.loaded]: { label: "Dispatch", next: DISPATCH_STATUS.dispatched },
  [DISPATCH_STATUS.dispatched]: { label: "Mark Arrived", next: DISPATCH_STATUS.arrived },
  [DISPATCH_STATUS.arrived]: { label: "Complete Delivery", next: DISPATCH_STATUS.completed },
};
const INBOUND_STEPS: Record<string, { label: string; next: string }> = {
  [DISPATCH_STATUS.scheduled]: { label: "Dispatch Driver", next: DISPATCH_STATUS.dispatched },
  [DISPATCH_STATUS.dispatched]: { label: "Arrived at Job", next: DISPATCH_STATUS.arrived },
  [DISPATCH_STATUS.arrived]: { label: "Mark Loaded", next: DISPATCH_STATUS.loaded },
  [DISPATCH_STATUS.loaded]: { label: "Returning to Yard", next: DISPATCH_STATUS.returning },
  [DISPATCH_STATUS.returning]: { label: "Arrived at Yard", next: DISPATCH_STATUS.atYard },
  [DISPATCH_STATUS.atYard]: { label: "Check In", next: DISPATCH_STATUS.completed },
};
const nextStep = (d: Dispatch) => d.planning_only ? undefined : (d.direction === "outbound" ? OUTBOUND_STEPS : INBOUND_STEPS)[d.status];
const isLive = (d: Dispatch) => isDispatchLive(d.status);
type PlanningAction = { label: string; status: "active_rental" | "ready_for_pickup" | "completed"; message: string };
const planningAction = (d: Dispatch): PlanningAction => {
  if (d.direction === "outbound") return {
    label: "Mark Delivered",
    status: DISPATCH_STATUS.activeRental,
    message: "This moves the delivered job into Active Rentals until an admin completes it. Continue?",
  };
  if (d.status === DISPATCH_STATUS.activeRental) return {
    label: "Complete Rental",
    status: DISPATCH_STATUS.readyForPickup,
    message: "This moves the completed rental into Inbound for pickup. Continue?",
  };
  return {
    label: "Mark Picked Up",
    status: DISPATCH_STATUS.completed,
    message: "This archives the completed planning item for later reference without moving rental or inventory buckets. Continue?",
  };
};

const equipmentSummary = (lines: DLine[], requirements: string[] = []) => {
  if (lines.length === 0 && requirements.length > 0) {
    if (requirements.length <= 2) return requirements.join(" · ");
    return `${requirements[0]} · ${requirements[1]} · +${requirements.length - 2} more`;
  }
  if (lines.length === 0) return "Equipment list pending";
  if (lines.length === 1) return `${lines[0].qty} ${lines[0].name}`;
  const total = lines.reduce((s, l) => s + l.qty, 0);
  return `${total} units · ${lines.length} lines`;
};
const shortDateTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Unscheduled";
const dispatchDate = (dispatch: Dispatch) => dispatch.source_date_text || shortDateTime(dispatch.scheduled_date);
const awaitingAdminCompletion = (dispatch: Dispatch) => dispatch.planning_only && dispatch.status === DISPATCH_STATUS.activeRental;
const visibleMovement = (dispatch: Dispatch) => isLive(dispatch) && !awaitingAdminCompletion(dispatch);
const displayStatus = (dispatch: Dispatch) => {
  const awaitingPickup = dispatch.direction === "inbound" &&
    [DISPATCH_STATUS.scheduled, DISPATCH_STATUS.readyForPickup].includes(dispatch.status as any);
  if (!awaitingPickup) return { label: dispatch.status };
  return dispatch.date_confirmed && dispatch.scheduled_date
    ? { label: "Confirmed", tone: "success" as const }
    : { label: "Pickup date unconfirmed", tone: "warning" as const };
};

type Tab = "all" | "outbound" | "inbound" | "completed";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "outbound", label: "Outbound" },
  { key: "inbound", label: "Inbound" },
  { key: "completed", label: "Archive" },
];

type DispatchScreenProps = { initialDirection?: Direction };

export function DispatchScreen({ initialDirection }: DispatchScreenProps = {}) {
  const { isShellWide, width } = useBreakpoint();
  const { canEdit, canAdmin } = usePermissions();
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const dispatchesRes = useCachedResource<Dispatch>("dispatches", () => api<Dispatch[]>("/dispatches"));
  const equipmentRes = useCachedResource<Eq>("equipment", () => api<Eq[]>("/equipment"));
  const rentalsRes = useCachedResource<RentalLite>("rentals", () => api<RentalLite[]>("/rentals"));
  const dispatches = dispatchesRes.data;
  const equipment = equipmentRes.data;
  const rentals = rentalsRes.data;
  const refreshing = dispatchesRes.refreshing || equipmentRes.refreshing || rentalsRes.refreshing;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = dispatches.find((d) => d.id === selectedId) || null;
  const setSelected = (d: Dispatch | null) => setSelectedId(d?.id ?? null);
  const [tab, setTab] = useState<Tab>(initialDirection || "all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignDraft, setAssignDraft] = useState<{ driver_name: string; truck: string; trailer: string; crew: string; scheduled_date: string } | null>(null);
  const [ticketLines, setTicketLines] = useState<Array<{ deliveredQty: string; pickupConfirmed: boolean }>>([]);

  const [creating, setCreating] = useState(false);
  const [newDirection, setNewDirection] = useState<Direction>(initialDirection || "outbound");
  const [outboundDraft, setOutboundDraft] = useState({ customer_name: "", job_site: "", scheduled_date: "" });
  const [outboundLines, setOutboundLines] = useState<DLine[]>([]);
  const [qtyPrompt, setQtyPrompt] = useState<{ eq: Eq; qty: string } | null>(null);
  const [pickupRentalId, setPickupRentalId] = useState<string>("");
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    title: string; message: string; confirmLabel: string; destructive?: boolean; onConfirm: () => void;
  } | null>(null);

  useEffect(() => {
    if (!params.open || dispatches.length === 0) return;
    setSelectedId(params.open);
  }, [params.open, dispatches.length]);

  const openNew = () => {
    setNewDirection(initialDirection || "outbound");
    setOutboundDraft({ customer_name: "", job_site: "", scheduled_date: "" });
    setOutboundLines([]);
    setPickupRentalId("");
    setCreating(true);
  };
  useEffect(() => {
    if (params.new) openNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.new]);

  const onRefresh = () => { dispatchesRes.onRefresh(); equipmentRes.onRefresh(); rentalsRes.onRefresh(); };

  useEffect(() => {
    if (selected) setAssignDraft({
      driver_name: selected.driver_name, truck: selected.truck, trailer: selected.trailer, crew: selected.crew,
      scheduled_date: selected.scheduled_date ? new Date(selected.scheduled_date).toISOString().slice(0, 16) : "",
    });
  }, [selected]);

  useEffect(() => {
    setTicketLines((selected?.lines || []).map((line) => ({
      deliveredQty: line.delivered_qty == null ? "" : String(line.delivered_qty),
      pickupConfirmed: !!line.pickup_confirmed,
    })));
  }, [selected?.id]);

  // Queues offline — this is the button a driver/crew taps standing at the
  // truck or job site. The optimistic patch only updates the dispatch's own
  // status/timestamp fields; the equipment bucket movement that status
  // change triggers server-side (_set_dispatch_status) is more involved
  // than a single-field patch, so the equipment list's numbers catch up
  // once this syncs rather than updating instantly — the dispatch's own
  // status (what this screen is about) updates immediately either way.
  const advance = async (d: Dispatch, status: string) => {
    if (d.planning_only) {
      setBusy(true);
      try {
        const updated = await api<Dispatch>(`/dispatches/${d.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
        dispatchesRes.onRefresh();
        if (updated.status === DISPATCH_STATUS.activeRental) {
          setSelected(null);
          router.push("/(app)/operations/active" as any);
          return;
        }
        if (!initialDirection) {
          if (TERMINAL_DISPATCH_STATUSES.includes(updated.status)) setTab("completed");
          else if (d.direction === "outbound" && updated.direction === "inbound") setTab("inbound");
        }
      } catch (e: any) {
        Alert.alert("Update failed", e.message);
      } finally {
        setBusy(false);
      }
      return;
    }

    const now = new Date().toISOString();
    const patch: Partial<Dispatch> = { status };
    if (status === DISPATCH_STATUS.dispatched && !d.started_at) patch.started_at = now;
    if (status === DISPATCH_STATUS.arrived && !d.arrived_at) patch.arrived_at = now;
    if (TERMINAL_DISPATCH_STATUSES.includes(status)) patch.completed_at = now;
    mutate<Dispatch>({
      kind: "command",
      entityType: "dispatches",
      entityId: d.id,
      path: `/dispatches/${d.id}/status`,
      method: "PATCH",
      body: { status },
      optimisticPatch: patch,
    });
  };

  const cancelDispatch = (d: Dispatch) => {
    setPendingConfirmation({
      title: "Cancel dispatch", message: "This releases any equipment this dispatch reserved or moved. Continue?",
      confirmLabel: "Cancel dispatch", destructive: true, onConfirm: () => advance(d, "cancelled"),
    });
  };

  const ticketReady = selected && !selected.planning_only && nextStep(selected)?.next === DISPATCH_STATUS.completed &&
    (selected.direction === "outbound"
      ? ticketLines.length === selected.lines.length && ticketLines.every((line, index) => {
          const qty = Number.parseInt(line.deliveredQty, 10);
          return Number.isInteger(qty) && qty >= 0 && qty <= selected.lines[index].qty;
        }) && ticketLines.some((line) => Number.parseInt(line.deliveredQty, 10) > 0)
      : ticketLines.length === selected.lines.length && ticketLines.every((line) => line.pickupConfirmed));

  const completeTicket = (dispatch: Dispatch) => {
    if (!ticketReady) return;
    const lines = dispatch.lines.map((line, lineIndex) => ({
      line_index: lineIndex,
      equipment_id: line.equipment_id,
      ...(dispatch.direction === "outbound"
        ? { delivered_qty: Number.parseInt(ticketLines[lineIndex].deliveredQty, 10) }
        : { pickup_confirmed: ticketLines[lineIndex].pickupConfirmed }),
    }));
    const now = new Date().toISOString();
    mutate<Dispatch>({
      kind: "command",
      entityType: "dispatches",
      entityId: dispatch.id,
      path: `/dispatches/${dispatch.id}/complete-ticket`,
      method: "POST",
      body: { lines },
      optimisticPatch: {
        status: DISPATCH_STATUS.completed,
        completed_at: now,
        lines: dispatch.lines.map((line, index) => ({
          ...line,
          ...(dispatch.direction === "outbound"
            ? { delivered_qty: Number.parseInt(ticketLines[index].deliveredQty, 10) }
            : { pickup_confirmed: true }),
        })),
      },
    });
    setSelected(null);
  };

  const confirmPlanAction = (d: Dispatch, action: PlanningAction) => {
    setPendingConfirmation({
      title: action.label, message: action.message, confirmLabel: action.label,
      onConfirm: () => advance(d, action.status),
    });
  };

  const cancelPlan = (d: Dispatch) => {
    setPendingConfirmation({
      title: "Cancel Plan", message: "This cancels the planning item without changing inventory. Continue?",
      confirmLabel: "Cancel Plan", destructive: true, onConfirm: () => advance(d, "cancelled"),
    });
  };

  const saveAssignment = async () => {
    if (!selected || !assignDraft) return;
    setBusy(true);
    try {
      const { scheduled_date, ...rest } = assignDraft;
      await api(`/dispatches/${selected.id}/assign`, {
        method: "PATCH",
        body: JSON.stringify({ ...rest, scheduled_date: scheduled_date ? new Date(scheduled_date).toISOString() : null }),
      });
      dispatchesRes.onRefresh();
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
      dispatchesRes.onRefresh(); rentalsRes.onRefresh();
    } catch (e: any) {
      Alert.alert("Create failed", e.message);
    }
  };

  const pickupEligibleRentals = useMemo(() => rentals.filter((r) => !isRentalReturned(r.status)), [rentals]);

  const counts = useMemo(() => ({
    all: dispatches.filter(visibleMovement).length,
    outbound: dispatches.filter((d) => d.direction === "outbound" && visibleMovement(d)).length,
    inbound: dispatches.filter((d) => d.direction === "inbound" && visibleMovement(d)).length,
    completed: dispatches.filter((d) => !isLive(d)).length,
  }), [dispatches]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    let rows = dispatches.filter((d) => {
      if (tab === "outbound") return d.direction === "outbound" && visibleMovement(d);
      if (tab === "inbound") return d.direction === "inbound" && visibleMovement(d);
      if (tab === "completed") return !isLive(d);
      return visibleMovement(d);
    });
    if (query) {
      rows = rows.filter((d) =>
        [d.id, d.customer_name, d.job_site, d.driver_name, d.truck, d.notes, d.raw_text, ...(d.requirements || []), ...d.lines.flatMap((l) => [l.sku, l.name])]
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
      { key: "scheduled_date", label: "Time", width: 100, render: (d) => <Mono style={styles.tableMono}>{dispatchDate(d)}</Mono> },
      { key: "direction", label: "Direction", width: 92, render: (d) => <DirectionTag direction={d.direction} /> },
      { key: "customer_name", label: "Customer / Job", flex: 1.2, render: (d) => (
        <View><Text numberOfLines={1}>{d.customer_name}</Text><Text style={styles.subCell} numberOfLines={1}>{d.job_site || "—"}</Text></View>
      ) },
    ];
    if (width < 1280) {
      return [...identity, { key: "status", label: "Status", width: 160, render: (d) => <StatusBadge {...displayStatus(d)} /> }];
    }
    return [
      ...identity,
      { key: "equipment", label: "Equipment", flex: 1, render: (d) => <Text numberOfLines={1}>{equipmentSummary(d.lines, d.requirements)}</Text> },
      { key: "driver_name", label: "Driver", width: 110, render: (d) => d.driver_name || "—" },
      { key: "truck", label: "Truck", width: 90, render: (d) => d.truck || "—" },
      { key: "status", label: "Status", width: 160, render: (d) => <StatusBadge {...displayStatus(d)} /> },
    ];
  }, [width]);

  return (
    <Screen title={initialDirection === "outbound" ? "Outbound" : initialDirection === "inbound" ? "Inbound" : "Dispatch"}
      subtitle={initialDirection === "outbound" ? `${counts.outbound} scheduled, loading, or delivering` : initialDirection === "inbound" ? `${counts.inbound} pickups scheduled or returning` : `${counts.outbound} outbound · ${counts.inbound} inbound scheduled`} back
      rightAction={canEdit ? { icon: "add", onPress: openNew, testID: "new-dispatch-btn" } : undefined}
      onRefresh={onRefresh} refreshing={refreshing} testID="dispatch-screen" scroll={!isShellWide}>

      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          {!initialDirection ? <View style={styles.tabRow}>
            <DispatchTabs tab={tab} counts={counts} onChange={setTab} />
          </View> : null}
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search customer, job, driver, equipment…" testID="dispatch-search" style={{ flex: 1, maxWidth: 420 }} />
            {canEdit ? <Button title="New Dispatch" onPress={openNew} fullWidth={false} style={styles.toolbarButton} testID="new-dispatch-desktop" /> : null}
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
                    <Row style={{ gap: 6 }}><DirectionTag direction={d.direction} /><Mono style={{ fontSize: 11, color: colors.inkMuted }}>{dispatchDate(d)}</Mono></Row>
                    <H3 style={{ marginTop: 4 }}>{d.customer_name}</H3>
                    <Text style={[typo.bodySmall, { marginTop: 2 }]}>{d.job_site || "—"}</Text>
                  </View>
                  <StatusBadge {...displayStatus(d)} />
                </Row>
                <Text style={[typo.bodySmall, { marginTop: spacing.sm }]}>{equipmentSummary(d.lines, d.requirements)}</Text>
                {d.driver_name ? <Text style={[typo.caption, { marginTop: 4 }]}>{d.planning_only ? "Owner" : "Driver"}: {d.driver_name}{d.truck ? ` · ${d.truck}` : ""}</Text> : null}
              </Card>
            </TouchableOpacity>
          ))}
        </>
      )}

      <DetailDrawer
        visible={!!selected}
        title={selected ? (selected.direction === "outbound" ? "Outbound" : "Inbound") : "Dispatch detail"}
        subtitle={selected ? `${selected.customer_name} · ${dispatchDate(selected)}` : undefined}
        onClose={() => setSelected(null)}
        width={460}
        testID="dispatch-detail-drawer"
      >
        {selected ? (
          <View>
            <View style={styles.detailStatusRow}>
              <StatusBadge {...displayStatus(selected)} />
              <DirectionTag direction={selected.direction} />
            </View>
            <DetailSection label="Job site">
              <Text style={styles.detailTitle}>{selected.job_site || "No job site"}</Text>
            </DetailSection>
            {selected.planning_only ? (
              <>
                <View style={styles.planNotice} testID="outbound-plan-notice">
                  <Ionicons name="information-circle-outline" size={18} color={colors.info} />
                  <Text style={styles.planNoticeText}>Planning item only · inventory is not reserved</Text>
                </View>
                <DetailSection label={`Requirements (${selected.requirements?.length || 0})`}>
                  {(selected.requirements || []).length ? (selected.requirements || []).map((requirement, index) => (
                    <Row key={`${selected.id}-requirement-${index}`} style={styles.requirementRow}>
                      <Ionicons name="cube-outline" size={15} color={colors.inkMuted} />
                      <Text style={[styles.detailText, { flex: 1 }]}>{requirement}</Text>
                    </Row>
                  )) : <Text style={styles.detailText}>Equipment list pending.</Text>}
                </DetailSection>
                {selected.driver_name ? <DetailSection label="Owner"><Text style={styles.detailTitle}>{selected.driver_name}</Text></DetailSection> : null}
              </>
            ) : (
              <>
                <DetailSection label={`Equipment (${selected.lines.length})`}>
                  {selected.lines.map((l, lineIndex) => (
                    <Row key={`${l.equipment_id}-${lineIndex}`} style={styles.ticketLine}>
                      <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.detailTitle} numberOfLines={1}>{l.name}</Text><Mono style={styles.detailSku}>{l.sku}</Mono></View>
                      <Mono style={styles.detailAmount}>{l.qty} planned</Mono>
                      {nextStep(selected)?.next === DISPATCH_STATUS.completed && selected.direction === "outbound" ? (
                        <View style={styles.quantityBox}>
                          <Input
                            label="Delivered qty"
                            value={ticketLines[lineIndex]?.deliveredQty || ""}
                            onChangeText={(value) => setTicketLines((lines) => lines.map((line, index) => index === lineIndex ? { ...line, deliveredQty: value.replace(/[^0-9]/g, "") } : line))}
                            keyboardType="number-pad"
                            mono
                            testID={`delivery-qty-${lineIndex}`}
                          />
                        </View>
                      ) : null}
                      {nextStep(selected)?.next === DISPATCH_STATUS.completed && selected.direction === "inbound" ? (
                        <TouchableOpacity
                          onPress={() => setTicketLines((lines) => lines.map((line, index) => index === lineIndex ? { ...line, pickupConfirmed: !line.pickupConfirmed } : line))}
                          style={styles.pickupCheck}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: !!ticketLines[lineIndex]?.pickupConfirmed }}
                          testID={`pickup-check-${lineIndex}`}
                        >
                          <Ionicons name={ticketLines[lineIndex]?.pickupConfirmed ? "checkbox" : "square-outline"} size={25} color={ticketLines[lineIndex]?.pickupConfirmed ? colors.success : colors.inkMuted} />
                          <Text style={styles.pickupCheckText}>Picked up</Text>
                        </TouchableOpacity>
                      ) : null}
                    </Row>
                  ))}
                  {nextStep(selected)?.next === DISPATCH_STATUS.completed ? (
                    <Text style={styles.ticketHelp}>
                      {selected.direction === "outbound"
                        ? "Enter the actual delivered quantity for every product. The ticket cannot complete with a blank line."
                        : "Check every product loaded for return before completing the pickup ticket."}
                    </Text>
                  ) : null}
                </DetailSection>
                <DetailSection label="Assignment">
                  <Input
                    label="Scheduled date/time (yyyy-mm-ddThh:mm)"
                    value={assignDraft?.scheduled_date || ""}
                    onChangeText={(t) => setAssignDraft((a) => a ? { ...a, scheduled_date: t } : a)}
                    mono
                    autoCapitalize="none"
                    testID="assign-scheduled-date"
                  />
                  <Input label="Driver" value={assignDraft?.driver_name || ""} onChangeText={(t) => setAssignDraft((a) => a ? { ...a, driver_name: t } : a)} testID="assign-driver" />
                  <Row style={{ gap: spacing.md }}>
                    <View style={{ flex: 1 }}><Input label="Truck" value={assignDraft?.truck || ""} onChangeText={(t) => setAssignDraft((a) => a ? { ...a, truck: t } : a)} testID="assign-truck" /></View>
                    <View style={{ flex: 1 }}><Input label="Trailer" value={assignDraft?.trailer || ""} onChangeText={(t) => setAssignDraft((a) => a ? { ...a, trailer: t } : a)} testID="assign-trailer" /></View>
                  </Row>
                  {canEdit ? <Button title="Save assignment" onPress={saveAssignment} variant="outline" loading={busy} testID="save-assignment-btn" /> : null}
                </DetailSection>
              </>
            )}
            {selected.notes ? <DetailSection label="Notes"><Text style={styles.detailText}>{selected.notes}</Text></DetailSection> : null}
            {selected.planning_only && selected.raw_text ? <DetailSection label="Original reminder"><Text style={styles.detailText}>{selected.raw_text}</Text></DetailSection> : null}
            {selected.rental_id ? <DetailSection label="Linked rental"><Mono style={styles.detailText}>{selected.rental_id.slice(0, 12)}</Mono></DetailSection> : null}
            <View style={styles.drawerActions}>
              {canEdit && isLive(selected) && nextStep(selected) ? (
                nextStep(selected)!.next === DISPATCH_STATUS.completed
                  ? <Button title={selected.direction === "outbound" ? "Complete Delivery Ticket" : "Complete Pickup Ticket"} onPress={() => completeTicket(selected)} disabled={!ticketReady} testID="dispatch-complete-ticket-btn" />
                  : <Button title={nextStep(selected)!.label} onPress={() => advance(selected, nextStep(selected)!.next)} testID="dispatch-advance-btn" />
              ) : null}
              {canEdit && isLive(selected) && selected.planning_only && selected.status !== DISPATCH_STATUS.activeRental ? (
                <Button title={planningAction(selected).label} onPress={() => confirmPlanAction(selected, planningAction(selected))} loading={busy} testID="planning-item-complete-btn" />
              ) : null}
              {canAdmin && isLive(selected) && selected.planning_only && selected.status === DISPATCH_STATUS.activeRental ? (
                <Button title="Complete Rental" onPress={() => router.push("/(app)/operations/active" as any)} testID="planning-rental-complete-btn" />
              ) : null}
              {canEdit && isLive(selected) && selected.planning_only ? (
                <Button title="Cancel Plan" onPress={() => cancelPlan(selected)} variant="danger" testID="planning-item-cancel-btn" />
              ) : canEdit && isLive(selected) && !selected.planning_only ? (
                <Button title="Cancel Dispatch" onPress={() => cancelDispatch(selected)} variant="danger" testID="dispatch-cancel-btn" />
              ) : null}
            </View>
          </View>
        ) : null}
      </DetailDrawer>

      <ConfirmDialog
        visible={!!pendingConfirmation}
        title={pendingConfirmation?.title || "Confirm"}
        message={pendingConfirmation?.message}
        confirmLabel={pendingConfirmation?.confirmLabel}
        destructive={pendingConfirmation?.destructive || false}
        onCancel={() => setPendingConfirmation(null)}
        onConfirm={() => {
          const onConfirm = pendingConfirmation?.onConfirm;
          setPendingConfirmation(null);
          onConfirm?.();
        }}
        testID="dispatch-confirm"
      />

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
              <Text style={[typo.bodySmall, { marginBottom: spacing.sm }]}>Schedules a pickup for whatever is still outstanding on that rental.</Text>
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

const DispatchTabs: React.FC<{ tab: Tab; counts: Record<Tab, number>; onChange: (t: Tab) => void }> = ({ tab, counts, onChange }) => {
  const { isShellWide } = useBreakpoint();
  return (
    <View style={[styles.tabsWrap, !isShellWide && styles.tabsWrapMobile]} testID="dispatch-tabs">
      {TABS.map(({ key, label }) => {
        const active = tab === key;
        return (
          <TouchableOpacity key={key} onPress={() => onChange(key)} style={[styles.tabItem, !isShellWide && styles.tabItemMobile, active && styles.tabItemActive]} testID={`dispatch-tab-${key}`}>
            <Text numberOfLines={1} style={[styles.tabText, !isShellWide && styles.tabTextMobile, active && styles.tabTextActive]}>{label}</Text>
            {isShellWide ? <View style={[styles.tabCount, active && styles.tabCountActive]}><Text style={[styles.tabCountText, active && styles.tabCountTextActive]}>{counts[key]}</Text></View> : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const DetailSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <View style={styles.detailSection}><Text style={styles.detailLabel}>{label}</Text>{children}</View>
);

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg },
  tabRow: { paddingHorizontal: spacing.xl, marginBottom: spacing.sm },
  tabsWrap: { flexDirection: "row", gap: spacing.xs, marginBottom: spacing.md, paddingHorizontal: spacing.xl },
  tabsWrapMobile: { paddingHorizontal: spacing.sm, gap: 4 },
  tabItem: { height: 38, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  tabItemMobile: { flex: 1, minWidth: 0, justifyContent: "center", gap: 4, paddingHorizontal: 4 },
  tabItemActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  tabText: { fontSize: 13, fontWeight: "700", color: colors.inkSecondary },
  tabTextMobile: { fontSize: 11.5 },
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
  detailAmount: { width: 72, textAlign: "right", fontSize: 12 },
  ticketLine: { alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  quantityBox: { width: 122 },
  pickupCheck: { width: 108, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 5 },
  pickupCheckText: { fontSize: 11, fontWeight: "700", color: colors.inkSecondary },
  ticketHelp: { ...typo.bodySmall, color: colors.inkMuted, marginTop: spacing.sm },
  planNotice: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.primarySoft },
  planNoticeText: { ...typo.bodySmall, flex: 1, color: colors.info, fontWeight: "700" },
  requirementRow: { alignItems: "flex-start", gap: spacing.sm, paddingVertical: 5 },
  drawerActions: { paddingTop: spacing.lg, gap: spacing.sm },
  eqRow: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  eqRowSelected: { backgroundColor: colors.primarySoft },
  qtyBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  qtyDialog: { backgroundColor: colors.bg, borderRadius: 8, padding: 20, width: "100%", maxWidth: 360 },
});

export default DispatchScreen;

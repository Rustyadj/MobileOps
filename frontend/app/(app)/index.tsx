// Dashboard — operations command center matching the reference enterprise
// console: operational KPI strip, live rental map + Needs Attention, four dense
// operational tables, and a full-width Recent Activity table. All data is
// pulled from existing endpoints (dashboard/stats, rentals, bookings,
// equipment, maintenance, bookings/capacity) — no fabricated business data.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { PageBody } from "@/src/components/layout/PageBody";
import { Pin } from "@/src/components/MapCanvas";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { KpiStrip, KpiTile } from "@/src/components/dashboard/KpiStrip";
import { DashboardMap } from "@/src/components/dashboard/DashboardMap";
import { NeedsAttention } from "@/src/components/dashboard/NeedsAttention";
import { Upcoming, NextMovement, ManualNextInput, ManualNextItem } from "@/src/components/dashboard/WhatsNext";
import { WhiteboardFeed } from "@/src/components/whiteboard/WhiteboardFeed";
import { ShortagesCard } from "@/src/components/dashboard/ShortagesCard";
import { SupplyRequestsCard } from "@/src/components/dashboard/SupplyRequestsCard";
import { RentalsBoard, BoardRow, BoardTab, buildRentalsBoard } from "@/src/components/dashboard/RentalsBoard";
import { OperationalTable, OpColumn } from "@/src/components/dashboard/OperationalTable";
import { RecentActivity } from "@/src/components/dashboard/RecentActivity";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { ErrorState } from "@/src/components/feedback/ErrorState";
import { Button, Mono } from "@/src/components/ui";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useNeedsAttention, AttentionItem } from "@/src/hooks/use-needs-attention";
import { usePermissions } from "@/src/hooks/use-permissions";
import { DEFAULT_SHOP, shopPin, SiteWithShop } from "@/src/config/shop-location";
import { colors, spacing } from "@/src/theme";
import { isBookingActive, isDispatchLive, isRentalReturned } from "@/src/domain/status";

type Stats = {
  total_quantity: number;
  total_available: number;
  total_reserved: number;
  total_on_rental: number;
  total_pending_inspection: number;
  returning_today: number;
  active_rentals: number;
  open_maintenance: number;
  open_shop_tasks: number;
  shortage_count: number;
  pending_requests?: number;
  contacts_count: number;
  vendors_count: number;
  activity: { type: string; title: string; ts: string }[];
};

type RentalLine = { equipment_id: string; name: string; sku: string; qty: number; delivered_qty?: number; returned_qty: number; damaged_qty?: number };
type Rental = {
  id: string; customer_name: string; customer_type?: "company" | "homeowner"; job_site: string; job_address?: string; start_date: string; due_date?: string | null;
  status: string; notes?: string; lat?: number | null; lng?: number | null; lines: RentalLine[];
};
type Booking = { id: string; customer_name: string; job_site: string; start_date: string; end_date: string; status: string };
type ShopTask = { id: string; title: string; assignee: string; priority: string; status: string; created_at: string; due_date?: string | null; notes?: string };
type DispatchDoc = NextMovement;
type Site = SiteWithShop & { brand_name?: string };

const EMPTY_STATS: Stats = {
  total_quantity: 0, total_available: 0, total_reserved: 0, total_on_rental: 0,
  total_pending_inspection: 0, returning_today: 0, active_rentals: 0,
  open_maintenance: 0, open_shop_tasks: 0, shortage_count: 0, contacts_count: 0, vendors_count: 0, activity: [],
};

const greetingFor = (date: Date) => date.getHours() < 12 ? "Good morning" : date.getHours() < 18 ? "Good afternoon" : "Good evening";
const statsResponse = (value: unknown): Stats => (
  typeof value === "object" && value !== null
    ? { ...EMPTY_STATS, ...(value as Partial<Stats>), activity: Array.isArray((value as Partial<Stats>).activity) ? (value as Partial<Stats>).activity! : [] }
    : EMPTY_STATS
);

const TASK_STATUS_TONE: Record<string, "error" | "warning" | "success" | "info"> = {
  to_do: "info", in_progress: "warning", blocked: "error", done: "success",
};
const TASK_STATUS_LABEL: Record<string, string> = {
  to_do: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done",
};

export default function Dashboard() {
  const { user } = useAuth();
  const { canEdit } = usePermissions();
  const router = useRouter();
  const { isShellWide } = useBreakpoint();
  const { items: attention, reload: reloadAttention } = useNeedsAttention();
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [shopTasks, setShopTasks] = useState<ShopTask[]>([]);
  const [dispatches, setDispatches] = useState<DispatchDoc[]>([]);
  const [manualNextItems, setManualNextItems] = useState<ManualNextItem[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [selectedAttention, setSelectedAttention] = useState<AttentionItem | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    let hadError = false;
    const guard = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
      p.catch(() => { hadError = true; return fallback; });
    const [nextStats, nextRentals, nextBookings, nextShopTasks, nextDispatches, nextManualItems, nextSite] = await Promise.all([
      guard(api<unknown>("/dashboard/stats").then(statsResponse), EMPTY_STATS),
      guard(api<Rental[]>("/rentals"), []),
      guard(api<Booking[]>("/bookings"), []),
      guard(api<ShopTask[]>("/shop-tasks"), []),
      guard(api<DispatchDoc[]>("/dispatches"), []),
      guard(api<ManualNextItem[]>("/dashboard/items"), []),
      guard(api<Site>("/site"), null),
    ]);
    setStats(nextStats);
    setRentals(nextRentals);
    setBookings(nextBookings);
    setShopTasks(nextShopTasks);
    setDispatches(nextDispatches);
    setManualNextItems(nextManualItems);
    setSite(nextSite);
    setLastUpdated(new Date());
    // The dashboard is a Promise.all of seven independent calls with a fallback
    // each so ONE flaky endpoint doesn't blank the whole screen — but a
    // fallback of "zero"/"empty" looks identical to a genuinely idle fleet
    // unless we also surface that a fetch actually failed.
    setLoadError(hadError ? "Some dashboard data failed to load — numbers below may be incomplete or stale." : null);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([load(), reloadAttention()]);
    setRefreshing(false);
  };

  const activeRentals = useMemo(
    () => rentals.filter((r) => !isRentalReturned(r.status)).sort((a, b) => +new Date(b.start_date) - +new Date(a.start_date)),
    [rentals],
  );
  const upcomingBookings = useMemo(() => {
    const now = new Date();
    return bookings.filter((b) => isBookingActive(b.status) && new Date(b.end_date) >= now).sort((a, b) => +new Date(a.start_date) - +new Date(b.start_date));
  }, [bookings]);
  const openShopTasks = useMemo(() => {
    const order: Record<string, number> = { high: 0, normal: 1, low: 2 };
    return shopTasks
      .filter((t) => t.status !== "done")
      .sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1) || +new Date(a.created_at) - +new Date(b.created_at));
  }, [shopTasks]);
  const upcomingDispatches = useMemo(() => {
    // Past-dated planning rows that never got closed out would otherwise pin
    // themselves to the top of "Upcoming" forever — they show as "late" on
    // the Rentals board instead.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const live = dispatches.filter((d) => isDispatchLive(d.status) && (!d.scheduled_date || new Date(d.scheduled_date) >= today));
    return [...live].sort((a, b) => {
      const aTime = a.scheduled_date ? +new Date(a.scheduled_date) : Number.MAX_SAFE_INTEGER;
      const bTime = b.scheduled_date ? +new Date(b.scheduled_date) : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
  }, [dispatches]);
  const rentalsBoard = useMemo(() => buildRentalsBoard(rentals, dispatches), [rentals, dispatches]);
  const openBoardRow = (row: BoardRow) => router.push((row.kind === "rental" ? `/(app)/operations/rentals?open=${row.id}` : `/(app)/operations/dispatch?open=${row.id}`) as any);
  const BOARD_ROUTES: Record<BoardTab, string> = {
    on_rent: "/(app)/operations/rentals", going_out: "/(app)/operations/outbound",
    pickups: "/(app)/operations/inbound", verify: "/(app)/operations/inbound",
  };
  const pins: Pin[] = useMemo(() => [
    shopPin(site),
    ...activeRentals.filter((r) => r.lat != null && r.lng != null).map((r) => ({ id: r.id, lat: r.lat!, lng: r.lng!, title: r.customer_type === "homeowner" ? r.job_site || r.customer_name : r.customer_name, subtitle: r.job_address || r.job_site, status: r.status })),
  ], [activeRentals, site]);

  const createManualNextItem = async (input: ManualNextInput) => {
    const created = await api<ManualNextItem>("/dashboard/items", { method: "POST", body: JSON.stringify(input) });
    setManualNextItems((current) => [created, ...current]);
  };

  const completeManualNextItem = async (item: ManualNextItem) => {
    await api<ManualNextItem>(`/dashboard/items/${item.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
    setManualNextItems((current) => current.filter((entry) => entry.id !== item.id));
  };

  const openAttention = (item: AttentionItem) => {
    if (item.kind === "shortage" && item.jobs?.length) {
      setSelectedAttention(item);
      return;
    }
    router.push(item.route as never);
  };

  const shopTaskColumns: OpColumn<ShopTask>[] = [
    { key: "title", label: "Task", flex: 1.6, render: (t) => <Text style={styles.cell} numberOfLines={1}>{t.title}</Text> },
    { key: "assignee", label: "Assignee", flex: 1, render: (t) => <Text style={styles.cell} numberOfLines={1}>{t.assignee || "Unassigned"}</Text> },
    { key: "priority", label: "Priority", flex: 0.9, render: (t) => <Text style={[styles.cell, t.priority === "high" && styles.danger]} numberOfLines={1}>{t.priority}</Text> },
    { key: "status", label: "Status", flex: 1, render: (t) => <StatusBadge label={TASK_STATUS_LABEL[t.status] || t.status} tone={TASK_STATUS_TONE[t.status]} /> },
  ];

  const commandCenter = (
    <View style={styles.commandCenter} testID="dashboard-command-center">
      {isShellWide ? (
        <View style={styles.welcomeRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.welcomeTitle}>{greetingFor(lastUpdated)}, {user?.name || "team"}</Text>
            <Text style={styles.welcomeSubtitle}>Here&apos;s what&apos;s happening with your rentals today.</Text>
          </View>
          <View style={styles.dateBlock}>
            <Text style={styles.dateText}>{lastUpdated.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</Text>
            <View style={styles.dateDivider} />
            <Text style={styles.dateText}>{lastUpdated.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</Text>
          </View>
        </View>
      ) : null}
      {loadError ? (
        <ErrorState message={loadError} onRetry={load} testID="dashboard-load-error" />
      ) : null}
      <KpiStrip>
        <KpiTile label="Available inventory" value={String(stats.total_available)} meta={`of ${stats.total_quantity} owned`} icon="layers-outline" tone="success" onPress={() => router.push("/(app)/inventory/equipment" as any)} testID="stat-available-inventory" />
        <KpiTile label="On rent" value={String(stats.total_on_rental)} meta={`${rentalsBoard.on_rent.length} job site${rentalsBoard.on_rent.length === 1 ? "" : "s"} · ${rentalsBoard.going_out.length} going out`} icon="cube-outline" tone="primary" onPress={() => router.push("/(app)/operations/rentals" as any)} testID="stat-on-rental" />
        <KpiTile label="Due / returning" value={String(stats.returning_today)} meta={`${stats.total_reserved} reserved for upcoming jobs`} icon="calendar-outline" tone="warning" onPress={() => router.push("/(app)/operations/inbound" as any)} testID="stat-returning-today" />
        <KpiTile label="Needs attention" value={String(attention.length)} meta={`${stats.pending_requests ?? 0} requests · ${stats.shortage_count} shortages`} icon="warning-outline" tone="danger" onPress={() => router.push("/(app)/operations/capacity" as any)} testID="stat-needs-attention" />
      </KpiStrip>

      <View style={[styles.priorityRow, !isShellWide && styles.stackGrid]}>
        <View style={[styles.feedCell, !isShellWide && styles.feedCellMobile]}><WhiteboardFeed compact /></View>
        <View style={[styles.attentionCell, !isShellWide && styles.attentionCellMobile]}>
          <NeedsAttention
            items={attention.slice(0, 3)}
            total={attention.length}
            onViewAll={() => router.push("/(app)/operations/capacity" as any)}
            onPressItem={openAttention}
          />
        </View>
      </View>

      <View style={[styles.operationsRow, !isShellWide && styles.stackGrid]}>
        <View style={[styles.upcomingCell, !isShellWide && styles.upcomingCellMobile]}>
          <Upcoming
            dispatches={upcomingDispatches}
            rentals={activeRentals}
            bookings={upcomingBookings}
            shopTasks={openShopTasks}
            manualItems={manualNextItems}
            canEdit={canEdit}
            compact={!isShellWide}
            limit={3}
            onPressDispatch={(item) => router.push(`/(app)/operations/dispatch?open=${item.id}` as any)}
            onPressRental={(item) => router.push(`/(app)/operations/rentals?open=${item.id}` as any)}
            onPressBooking={(item) => router.push(`/(app)/operations/bookings?open=${item.id}` as any)}
            onPressTask={(item) => router.push(`/(app)/shop/tasks?open=${item.id}` as any)}
            onViewAll={() => router.push("/(app)/operations/dispatch" as any)}
            onCreateManual={createManualNextItem}
            onCompleteManual={completeManualNextItem}
          />
        </View>
        <View style={[styles.boardCell, !isShellWide && styles.boardCellMobile]}>
          <RentalsBoard
            rentals={rentals} dispatches={dispatches} compact={!isShellWide} limit={5}
            onPressRow={openBoardRow} onViewAll={(tab) => router.push(BOARD_ROUTES[tab] as any)}
          />
        </View>
      </View>

      <View style={[styles.lowerRow, !isShellWide && styles.stackGrid]}>
        <View style={[styles.requestsCell, !isShellWide && styles.requestsCellMobile]}><SupplyRequestsCard compact /></View>
        <ShortagesCard compact />
        <OperationalTable
          title="Shop Tasks" icon="construct-outline" columns={shopTaskColumns} rows={openShopTasks.slice(0, 4)}
          keyExtractor={(t) => t.id} onRowPress={(t) => router.push(`/(app)/shop/tasks?open=${t.id}` as any)}
          emptyLabel="No open shop tasks." viewAllLabel="View all tasks" onViewAll={() => router.push("/(app)/shop/tasks" as any)}
          testID="dashboard-shop-tasks" compact
        />
      </View>

      <View style={[styles.mapRow, !isShellWide && styles.stackGrid]}>
        <View style={[styles.mapCell, !isShellWide && styles.mapRowMobile]}>
        <DashboardMap
          style={styles.mapFill}
          pins={pins}
          missingLocationCount={Math.max(0, activeRentals.length - Math.max(0, pins.length - 1))}
          onPinPress={(pin) => router.push(`/(app)/operations/rentals?open=${pin.id}` as any)}
          onOpenMap={() => router.push("/(app)/operations/map" as any)}
          onRefresh={onRefresh}
          lastUpdated={lastUpdated}
          shopAddress={site?.company_address || DEFAULT_SHOP.address}
        />
        </View>
        <RecentActivity
          rows={stats.activity}
          onViewAll={onRefresh}
          onRowPress={(row) => router.push((row.type === "rental" ? "/(app)/operations/rentals" : row.type === "shop_task" ? "/(app)/shop/tasks" : "/(app)/shop/maintenance") as any)}
          compact
        />
      </View>
      <DetailDrawer
        visible={!!selectedAttention}
        title={selectedAttention?.title || "Shortage detail"}
        subtitle="Jobs driving committed demand"
        onClose={() => setSelectedAttention(null)}
        testID="shortage-jobs-drawer"
      >
        {selectedAttention ? (
          <View>
            <Text style={styles.drawerLabel}>AFFECTED JOBS</Text>
            {(selectedAttention.jobs || []).map((job, index) => (
              <View key={`${job}-${index}`} style={styles.jobRow}>
                <Mono style={styles.jobIndex}>{String(index + 1).padStart(2, "0")}</Mono>
                <Text style={styles.jobName}>{job}</Text>
              </View>
            ))}
            <Button
              title="Open Capacity"
              onPress={() => { setSelectedAttention(null); router.push(selectedAttention.route as never); }}
              style={{ marginTop: spacing.lg }}
              testID="shortage-open-capacity"
            />
          </View>
        ) : null}
      </DetailDrawer>
    </View>
  );

  if (isShellWide) {
    return <View style={styles.desktopPage} testID="dashboard-screen"><PageBody dense refreshing={refreshing} onRefresh={onRefresh} testID="dashboard-desktop-body">{commandCenter}</PageBody></View>;
  }

  return <Screen title={`Welcome, ${user?.name || ""}`} subtitle="Operations command center" onRefresh={onRefresh} refreshing={refreshing} testID="dashboard-screen">{commandCenter}</Screen>;
}

const styles = StyleSheet.create({
  desktopPage: { flex: 1, backgroundColor: colors.bgMuted },
  commandCenter: { paddingTop: 10, minWidth: 0 },
  welcomeRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.md },
  welcomeTitle: { fontSize: 24, lineHeight: 28, fontWeight: "800", color: colors.ink, letterSpacing: -0.45 },
  welcomeSubtitle: { marginTop: 1, fontSize: 12.5, lineHeight: 17, color: colors.inkSecondary },
  dateBlock: { flexDirection: "row", alignItems: "center", gap: 12 },
  dateText: { fontSize: 11.5, color: colors.inkSecondary, fontWeight: "600" },
  dateDivider: { width: 1, height: 18, backgroundColor: colors.border },
  priorityRow: { flexDirection: "row", gap: 10, alignItems: "stretch", height: 320, marginBottom: 10 },
  operationsRow: { flexDirection: "row", gap: 10, height: 320, marginBottom: 10 },
  feedCell: { flex: 0.92, minWidth: 0 },
  feedCellMobile: { flexGrow: 0, flexShrink: 0, flexBasis: 380, height: 380 },
  attentionCell: { flex: 1.08, minWidth: 0 },
  attentionCellMobile: { flexGrow: 0, flexShrink: 0, flexBasis: 182, height: 182 },
  upcomingCell: { flex: 0.92, minWidth: 0 },
  upcomingCellMobile: { flexGrow: 0, flexShrink: 0, flexBasis: 220, height: 220 },
  boardCell: { flex: 1.08, minWidth: 0 },
  boardCellMobile: { flexGrow: 0, flexShrink: 0, flexBasis: 360, height: 360 },
  lowerRow: { flexDirection: "row", gap: 10, height: 236, marginBottom: 10 },
  requestsCell: { flex: 1.15, minWidth: 0 },
  requestsCellMobile: { flex: 0, height: 300 },
  mapRow: { flexDirection: "row", gap: 10, height: 320, marginBottom: 10 },
  mapCell: { flex: 2, minWidth: 0 },
  mapRowMobile: { height: 300 },
  mapFill: { flex: 1 },
  stackGrid: { height: "auto", flexDirection: "column" },
  cell: { fontSize: 11.5, color: colors.ink },
  link: { fontSize: 11.5, color: colors.primary, fontWeight: "700" },
  danger: { fontSize: 12, color: colors.error, fontWeight: "700" },
  drawerLabel: { fontSize: 10.5, fontWeight: "800", color: colors.inkMuted, letterSpacing: 0.6, marginBottom: spacing.sm },
  jobRow: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  jobIndex: { width: 24, color: colors.inkMuted, fontSize: 11 },
  jobName: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: "600" },
});

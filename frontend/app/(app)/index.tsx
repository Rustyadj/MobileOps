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
  vendors_count: number;
  activity: { type: string; title: string; ts: string }[];
};

type RentalLine = { equipment_id: string; name: string; sku: string; qty: number; delivered_qty?: number; returned_qty: number; damaged_qty?: number };
type Rental = {
  id: string; customer_name: string; job_site: string; start_date: string; due_date?: string | null;
  status: string; notes?: string; lat?: number | null; lng?: number | null; lines: RentalLine[];
};
type Booking = { id: string; customer_name: string; job_site: string; start_date: string; end_date: string; status: string };
type ShortageRow = { date: string; equipment_id: string; sku: string; name: string; shortage: number; demand: number; owned: number; jobs: string[] };
type ShopTask = { id: string; title: string; assignee: string; priority: string; status: string; created_at: string; due_date?: string | null; notes?: string };
type DispatchDoc = NextMovement;
type Site = SiteWithShop & { brand_name?: string };

const EMPTY_STATS: Stats = {
  total_quantity: 0, total_available: 0, total_reserved: 0, total_on_rental: 0,
  total_pending_inspection: 0, returning_today: 0, active_rentals: 0,
  open_maintenance: 0, open_shop_tasks: 0, shortage_count: 0, vendors_count: 0, activity: [],
};

const dateLabel = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const shortId = (id: string) => id.slice(0, 8).toUpperCase();
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
  const [shortageRows, setShortageRows] = useState<ShortageRow[]>([]);
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
    const [nextStats, nextRentals, nextBookings, nextShortages, nextShopTasks, nextDispatches, nextManualItems, nextSite] = await Promise.all([
      guard(api<unknown>("/dashboard/stats").then(statsResponse), EMPTY_STATS),
      guard(api<Rental[]>("/rentals"), []),
      guard(api<Booking[]>("/bookings"), []),
      guard(api<{ rows: ShortageRow[] }>("/dashboard/shortages?days=14"), { rows: [] }),
      guard(api<ShopTask[]>("/shop-tasks"), []),
      guard(api<DispatchDoc[]>("/dispatches"), []),
      guard(api<ManualNextItem[]>("/dashboard/items"), []),
      guard(api<Site>("/site"), null),
    ]);
    setStats(nextStats);
    setRentals(nextRentals);
    setBookings(nextBookings);
    setShortageRows(nextShortages.rows);
    setShopTasks(nextShopTasks);
    setDispatches(nextDispatches);
    setManualNextItems(nextManualItems);
    setSite(nextSite);
    setLastUpdated(new Date());
    // The dashboard is a Promise.all of eight independent calls with a fallback
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
  const shortages = useMemo(
    () => [...shortageRows].sort((a, b) => a.date.localeCompare(b.date) || b.shortage - a.shortage),
    [shortageRows],
  );
  const openShopTasks = useMemo(() => {
    const order: Record<string, number> = { high: 0, normal: 1, low: 2 };
    return shopTasks
      .filter((t) => t.status !== "done")
      .sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1) || +new Date(a.created_at) - +new Date(b.created_at));
  }, [shopTasks]);
  const upcomingDispatches = useMemo(() => {
    const live = dispatches.filter((d) => isDispatchLive(d.status));
    return [...live].sort((a, b) => {
      const aTime = a.scheduled_date ? +new Date(a.scheduled_date) : Number.MAX_SAFE_INTEGER;
      const bTime = b.scheduled_date ? +new Date(b.scheduled_date) : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
  }, [dispatches]);
  const pins: Pin[] = useMemo(() => [
    shopPin(site),
    ...activeRentals.filter((r) => r.lat != null && r.lng != null).map((r) => ({ id: r.id, lat: r.lat!, lng: r.lng!, title: r.customer_name, subtitle: r.job_site, status: r.status })),
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

  const rentalColumns: OpColumn<Rental>[] = [
    { key: "id", label: "Rental #", flex: 1, render: (r) => <Text style={styles.link} numberOfLines={1}>{shortId(r.id)}</Text> },
    { key: "site", label: "Site", flex: 1.3, render: (r) => <Text style={styles.cell} numberOfLines={1}>{r.job_site || "—"}</Text> },
    { key: "equipment", label: "Equipment", flex: 1.4, render: (r) => <Text style={styles.cell} numberOfLines={1}>{r.lines[0]?.name || "—"}{r.lines.length > 1 ? ` +${r.lines.length - 1}` : ""}</Text> },
    { key: "due", label: "Due back", flex: 1, render: (r) => <Text style={styles.cell} numberOfLines={1}>{r.due_date ? dateLabel(r.due_date) : "—"}</Text> },
  ];

  const bookingColumns: OpColumn<Booking>[] = [
    { key: "id", label: "Booking #", flex: 1, render: (b) => <Text style={styles.link} numberOfLines={1}>{shortId(b.id)}</Text> },
    { key: "site", label: "Site", flex: 1.4, render: (b) => <Text style={styles.cell} numberOfLines={1}>{b.job_site || "—"}</Text> },
    { key: "start", label: "Start date", flex: 1, render: (b) => <Text style={styles.cell} numberOfLines={1}>{dateLabel(b.start_date)}</Text> },
  ];

  const shortageColumns: OpColumn<ShortageRow>[] = [
    { key: "equipment", label: "Equipment", flex: 1.4, render: (r) => <Text style={styles.cell} numberOfLines={1}>{r.name}</Text> },
    { key: "jobs", label: "Job", flex: 1.3, render: (r) => <Text style={styles.cell} numberOfLines={1}>{r.jobs[0] || "—"}{r.jobs.length > 1 ? ` +${r.jobs.length - 1}` : ""}</Text> },
    { key: "date", label: "Date", flex: 1, render: (r) => <Text style={styles.cell} numberOfLines={1}>{dateLabel(r.date)}</Text> },
    { key: "short", label: "Qty short", flex: 0.8, align: "right", render: (r) => <Text style={styles.danger}>{r.shortage}</Text> },
  ];

  const shopTaskColumns: OpColumn<ShopTask>[] = [
    { key: "title", label: "Task", flex: 1.6, render: (t) => <Text style={styles.cell} numberOfLines={1}>{t.title}</Text> },
    { key: "assignee", label: "Assignee", flex: 1, render: (t) => <Text style={styles.cell} numberOfLines={1}>{t.assignee || "Unassigned"}</Text> },
    { key: "priority", label: "Priority", flex: 0.9, render: (t) => <Text style={[styles.cell, t.priority === "high" && styles.danger]} numberOfLines={1}>{t.priority}</Text> },
    { key: "status", label: "Status", flex: 1, render: (t) => <StatusBadge label={TASK_STATUS_LABEL[t.status] || t.status} tone={TASK_STATUS_TONE[t.status]} /> },
  ];

  const commandCenter = (
    <View style={styles.commandCenter} testID="dashboard-command-center">
      {loadError ? (
        <ErrorState message={loadError} onRetry={load} testID="dashboard-load-error" />
      ) : null}
      <KpiStrip>
        <KpiTile label="Available inventory" value={String(stats.total_available)} meta={`of ${stats.total_quantity} owned`} icon="layers-outline" tone="success" onPress={() => router.push("/(app)/inventory/equipment" as any)} testID="stat-available-inventory" />
        <KpiTile label="On rental" value={String(stats.total_on_rental)} meta={`${activeRentals.length} active rentals`} icon="cube-outline" tone="primary" onPress={() => router.push("/(app)/operations/rentals" as any)} testID="stat-on-rental" />
        <KpiTile label="Reserved" value={String(stats.total_reserved)} meta="Booked, not yet delivered" icon="calendar-outline" tone="info" onPress={() => router.push("/(app)/operations/bookings" as any)} testID="stat-reserved" />
        <KpiTile label="Returning today" value={String(stats.returning_today)} meta="Units due back" icon="arrow-undo-outline" tone="warning" onPress={() => router.push("/(app)/operations/returns" as any)} testID="stat-returning-today" />
        <KpiTile label="Open shop tasks" value={String(stats.open_shop_tasks)} meta="To do / in progress / blocked" icon="checkbox-outline" tone="danger" onPress={() => router.push("/(app)/shop/tasks" as any)} testID="stat-shop-tasks" />
        <KpiTile label="Equipment shortages" value={String(stats.shortage_count)} meta={stats.shortage_count ? "Constrained in next 14 days" : "No upcoming shortages"} icon="warning-outline" tone="warning" last onPress={() => router.push("/(app)/operations/capacity" as any)} testID="stat-shortages" />
      </KpiStrip>

      <View style={[styles.dashboardTopRow, !isShellWide && styles.stackGrid]}>
        <Upcoming
          dispatches={upcomingDispatches}
          rentals={activeRentals}
          shopTasks={openShopTasks}
          manualItems={manualNextItems}
          canEdit={canEdit}
          compact={!isShellWide}
          onPressDispatch={(item) => router.push(`/(app)/operations/dispatch?open=${item.id}` as any)}
          onPressRental={(item) => router.push(`/(app)/operations/rentals?open=${item.id}` as any)}
          onPressTask={(item) => router.push(`/(app)/shop/tasks?open=${item.id}` as any)}
          onViewAll={() => router.push("/(app)/operations/dispatch" as any)}
          onCreateManual={createManualNextItem}
          onCompleteManual={completeManualNextItem}
        />
        <WhiteboardFeed compact />
      </View>

      <View style={[styles.mainRow, !isShellWide && styles.stackGrid]}>
        <DashboardMap
          pins={pins}
          missingLocationCount={Math.max(0, activeRentals.length - Math.max(0, pins.length - 1))}
          onPinPress={(pin) => router.push(`/(app)/operations/rentals?open=${pin.id}` as any)}
          onOpenMap={() => router.push("/(app)/operations/map" as any)}
          onRefresh={onRefresh}
          lastUpdated={lastUpdated}
          shopAddress={site?.company_address || DEFAULT_SHOP.address}
        />
        <NeedsAttention
          items={attention.slice(0, 5)}
          total={attention.length}
          onViewAll={() => router.push("/(app)/operations/capacity" as any)}
          onPressItem={openAttention}
        />
      </View>

      <View style={[styles.tableRow, !isShellWide && styles.stackGrid]}>
        <OperationalTable
          title="Active rentals" icon="receipt-outline" columns={rentalColumns} rows={activeRentals.slice(0, 5)}
          keyExtractor={(r) => r.id} onRowPress={(r) => router.push(`/(app)/operations/rentals?open=${r.id}` as any)}
          emptyLabel="No active rentals." viewAllLabel="View all rentals" onViewAll={() => router.push("/(app)/operations/rentals" as any)}
          testID="dashboard-active-rentals"
        />
        <OperationalTable
          title="Upcoming jobs" icon="calendar-outline" columns={bookingColumns} rows={upcomingBookings.slice(0, 5)}
          keyExtractor={(b) => b.id} onRowPress={(b) => router.push(`/(app)/operations/bookings?open=${b.id}` as any)}
          emptyLabel="No upcoming jobs." viewAllLabel="View all bookings" onViewAll={() => router.push("/(app)/operations/bookings" as any)}
          testID="dashboard-upcoming-bookings"
        />
        <OperationalTable
          title="Shop tasks" icon="checkbox-outline" columns={shopTaskColumns} rows={openShopTasks.slice(0, 5)}
          keyExtractor={(t) => t.id} onRowPress={(t) => router.push(`/(app)/shop/tasks?open=${t.id}` as any)}
          emptyLabel="No open shop tasks." viewAllLabel="View all tasks" onViewAll={() => router.push("/(app)/shop/tasks" as any)}
          testID="dashboard-shop-tasks"
        />
        <OperationalTable
          title="Equipment shortages" icon="warning-outline" columns={shortageColumns} rows={shortages.slice(0, 5)}
          keyExtractor={(r) => `${r.date}-${r.equipment_id}`} onRowPress={(r) => router.push(`/(app)/inventory/equipment?open=${r.equipment_id}` as any)}
          emptyLabel="Inventory levels are healthy." viewAllLabel="View all shortages" onViewAll={() => router.push("/(app)/operations/capacity" as any)}
          testID="dashboard-shortages"
        />
      </View>

      <RecentActivity
        rows={stats.activity}
        onViewAll={onRefresh}
        onRowPress={(row) => router.push((row.type === "rental" ? "/(app)/operations/rentals" : row.type === "shop_task" ? "/(app)/shop/tasks" : "/(app)/shop/maintenance") as any)}
      />
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
    return <View style={styles.desktopPage} testID="dashboard-screen"><PageBody refreshing={refreshing} onRefresh={onRefresh} testID="dashboard-desktop-body">{commandCenter}</PageBody></View>;
  }

  return <Screen title={`Welcome, ${user?.name || ""}`} subtitle="Operations command center" onRefresh={onRefresh} refreshing={refreshing} testID="dashboard-screen">{commandCenter}</Screen>;
}

const styles = StyleSheet.create({
  desktopPage: { flex: 1, backgroundColor: colors.bgMuted },
  commandCenter: { paddingTop: spacing.md, minWidth: 0 },
  dashboardTopRow: { flexDirection: "row", gap: 12, alignItems: "stretch", marginBottom: 12 },
  mainRow: { flexDirection: "row", gap: 12, height: 360, marginBottom: 12 },
  tableRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  stackGrid: { height: "auto", flexDirection: "column" },
  cell: { fontSize: 12, color: colors.ink },
  link: { fontSize: 12, color: colors.primary, fontWeight: "700" },
  danger: { fontSize: 12, color: colors.error, fontWeight: "700" },
  drawerLabel: { fontSize: 10.5, fontWeight: "800", color: colors.inkMuted, letterSpacing: 0.6, marginBottom: spacing.sm },
  jobRow: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  jobIndex: { width: 24, color: colors.inkMuted, fontSize: 11 },
  jobName: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: "600" },
});

// Dashboard — operations command center matching the reference enterprise
// console: 5-tile KPI strip, live rental map + Needs Attention, four dense
// operational tables, and a full-width Recent Activity table. All data is
// pulled from existing endpoints (dashboard/stats, rentals, bookings,
// equipment, maintenance, bookings/capacity) — no fabricated business data.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { PageBody } from "@/src/components/layout/PageBody";
import { Pin } from "@/src/components/MapCanvas";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { KpiStrip, KpiTile } from "@/src/components/dashboard/KpiStrip";
import { DashboardMap } from "@/src/components/dashboard/DashboardMap";
import { NeedsAttention } from "@/src/components/dashboard/NeedsAttention";
import { OperationalTable, OpColumn } from "@/src/components/dashboard/OperationalTable";
import { RecentActivity } from "@/src/components/dashboard/RecentActivity";
import { api, apiBaseUrl } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useNeedsAttention, AttentionItem } from "@/src/hooks/use-needs-attention";
import { colors, spacing } from "@/src/theme";

type Stats = {
  utilization: number;
  total_quantity: number;
  total_available: number;
  active_rentals: number;
  open_maintenance: number;
  vendors_count: number;
  activity: { type: string; title: string; ts: string }[];
};

type RentalLine = { equipment_id: string; name: string; sku: string; qty: number; returned_qty: number; daily_rate: number };
type Rental = {
  id: string; customer_name: string; job_site: string; start_date: string; due_date?: string | null;
  status: string; lat?: number | null; lng?: number | null; lines: RentalLine[];
};
type Booking = { id: string; customer_name: string; job_site: string; start_date: string; end_date: string; status: string };
type Equipment = { id: string; sku: string; name: string; quantity: number; available: number; condition: string; location: string };
type Maintenance = { id: string; equipment_name: string; issue: string; status: string; created_at: string; serviced_at?: string | null };
type CapacityRow = { equipment_id: string; sku: string; name: string; category: string; quantity: number; committed: number; available: number };

const EMPTY_STATS: Stats = {
  utilization: 0, total_quantity: 0, total_available: 0, active_rentals: 0,
  open_maintenance: 0, vendors_count: 0, activity: [],
};

const dateLabel = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const shortId = (id: string) => id.slice(0, 8).toUpperCase();

const MAINT_STATUS_TONE: Record<string, "error" | "warning" | "success"> = {
  open: "error", in_progress: "warning", resolved: "success",
};
const MAINT_STATUS_LABEL: Record<string, string> = {
  open: "Open", in_progress: "In progress", resolved: "Resolved",
};

export default function Dashboard() {
  const { user } = useAuth();
  const router = useRouter();
  const { isShellWide } = useBreakpoint();
  const { items: attention, reload: reloadAttention } = useNeedsAttention();
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [maintenance, setMaintenance] = useState<Maintenance[]>([]);
  const [capacityRows, setCapacityRows] = useState<CapacityRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const load = useCallback(async () => {
    const todayISO = new Date().toISOString().slice(0, 10) + "T00:00:00";
    const [nextStats, nextRentals, nextBookings, nextEquipment, nextMaintenance, nextCapacity] = await Promise.all([
      api<Stats>("/dashboard/stats").catch(() => EMPTY_STATS),
      api<Rental[]>("/rentals").catch(() => []),
      api<Booking[]>("/bookings").catch(() => []),
      api<Equipment[]>("/equipment").catch(() => []),
      api<Maintenance[]>("/maintenance").catch(() => []),
      api<{ date: string; rows: CapacityRow[] }>(`/bookings/capacity?target_date=${todayISO}`).catch(() => ({ date: "", rows: [] })),
    ]);
    setStats(nextStats);
    setRentals(nextRentals);
    setBookings(nextBookings);
    setEquipment(nextEquipment);
    setMaintenance(nextMaintenance);
    setCapacityRows(nextCapacity.rows);
    setLastUpdated(new Date());
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      if (Platform.OS === "web" || !Device.isDevice) return;
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== "granted") return;
        const tok = await Notifications.getDevicePushTokenAsync();
        if (!tok?.data || !user) return;
        await fetch(`${apiBaseUrl()}/register-push`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: user.id, platform: Platform.OS, device_token: tok.data }),
        });
      } catch {}
    })();
  }, [user]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([load(), reloadAttention()]);
    setRefreshing(false);
  };

  const activeRentals = useMemo(
    () => rentals.filter((r) => r.status !== "returned").sort((a, b) => +new Date(b.start_date) - +new Date(a.start_date)),
    [rentals],
  );
  const unitsOnRental = useMemo(
    () => activeRentals.reduce((sum, r) => sum + r.lines.reduce((s, l) => s + Math.max(0, l.qty - l.returned_qty), 0), 0),
    [activeRentals],
  );
  const upcomingBookings = useMemo(() => {
    const now = new Date();
    return bookings.filter((b) => b.status !== "cancelled" && new Date(b.end_date) >= now).sort((a, b) => +new Date(a.start_date) - +new Date(b.start_date));
  }, [bookings]);
  const equipmentLocation = useMemo(() => Object.fromEntries(equipment.map((e) => [e.id, e.location])), [equipment]);
  const shortages = useMemo(
    () => capacityRows.filter((r) => r.committed > r.quantity).sort((a, b) => (b.committed - b.quantity) - (a.committed - a.quantity)),
    [capacityRows],
  );
  const maintenanceQueue = useMemo(
    () => maintenance.filter((m) => m.status === "open" || m.status === "in_progress").sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)),
    [maintenance],
  );
  const pins: Pin[] = useMemo(
    () => activeRentals.filter((r) => r.lat != null && r.lng != null).map((r) => ({ id: r.id, lat: r.lat!, lng: r.lng!, title: r.customer_name, subtitle: r.job_site, status: r.status })),
    [activeRentals],
  );

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

  const shortageColumns: OpColumn<CapacityRow>[] = [
    { key: "equipment", label: "Equipment", flex: 1.6, render: (r) => <Text style={styles.cell} numberOfLines={1}>{r.name}</Text> },
    { key: "site", label: "Site", flex: 1, render: (r) => <Text style={styles.cell} numberOfLines={1}>{equipmentLocation[r.equipment_id] || "—"}</Text> },
    { key: "short", label: "Qty short", flex: 0.8, align: "right", render: (r) => <Text style={styles.danger}>{r.quantity - r.committed}</Text> },
  ];

  const maintenanceColumns: OpColumn<Maintenance>[] = [
    { key: "id", label: "ID", flex: 0.8, render: (m) => <Text style={styles.link} numberOfLines={1}>{shortId(m.id)}</Text> },
    { key: "equipment", label: "Equipment", flex: 1.4, render: (m) => <Text style={styles.cell} numberOfLines={1}>{m.equipment_name || "—"}</Text> },
    { key: "opened", label: "Opened", flex: 1, render: (m) => <Text style={styles.cell} numberOfLines={1}>{dateLabel(m.created_at)}</Text> },
    { key: "status", label: "Status", flex: 1, render: (m) => <StatusBadge label={MAINT_STATUS_LABEL[m.status] || m.status} tone={MAINT_STATUS_TONE[m.status]} /> },
  ];

  const commandCenter = (
    <View style={styles.commandCenter} testID="dashboard-command-center">
      <KpiStrip>
        <KpiTile label="Active rentals" value={String(activeRentals.length)} meta={`${pins.length} mapped`} icon="receipt-outline" tone="primary" onPress={() => router.push("/(app)/operations/rentals" as any)} testID="stat-active-rentals" />
        <KpiTile label="On rental (units)" value={String(unitsOnRental)} meta="Units deployed" icon="cube-outline" tone="success" onPress={() => router.push("/(app)/assets/equipment" as any)} testID="stat-units-on-rental" />
        <KpiTile label="Equipment shortages" value={String(shortages.length)} meta={shortages.length ? "Constrained SKUs today" : "No shortages today"} icon="warning-outline" tone="warning" onPress={() => router.push("/(app)/operations/capacity" as any)} testID="stat-shortages" />
        <KpiTile label="Maintenance due" value={String(maintenanceQueue.length)} meta="Open queue" icon="build-outline" tone="danger" onPress={() => router.push("/(app)/assets/maintenance" as any)} testID="stat-maintenance-due" />
        <KpiTile label="Available equipment" value={String(stats.total_available)} meta={`${stats.utilization}% utilization`} icon="layers-outline" tone="info" last onPress={() => router.push("/(app)/assets/equipment" as any)} testID="stat-available" />
      </KpiStrip>

      <View style={[styles.mainRow, !isShellWide && styles.stackGrid]}>
        <DashboardMap
          pins={pins}
          missingLocationCount={Math.max(0, activeRentals.length - pins.length)}
          onPinPress={(pin) => router.push(`/(app)/operations/rentals?open=${pin.id}` as any)}
          onOpenMap={() => router.push("/(app)/operations/map" as any)}
          onRefresh={onRefresh}
          lastUpdated={lastUpdated}
        />
        <NeedsAttention
          items={attention.slice(0, 5)}
          total={attention.length}
          onViewAll={() => router.push("/(app)/operations/capacity" as any)}
          onPressItem={(item: AttentionItem) => router.push(item.route as any)}
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
          title="Upcoming bookings" icon="calendar-outline" columns={bookingColumns} rows={upcomingBookings.slice(0, 5)}
          keyExtractor={(b) => b.id} onRowPress={(b) => router.push(`/(app)/operations/bookings?open=${b.id}` as any)}
          emptyLabel="No upcoming bookings." viewAllLabel="View all bookings" onViewAll={() => router.push("/(app)/operations/bookings" as any)}
          testID="dashboard-upcoming-bookings"
        />
        <OperationalTable
          title="Equipment shortages" icon="warning-outline" columns={shortageColumns} rows={shortages.slice(0, 5)}
          keyExtractor={(r) => r.equipment_id} onRowPress={(r) => router.push(`/(app)/assets/equipment?open=${r.equipment_id}` as any)}
          emptyLabel="Inventory levels are healthy." viewAllLabel="View all shortages" onViewAll={() => router.push("/(app)/operations/capacity" as any)}
          testID="dashboard-shortages"
        />
        <OperationalTable
          title="Maintenance queue" icon="build-outline" columns={maintenanceColumns} rows={maintenanceQueue.slice(0, 5)}
          keyExtractor={(m) => m.id} onRowPress={(m) => router.push(`/(app)/assets/maintenance?open=${m.id}` as any)}
          emptyLabel="No open maintenance." viewAllLabel="View all maintenance" onViewAll={() => router.push("/(app)/assets/maintenance" as any)}
          testID="dashboard-maintenance-queue"
        />
      </View>

      <RecentActivity
        rows={stats.activity}
        onViewAll={onRefresh}
        onRowPress={(row) => router.push((row.type === "rental" ? "/(app)/operations/rentals" : "/(app)/assets/maintenance") as any)}
      />
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
  mainRow: { flexDirection: "row", gap: 12, height: 360, marginBottom: 12 },
  tableRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  stackGrid: { height: "auto", flexDirection: "column" },
  cell: { fontSize: 12, color: colors.ink },
  link: { fontSize: 12, color: colors.primary, fontWeight: "700" },
  danger: { fontSize: 12, color: colors.error, fontWeight: "700" },
});

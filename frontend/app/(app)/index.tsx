import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { PageBody } from "@/src/components/layout/PageBody";
import { MapCanvas, Pin } from "@/src/components/MapCanvas";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { api, apiBaseUrl } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useNeedsAttention, AttentionItem } from "@/src/hooks/use-needs-attention";
import { colors, spacing, type as typo, radii } from "@/src/theme";

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
type Equipment = { id: string; sku: string; name: string; quantity: number; available: number; condition: string };
type Maintenance = { id: string; equipment_name: string; issue: string; status: string; created_at: string; serviced_at?: string | null };

const EMPTY_STATS: Stats = {
  utilization: 0, total_quantity: 0, total_available: 0, active_rentals: 0,
  open_maintenance: 0, vendors_count: 0, activity: [],
};

const dateLabel = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function Dashboard() {
  const { user } = useAuth();
  const router = useRouter();
  const { isShellWide, isDesktop } = useBreakpoint();
  const { items: attention, reload: reloadAttention } = useNeedsAttention();
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [maintenance, setMaintenance] = useState<Maintenance[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [nextStats, nextRentals, nextBookings, nextEquipment, nextMaintenance] = await Promise.all([
      api<Stats>("/dashboard/stats").catch(() => EMPTY_STATS),
      api<Rental[]>("/rentals").catch(() => []),
      api<Booking[]>("/bookings").catch(() => []),
      api<Equipment[]>("/equipment").catch(() => []),
      api<Maintenance[]>("/maintenance").catch(() => []),
    ]);
    setStats(nextStats);
    setRentals(nextRentals);
    setBookings(nextBookings);
    setEquipment(nextEquipment);
    setMaintenance(nextMaintenance);
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

  const today = useMemo(() => new Date(), []);
  const activeRentals = useMemo(
    () => rentals.filter((r) => r.status !== "returned").sort((a, b) => +new Date(b.start_date) - +new Date(a.start_date)),
    [rentals],
  );
  const upcomingBookings = useMemo(
    () => bookings.filter((b) => b.status !== "cancelled" && new Date(b.end_date) >= today).sort((a, b) => +new Date(a.start_date) - +new Date(b.start_date)),
    [bookings, today],
  );
  const shortages = useMemo(
    () => equipment.filter((e) => e.quantity > 0 && e.available / e.quantity <= 0.2).sort((a, b) => (a.available / a.quantity) - (b.available / b.quantity)),
    [equipment],
  );
  const maintenanceQueue = useMemo(
    () => maintenance.filter((m) => m.status === "open" || m.status === "in_progress").sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)),
    [maintenance],
  );
  const pins: Pin[] = useMemo(
    () => activeRentals.filter((r) => r.lat != null && r.lng != null).map((r) => ({ id: r.id, lat: r.lat!, lng: r.lng!, title: r.customer_name, subtitle: r.job_site, status: r.status })),
    [activeRentals],
  );

  const commandCenter = (
    <View style={[styles.commandCenter, !isDesktop && styles.commandCenterCompact]} testID="dashboard-command-center">
      <View style={styles.dashboardHeading}>
        <View>
          <Text style={styles.eyebrow}>Live operations</Text>
          <Text style={styles.heading}>Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}, {user?.name?.split(" ")[0] || "team"}</Text>
        </View>
        <View style={styles.asOf}>
          <View style={styles.liveDot} />
          <Text style={styles.asOfText}>{new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</Text>
        </View>
      </View>

      <View style={[styles.kpiStrip, !isDesktop && styles.wrapGrid]} testID="dashboard-kpi-strip">
        <Kpi label="Utilization" value={`${stats.utilization}%`} meta={`${stats.total_quantity - stats.total_available} units deployed`} icon="pulse-outline" onPress={() => router.push("/(app)/assets/equipment" as any)} testID="stat-utilization" />
        <Kpi label="Active rentals" value={String(activeRentals.length)} meta={`${pins.length} mapped`} icon="receipt-outline" onPress={() => router.push("/(app)/operations/rentals" as any)} testID="stat-active-rentals" />
        <Kpi label="Upcoming bookings" value={String(upcomingBookings.length)} meta="Current pipeline" icon="calendar-outline" onPress={() => router.push("/(app)/operations/bookings" as any)} testID="stat-upcoming-bookings" />
        <Kpi label="Available units" value={String(stats.total_available)} meta={`${shortages.length} shortages`} icon="cube-outline" tone={shortages.length ? "warning" : "default"} onPress={() => router.push("/(app)/assets/equipment" as any)} testID="stat-available" />
        <Kpi label="Open service" value={String(maintenanceQueue.length)} meta="Maintenance queue" icon="build-outline" tone={maintenanceQueue.length ? "warning" : "default"} onPress={() => router.push("/(app)/assets/maintenance" as any)} testID="stat-open-maintenance" />
      </View>

      <View style={[styles.primaryGrid, !isDesktop && styles.stackGrid]}>
        <ConsolePanel title="Live rental map" subtitle={`${pins.length} pinned · ${activeRentals.length - pins.length} missing location`} icon="map-outline" actionLabel="Open map" onAction={() => router.push("/(app)/operations/map" as any)} style={styles.mapPanel} testID="dashboard-map-panel">
          <View style={styles.mapBody}>
            <MapCanvas pins={pins} onPinPress={(pin) => router.push(`/(app)/operations/rentals?open=${pin.id}` as any)} style={{ borderRadius: 0, borderWidth: 0 }} />
          </View>
        </ConsolePanel>

        <View style={styles.rightStack}>
          <ConsolePanel title="Needs attention" subtitle={`${attention.length} open exceptions`} icon="alert-circle-outline" actionLabel="Review" onAction={() => router.push("/(app)/operations/capacity" as any)} style={styles.attentionPanel} testID="dashboard-attention-panel">
            <PanelList rows={attention.slice(0, 4)} empty="No operational exceptions." renderRow={(item: AttentionItem) => (
              <ConsoleRow key={item.id} title={item.title} subtitle={item.subtitle} tone="warning" onPress={() => router.push(item.route as any)} testID={`attention-${item.id}`} />
            )} />
          </ConsolePanel>

          <ConsolePanel title="Recent activity" icon="time-outline" actionLabel="Refresh" onAction={onRefresh} style={styles.activityPanel} testID="activity-card">
            <PanelList rows={stats.activity.slice(0, 3)} empty="No recent activity." renderRow={(item, index) => (
              <ConsoleRow key={`${item.type}-${item.ts}-${index}`} title={item.title} subtitle={dateLabel(item.ts)} icon={item.type === "rental" ? "receipt-outline" : "build-outline"} onPress={() => router.push((item.type === "rental" ? "/(app)/operations/rentals" : "/(app)/assets/maintenance") as any)} />
            )} />
          </ConsolePanel>
        </View>
      </View>

      <View style={[styles.queueGrid, !isDesktop && styles.wrapGrid]}>
        <ConsolePanel title="Active rentals" subtitle={`${activeRentals.length} in field`} icon="receipt-outline" actionLabel="View all" onAction={() => router.push("/(app)/operations/rentals" as any)} style={styles.queuePanel} testID="dashboard-rentals-panel">
          <PanelList rows={activeRentals.slice(0, 4)} empty="No active rentals." renderRow={(r: Rental) => (
            <ConsoleRow key={r.id} title={r.customer_name} subtitle={`${r.job_site || "No job site"} · ${r.lines.reduce((sum, line) => sum + line.qty - line.returned_qty, 0)} units`} badge={r.status} onPress={() => router.push(`/(app)/operations/rentals?open=${r.id}` as any)} />
          )} />
        </ConsolePanel>

        <ConsolePanel title="Upcoming bookings" subtitle="Scheduled pipeline" icon="calendar-outline" actionLabel="View all" onAction={() => router.push("/(app)/operations/bookings" as any)} style={styles.queuePanel} testID="dashboard-bookings-panel">
          <PanelList rows={upcomingBookings.slice(0, 4)} empty="No upcoming bookings." renderRow={(b: Booking) => (
            <ConsoleRow key={b.id} title={b.customer_name} subtitle={`${dateLabel(b.start_date)} · ${b.job_site || "No job site"}`} badge={b.status} onPress={() => router.push(`/(app)/operations/bookings?open=${b.id}` as any)} />
          )} />
        </ConsolePanel>

        <ConsolePanel title="Equipment shortages" subtitle={`${shortages.length} constrained SKUs`} icon="warning-outline" actionLabel="Inventory" onAction={() => router.push("/(app)/assets/equipment" as any)} style={styles.queuePanel} testID="dashboard-shortages-panel">
          <PanelList rows={shortages.slice(0, 4)} empty="Inventory levels are healthy." renderRow={(e: Equipment) => (
            <ConsoleRow key={e.id} title={e.name} subtitle={`${e.sku} · ${e.available}/${e.quantity} available`} tone="warning" onPress={() => router.push(`/(app)/assets/equipment?open=${e.id}` as any)} />
          )} />
        </ConsolePanel>

        <ConsolePanel title="Maintenance queue" subtitle={`${maintenanceQueue.length} unresolved`} icon="build-outline" actionLabel="Open queue" onAction={() => router.push("/(app)/assets/maintenance" as any)} style={styles.queuePanel} testID="dashboard-maintenance-panel">
          <PanelList rows={maintenanceQueue.slice(0, 4)} empty="No open maintenance." renderRow={(m: Maintenance) => (
            <ConsoleRow key={m.id} title={m.equipment_name || "Equipment"} subtitle={m.issue} badge={m.status} onPress={() => router.push(`/(app)/assets/maintenance?open=${m.id}` as any)} />
          )} />
        </ConsolePanel>
      </View>
    </View>
  );

  if (isShellWide) {
    return <View style={styles.desktopPage} testID="dashboard-screen"><PageBody refreshing={refreshing} onRefresh={onRefresh} testID="dashboard-desktop-body">{commandCenter}</PageBody></View>;
  }

  return <Screen title={`Welcome, ${user?.name || ""}`} subtitle="Operations command center" onRefresh={onRefresh} refreshing={refreshing} testID="dashboard-screen">{commandCenter}</Screen>;
}

const Kpi: React.FC<{
  label: string; value: string; meta: string; icon: React.ComponentProps<typeof Ionicons>["name"];
  tone?: "default" | "warning"; onPress: () => void; testID: string;
}> = ({ label, value, meta, icon, tone = "default", onPress, testID }) => (
  <TouchableOpacity style={styles.kpi} onPress={onPress} activeOpacity={0.72} testID={testID}>
    <View style={styles.kpiTop}><Text style={styles.kpiLabel}>{label}</Text><Ionicons name={icon} size={15} color={tone === "warning" ? colors.warning : colors.primary} /></View>
    <Text style={[styles.kpiValue, tone === "warning" && { color: colors.warning }]}>{value}</Text>
    <Text style={styles.kpiMeta} numberOfLines={1}>{meta}</Text>
  </TouchableOpacity>
);

const ConsolePanel: React.FC<{
  title: string; subtitle?: string; icon: React.ComponentProps<typeof Ionicons>["name"]; actionLabel: string;
  onAction: () => void; children: React.ReactNode; style?: any; testID?: string;
}> = ({ title, subtitle, icon, actionLabel, onAction, children, style, testID }) => (
  <View style={[styles.panel, style]} testID={testID}>
    <View style={styles.panelHeader}>
      <View style={styles.panelTitleIcon}><Ionicons name={icon} size={15} color={colors.primary} /></View>
      <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.panelTitle} numberOfLines={1}>{title}</Text>{subtitle ? <Text style={styles.panelSubtitle} numberOfLines={1}>{subtitle}</Text> : null}</View>
      <TouchableOpacity onPress={onAction} style={styles.panelAction} activeOpacity={0.65}><Text style={styles.panelActionText}>{actionLabel}</Text><Ionicons name="arrow-forward" size={12} color={colors.primary} /></TouchableOpacity>
    </View>
    <View style={styles.panelBody}>{children}</View>
  </View>
);

function PanelList<T>({ rows, empty, renderRow }: { rows: T[]; empty: string; renderRow: (item: T, index: number) => React.ReactNode }) {
  if (rows.length === 0) return <View style={styles.emptyPanel}><Ionicons name="checkmark-circle-outline" size={18} color={colors.success} /><Text style={styles.emptyPanelText}>{empty}</Text></View>;
  return <>{rows.map(renderRow)}</>;
}

const ConsoleRow: React.FC<{
  title: string; subtitle: string; badge?: string; tone?: "default" | "warning";
  icon?: React.ComponentProps<typeof Ionicons>["name"]; onPress: () => void; testID?: string;
}> = ({ title, subtitle, badge, tone = "default", icon, onPress, testID }) => (
  <TouchableOpacity style={styles.consoleRow} onPress={onPress} activeOpacity={0.62} testID={testID}>
    <View style={[styles.rowMarker, tone === "warning" && styles.rowMarkerWarning]}>{icon ? <Ionicons name={icon} size={13} color={tone === "warning" ? colors.warning : colors.primary} /> : null}</View>
    <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.rowTitle} numberOfLines={1}>{title}</Text><Text style={styles.rowSubtitle} numberOfLines={1}>{subtitle}</Text></View>
    {badge ? <StatusBadge label={badge} /> : <Ionicons name="chevron-forward" size={14} color={colors.inkMuted} />}
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  desktopPage: { flex: 1, backgroundColor: colors.bgMuted },
  commandCenter: { paddingTop: spacing.md, minWidth: 0 },
  commandCenterCompact: { paddingTop: 0 },
  dashboardHeading: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginBottom: spacing.md },
  eyebrow: { ...typo.caption, color: colors.primary, marginBottom: 3 },
  heading: { ...typo.h2, fontSize: 21 },
  asOf: { flexDirection: "row", alignItems: "center", gap: 7, paddingBottom: 2 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  asOfText: { fontSize: 12, color: colors.inkSecondary, fontWeight: "600" },
  kpiStrip: { flexDirection: "row", gap: 10, marginBottom: 12 },
  wrapGrid: { flexWrap: "wrap" },
  kpi: { flex: 1, minWidth: 142, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingHorizontal: 13, paddingVertical: 11 },
  kpiTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 },
  kpiLabel: { fontSize: 10.5, fontWeight: "700", color: colors.inkSecondary, textTransform: "uppercase", letterSpacing: 0.55 },
  kpiValue: { fontFamily: "monospace", fontSize: 23, fontWeight: "700", color: colors.ink, marginTop: 5 },
  kpiMeta: { fontSize: 10.5, color: colors.inkMuted, marginTop: 2 },
  primaryGrid: { flexDirection: "row", gap: 12, height: 360, marginBottom: 12 },
  stackGrid: { height: "auto", flexDirection: "column" },
  mapPanel: { flex: 1.7, minHeight: 300 },
  rightStack: { flex: 1, gap: 12, minWidth: 0 },
  attentionPanel: { flex: 1.35, minHeight: 205 },
  activityPanel: { flex: 1, minHeight: 135 },
  queueGrid: { flexDirection: "row", gap: 12, paddingBottom: spacing.md },
  queuePanel: { flex: 1, minWidth: 210, height: 230 },
  panel: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", minWidth: 0 },
  panelHeader: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bg },
  panelTitleIcon: { width: 27, height: 27, borderRadius: radii.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft },
  panelTitle: { fontSize: 13, fontWeight: "700", color: colors.ink },
  panelSubtitle: { fontSize: 10.5, color: colors.inkMuted, marginTop: 1 },
  panelAction: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 7, paddingLeft: 8 },
  panelActionText: { fontSize: 10.5, color: colors.primary, fontWeight: "700" },
  panelBody: { flex: 1, minHeight: 0 },
  mapBody: { flex: 1, minHeight: 0 },
  consoleRow: { minHeight: 43, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 11, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowMarker: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  rowMarkerWarning: { backgroundColor: colors.warningSoft },
  rowTitle: { fontSize: 11.5, color: colors.ink, fontWeight: "600" },
  rowSubtitle: { fontSize: 10, color: colors.inkMuted, marginTop: 1 },
  emptyPanel: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.md, flexDirection: "row", gap: 7 },
  emptyPanelText: { fontSize: 11, color: colors.inkSecondary },
});

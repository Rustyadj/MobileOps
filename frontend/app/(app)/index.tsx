// Dashboard — operations command center. Answers: what's happening now,
// what needs attention, what's coming next, where is our equipment, and do
// we have enough inventory — in one screen instead of four KPI tiles plus
// a shortcut grid.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card, Mono, SectionLabel } from "@/src/components/ui";
import { ResponsiveGrid } from "@/src/components/layout/ResponsiveGrid";
import { KpiCard } from "@/src/components/data/KpiCard";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { LoadingState } from "@/src/components/feedback/LoadingState";
import { MapCanvas, Pin } from "@/src/components/MapCanvas";
import { api, apiBaseUrl } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useNeedsAttention, AttentionItem } from "@/src/hooks/use-needs-attention";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
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

type Rental = {
  id: string; customer_name: string; job_site: string; status: string; start_date: string;
  lat?: number | null; lng?: number | null;
  lines: { qty: number; returned_qty: number }[];
};
type Booking = { id: string; customer_name: string; job_site: string; start_date: string; end_date: string; status: string };
type Equipment = { id: string; sku: string; name: string; quantity: number; available: number };
type MaintItem = { id: string; equipment_name: string; issue: string; status: string; cost: number };

const ATTENTION_ICON: Record<AttentionItem["kind"], any> = {
  overdue: "time-outline",
  "low-availability": "alert-circle-outline",
  "missing-location": "location-outline",
  "open-maintenance": "build-outline",
  "booking-conflict": "warning-outline",
};

export default function Dashboard() {
  const { user } = useAuth();
  const router = useRouter();
  const { isShellWide } = useBreakpoint();
  const [stats, setStats] = useState<Stats | null>(null);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [maintenance, setMaintenance] = useState<MaintItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const attention = useNeedsAttention();

  const load = useCallback(async () => {
    try {
      const [s, r, b, e, m] = await Promise.all([
        api<Stats>("/dashboard/stats"),
        api<Rental[]>("/rentals").catch(() => []),
        api<Booking[]>("/bookings").catch(() => []),
        api<Equipment[]>("/equipment").catch(() => []),
        api<MaintItem[]>("/maintenance").catch(() => []),
      ]);
      setStats(s); setRentals(r); setBookings(b); setEquipment(e); setMaintenance(m);
    } catch (e) {
      console.warn("dashboard load", e);
    } finally {
      setLoading(false);
    }
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
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: user.id, platform: Platform.OS, device_token: tok.data }),
        });
      } catch {}
    })();
  }, [user]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([load(), attention.reload()]);
    setRefreshing(false);
  };

  const activeRentals = useMemo(() => rentals.filter((r) => r.status !== "returned"), [rentals]);
  const upcomingBookings = useMemo(() => {
    const now = new Date();
    const cutoff = new Date(now.getTime() + 14 * 86400000);
    return bookings
      .filter((b) => b.status !== "cancelled" && new Date(b.start_date) >= now && new Date(b.start_date) <= cutoff)
      .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
      .slice(0, 6);
  }, [bookings]);
  const openMaintenance = useMemo(() => maintenance.filter((m) => m.status !== "resolved").slice(0, 6), [maintenance]);
  const lowStock = useMemo(() => [...equipment].sort((a, b) => a.available - b.available).slice(0, 6), [equipment]);
  const conflictCount = attention.items.filter((i) => i.kind === "booking-conflict").length;

  const pins: Pin[] = useMemo(
    () =>
      rentals
        .filter((r) => r.lat != null && r.lng != null && r.status !== "returned")
        .map((r) => ({ id: r.id, lat: r.lat!, lng: r.lng!, title: r.customer_name, subtitle: r.job_site, status: r.status })),
    [rentals],
  );

  if (loading && !stats) {
    return (
      <Screen title="Dashboard" subtitle="Operations command center" testID="dashboard-screen">
        <LoadingState label="Loading operations overview…" testID="dashboard-loading" />
      </Screen>
    );
  }

  return (
    <Screen
      title={`Welcome, ${user?.name || ""}`}
      subtitle="Operations command center"
      onRefresh={onRefresh}
      refreshing={refreshing}
      testID="dashboard-screen"
    >
      {/* KPI row */}
      <ResponsiveGrid minItemWidth={168}>
        <KpiCard label="Utilization" value={`${stats?.utilization ?? 0}%`} icon="speedometer-outline" onPress={() => router.push("/(app)/assets/equipment" as any)} testID="kpi-utilization" />
        <KpiCard label="Available inventory" value={`${stats?.total_available ?? 0}`} icon="cube-outline" onPress={() => router.push("/(app)/assets/equipment" as any)} testID="kpi-available" />
        <KpiCard label="Active rentals" value={`${stats?.active_rentals ?? 0}`} icon="receipt-outline" onPress={() => router.push("/(app)/operations/rentals" as any)} testID="kpi-active-rentals" />
        <KpiCard label="Upcoming bookings" value={`${upcomingBookings.length}`} icon="calendar-outline" onPress={() => router.push("/(app)/operations/bookings" as any)} testID="kpi-upcoming-bookings" />
        <KpiCard label="Open maintenance" value={`${stats?.open_maintenance ?? 0}`} icon="build-outline" tone={stats?.open_maintenance ? "warning" : "default"} onPress={() => router.push("/(app)/assets/maintenance" as any)} testID="kpi-open-maintenance" />
        <KpiCard label="Conflicts" value={`${conflictCount}`} icon="warning-outline" tone={conflictCount ? "error" : "default"} onPress={() => router.push("/(app)/operations/capacity" as any)} testID="kpi-conflicts" />
      </ResponsiveGrid>

      <View style={{ height: spacing.lg }} />

      {/* Map + Needs Attention */}
      <View style={isShellWide ? styles.mainRow : undefined}>
        <View style={[styles.mapCard, isShellWide ? { flex: 65 } : { height: 240 }]} testID="dashboard-map">
          {pins.length === 0 ? (
            <View style={styles.mapEmpty}>
              <Ionicons name="map-outline" size={24} color={colors.inkMuted} />
              <Text style={[typo.bodySmall, { marginTop: 6 }]}>No active job-site locations yet.</Text>
            </View>
          ) : (
            <MapCanvas pins={pins} onPinPress={(p) => router.push(`/(app)/operations/rentals?open=${p.id}` as any)} />
          )}
        </View>

        <View style={isShellWide ? { flex: 35, marginLeft: spacing.md } : { marginTop: spacing.md }}>
          <Card style={{ padding: 0 }} testID="needs-attention-card">
            <View style={styles.panelHeader}>
              <Text style={typo.h3}>Needs attention</Text>
              {attention.items.length > 0 ? (
                <View style={styles.countBadge}><Text style={styles.countBadgeText}>{attention.items.length}</Text></View>
              ) : null}
            </View>
            {attention.loading && attention.items.length === 0 ? (
              <LoadingState label="Checking…" />
            ) : attention.items.length === 0 ? (
              <View style={{ padding: spacing.lg, alignItems: "center" }}>
                <Ionicons name="checkmark-circle-outline" size={22} color={colors.success} />
                <Text style={[typo.bodySmall, { marginTop: 6 }]}>All clear — nothing needs attention.</Text>
              </View>
            ) : (
              <View style={isShellWide ? { maxHeight: 340 } : undefined}>
                {attention.items.slice(0, 12).map((item) => (
                  <TouchableOpacity key={item.id} style={styles.attentionRow} onPress={() => router.push(item.route as any)} testID={`attention-${item.id}`}>
                    <Ionicons name={ATTENTION_ICON[item.kind]} size={16} color={colors.warning} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={typo.body} numberOfLines={1}>{item.title}</Text>
                      <Text style={[typo.caption, { marginTop: 1, textTransform: "none", letterSpacing: 0 }]} numberOfLines={1}>{item.subtitle}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.inkMuted} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </Card>
        </View>
      </View>

      <View style={{ height: spacing.lg }} />

      {/* Lower dashboard: interconnected snapshots */}
      <ResponsiveGrid minItemWidth={320}>
        <DashboardPanel
          title="Upcoming bookings"
          testID="panel-upcoming-bookings"
          onSeeAll={() => router.push("/(app)/operations/bookings" as any)}
          emptyLabel="Nothing booked in the next 14 days."
          rows={upcomingBookings}
          renderRow={(b: Booking) => (
            <TouchableOpacity key={b.id} style={styles.listRow} onPress={() => router.push(`/(app)/operations/bookings?open=${b.id}` as any)}>
              <View style={{ flex: 1 }}>
                <Text style={typo.body} numberOfLines={1}>{b.customer_name}</Text>
                <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{b.job_site || "—"}</Text>
              </View>
              <Mono style={{ fontSize: 12, marginRight: 8 }}>{new Date(b.start_date).toLocaleDateString()}</Mono>
              <StatusBadge label={b.status} />
            </TouchableOpacity>
          )}
        />

        <DashboardPanel
          title="Active rentals"
          testID="panel-active-rentals"
          onSeeAll={() => router.push("/(app)/operations/rentals" as any)}
          emptyLabel="No active rentals."
          rows={activeRentals.slice(0, 6)}
          renderRow={(r: Rental) => {
            const total = r.lines.reduce((s, l) => s + l.qty, 0);
            const returned = r.lines.reduce((s, l) => s + l.returned_qty, 0);
            return (
              <TouchableOpacity key={r.id} style={styles.listRow} onPress={() => router.push(`/(app)/operations/rentals?open=${r.id}` as any)}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body} numberOfLines={1}>{r.customer_name}</Text>
                  <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{r.job_site || "—"}</Text>
                </View>
                <Mono style={{ fontSize: 12, marginRight: 8 }}>{returned}/{total}</Mono>
                <StatusBadge label={r.status} />
              </TouchableOpacity>
            );
          }}
        />

        <DashboardPanel
          title="Maintenance queue"
          testID="panel-maintenance-queue"
          onSeeAll={() => router.push("/(app)/assets/maintenance" as any)}
          emptyLabel="No open service entries."
          rows={openMaintenance}
          renderRow={(m: MaintItem) => (
            <TouchableOpacity key={m.id} style={styles.listRow} onPress={() => router.push(`/(app)/assets/maintenance?open=${m.id}` as any)}>
              <View style={{ flex: 1 }}>
                <Text style={typo.body} numberOfLines={1}>{m.equipment_name || "Equipment"}</Text>
                <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{m.issue}</Text>
              </View>
              <StatusBadge label={m.status} />
            </TouchableOpacity>
          )}
        />

        <DashboardPanel
          title="Inventory snapshot"
          testID="panel-inventory-snapshot"
          onSeeAll={() => router.push("/(app)/assets/equipment" as any)}
          emptyLabel="No equipment yet."
          rows={lowStock}
          renderRow={(e: Equipment) => (
            <TouchableOpacity key={e.id} style={styles.listRow} onPress={() => router.push(`/(app)/assets/equipment?open=${e.id}` as any)}>
              <View style={{ flex: 1 }}>
                <Text style={typo.body} numberOfLines={1}>{e.name}</Text>
                <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{e.sku}</Mono>
              </View>
              <Mono style={{ color: e.available > 0 ? colors.success : colors.error, fontWeight: "700" }}>{e.available}/{e.quantity}</Mono>
            </TouchableOpacity>
          )}
        />
      </ResponsiveGrid>

      <View style={{ height: spacing.lg }} />

      <SectionLabel>Recent activity</SectionLabel>
      <Card testID="activity-card">
        {(stats?.activity ?? []).length === 0 ? (
          <Text style={[typo.bodySmall]}>No activity yet.</Text>
        ) : (
          (stats?.activity ?? []).map((a, idx) => (
            <View key={idx} style={styles.activityRow}>
              <View style={styles.activityIcon}>
                <Ionicons name={a.type === "rental" ? "receipt-outline" : "construct-outline"} size={16} color={colors.primary} />
              </View>
              <Text style={[typo.body, { flex: 1, fontSize: 14 }]}>{a.title}</Text>
              <Text style={typo.caption}>{new Date(a.ts).toLocaleDateString()}</Text>
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

function DashboardPanel<T>({
  title, rows, renderRow, emptyLabel, onSeeAll, testID,
}: {
  title: string;
  rows: T[];
  renderRow: (row: T) => React.ReactNode;
  emptyLabel: string;
  onSeeAll: () => void;
  testID: string;
}) {
  return (
    <Card style={{ padding: 0 }} testID={testID}>
      <View style={styles.panelHeader}>
        <Text style={typo.h3}>{title}</Text>
        <TouchableOpacity onPress={onSeeAll} testID={`${testID}-see-all`}>
          <Text style={styles.seeAll}>See all</Text>
        </TouchableOpacity>
      </View>
      {rows.length === 0 ? (
        <View style={{ padding: spacing.lg }}>
          <Text style={[typo.bodySmall]}>{emptyLabel}</Text>
        </View>
      ) : (
        rows.map(renderRow)
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  mainRow: { flexDirection: "row" },
  mapCard: { borderRadius: radii.md, overflow: "hidden", borderWidth: 1, borderColor: colors.border },
  mapEmpty: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bgMuted, padding: spacing.lg },
  panelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  countBadge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  countBadgeText: { color: "#FFF", fontSize: 11, fontWeight: "700" },
  seeAll: { fontSize: 12, fontWeight: "700", color: colors.primary },
  attentionRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  listRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border, gap: 8 },
  activityRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    gap: 12,
  },
  activityIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.primarySoft,
    alignItems: "center", justifyContent: "center",
  },
});

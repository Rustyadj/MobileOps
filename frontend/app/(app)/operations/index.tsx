// Operations Overview — the hub tying Map, Rentals, Bookings, and Capacity
// together with live counts and deep links, instead of four unrelated screens.
import { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card } from "@/src/components/ui";
import { ResponsiveGrid } from "@/src/components/layout/ResponsiveGrid";
import { KpiCard } from "@/src/components/data/KpiCard";
import { ErrorState } from "@/src/components/feedback/ErrorState";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo, radii } from "@/src/theme";

type Rental = { id: string; status: string; lat?: number | null; lng?: number | null };
type Booking = { id: string; status: string; start_date: string };

export default function OperationsIndex() {
  const router = useRouter();
  const [activeRentals, setActiveRentals] = useState<number | null>(null);
  const [missingLocation, setMissingLocation] = useState<number | null>(null);
  const [upcomingBookings, setUpcomingBookings] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rentals, bookings] = await Promise.all([
        api<Rental[]>("/rentals"),
        api<Booking[]>("/bookings"),
      ]);
      const active = rentals.filter((r) => r.status !== "returned");
      setActiveRentals(active.length);
      setMissingLocation(active.filter((r) => r.lat == null || r.lng == null).length);
      const now = new Date();
      const cutoff = new Date(now.getTime() + 14 * 86400000);
      setUpcomingBookings(bookings.filter((b) => b.status !== "cancelled" && new Date(b.start_date) >= now && new Date(b.start_date) <= cutoff).length);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const modules: { label: string; sub: string; route: string; icon: any; testID: string }[] = [
    { label: "Map", sub: "Live job-site locations", route: "/(app)/operations/map", icon: "map-outline", testID: "ops-map" },
    { label: "Rentals", sub: "Active, upcoming & returns", route: "/(app)/operations/rentals", icon: "receipt-outline", testID: "ops-rentals" },
    { label: "Bookings", sub: "Scheduling & pipeline", route: "/(app)/operations/bookings", icon: "calendar-outline", testID: "ops-bookings" },
    { label: "Capacity", sub: "Demand vs. supply by date", route: "/(app)/operations/capacity", icon: "bar-chart-outline", testID: "ops-capacity" },
  ];

  return (
    <Screen title="Operations" subtitle="Map · Rentals · Bookings · Capacity" onRefresh={load} testID="operations-index-screen">
      {loadError ? <ErrorState message="Couldn't load operations counts." onRetry={load} testID="operations-index-error" /> : null}
      <ResponsiveGrid minItemWidth={180}>
        <KpiCard label="Active rentals" value={String(activeRentals ?? "—")} icon="receipt-outline" onPress={() => router.push("/(app)/operations/rentals" as any)} testID="ops-kpi-active" />
        <KpiCard label="Upcoming bookings (14d)" value={String(upcomingBookings ?? "—")} icon="calendar-outline" onPress={() => router.push("/(app)/operations/bookings" as any)} testID="ops-kpi-upcoming" />
        <KpiCard label="Missing location" value={String(missingLocation ?? "—")} icon="location-outline" tone={missingLocation ? "warning" : "default"} onPress={() => router.push("/(app)/operations/map" as any)} testID="ops-kpi-missing-loc" />
      </ResponsiveGrid>

      <View style={{ height: spacing.lg }} />

      {modules.map((m) => (
        <TouchableOpacity key={m.route} onPress={() => router.push(m.route as any)} activeOpacity={0.6} testID={m.testID}>
          <Card style={{ marginBottom: spacing.sm, flexDirection: "row", alignItems: "center" }}>
            <View style={{ width: 40, height: 40, borderRadius: radii.md, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", marginRight: spacing.md }}>
              <Ionicons name={m.icon} size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={typo.h3}>{m.label}</Text>
              <Text style={[typo.bodySmall, { marginTop: 2 }]}>{m.sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.inkMuted} />
          </Card>
        </TouchableOpacity>
      ))}
    </Screen>
  );
}

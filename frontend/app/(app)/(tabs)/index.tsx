import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card, Mono, SectionLabel } from "@/src/components/ui";
import { api, apiBaseUrl } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
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

export default function Dashboard() {
  const { user } = useAuth();
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api<Stats>("/dashboard/stats");
      setStats(s);
    } catch (e) {
      console.warn("stats", e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    await load();
    setRefreshing(false);
  };

  return (
    <Screen
      title={`Welcome, ${user?.name || ""}`}
      subtitle="Operations overview"
      onRefresh={onRefresh}
      refreshing={refreshing}
      testID="dashboard-screen"
    >
      <View style={styles.grid}>
        <StatTile label="Utilization" value={`${stats?.utilization ?? 0}%`} accent testID="stat-utilization" />
        <StatTile label="Active rentals" value={`${stats?.active_rentals ?? 0}`} testID="stat-active-rentals" />
        <StatTile label="Open service" value={`${stats?.open_maintenance ?? 0}`} testID="stat-open-maintenance" />
        <StatTile label="Vendors" value={`${stats?.vendors_count ?? 0}`} testID="stat-vendors" />
      </View>

      <SectionLabel>Quick actions</SectionLabel>
      <View style={styles.actionsRow}>
        <ActionTile icon="construct-outline" label="Bracing" onPress={() => router.push("/(app)/(tabs)/bracing")} testID="action-bracing" />
        <ActionTile icon="calculator-outline" label="Calculator" onPress={() => router.push("/(app)/(tabs)/calculator")} testID="action-calculator" />
        <ActionTile icon="cube-outline" label="Equipment" onPress={() => router.push("/(app)/(tabs)/equipment")} testID="action-equipment" />
        <ActionTile icon="receipt-outline" label="Rentals" onPress={() => router.push("/(app)/rentals")} testID="action-rentals" />
      </View>

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

const StatTile: React.FC<{ label: string; value: string; accent?: boolean; testID?: string }> = ({ label, value, accent, testID }) => (
  <View style={[styles.tile, accent && { backgroundColor: colors.primary, borderColor: colors.primary }]} testID={testID}>
    <Text style={[typo.caption, accent && { color: "#FFF", opacity: 0.8 }]}>{label}</Text>
    <Mono large style={[{ marginTop: 4 }, accent ? { color: "#FFF" } : undefined]}>{value}</Mono>
  </View>
);

const ActionTile: React.FC<{ icon: any; label: string; onPress: () => void; testID?: string }> = ({ icon, label, onPress, testID }) => (
  <TouchableOpacity onPress={onPress} style={styles.action} testID={testID} activeOpacity={0.7}>
    <Ionicons name={icon} size={22} color={colors.primary} />
    <Text style={[typo.body, { fontSize: 13, marginTop: 6, fontWeight: "500" }]}>{label}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: spacing.lg },
  tile: {
    width: "47.5%",
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: colors.bg,
  },
  actionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: spacing.lg },
  action: {
    width: "22%",
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md,
    padding: 12, alignItems: "center", justifyContent: "center",
    minHeight: 76, flexGrow: 1,
    backgroundColor: colors.bg,
  },
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

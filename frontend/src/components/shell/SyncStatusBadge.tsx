// Minimum "don't let queued offline work vanish silently" affordance —
// shows how many actions are still queued to sync and how many couldn't
// sync at all, tapping through to the sync-issues review screen. Rendered
// in the shell (TopBar) next to the existing Needs Attention bell so it
// reads as part of the same "status" cluster.
import React from "react";
import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii } from "@/src/theme";
import { useQueueStatus } from "@/src/hooks/use-queue-status";

export const SyncStatusBadge: React.FC = () => {
  const router = useRouter();
  const { pending, failed } = useQueueStatus();

  if (pending === 0 && failed === 0) return null;

  const label = failed > 0
    ? `${failed} action${failed === 1 ? "" : "s"} couldn't sync`
    : `${pending} action${pending === 1 ? "" : "s"} pending sync`;

  return (
    <TouchableOpacity
      onPress={() => router.push("/(app)/sync-issues" as any)}
      style={styles.iconBtn}
      testID="topbar-sync-status"
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <Ionicons name={failed > 0 ? "cloud-offline-outline" : "sync-outline"} size={18} color={failed > 0 ? colors.error : colors.inkSecondary} />
      <View style={[styles.badge, failed > 0 && styles.badgeWarning]}>
        <Text style={styles.badgeText}>{(failed || pending) > 9 ? "9+" : failed || pending}</Text>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  iconBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radii.md },
  badge: { position: "absolute", top: 2, right: 2, minWidth: 15, height: 15, borderRadius: 8, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  badgeWarning: { backgroundColor: colors.error },
  badgeText: { color: "#FFF", fontSize: 9, fontWeight: "700" },
});

import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppNotification } from "@/src/types/notification";
import { colors, radii, spacing } from "@/src/theme";

const ago = (value: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

type Props = {
  items: AppNotification[];
  loading: boolean;
  error: string | null;
  onOpen: (item: AppNotification) => void;
  onRetry: () => void;
  maxHeight?: number;
};

export function NotificationList({ items, loading, error, onOpen, onRetry, maxHeight }: Props) {
  if (error) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>{error}</Text>
        <TouchableOpacity onPress={onRetry} accessibilityRole="button"><Text style={styles.retry}>Retry</Text></TouchableOpacity>
      </View>
    );
  }
  if (loading && !items.length) return <View style={styles.state}><Text style={styles.stateText}>Loading…</Text></View>;
  if (!items.length) {
    return (
      <View style={styles.state} testID="notifications-empty">
        <Ionicons name="at-outline" size={22} color={colors.inkMuted} />
        <Text style={styles.stateText}>No mentions yet. You will see them here when someone @mentions you in the Live Feed.</Text>
      </View>
    );
  }
  return (
    <ScrollView style={maxHeight ? { maxHeight } : undefined} testID="notifications-list">
      {items.map((item) => (
        <TouchableOpacity
          key={item.id}
          onPress={() => onOpen(item)}
          style={[styles.row, !item.read && styles.unread]}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`${item.title} ${item.read ? "" : "Unread."}`}
          testID={`notification-${item.id}`}
        >
          <View style={[styles.dot, item.read && styles.dotRead]} />
          <View style={styles.rowBody}>
            <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
            {item.preview ? <Text style={styles.preview} numberOfLines={2}>{item.preview}</Text> : null}
            <Text style={styles.time}>{ago(item.created_at)}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  state: { alignItems: "center", gap: spacing.sm, padding: spacing.lg },
  stateText: { fontSize: 12.5, color: colors.inkMuted, textAlign: "center" },
  retry: { fontSize: 12.5, fontWeight: "700", color: colors.primary },
  row: { flexDirection: "row", gap: spacing.sm, padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  unread: { backgroundColor: colors.primarySoft },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, backgroundColor: colors.primary },
  dotRead: { backgroundColor: "transparent" },
  rowBody: { flex: 1, minWidth: 0 },
  title: { fontSize: 13, fontWeight: "700", color: colors.ink },
  preview: { fontSize: 12.5, color: colors.inkSecondary, marginTop: 2, borderRadius: radii.sm },
  time: { fontSize: 11, color: colors.inkMuted, marginTop: 4 },
});

// Top-bar "Mentions" inbox: unread badge + dropdown of @mention notifications.
// Separate from the "Needs attention" bell, which tracks operational work.
import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { NotificationList } from "@/src/components/notifications/NotificationList";
import { useNotifications } from "@/src/hooks/use-notifications";
import { colors, radii, spacing } from "@/src/theme";

export const MentionsInbox: React.FC = () => {
  const router = useRouter();
  const inbox = useNotifications();
  const [open, setOpen] = useState(false);

  return (
    <View>
      <TouchableOpacity
        onPress={() => setOpen((value) => !value)}
        style={styles.iconBtn}
        testID="topbar-mentions"
        accessibilityRole="button"
        accessibilityLabel={`Mentions, ${inbox.unread} unread`}
      >
        <Ionicons name="at-outline" size={18} color={colors.inkSecondary} />
        {inbox.unread > 0 ? (
          <View style={styles.badge}><Text style={styles.badgeText}>{inbox.unread > 9 ? "9+" : inbox.unread}</Text></View>
        ) : null}
      </TouchableOpacity>
      {open ? (
        <>
          <TouchableOpacity style={StyleSheet.absoluteFillObject as any} activeOpacity={1} onPress={() => setOpen(false)} />
          <View style={styles.panel} testID="mentions-panel">
            <View style={styles.header}>
              <Text style={styles.headerTitle}>Mentions</Text>
              {inbox.unread > 0 ? (
                <TouchableOpacity onPress={inbox.markAllRead} accessibilityRole="button" testID="mentions-mark-all">
                  <Text style={styles.link}>Mark all read</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <NotificationList
              items={inbox.items}
              loading={inbox.loading}
              error={inbox.error}
              onRetry={inbox.reload}
              maxHeight={420}
              onOpen={(item) => {
                setOpen(false);
                if (!item.read) inbox.markRead(item.id);
                router.push(item.link as any);
              }}
            />
          </View>
        </>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  iconBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radii.md },
  badge: { position: "absolute", top: 2, right: 2, minWidth: 15, height: 15, borderRadius: 8, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  badgeText: { color: "#FFF", fontSize: 9, fontWeight: "700" },
  panel: {
    position: "absolute", top: 40, right: 0, width: 340, zIndex: 100,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden",
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerTitle: { fontSize: 13, fontWeight: "800", color: colors.ink },
  link: { fontSize: 12, fontWeight: "700", color: colors.primary },
});

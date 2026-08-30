// Mobile "Menu" tab — secondary destinations not on the primary bottom nav
// (Tools, Contacts, Administration) plus account info and sign out.
// Home/Operations/Inventory/Shop each have their own bottom-nav tab, so
// they aren't repeated here.
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card, Button, SectionLabel } from "@/src/components/ui";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, type as typo, radii } from "@/src/theme";

const ITEMS: { label: string; sub: string; route: string; icon: any; testID: string }[] = [
  { label: "Utilities", sub: "Delivery tickets, bracing, and calculators", route: "/(app)/tools", icon: "construct-outline", testID: "more-tools" },
  { label: "Contacts", sub: "Companies, homeowners, and current job locations", route: "/(app)/contacts", icon: "people-outline", testID: "more-contacts" },
  { label: "Site Admin", sub: "Brand, logo, company contact", route: "/(app)/site-admin", icon: "settings-outline", testID: "more-site-admin" },
];

export default function MenuScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();

  const initials = (user?.name || user?.email || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || "")
    .join("") || "?";

  return (
    <Screen title="Menu" subtitle="Partners, admin & account" testID="menu-screen">
      <View style={styles.userCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.userName}>{user?.name}</Text>
          <Text style={styles.userMeta}>{user?.email}</Text>
          <View style={styles.roleTag}>
            <Text style={styles.roleText}>{user?.role}</Text>
          </View>
        </View>
      </View>

      <SectionLabel>Tools, partners &amp; administration</SectionLabel>
      {ITEMS.map((it) => (
        <TouchableOpacity key={it.route} onPress={() => router.push(it.route as any)} activeOpacity={0.6} testID={it.testID}>
          <Card style={{ marginBottom: spacing.sm, flexDirection: "row", alignItems: "center" }}>
            <View style={styles.iconBox}>
              <Ionicons name={it.icon} size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[typo.h3]}>{it.label}</Text>
              <Text style={[typo.bodySmall, { marginTop: 2 }]}>{it.sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.inkMuted} />
          </Card>
        </TouchableOpacity>
      ))}

      <View style={{ height: spacing.lg }} />
      <Button title="Sign out" onPress={logout} variant="outline" testID="logout-btn" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primary,
    padding: spacing.md,
    gap: 14,
    marginBottom: spacing.lg,
    borderRadius: radii.lg,
  },
  avatar: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.25)",
  },
  avatarText: { color: "#FFF", fontSize: 18, fontWeight: "600" },
  userName: { color: "#FFF", fontSize: 16, fontWeight: "600" },
  userMeta: { color: "rgba(255,255,255,0.75)", fontSize: 12, marginTop: 2 },
  roleTag: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: radii.sm,
    marginTop: 6,
  },
  roleText: { color: "#FFF", fontSize: 10, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" },
  iconBox: {
    width: 40, height: 40,
    borderRadius: radii.md,
    backgroundColor: colors.primarySoft,
    alignItems: "center", justifyContent: "center",
    marginRight: spacing.md,
  },
});

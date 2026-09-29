import { StyleSheet, View } from "react-native";
import { Screen } from "@/src/components/Screen";
import { SupplyRequestsCard } from "@/src/components/dashboard/SupplyRequestsCard";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, spacing } from "@/src/theme";

export default function RequestsScreen() {
  const { isShellWide } = useBreakpoint();
  if (isShellWide) {
    return <View style={styles.desktop} testID="requests-screen"><View style={styles.desktopCard}><SupplyRequestsCard /></View></View>;
  }
  return <Screen title="Requests" subtitle="Crew supply asks waiting on approval" testID="requests-screen"><View style={styles.mobile}><SupplyRequestsCard /></View></Screen>;
}

const styles = StyleSheet.create({
  desktop: { flex: 1, backgroundColor: colors.bgMuted, padding: spacing.lg },
  desktopCard: { flex: 1, minHeight: 600, maxWidth: 900, width: "100%", alignSelf: "center" },
  mobile: { minHeight: 500, marginBottom: spacing.xl },
});

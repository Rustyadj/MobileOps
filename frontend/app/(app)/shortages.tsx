import { StyleSheet, View } from "react-native";
import { Screen } from "@/src/components/Screen";
import { ShortagesCard } from "@/src/components/dashboard/ShortagesCard";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, spacing } from "@/src/theme";

export default function ShortagesScreen() {
  const { isShellWide } = useBreakpoint();
  if (isShellWide) {
    return <View style={styles.desktop} testID="shortages-screen"><View style={styles.desktopCard}><ShortagesCard /></View></View>;
  }
  return <Screen title="Shortages" subtitle="Everything the operation currently needs more of" testID="shortages-screen"><View style={styles.mobile}><ShortagesCard /></View></Screen>;
}

const styles = StyleSheet.create({
  desktop: { flex: 1, backgroundColor: colors.bgMuted, padding: spacing.lg },
  desktopCard: { flex: 1, minHeight: 600, maxWidth: 900, width: "100%", alignSelf: "center" },
  mobile: { minHeight: 500, marginBottom: spacing.xl },
});

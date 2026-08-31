import { StyleSheet, View } from "react-native";
import { Screen } from "@/src/components/Screen";
import { WhiteboardFeed } from "@/src/components/whiteboard/WhiteboardFeed";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, spacing } from "@/src/theme";

export default function WhiteboardScreen() {
  const { isShellWide } = useBreakpoint();
  if (isShellWide) {
    return <View style={styles.desktop} testID="whiteboard-screen"><View style={styles.desktopCard}><WhiteboardFeed /></View></View>;
  }
  return <Screen title="Live Feed" subtitle="Team updates, replies, files, and @Nathan" testID="whiteboard-screen"><View style={styles.mobile}><WhiteboardFeed /></View></Screen>;
}

const styles = StyleSheet.create({
  desktop: { flex: 1, backgroundColor: colors.bgMuted, padding: spacing.lg },
  desktopCard: { flex: 1, minHeight: 600, maxWidth: 1100, width: "100%", alignSelf: "center" },
  mobile: { minHeight: 620, marginBottom: spacing.xl },
});

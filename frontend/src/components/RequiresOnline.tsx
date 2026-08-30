// Wraps a write action that stays online-only in phase 1 of offline support
// (site settings, contact CRUD, CSV import/export, booking flows, ...) —
// dims it and explains why, rather than letting the user tap it and get a
// generic network-error alert. See memory/PRD.md's offline-sync roadmap
// entry for which flows are online-only vs. queued and why.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { colors, spacing, radii, type as typo } from "@/src/theme";

export const RequiresOnline: React.FC<{ children: React.ReactNode; message?: string }> = ({
  children,
  message = "Requires a connection",
}) => {
  const [online, setOnline] = React.useState(true);

  React.useEffect(() => {
    return NetInfo.addEventListener((state) => {
      setOnline(!!state.isConnected && state.isInternetReachable !== false);
    });
  }, []);

  if (online) return <>{children}</>;

  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={{ opacity: 0.4 }}>{children}</View>
      <View style={styles.overlay}>
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { position: "relative" },
  overlay: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    alignItems: "center", paddingVertical: spacing.xs,
    backgroundColor: colors.bgTint, borderRadius: radii.sm,
  },
  text: { ...typo.label, color: colors.inkSecondary },
});

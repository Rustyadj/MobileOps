// Right-side detail drawer on tablet/desktop; full-screen sheet on phone.
// Used for record detail/edit views (Equipment, Rentals, Bookings, Vendors,
// Maintenance) so browsing a list and inspecting a record don't bounce
// through separate screens on larger displays.
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";

export const DetailDrawer: React.FC<{
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
  testID?: string;
}> = ({ visible, title, subtitle, onClose, headerActions, children, width = 440, testID = "detail-drawer" }) => {
  const { isShellWide } = useBreakpoint();
  const insets = useSafeAreaInsets();
  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType={isShellWide ? "fade" : "slide"} onRequestClose={onClose}>
      <View style={[styles.backdrop, isShellWide && styles.backdropDesktop]}>
        <TouchableOpacity style={StyleSheet.absoluteFillObject as any} activeOpacity={1} onPress={onClose} />
        <View
          style={[
            styles.panel,
            isShellWide
              ? { width, right: 0, top: 0, bottom: 0, borderLeftWidth: 1 }
              : { left: 0, right: 0, bottom: 0, top: insets.top, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl },
          ]}
          testID={testID}
        >
          <View style={styles.header}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={typo.h3} numberOfLines={1}>{title}</Text>
              {subtitle ? <Text style={[typo.bodySmall, { marginTop: 2 }]} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
            {headerActions}
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID={`${testID}-close`}>
              <Ionicons name="close" size={20} color={colors.ink} />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.4)", zIndex: 1000 },
  backdropDesktop: { backgroundColor: "transparent" },
  panel: { position: "absolute", backgroundColor: colors.bg, borderColor: colors.border, zIndex: 1 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  closeBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
});

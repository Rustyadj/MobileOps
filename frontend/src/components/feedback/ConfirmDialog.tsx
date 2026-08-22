// Confirmation modal for destructive actions (delete equipment/rental/etc).
// Controlled component — parent owns the `visible` state.
import React from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity } from "react-native";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { Button } from "@/src/components/ui";

export const ConfirmDialog: React.FC<{
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
}> = ({ visible, title, message, confirmLabel = "Confirm", destructive = true, onConfirm, onCancel, testID = "confirm-dialog" }) => {
  if (!visible) return null;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onCancel}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.card} testID={testID}>
          <Text style={typo.h3}>{title}</Text>
          {message ? <Text style={[typo.bodySmall, { marginTop: 6 }]}>{message}</Text> : null}
          <View style={styles.actions}>
            <View style={{ flex: 1 }}>
              <Button title="Cancel" onPress={onCancel} variant="outline" testID={`${testID}-cancel`} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title={confirmLabel} onPress={onConfirm} variant={destructive ? "danger" : "primary"} testID={`${testID}-confirm`} />
            </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)", alignItems: "center", justifyContent: "center", padding: spacing.lg },
  card: { backgroundColor: colors.bg, borderRadius: radii.lg, padding: spacing.lg, width: "100%", maxWidth: 380 },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
});

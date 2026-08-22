import React, { useState } from "react";
import { View, Text, StyleSheet, Alert } from "react-native";
import { Mono, Row, Button } from "@/src/components/ui";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { colors, spacing, type as typo } from "@/src/theme";
import { MaintItem, ageDays } from "./useMaintenance";

export const MaintenanceDetailDrawer: React.FC<{
  item: MaintItem | null;
  onClose: () => void;
  onEdit: (m: MaintItem) => void;
  onDelete: (id: string) => Promise<void>;
}> = ({ item, onClose, onEdit, onDelete }) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!item) return null;

  const handleDelete = async () => {
    setConfirmDelete(false);
    try { await onDelete(item.id); onClose(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  return (
    <>
      <DetailDrawer visible={!!item} title={item.equipment_name || "Equipment"} subtitle={item.issue} onClose={onClose} headerActions={<StatusBadge label={item.status} />} testID="maintenance-detail-drawer">
        <Row style={{ gap: spacing.lg, flexWrap: "wrap", marginBottom: spacing.lg }}>
          <Text style={typo.label}>Cost <Mono style={{ fontSize: 13 }}>${item.cost.toFixed(2)}</Mono></Text>
          <Text style={typo.label}>Age <Mono style={{ fontSize: 13 }}>{ageDays(item.created_at)}d</Mono></Text>
          {item.serviced_at ? <Text style={typo.label}>Serviced <Mono style={{ fontSize: 13 }}>{new Date(item.serviced_at).toLocaleDateString()}</Mono></Text> : null}
        </Row>

        {item.action_taken ? (
          <View style={styles.box}>
            <Text style={typo.caption}>Action taken</Text>
            <Text style={[typo.body, { marginTop: 4 }]}>{item.action_taken}</Text>
          </View>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Row style={{ gap: spacing.sm }}>
          <View style={{ flex: 1 }}><Button title="Edit" onPress={() => onEdit(item)} variant="outline" testID="drawer-edit-maint" /></View>
          <View style={{ flex: 1 }}><Button title="Delete" onPress={() => setConfirmDelete(true)} variant="danger" testID="drawer-delete-maint" /></View>
        </Row>
      </DetailDrawer>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete this service entry?"
        message="This can't be undone."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
        testID="delete-maint-confirm"
      />
    </>
  );
};

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: spacing.sm, marginBottom: spacing.md },
});

// Equipment detail — core info, rental usage (who has it out right now),
// maintenance history, rates/notes, and edit/delete actions.
import React, { useState } from "react";
import { View, Text, StyleSheet, Alert } from "react-native";
import { Mono, Row, SectionLabel, Button } from "@/src/components/ui";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { colors, spacing, type as typo } from "@/src/theme";
import type { Equipment, MaintenanceEntry, RentalUsage } from "./useEquipment";

export const EquipmentDetailDrawer: React.FC<{
  item: Equipment | null;
  maintenance: MaintenanceEntry[];
  rentalUsage: RentalUsage[];
  onClose: () => void;
  onEdit: (e: Equipment) => void;
  onDelete: (id: string) => Promise<void>;
}> = ({ item, maintenance, rentalUsage, onClose, onEdit, onDelete }) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!item) return null;

  const history = maintenance.filter((m) => m.equipment_id === item.id);

  const handleDelete = async () => {
    setConfirmDelete(false);
    try { await onDelete(item.id); onClose(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  return (
    <>
      <DetailDrawer
        visible={!!item}
        title={item.name}
        subtitle={item.sku}
        onClose={onClose}
        headerActions={<StatusBadge label={item.available > 0 ? "Available" : "None available"} tone={item.available > 0 ? "success" : "error"} />}
        testID="equipment-detail-drawer"
      >
        <Row style={{ gap: spacing.lg, flexWrap: "wrap", marginBottom: spacing.lg }}>
          <Text style={typo.label}>Category <Text style={typo.body}>{item.category.replace(/_/g, " ")}</Text></Text>
          <Text style={typo.label}>Location <Text style={typo.body}>{item.location || "—"}</Text></Text>
          <Text style={typo.label}>Condition <Text style={typo.body}>{item.condition}</Text></Text>
        </Row>

        <View style={styles.qtyRow}>
          <View style={styles.qtyBox}>
            <Text style={typo.caption}>On hand</Text>
            <Mono large>{item.quantity}</Mono>
          </View>
          <View style={styles.qtyBox}>
            <Text style={typo.caption}>Available</Text>
            <Mono large style={{ color: item.available > 0 ? colors.success : colors.error }}>{item.available}</Mono>
          </View>
          <View style={styles.qtyBox}>
            <Text style={typo.caption}>Daily rate</Text>
            <Mono large>${item.daily_rate}</Mono>
          </View>
        </View>

        <SectionLabel>Currently rented ({rentalUsage.length})</SectionLabel>
        {rentalUsage.length === 0 ? (
          <Text style={[typo.bodySmall, { marginBottom: spacing.md }]}>Not currently on any active rental.</Text>
        ) : (
          <View style={styles.wrap}>
            {rentalUsage.map((u) => (
              <Row key={u.id} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body} numberOfLines={1}>{u.customer_name}</Text>
                  <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{u.job_site || "—"}</Text>
                </View>
                <Mono>{u.qty}</Mono>
              </Row>
            ))}
          </View>
        )}

        <View style={{ height: spacing.md }} />
        <SectionLabel>Maintenance history ({history.length})</SectionLabel>
        {history.length === 0 ? (
          <Text style={[typo.bodySmall, { marginBottom: spacing.md }]}>No service history.</Text>
        ) : (
          <View style={styles.wrap}>
            {history.map((m) => (
              <Row key={m.id} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body} numberOfLines={1}>{m.issue}</Text>
                  <Text style={[typo.bodySmall, { marginTop: 1 }]}>${m.cost.toFixed(2)}</Text>
                </View>
                <StatusBadge label={m.status} />
              </Row>
            ))}
          </View>
        )}

        {item.notes ? (
          <>
            <View style={{ height: spacing.md }} />
            <SectionLabel>Notes</SectionLabel>
            <Text style={typo.body}>{item.notes}</Text>
          </>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Row style={{ gap: spacing.sm }}>
          <View style={{ flex: 1 }}><Button title="Edit" onPress={() => onEdit(item)} variant="outline" testID="drawer-edit-equipment" /></View>
          <View style={{ flex: 1 }}><Button title="Delete" onPress={() => setConfirmDelete(true)} variant="danger" testID="drawer-delete-equipment" /></View>
        </Row>
      </DetailDrawer>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete this equipment?"
        message={`This removes ${item.name} (${item.sku}) from inventory. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
        testID="delete-equipment-confirm"
      />
    </>
  );
};

const styles = StyleSheet.create({
  qtyRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  qtyBox: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: spacing.sm },
  wrap: { borderTopWidth: 1, borderTopColor: colors.border },
  row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
});

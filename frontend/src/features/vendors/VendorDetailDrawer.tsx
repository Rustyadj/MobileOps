import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Linking, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Mono, Row, Pill, Button } from "@/src/components/ui";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { colors, spacing, type as typo } from "@/src/theme";
import type { Vendor } from "./useVendors";

export const VendorDetailDrawer: React.FC<{
  vendor: Vendor | null;
  onClose: () => void;
  onEdit: (v: Vendor) => void;
  onDelete: (id: string) => Promise<void>;
}> = ({ vendor, onClose, onEdit, onDelete }) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!vendor) return null;

  const handleDelete = async () => {
    setConfirmDelete(false);
    try { await onDelete(vendor.id); onClose(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  return (
    <>
      <DetailDrawer visible={!!vendor} title={vendor.name} subtitle={vendor.contact_name || undefined} onClose={onClose} testID="vendor-detail-drawer">
        <Row style={{ gap: 8, flexWrap: "wrap", marginBottom: spacing.md }}>
          {vendor.categories.map((c) => <Pill key={c}>{c}</Pill>)}
        </Row>

        {(vendor.phone || vendor.email) ? (
          <Row style={{ gap: spacing.lg, marginBottom: spacing.md, flexWrap: "wrap" }}>
            {vendor.phone ? (
              <TouchableOpacity onPress={() => Linking.openURL(`tel:${vendor.phone}`)} testID="drawer-call-vendor">
                <Row style={{ gap: 4 }}><Ionicons name="call-outline" size={14} color={colors.accent} /><Mono style={{ fontSize: 13 }}>{vendor.phone}</Mono></Row>
              </TouchableOpacity>
            ) : null}
            {vendor.email ? (
              <TouchableOpacity onPress={() => Linking.openURL(`mailto:${vendor.email}`)} testID="drawer-email-vendor">
                <Row style={{ gap: 4 }}><Ionicons name="mail-outline" size={14} color={colors.accent} /><Mono style={{ fontSize: 13 }}>{vendor.email}</Mono></Row>
              </TouchableOpacity>
            ) : null}
          </Row>
        ) : null}

        {vendor.address ? <Text style={[typo.body, { marginBottom: spacing.md }]}>{vendor.address}</Text> : null}

        <View style={styles.grid}>
          {vendor.freight_terms ? <Text style={typo.label}>Freight <Text style={typo.body}>{vendor.freight_terms}</Text></Text> : null}
          {vendor.truck_capacity ? <Text style={typo.label}>Truck <Text style={typo.body}>{vendor.truck_capacity}</Text></Text> : null}
          {vendor.lead_time_days > 0 ? <Text style={typo.label}>Lead time <Text style={typo.body}>{vendor.lead_time_days} days</Text></Text> : null}
        </View>

        {vendor.notes ? (
          <>
            <View style={{ height: spacing.md }} />
            <Text style={typo.caption}>Notes</Text>
            <Text style={[typo.body, { marginTop: 4 }]}>{vendor.notes}</Text>
          </>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Row style={{ gap: spacing.sm }}>
          <View style={{ flex: 1 }}><Button title="Edit" onPress={() => onEdit(vendor)} variant="outline" testID="drawer-edit-vendor" /></View>
          <View style={{ flex: 1 }}><Button title="Delete" onPress={() => setConfirmDelete(true)} variant="danger" testID="drawer-delete-vendor" /></View>
        </Row>
      </DetailDrawer>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete this vendor?"
        message={`This removes ${vendor.name} from the directory. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
        testID="delete-vendor-confirm"
      />
    </>
  );
};

const styles = StyleSheet.create({
  grid: { gap: 6 },
});

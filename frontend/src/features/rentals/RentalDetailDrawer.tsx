// Rental detail — customer, job site + mini-map, line items with a
// first-class Return action per line, notes, delivery PDF, and record
// actions (Edit / Set location / Delete). Rendered inside DetailDrawer so
// it's a right-side panel on desktop and a full-screen sheet on phone.
import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, Mono, Row, SectionLabel } from "@/src/components/ui";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { MapCanvas } from "@/src/components/MapCanvas";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import type { Rental, Line } from "./useRentals";

export const RentalDetailDrawer: React.FC<{
  rental: Rental | null;
  onClose: () => void;
  onEdit: (r: Rental) => void;
  onDelete: (id: string) => Promise<void>;
  onReturn: (r: Rental, line: Line, qty: number) => Promise<void>;
  onSetLocation: (r: Rental) => void;
  onGeneratePDF: (r: Rental) => Promise<void>;
}> = ({ rental, onClose, onEdit, onDelete, onReturn, onSetLocation, onGeneratePDF }) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyPdf, setBusyPdf] = useState(false);

  if (!rental) return null;
  const totalQty = rental.lines.reduce((s, l) => s + l.qty, 0);
  const returnedQty = rental.lines.reduce((s, l) => s + l.returned_qty, 0);

  const handleDelete = async () => {
    setConfirmDelete(false);
    try { await onDelete(rental.id); onClose(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  const handlePdf = async () => {
    setBusyPdf(true);
    try { await onGeneratePDF(rental); }
    catch (e: any) { Alert.alert("PDF failed", e?.message || "Unable to generate PDF"); }
    finally { setBusyPdf(false); }
  };

  return (
    <>
      <DetailDrawer
        visible={!!rental}
        title={rental.customer_name}
        subtitle={rental.job_site || "No job site"}
        onClose={onClose}
        headerActions={<StatusBadge label={rental.status} />}
        testID="rental-detail-drawer"
      >
        <Row style={{ gap: spacing.lg, flexWrap: "wrap", marginBottom: spacing.md }}>
          {rental.customer_phone ? (
            <Row style={{ gap: 4 }}><Ionicons name="call-outline" size={13} color={colors.primary} /><Mono style={{ fontSize: 12 }}>{rental.customer_phone}</Mono></Row>
          ) : null}
          {rental.customer_email ? (
            <Row style={{ gap: 4 }}><Ionicons name="mail-outline" size={13} color={colors.primary} /><Text style={{ fontSize: 12, color: colors.inkSecondary }}>{rental.customer_email}</Text></Row>
          ) : null}
          <Row style={{ gap: 4 }}><Ionicons name="calendar-outline" size={13} color={colors.inkMuted} /><Mono style={{ fontSize: 12 }}>{new Date(rental.start_date).toLocaleDateString()}</Mono></Row>
        </Row>

        {rental.lat != null && rental.lng != null ? (
          <View style={styles.miniMap} testID="rental-detail-map">
            <MapCanvas pins={[{ id: rental.id, lat: rental.lat, lng: rental.lng, title: rental.customer_name, subtitle: rental.job_site, status: rental.status }]} />
          </View>
        ) : (
          <View style={[styles.miniMap, styles.miniMapEmpty]}>
            <Ionicons name="location-outline" size={20} color={colors.inkMuted} />
            <Text style={[typo.bodySmall, { marginTop: 4 }]}>No location set</Text>
          </View>
        )}
        <View style={{ marginTop: spacing.sm, marginBottom: spacing.lg }}>
          <Button title={rental.lat != null ? "Update location" : "Set location"} onPress={() => onSetLocation(rental)} variant="outline" testID="drawer-set-location" />
        </View>

        <SectionLabel>Equipment ({rental.lines.length}) · {returnedQty}/{totalQty} returned</SectionLabel>
        <View style={styles.lineWrap}>
          {rental.lines.map((l) => (
            <Row key={l.equipment_id} style={styles.lineRow}>
              <View style={{ flex: 1 }}>
                <Text style={typo.body}>{l.name}</Text>
                <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{l.sku}</Mono>
              </View>
              <Mono style={{ marginRight: 12 }}>{l.returned_qty}/{l.qty}</Mono>
              {l.returned_qty < l.qty && rental.status !== "returned" ? (
                <TouchableOpacity onPress={() => onReturn(rental, l, l.qty - l.returned_qty)} style={styles.returnBtn} testID={`drawer-return-${l.equipment_id}`}>
                  <Text style={styles.returnBtnText}>Return</Text>
                </TouchableOpacity>
              ) : null}
            </Row>
          ))}
        </View>

        {rental.notes ? (
          <>
            <View style={{ height: spacing.md }} />
            <SectionLabel>Notes</SectionLabel>
            <Text style={typo.body}>{rental.notes}</Text>
          </>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Row style={{ gap: spacing.sm }}>
          <View style={{ flex: 1 }}><Button title="Edit" onPress={() => onEdit(rental)} variant="outline" testID="drawer-edit-rental" /></View>
          <View style={{ flex: 1 }}><Button title="Delivery PDF" onPress={handlePdf} loading={busyPdf} variant="outline" testID="drawer-pdf-rental" /></View>
        </Row>
        <View style={{ height: spacing.sm }} />
        <Button title="Delete rental" onPress={() => setConfirmDelete(true)} variant="danger" testID="drawer-delete-rental" />
      </DetailDrawer>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete this rental?"
        message={`This removes ${rental.customer_name}'s rental record. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
        testID="delete-rental-confirm"
      />
    </>
  );
};

const styles = StyleSheet.create({
  miniMap: { height: 160, borderRadius: radii.md, overflow: "hidden", borderWidth: 1, borderColor: colors.border },
  miniMapEmpty: { alignItems: "center", justifyContent: "center", backgroundColor: colors.bgMuted },
  lineWrap: { borderTopWidth: 1, borderTopColor: colors.border },
  lineRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  returnBtn: { paddingHorizontal: 10, height: 30, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
  returnBtnText: { fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6 },
});

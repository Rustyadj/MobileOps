// Booking detail — customer/job/dates, requested equipment, and a live
// capacity check for the start date so a shortage shows up right where
// you're planning, not only on a separate Capacity screen.
import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Mono, Row, SectionLabel, Button } from "@/src/components/ui";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { computeCapacity, CapEquipment, CapRental } from "@/src/features/capacity/computeCapacity";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import type { Booking } from "./useBookings";

export const BookingDetailDrawer: React.FC<{
  booking: Booking | null;
  equipment: CapEquipment[];
  rentals: CapRental[];
  onClose: () => void;
  onDelete: (id: string) => Promise<void>;
}> = ({ booking, equipment, rentals, onClose, onDelete }) => {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const conflicts = useMemo(() => {
    if (!booking) return [];
    const rows = computeCapacity(equipment, rentals, [booking], booking.start_date.slice(0, 10));
    return rows.filter((r) => r.conflict && booking.items.some((i) => i.equipment_id === r.equipment_id));
  }, [booking, equipment, rentals]);

  if (!booking) return null;

  const handleDelete = async () => {
    setConfirmDelete(false);
    try { await onDelete(booking.id); onClose(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  return (
    <>
      <DetailDrawer
        visible={!!booking}
        title={booking.customer_name}
        subtitle={booking.job_site || "No job site"}
        onClose={onClose}
        headerActions={<StatusBadge label={booking.status} />}
        testID="booking-detail-drawer"
      >
        <Row style={{ gap: spacing.lg, flexWrap: "wrap", marginBottom: spacing.lg }}>
          <Mono style={{ fontSize: 13 }}>{new Date(booking.start_date).toLocaleDateString()} → {new Date(booking.end_date).toLocaleDateString()}</Mono>
        </Row>

        {conflicts.length > 0 ? (
          <View style={styles.conflictBanner} testID="booking-conflict-banner">
            <Text style={styles.conflictText}>
              Shortage on {new Date(booking.start_date).toLocaleDateString()}: {conflicts.map((c) => c.name).join(", ")}
            </Text>
            <TouchableOpacity onPress={() => { onClose(); router.push(`/(app)/operations/capacity?date=${booking.start_date.slice(0, 10)}` as any); }} testID="booking-view-capacity">
              <Text style={styles.conflictLink}>View capacity →</Text>
            </TouchableOpacity>
          </View>
        ) : booking.items.length > 0 ? (
          <View style={styles.okBanner}>
            <Text style={styles.okText}>No shortages for this date.</Text>
          </View>
        ) : null}

        <SectionLabel>Equipment requested ({booking.items.length})</SectionLabel>
        {booking.items.length === 0 ? (
          <Text style={[typo.bodySmall, { marginBottom: spacing.md }]}>No equipment specified on this booking.</Text>
        ) : (
          <View style={styles.lineWrap}>
            {booking.items.map((l) => (
              <Row key={l.equipment_id} style={styles.lineRow}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body}>{l.name}</Text>
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{l.sku}</Mono>
                </View>
                <Mono style={{ fontSize: 15 }}>{l.qty}</Mono>
              </Row>
            ))}
          </View>
        )}

        {booking.notes ? (
          <>
            <View style={{ height: spacing.md }} />
            <SectionLabel>Notes</SectionLabel>
            <Text style={typo.body}>{booking.notes}</Text>
          </>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Button title="Delete booking" onPress={() => setConfirmDelete(true)} variant="danger" testID="drawer-delete-booking" />
      </DetailDrawer>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete this booking?"
        message={`This removes ${booking.customer_name}'s booking. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
        testID="delete-booking-confirm"
      />
    </>
  );
};

const styles = StyleSheet.create({
  lineWrap: { borderTopWidth: 1, borderTopColor: colors.border },
  lineRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  conflictBanner: { backgroundColor: colors.errorSoft, borderWidth: 1, borderColor: colors.error, borderRadius: radii.md, padding: spacing.sm, marginBottom: spacing.md },
  conflictText: { color: colors.error, fontSize: 12.5, fontWeight: "600" },
  conflictLink: { color: colors.error, fontSize: 12, fontWeight: "700", marginTop: 4, textDecorationLine: "underline" },
  okBanner: { backgroundColor: colors.successSoft, borderWidth: 1, borderColor: colors.success, borderRadius: radii.md, padding: spacing.sm, marginBottom: spacing.md },
  okText: { color: colors.success, fontSize: 12.5, fontWeight: "600" },
});

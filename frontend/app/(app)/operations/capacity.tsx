// Standalone Capacity workspace — demand vs. supply for a selected date.
// Rented/Booked are computed client-side (mirroring the backend's
// /bookings/capacity logic) so the table can show them as separate columns;
// the backend endpoint only returns a combined "committed" figure.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Input, Button, Mono } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { EmptyState } from "@/src/components/feedback/EmptyState";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo } from "@/src/theme";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { computeCapacity, CapacityRow, CapEquipment, CapRental, CapBooking } from "@/src/features/capacity/computeCapacity";

export default function CapacityScreen() {
  const params = useLocalSearchParams<{ date?: string }>();
  const { isShellWide } = useBreakpoint();
  const [date, setDate] = useState(params.date || new Date().toISOString().slice(0, 10));
  const [equipment, setEquipment] = useState<CapEquipment[]>([]);
  const [rentals, setRentals] = useState<CapRental[]>([]);
  const [bookings, setBookings] = useState<CapBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, r, b] = await Promise.all([
        api<CapEquipment[]>("/equipment"),
        api<CapRental[]>("/rentals"),
        api<CapBooking[]>("/bookings"),
      ]);
      setEquipment(e); setRentals(r); setBookings(b);
    } catch (err) { console.warn(err); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows: CapacityRow[] = useMemo(
    () => computeCapacity(equipment, rentals, bookings, date).sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.name.localeCompare(b.name)),
    [equipment, rentals, bookings, date],
  );

  const conflicts = rows.filter((r) => r.conflict);

  const columns: ColumnDef<CapacityRow>[] = [
    { key: "name", label: "Equipment", flex: 2, render: (r) => (
      <View>
        <Text style={typo.body} numberOfLines={1}>{r.name}</Text>
        <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{r.sku}</Mono>
      </View>
    ) },
    { key: "quantity", label: "Total", width: 70, align: "right", render: (r) => <Mono>{r.quantity}</Mono> },
    { key: "rented", label: "Rented", width: 80, align: "right", render: (r) => <Mono>{r.rented}</Mono> },
    { key: "booked", label: "Booked", width: 80, align: "right", render: (r) => <Mono>{r.booked}</Mono> },
    { key: "available", label: "Available", width: 90, align: "right", render: (r) => (
      <Mono style={{ color: r.available > 0 ? colors.success : colors.error, fontWeight: "700" }}>{r.available}</Mono>
    ) },
    { key: "conflict", label: "Status", width: 110, align: "right", render: (r) => (
      r.conflict ? <StatusBadge label="Conflict" tone="error" /> : <StatusBadge label="OK" tone="success" />
    ) },
  ];

  return (
    <Screen title="Capacity" subtitle={`Demand vs. supply · ${date}`} back scroll={false} testID="capacity-screen">
      <PageToolbar>
        <Input
          value={date}
          onChangeText={setDate}
          mono
          autoCapitalize="none"
          placeholder="yyyy-mm-dd"
          style={{ width: 160 }}
          testID="capacity-date"
        />
        <View style={{ width: 140 }}>
          <Button title="Refresh" onPress={async () => { setRefreshing(true); await load(); setRefreshing(false); }} variant="outline" loading={refreshing} testID="capacity-refresh" />
        </View>
      </PageToolbar>

      {conflicts.length > 0 ? (
        <View style={styles.conflictBanner} testID="capacity-conflict-banner">
          <Text style={styles.conflictText}>
            {conflicts.length} shortage{conflicts.length > 1 ? "s" : ""} on {date}: {conflicts.slice(0, 3).map((c) => c.name).join(", ")}{conflicts.length > 3 ? "…" : ""}
          </Text>
        </View>
      ) : null}

      <View style={{ flex: 1, paddingHorizontal: isShellWide ? spacing.xl : 0 }}>
        {!loading && rows.length === 0 ? (
          <EmptyState icon="bar-chart-outline" title="No equipment yet" subtitle="Add equipment to see capacity here." />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.equipment_id}
            rowTestID={(r) => `cap-row-${r.sku}`}
          />
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  conflictBanner: {
    marginHorizontal: spacing.lg, marginBottom: spacing.md,
    backgroundColor: colors.errorSoft, borderWidth: 1, borderColor: colors.error,
    borderRadius: 6, padding: spacing.sm,
  },
  conflictText: { color: colors.error, fontSize: 12.5, fontWeight: "600" },
});

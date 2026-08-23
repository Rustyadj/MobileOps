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
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";

type Equipment = { id: string; sku: string; qr_code?: string | null; name: string; category: string; quantity: number };
type Rental = { id: string; status: string; lines: { equipment_id: string; qty: number; returned_qty: number }[] };
type Booking = { id: string; status: string; start_date: string; end_date: string; items: { equipment_id: string; qty: number }[] };

type CapRow = {
  equipment_id: string; sku: string; qr_code?: string | null; name: string; category: string;
  quantity: number; rented: number; booked: number; available: number; conflict: boolean;
};

export default function CapacityScreen() {
  const params = useLocalSearchParams<{ date?: string }>();
  const { isShellWide } = useBreakpoint();
  const [date, setDate] = useState(params.date || new Date().toISOString().slice(0, 10));
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, r, b] = await Promise.all([
        api<Equipment[]>("/equipment"),
        api<Rental[]>("/rentals"),
        api<Booking[]>("/bookings"),
      ]);
      setEquipment(e); setRentals(r); setBookings(b);
    } catch (err) { console.warn(err); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows: CapRow[] = useMemo(() => {
    const rented: Record<string, number> = {};
    for (const r of rentals) {
      if (!["active", "partially_returned"].includes(r.status)) continue;
      for (const line of r.lines) {
        const rem = line.qty - line.returned_qty;
        if (rem > 0) rented[line.equipment_id] = (rented[line.equipment_id] || 0) + rem;
      }
    }
    const booked: Record<string, number> = {};
    const target = new Date(date + "T00:00:00");
    const dayOnly = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const targetDay = dayOnly(target);
    for (const b of bookings) {
      if (!["tentative", "confirmed"].includes(b.status)) continue;
      const sdDay = dayOnly(new Date(b.start_date));
      const edDay = dayOnly(new Date(b.end_date));
      if (sdDay <= targetDay && targetDay <= edDay) {
        for (const item of b.items) booked[item.equipment_id] = (booked[item.equipment_id] || 0) + item.qty;
      }
    }
    return equipment.map((e) => {
      const rq = rented[e.id] || 0;
      const bq = booked[e.id] || 0;
      const available = Math.max(e.quantity - rq - bq, 0);
      return {
        equipment_id: e.id, sku: e.sku, qr_code: e.qr_code, name: e.name, category: e.category,
        quantity: e.quantity, rented: rq, booked: bq, available,
        conflict: rq + bq > e.quantity,
      };
    }).sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.name.localeCompare(b.name));
  }, [equipment, rentals, bookings, date]);

  const conflicts = rows.filter((r) => r.conflict);

  const columns: ColumnDef<CapRow>[] = [
    { key: "name", label: "Equipment", flex: 2, render: (r) => (
      <View>
        <Text style={typo.body} numberOfLines={1}>{r.name}</Text>
        <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{equipmentIdentifier(r)}</Mono>
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

// Returns — flat queue of every outstanding rental line across active and
// partially-returned rentals, so a return can be processed without hunting
// through the full Rentals list first. Recording a return routes clean
// units to inspection and damaged units straight to a repair task.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { usePermissions } from "@/src/hooks/use-permissions";
import { api } from "@/src/api/client";
import { colors, radii, spacing, type as typo } from "@/src/theme";
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";

type Line = { equipment_id: string; sku: string; qr_code?: string | null; name: string; qty: number; delivered_qty: number; returned_qty: number; damaged_qty: number };
type Rental = { id: string; customer_name: string; job_site: string; start_date: string; status: string; lines: Line[] };
type OutstandingRow = { rental: Rental; line: Line; onSite: number };

const shortDate = (v?: string | null) => v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
const onSiteQty = (line: Line) => {
  const delivered = line.delivered_qty > 0 ? line.delivered_qty : line.qty;
  // returned_qty already counts every physically-returned unit, damaged or
  // not — damaged_qty is a subset marker, not an additional deduction.
  return Math.max(0, delivered - line.returned_qty);
};

export default function ReturnsScreen() {
  const router = useRouter();
  const { isShellWide } = useBreakpoint();
  const { canEdit } = usePermissions();
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<OutstandingRow | null>(null);
  const [qty, setQty] = useState("");
  const [damagedQty, setDamagedQty] = useState("0");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await api<Rental[]>("/rentals");
      setRentals(all.filter((r) => r.status === "active" || r.status === "partially_returned"));
    } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const rows = useMemo<OutstandingRow[]>(() => {
    const out: OutstandingRow[] = [];
    for (const rental of rentals) {
      for (const line of rental.lines) {
        const onSite = onSiteQty(line);
        if (onSite > 0) out.push({ rental, line, onSite });
      }
    }
    return out.sort((a, b) => a.rental.customer_name.localeCompare(b.rental.customer_name));
  }, [rentals]);

  const openReturn = (row: OutstandingRow) => { setSelected(row); setQty(String(row.onSite)); setDamagedQty("0"); };

  const submit = async () => {
    if (!selected) return;
    const parsedQty = Number.parseInt(qty, 10);
    const parsedDamaged = Number.parseInt(damagedQty || "0", 10);
    if (!Number.isInteger(parsedQty) || parsedQty <= 0 || parsedQty > selected.onSite) {
      Alert.alert("Invalid quantity", `Enter between 1 and ${selected.onSite}.`);
      return;
    }
    if (!Number.isInteger(parsedDamaged) || parsedDamaged < 0 || parsedDamaged > parsedQty) {
      Alert.alert("Invalid damaged quantity", "Damaged units must be between 0 and the return quantity.");
      return;
    }
    setSubmitting(true);
    try {
      await api(`/rentals/${selected.rental.id}/return`, {
        method: "POST",
        body: JSON.stringify([{ equipment_id: selected.line.equipment_id, qty: parsedQty, damaged_qty: parsedDamaged }]),
      });
      setSelected(null);
      load();
    } catch (e: any) { Alert.alert("Return failed", e.message); }
    finally { setSubmitting(false); }
  };

  const columns: ColumnDef<OutstandingRow>[] = [
    { key: "customer", label: "Customer", flex: 1.3, render: (r) => r.rental.customer_name },
    { key: "job_site", label: "Job Site", flex: 1.2, render: (r) => r.rental.job_site || "—" },
    { key: "equipment", label: "Equipment", flex: 1.3, render: (r) => r.line.name },
    { key: "qr_code", label: "QR Code", width: 130, render: (r) => <Mono style={{ fontSize: 12 }}>{equipmentIdentifier(r.line)}</Mono> },
    { key: "start_date", label: "Since", width: 96, render: (r) => shortDate(r.rental.start_date) },
    { key: "on_site", label: "On Site", width: 84, align: "right", render: (r) => <Mono style={{ fontSize: 13, fontWeight: "700" }}>{r.onSite}</Mono> },
  ];

  return (
    <Screen title="Returns" subtitle={`${rows.length} outstanding line${rows.length === 1 ? "" : "s"}`} back
      onRefresh={onRefresh} refreshing={refreshing} testID="returns-screen" scroll={!isShellWide}>
      {isShellWide ? (
        <View style={styles.tableWrap}>
          <DataTable columns={columns} rows={rows} keyExtractor={(r) => `${r.rental.id}-${r.line.equipment_id}`}
            rowTestID={(r) => `return-row-${r.rental.id}-${r.line.sku}`} onRowPress={openReturn}
            selectedId={selected ? `${selected.rental.id}-${selected.line.equipment_id}` : null}
            emptyLabel="Nothing outstanding — every active rental has been fully returned." />
        </View>
      ) : rows.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>Nothing outstanding.</Text></Card>
      ) : rows.map((r) => (
        <TouchableOpacity key={`${r.rental.id}-${r.line.equipment_id}`} onPress={() => openReturn(r)} testID={`return-row-${r.rental.id}-${r.line.sku}`}>
          <Card style={{ marginBottom: spacing.sm, flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <H3>{r.line.name}</H3>
              <Text style={[typo.label, { marginTop: 2 }]}>{r.rental.customer_name} · {r.rental.job_site || "No job site"} · since {shortDate(r.rental.start_date)}</Text>
            </View>
            <Mono style={{ fontSize: 16, fontWeight: "700" }}>{r.onSite}</Mono>
          </Card>
        </TouchableOpacity>
      ))}

      <DetailDrawer visible={!!selected} title={selected?.line.name || "Return"} subtitle={selected ? `${selected.rental.customer_name} · ${selected.onSite} on site` : undefined} onClose={() => setSelected(null)} testID="return-drawer">
        {selected ? (
          <View>
            <SectionLabel>Record return</SectionLabel>
            <Input label={`Quantity returning (max ${selected.onSite})`} value={qty} onChangeText={(v) => setQty(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono editable={canEdit} testID="return-qty" />
            <Input label="Of which damaged" value={damagedQty} onChangeText={(v) => setDamagedQty(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono editable={canEdit} testID="return-damaged-qty" />
            <Text style={[typo.bodySmall, { color: colors.inkMuted, marginBottom: spacing.md }]}>Clean units go to inspection; damaged units go straight to a repair task.</Text>
            {canEdit ? <Button title="Record Return" onPress={submit} loading={submitting} testID="submit-return" /> : null}
            <Button title="View Rental" variant="outline" onPress={() => router.push(`/(app)/operations/rentals?open=${selected.rental.id}` as any)} style={{ marginTop: spacing.sm }} testID="return-view-rental" />
          </View>
        ) : null}
      </DetailDrawer>
    </Screen>
  );
}

const styles = StyleSheet.create({
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, marginTop: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
});

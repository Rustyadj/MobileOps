// Rentals > Inbound. Everything coming back to the yard:
//   - scheduled pickups (inbound dispatches) arriving today / upcoming
//   - every outstanding rental line, with expected / returned / damaged /
//     remaining, so equipment can be received straight against the rental
// Returns live here. There is deliberately no separate "Returns" route in
// the sidebar — /operations/returns redirects to this tab.
import { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { SearchInput } from "@/src/components/data/SearchInput";
import { FilterChips } from "@/src/components/data/FilterBar";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { RentalTabs } from "@/src/components/rentals/RentalTabs";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { usePermissions } from "@/src/hooks/use-permissions";
import { useCachedResource } from "@/src/hooks/use-cached-resource";
import { mutate } from "@/src/sync/mutate";
import { api } from "@/src/api/client";
import { colors, radii, spacing, type as typo } from "@/src/theme";
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";
import { isRentalOpen, isDispatchLive } from "@/src/domain/status";

type Line = { equipment_id: string; sku: string; qr_code?: string | null; name: string; qty: number; delivered_qty: number; returned_qty: number; damaged_qty: number };
type Rental = { id: string; customer_name: string; job_site: string; start_date: string; due_date?: string | null; status: string; lines: Line[] };
type Dispatch = { id: string; direction: "outbound" | "inbound"; status: string; scheduled_date?: string | null; customer_name: string; job_site: string; rental_id?: string | null };

type Row = {
  key: string;
  rental: Rental;
  line: Line;
  /** delivered to the job — what we expect back */
  expected: number;
  returned: number;
  damaged: number;
  /** still on site */
  remaining: number;
  dueDate: string | null;
};

const DAY_MS = 86_400_000;
const shortDate = (v?: string | null) => v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const TIMING_FILTERS = [
  { key: "all", label: "All outstanding" },
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due today" },
  { key: "week", label: "Next 7 days" },
  { key: "partial", label: "Partial returns" },
];

// expected == what physically left the yard for this line. delivered_qty is
// authoritative once a dispatch has run; ordered qty is the fallback for
// rentals written by hand.
const expectedQty = (line: Line) => (line.delivered_qty > 0 ? line.delivered_qty : line.qty);

export default function InboundScreen() {
  const router = useRouter();
  const { isShellWide } = useBreakpoint();
  const { canEdit } = usePermissions();
  const rentalsRes = useCachedResource<Rental>("rentals", () => api<Rental[]>("/rentals"));
  const dispatchesRes = useCachedResource<Dispatch>("dispatches", () => api<Dispatch[]>("/dispatches").catch(() => []));

  const [search, setSearch] = useState("");
  const [timing, setTiming] = useState("all");
  const [qty, setQty] = useState("");
  const [damagedQty, setDamagedQty] = useState("0");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const openRentals = useMemo(() => rentalsRes.data.filter((r) => isRentalOpen(r.status)), [rentalsRes.data]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const rental of openRentals) {
      for (const line of rental.lines) {
        const expected = expectedQty(line);
        // returned_qty already counts every physically-returned unit, damaged
        // or not — damaged_qty is a subset marker, not an extra deduction.
        const remaining = Math.max(0, expected - line.returned_qty);
        if (remaining <= 0) continue;
        out.push({
          key: `${rental.id}-${line.equipment_id}`,
          rental, line, expected,
          returned: line.returned_qty,
          damaged: line.damaged_qty,
          remaining,
          dueDate: rental.due_date || null,
        });
      }
    }
    return out;
  }, [openRentals]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const today = startOfDay(new Date());
    return rows.filter((row) => {
      if (timing === "partial" && row.returned === 0) return false;
      if (timing === "overdue" || timing === "today" || timing === "week") {
        if (!row.dueDate) return false;
        const due = startOfDay(new Date(row.dueDate));
        if (timing === "overdue" && due >= today) return false;
        if (timing === "today" && due !== today) return false;
        if (timing === "week" && (due < today || due > today + 7 * DAY_MS)) return false;
      }
      if (!query) return true;
      return [row.rental.customer_name, row.rental.job_site, row.rental.id, row.line.name, row.line.qr_code, row.line.sku]
        .some((value) => value?.toLowerCase().includes(query));
    }).sort((a, b) => {
      const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      return aDue - bDue || a.rental.customer_name.localeCompare(b.rental.customer_name);
    });
  }, [rows, search, timing]);

  // Pickups on their way in — the trucks side of Inbound.
  const arrivals = useMemo(() => dispatchesRes.data
    .filter((d) => d.direction === "inbound" && isDispatchLive(d.status))
    .sort((a, b) => (a.scheduled_date || "").localeCompare(b.scheduled_date || "")), [dispatchesRes.data]);

  const selected = filtered.find((r) => r.key === selectedKey) || rows.find((r) => r.key === selectedKey) || null;
  const openReceive = (row: Row) => { setSelectedKey(row.key); setQty(String(row.remaining)); setDamagedQty("0"); };

  const overdueCount = useMemo(() => {
    const today = startOfDay(new Date());
    return rows.filter((r) => r.dueDate && startOfDay(new Date(r.dueDate)) < today).length;
  }, [rows]);

  // Queues offline — same optimistic shape as operations/rentals.tsx's
  // submitReturn; both write through the one /rentals/{id}/return command so
  // the inventory ledger stays the single authority for bucket moves.
  const submit = () => {
    if (!selected) return;
    const parsedQty = Number.parseInt(qty, 10);
    const parsedDamaged = Number.parseInt(damagedQty || "0", 10);
    if (!Number.isInteger(parsedQty) || parsedQty <= 0 || parsedQty > selected.remaining) {
      Alert.alert("Invalid quantity", `Enter between 1 and ${selected.remaining}.`);
      return;
    }
    if (!Number.isInteger(parsedDamaged) || parsedDamaged < 0 || parsedDamaged > parsedQty) {
      Alert.alert("Invalid damaged quantity", "Damaged units must be between 0 and the return quantity.");
      return;
    }
    const rental = selected.rental;
    const nextLines = rental.lines.map((l) =>
      l.equipment_id === selected.line.equipment_id
        ? { ...l, returned_qty: l.returned_qty + parsedQty, damaged_qty: l.damaged_qty + parsedDamaged }
        : l,
    );
    const allReturned = nextLines.every((l) => l.returned_qty >= expectedQty(l));
    const anyReturned = nextLines.some((l) => l.returned_qty > 0);
    mutate<Rental>({
      kind: "command",
      entityType: "rentals",
      entityId: rental.id,
      path: `/rentals/${rental.id}/return`,
      method: "POST",
      body: [{ equipment_id: selected.line.equipment_id, qty: parsedQty, damaged_qty: parsedDamaged }],
      optimisticPatch: {
        lines: nextLines,
        status: allReturned ? "returned" : anyReturned ? "partially_returned" : "active",
      },
    });
    setSelectedKey(null);
  };

  const columns: ColumnDef<Row>[] = [
    { key: "customer", label: "Customer", flex: 1.2, render: (r) => r.rental.customer_name },
    { key: "job_site", label: "Job Site", flex: 1.1, render: (r) => r.rental.job_site || "—" },
    { key: "equipment", label: "Equipment", flex: 1.3, render: (r) => (
      <View>
        <Text style={typo.body} numberOfLines={1}>{r.line.name}</Text>
        <Mono style={styles.subMono}>{equipmentIdentifier(r.line)}</Mono>
      </View>
    ) },
    { key: "due", label: "Due", width: 92, render: (r) => <Text style={[typo.bodySmall, r.dueDate && startOfDay(new Date(r.dueDate)) < startOfDay(new Date()) ? styles.overdue : null]}>{shortDate(r.dueDate)}</Text> },
    { key: "expected", label: "Expected", width: 84, align: "right", render: (r) => <Mono style={styles.qty}>{r.expected}</Mono> },
    { key: "returned", label: "Returned", width: 84, align: "right", render: (r) => <Mono style={styles.qty}>{r.returned}</Mono> },
    { key: "damaged", label: "Damaged", width: 84, align: "right", render: (r) => <Mono style={[styles.qty, r.damaged > 0 ? styles.damaged : null]}>{r.damaged}</Mono> },
    { key: "remaining", label: "Remaining", width: 92, align: "right", render: (r) => <Mono style={[styles.qty, styles.remaining]}>{r.remaining}</Mono> },
  ];

  const onRefresh = () => { rentalsRes.onRefresh(); dispatchesRes.onRefresh(); };

  return (
    <Screen
      title="Rentals"
      subtitle={`${filtered.length} line${filtered.length === 1 ? "" : "s"} to receive${overdueCount ? ` · ${overdueCount} overdue` : ""}`}
      tabs={<RentalTabs active="inbound" counts={{ inbound: rows.length }} />}
      onRefresh={onRefresh}
      refreshing={rentalsRes.refreshing || dispatchesRes.refreshing}
      testID="inbound-screen"
      scroll={!isShellWide}
    >
      <View style={isShellWide ? styles.desktopWorkspace : undefined}>
        {arrivals.length ? (
          <View style={isShellWide ? styles.gutter : undefined}>
            <SectionLabel>Pickups en route ({arrivals.length})</SectionLabel>
            <View style={styles.arrivalRow}>
              {arrivals.slice(0, 6).map((d) => (
                <TouchableOpacity key={d.id} onPress={() => router.push(`/(app)/operations/dispatch?open=${d.id}` as any)} testID={`inbound-arrival-${d.id}`}>
                  <View style={styles.arrivalCard}>
                    <Text style={styles.arrivalCustomer} numberOfLines={1}>{d.customer_name}</Text>
                    <Text style={styles.arrivalSite} numberOfLines={1}>{d.job_site || "No job site"}</Text>
                    <View style={styles.arrivalMeta}>
                      <StatusBadge label={d.status} />
                      <Text style={styles.arrivalDate}>{shortDate(d.scheduled_date)}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        <PageToolbar>
          <SearchInput value={search} onChangeText={setSearch} placeholder="Search customer, job site, equipment, QR…" testID="inbound-search" style={{ flex: 1, maxWidth: 420 }} />
        </PageToolbar>
        <View style={isShellWide ? styles.gutter : { marginBottom: spacing.sm }}>
          <FilterChips options={TIMING_FILTERS} value={timing} onChange={setTiming} testIDPrefix="inbound-timing" />
        </View>

        {isShellWide ? (
          <View style={styles.tableWrap}>
            <DataTable columns={columns} rows={filtered} keyExtractor={(r) => r.key}
              rowTestID={(r) => `inbound-row-${r.rental.id}-${r.line.sku}`} onRowPress={openReceive}
              selectedId={selected?.key ?? null}
              emptyLabel="Nothing outstanding — every active rental has been fully returned." />
          </View>
        ) : filtered.length === 0 ? (
          <Card><Text style={[typo.body, { color: colors.inkMuted }]}>Nothing outstanding.</Text></Card>
        ) : filtered.map((r) => (
          <TouchableOpacity key={r.key} onPress={() => openReceive(r)} testID={`inbound-row-${r.rental.id}-${r.line.sku}`}>
            <Card style={{ marginBottom: spacing.sm }}>
              <View style={styles.mobileTop}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <H3>{r.line.name}</H3>
                  <Text style={[typo.label, { marginTop: 2 }]} numberOfLines={1}>{r.rental.customer_name} · {r.rental.job_site || "No job site"}</Text>
                  <Mono style={styles.subMono}>{equipmentIdentifier(r.line)} · due {shortDate(r.dueDate)}</Mono>
                </View>
                <View style={styles.remainingBlock}>
                  <Mono style={styles.remainingBig}>{r.remaining}</Mono>
                  <Text style={styles.remainingCaption}>remaining</Text>
                </View>
              </View>
              <View style={styles.mobileCounts}>
                <Count label="Expected" value={r.expected} />
                <Count label="Returned" value={r.returned} />
                <Count label="Damaged" value={r.damaged} tone={r.damaged > 0 ? colors.error : undefined} />
              </View>
            </Card>
          </TouchableOpacity>
        ))}
      </View>

      <DetailDrawer visible={!!selected} title={selected?.line.name || "Receive"}
        subtitle={selected ? `${selected.rental.customer_name} · ${selected.remaining} still on site` : undefined}
        onClose={() => setSelectedKey(null)} testID="inbound-receive-drawer">
        {selected ? (
          <View>
            <View style={styles.drawerCounts}>
              <Count label="Expected" value={selected.expected} />
              <Count label="Returned" value={selected.returned} />
              <Count label="Damaged" value={selected.damaged} tone={selected.damaged > 0 ? colors.error : undefined} />
              <Count label="Remaining" value={selected.remaining} tone={colors.primary} />
            </View>
            <SectionLabel>Receive against this rental</SectionLabel>
            <Input label={`Quantity returning (max ${selected.remaining})`} value={qty} onChangeText={(v) => setQty(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono editable={canEdit} testID="return-qty" />
            <Input label="Of which damaged" value={damagedQty} onChangeText={(v) => setDamagedQty(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" mono editable={canEdit} testID="return-damaged-qty" />
            <Text style={[typo.bodySmall, { color: colors.inkMuted, marginBottom: spacing.md }]}>Clean units go to inspection; damaged units go straight to a repair task. Availability updates once inspection passes.</Text>
            {canEdit ? <Button title="Record Return" onPress={submit} testID="submit-return" /> : null}
            <Button title="View Rental" variant="outline" onPress={() => router.push(`/(app)/operations/rentals?open=${selected.rental.id}` as any)} style={{ marginTop: spacing.sm }} testID="return-view-rental" />
          </View>
        ) : null}
      </DetailDrawer>
    </Screen>
  );
}

const Count: React.FC<{ label: string; value: number; tone?: string }> = ({ label, value, tone }) => (
  <View style={styles.count}>
    <Mono style={[styles.countValue, tone ? { color: tone } : null]}>{value}</Mono>
    <Text style={styles.countLabel}>{label}</Text>
  </View>
);

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg },
  gutter: { paddingHorizontal: spacing.xl },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, marginBottom: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", backgroundColor: colors.bg },
  subMono: { fontSize: 11.5, color: colors.inkMuted, marginTop: 2 },
  qty: { fontSize: 13, fontWeight: "600" },
  remaining: { fontWeight: "800", color: colors.primary },
  damaged: { color: colors.error, fontWeight: "800" },
  overdue: { color: colors.error, fontWeight: "700" },
  arrivalRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md },
  arrivalCard: { minWidth: 190, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.sm, backgroundColor: colors.bg, gap: 3 },
  arrivalCustomer: { ...typo.body, fontSize: 13.5, fontWeight: "700" },
  arrivalSite: { ...typo.bodySmall, fontSize: 11.5 },
  arrivalMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4, gap: spacing.sm },
  arrivalDate: { ...typo.bodySmall, fontSize: 11.5, fontWeight: "700" },
  mobileTop: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  mobileCounts: { flexDirection: "row", gap: spacing.lg, marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  drawerCounts: { flexDirection: "row", flexWrap: "wrap", gap: spacing.lg, marginBottom: spacing.md },
  remainingBlock: { alignItems: "flex-end" },
  remainingBig: { fontSize: 24, fontWeight: "800", color: colors.primary },
  remainingCaption: { ...typo.caption, fontSize: 9.5 },
  count: { minWidth: 62 },
  countValue: { fontSize: 16, fontWeight: "700" },
  countLabel: { ...typo.caption, fontSize: 9.5, marginTop: 1 },
});

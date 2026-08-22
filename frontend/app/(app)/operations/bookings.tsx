// Bookings — scheduling/planning tool: List (table) and Week views, with a
// live capacity conflict flag per booking instead of a disconnected tab.
// Booking editing isn't supported by the backend (create + delete only).
import { useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card, Mono, Row, H3, Button } from "@/src/components/ui";
import { PageHeader } from "@/src/components/layout/PageHeader";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { PageBody } from "@/src/components/layout/PageBody";
import { SearchInput } from "@/src/components/data/SearchInput";
import { FilterChips } from "@/src/components/data/FilterBar";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { EmptyState } from "@/src/components/feedback/EmptyState";
import { LoadingState } from "@/src/components/feedback/LoadingState";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useBookings, Booking } from "@/src/features/bookings/useBookings";
import { BookingDetailDrawer } from "@/src/features/bookings/BookingDetailDrawer";
import { BookingForm } from "@/src/features/bookings/BookingForm";
import { computeCapacity } from "@/src/features/capacity/computeCapacity";
import { colors, spacing, type as typo } from "@/src/theme";

type StatusFilter = "all" | "tentative" | "confirmed" | "cancelled";
const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "tentative", label: "Tentative" },
  { key: "confirmed", label: "Confirmed" },
  { key: "cancelled", label: "Cancelled" },
];

export default function BookingsScreen() {
  const { isShellWide } = useBreakpoint();
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const { bookings, equipment, rentals, loading, refreshing, load, refresh, save, del } = useBookings();

  const [view, setView] = useState<"list" | "week">("list");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (params.open) setSelectedId(String(params.open));
    if (params.new === "1") newBooking();
  }, [params.open, params.new]);

  const newBooking = () => {
    const now = new Date();
    const end = new Date(now.getTime() + 3 * 86400000);
    setDraft({ customer_name: "", job_site: "", start_date: now.toISOString(), end_date: end.toISOString(), status: "tentative", items: [], notes: "" });
    setFormOpen(true);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bookings.filter((b) => {
      if (q && !b.customer_name.toLowerCase().includes(q) && !b.job_site.toLowerCase().includes(q)) return false;
      if (statusFilter !== "all") return b.status === statusFilter;
      return true;
    });
  }, [bookings, statusFilter, search]);

  const hasConflict = (b: Booking) => {
    if (b.items.length === 0 || b.status === "cancelled") return false;
    const rows = computeCapacity(equipment, rentals, [b], b.start_date.slice(0, 10));
    return rows.some((r) => r.conflict && b.items.some((i) => i.equipment_id === r.equipment_id));
  };

  const selected = bookings.find((b) => b.id === selectedId) || null;

  const columns: ColumnDef<Booking>[] = [
    { key: "customer", label: "Customer", flex: 2, render: (b) => (
      <View>
        <Text style={typo.body} numberOfLines={1}>{b.customer_name}</Text>
        <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{b.job_site || "—"}</Text>
      </View>
    ) },
    { key: "dates", label: "Dates", width: 190, render: (b) => <Mono style={{ fontSize: 12 }}>{new Date(b.start_date).toLocaleDateString()} → {new Date(b.end_date).toLocaleDateString()}</Mono> },
    { key: "demand", label: "Equipment", width: 90, align: "right", render: (b) => <Mono>{b.items.reduce((s, i) => s + i.qty, 0)}</Mono> },
    { key: "conflict", label: "Capacity", width: 100, align: "center", render: (b) => hasConflict(b) ? <Ionicons name="warning" size={16} color={colors.error} /> : <Ionicons name="checkmark-circle-outline" size={16} color={colors.inkMuted} /> },
    { key: "status", label: "Status", width: 110, align: "right", render: (b) => <StatusBadge label={b.status} /> },
  ];

  if (loading) {
    return <Screen title="Bookings" back testID="bookings-screen"><LoadingState label="Loading bookings…" /></Screen>;
  }

  const desktopHeader = (
    <PageHeader
      title="Bookings"
      subtitle={`${bookings.length} total`}
      actions={<Button title="+ New Booking" onPress={newBooking} testID="new-booking-btn" fullWidth={false} style={{ backgroundColor: colors.accent, borderColor: colors.accent, height: 38, paddingHorizontal: 16 }} />}
    />
  );

  return (
    <Screen
      title="Bookings"
      subtitle={`${bookings.length} total`}
      back
      rightAction={{ icon: "add", onPress: newBooking, testID: "new-booking-btn" }}
      onRefresh={refresh}
      refreshing={refreshing}
      scroll={isShellWide && view === "list" ? false : true}
      desktopHeader={desktopHeader}
      testID="bookings-screen"
    >
      <PageToolbar>
        <FilterChips options={[{ key: "list", label: "List" }, { key: "week", label: "Week" }]} value={view} onChange={(k) => setView(k as any)} testIDPrefix="bookings-view" />
        {view === "list" ? (
          <>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search customer or job site…" testID="bookings-search" />
            <FilterChips options={STATUS_FILTERS} value={statusFilter} onChange={(k) => setStatusFilter(k as StatusFilter)} testIDPrefix="bookings-status" />
          </>
        ) : null}
      </PageToolbar>

      {view === "week" ? (
        <WeekView bookings={bookings} weekStart={weekStart} onPrev={() => setWeekStart(addDays(weekStart, -7))} onNext={() => setWeekStart(addDays(weekStart, 7))} onSelect={(b) => setSelectedId(b.id)} />
      ) : filtered.length === 0 ? (
        <EmptyState icon="calendar-outline" title="No bookings match" subtitle={bookings.length === 0 ? "Create your first booking to get started." : "Try a different filter or search."} actionLabel={bookings.length === 0 ? "New Booking" : undefined} onAction={bookings.length === 0 ? newBooking : undefined} testID="bookings-empty" />
      ) : isShellWide ? (
        <View style={{ flex: 1, paddingHorizontal: spacing.xl }}>
          <DataTable columns={columns} rows={filtered} keyExtractor={(b) => b.id} onRowPress={(b) => setSelectedId(b.id)} rowTestID={(b) => `booking-row-${b.id}`} selectedId={selectedId} />
        </View>
      ) : (
        <PageBody scroll={false} testID="bookings-list">
          {filtered.map((b) => (
            <TouchableOpacity key={b.id} onPress={() => setSelectedId(b.id)} activeOpacity={0.7} testID={`booking-${b.id}`}>
              <Card style={{ marginBottom: spacing.sm }}>
                <Row style={{ justifyContent: "space-between" }}>
                  <View style={{ flex: 1 }}>
                    <H3>{b.customer_name}</H3>
                    <Text style={[typo.label, { marginTop: 2 }]}>{b.job_site || "—"}</Text>
                  </View>
                  <StatusBadge label={b.status} />
                </Row>
                <Row style={{ marginTop: 8, gap: spacing.md }}>
                  <Mono style={{ fontSize: 12 }}>{new Date(b.start_date).toLocaleDateString()} → {new Date(b.end_date).toLocaleDateString()}</Mono>
                  {hasConflict(b) ? <Row style={{ gap: 4 }}><Ionicons name="warning" size={13} color={colors.error} /><Text style={{ color: colors.error, fontSize: 11, fontWeight: "700" }}>Shortage</Text></Row> : null}
                </Row>
              </Card>
            </TouchableOpacity>
          ))}
        </PageBody>
      )}

      <BookingDetailDrawer booking={selected} equipment={equipment} rentals={rentals} onClose={() => { setSelectedId(null); if (params.open) router.setParams({ open: undefined }); }} onDelete={del} />

      <BookingForm
        visible={formOpen}
        draft={draft}
        setDraft={setDraft}
        equipment={equipment}
        onClose={() => { setFormOpen(false); setDraft(null); if (params.new) router.setParams({ new: undefined }); }}
        onSave={async () => { await save(draft); setFormOpen(false); setDraft(null); }}
      />
    </Screen>
  );
}

function startOfWeek(d: Date) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d: Date, n: number) {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}

const WeekView: React.FC<{
  bookings: Booking[];
  weekStart: Date;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (b: Booking) => void;
}> = ({ bookings, weekStart, onPrev, onNext, onSelect }) => {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekEnd = days[6];

  const bookingsForDay = (day: Date) => bookings.filter((b) => {
    if (b.status === "cancelled") return false;
    const sd = new Date(new Date(b.start_date).toDateString());
    const ed = new Date(new Date(b.end_date).toDateString());
    const d = new Date(day.toDateString());
    return sd <= d && d <= ed;
  });

  return (
    <View style={{ flex: 1, paddingHorizontal: spacing.lg }}>
      <Row style={{ justifyContent: "space-between", marginBottom: spacing.md }}>
        <TouchableOpacity onPress={onPrev} testID="week-prev"><Ionicons name="chevron-back-circle-outline" size={26} color={colors.primary} /></TouchableOpacity>
        <Text style={typo.h3}>{weekStart.toLocaleDateString()} – {weekEnd.toLocaleDateString()}</Text>
        <TouchableOpacity onPress={onNext} testID="week-next"><Ionicons name="chevron-forward-circle-outline" size={26} color={colors.primary} /></TouchableOpacity>
      </Row>
      {days.map((day) => {
        const dayBookings = bookingsForDay(day);
        return (
          <View key={day.toISOString()} style={{ marginBottom: spacing.md }}>
            <Text style={typo.label}>{day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</Text>
            {dayBookings.length === 0 ? (
              <Text style={[typo.caption, { textTransform: "none", letterSpacing: 0, marginTop: 4 }]}>—</Text>
            ) : (
              dayBookings.map((b) => (
                <TouchableOpacity key={b.id} onPress={() => onSelect(b)} style={{ marginTop: 6 }} testID={`week-booking-${b.id}`}>
                  <Card style={{ paddingVertical: 8, paddingHorizontal: 12 }}>
                    <Row style={{ justifyContent: "space-between" }}>
                      <Text style={typo.body} numberOfLines={1}>{b.customer_name} · {b.job_site || "—"}</Text>
                      <StatusBadge label={b.status} />
                    </Row>
                  </Card>
                </TouchableOpacity>
              ))
            )}
          </View>
        );
      })}
    </View>
  );
};

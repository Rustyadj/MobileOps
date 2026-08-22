// Rentals — master/detail on tablet/desktop (DataTable + DetailDrawer),
// cards on phone. Deep-linkable via ?open=<id> (dashboard/search/command
// menu land here) and ?new=1 (global +New action).
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
import { useRentals, Rental } from "@/src/features/rentals/useRentals";
import { RentalDetailDrawer } from "@/src/features/rentals/RentalDetailDrawer";
import { RentalForm } from "@/src/features/rentals/RentalForm";
import { LocationPicker } from "@/src/components/MapCanvas";
import { colors, spacing, type as typo } from "@/src/theme";

type FilterKey = "all" | "active" | "returned" | "upcoming" | "missing-location";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "upcoming", label: "Upcoming" },
  { key: "missing-location", label: "Location missing" },
  { key: "returned", label: "Returned" },
];

export default function RentalsScreen() {
  const { isShellWide } = useBreakpoint();
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const { rentals, equipment, loading, refreshing, load, refresh, save, del, doReturn, patchLocation, generatePDF } = useRentals();

  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>(null);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (params.open) setSelectedId(String(params.open));
    if (params.new === "1") newRental();
  }, [params.open, params.new]);

  const newRental = () => {
    const now = new Date();
    setDraft({ customer_name: "", customer_phone: "", customer_email: "", job_site: "", start_date: now.toISOString(), deposit: 0, notes: "", lines: [] });
    setFormOpen(true);
  };

  const editRental = (r: Rental) => {
    setSelectedId(null);
    setDraft({
      id: r.id, customer_name: r.customer_name, customer_phone: r.customer_phone, customer_email: r.customer_email,
      job_site: r.job_site, start_date: r.start_date, deposit: r.deposit, notes: r.notes,
      lines: r.lines.map((l) => ({ ...l })), lat: r.lat, lng: r.lng,
    });
    setFormOpen(true);
  };

  const [locationTarget, setLocationTarget] = useState<Rental | null>(null);

  const filtered = useMemo(() => {
    const now = new Date();
    const q = search.trim().toLowerCase();
    return rentals.filter((r) => {
      if (q && !r.customer_name.toLowerCase().includes(q) && !r.job_site.toLowerCase().includes(q)) return false;
      if (filter === "active") return r.status === "active" || r.status === "partially_returned";
      if (filter === "returned") return r.status === "returned";
      if (filter === "upcoming") return r.status !== "returned" && new Date(r.start_date) > now;
      if (filter === "missing-location") return r.status !== "returned" && (r.lat == null || r.lng == null);
      return true;
    });
  }, [rentals, filter, search]);

  const selected = rentals.find((r) => r.id === selectedId) || null;

  const columns: ColumnDef<Rental>[] = [
    { key: "customer", label: "Customer", flex: 2, render: (r) => (
      <View>
        <Text style={typo.body} numberOfLines={1}>{r.customer_name}</Text>
        <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{r.job_site || "—"}</Text>
      </View>
    ) },
    { key: "start", label: "Start", width: 100, render: (r) => <Mono style={{ fontSize: 12.5 }}>{new Date(r.start_date).toLocaleDateString()}</Mono> },
    { key: "items", label: "Returned/Total", width: 120, align: "right", render: (r) => {
      const total = r.lines.reduce((s, l) => s + l.qty, 0);
      const returned = r.lines.reduce((s, l) => s + l.returned_qty, 0);
      return <Mono>{returned}/{total}</Mono>;
    } },
    { key: "location", label: "Location", width: 90, align: "center", render: (r) => (
      r.lat != null && r.lng != null
        ? <Ionicons name="location" size={16} color={colors.primary} />
        : <Ionicons name="location-outline" size={16} color={colors.inkMuted} />
    ) },
    { key: "status", label: "Status", width: 120, align: "right", render: (r) => <StatusBadge label={r.status} /> },
  ];

  if (loading) {
    return (
      <Screen title="Rentals" back testID="rentals-screen">
        <LoadingState label="Loading rentals…" />
      </Screen>
    );
  }

  const desktopHeader = (
    <PageHeader
      title="Rentals"
      subtitle={`${rentals.length} total · ${rentals.filter((r) => r.status === "active").length} active`}
      actions={<Button title="+ New Rental" onPress={newRental} testID="new-rental-btn" fullWidth={false} style={{ backgroundColor: colors.accent, borderColor: colors.accent, height: 38, paddingHorizontal: 16 }} />}
    />
  );

  return (
    <Screen
      title="Rentals"
      subtitle={`${rentals.length} total · ${rentals.filter((r) => r.status === "active").length} active`}
      back
      rightAction={{ icon: "add", onPress: newRental, testID: "new-rental-btn" }}
      onRefresh={refresh}
      refreshing={refreshing}
      scroll={isShellWide ? false : true}
      desktopHeader={desktopHeader}
      testID="rentals-screen"
    >
      <PageToolbar>
        <SearchInput value={search} onChangeText={setSearch} placeholder="Search customer or job site…" testID="rentals-search" />
        <FilterChips options={FILTERS} value={filter} onChange={(k) => setFilter(k as FilterKey)} testIDPrefix="rentals-filter" />
      </PageToolbar>

      {filtered.length === 0 ? (
        <EmptyState icon="receipt-outline" title="No rentals match" subtitle={rentals.length === 0 ? "Create your first rental to get started." : "Try a different filter or search."} actionLabel={rentals.length === 0 ? "New Rental" : undefined} onAction={rentals.length === 0 ? newRental : undefined} testID="rentals-empty" />
      ) : isShellWide ? (
        <View style={{ flex: 1, paddingHorizontal: spacing.xl }}>
          <DataTable
            columns={columns}
            rows={filtered}
            keyExtractor={(r) => r.id}
            onRowPress={(r) => setSelectedId(r.id)}
            rowTestID={(r) => `rental-row-${r.id}`}
            selectedId={selectedId}
          />
        </View>
      ) : (
        <PageBody scroll={false} testID="rentals-list">
          {filtered.map((r) => {
            const total = r.lines.reduce((s, l) => s + l.qty, 0);
            const returned = r.lines.reduce((s, l) => s + l.returned_qty, 0);
            return (
              <TouchableOpacity key={r.id} onPress={() => setSelectedId(r.id)} activeOpacity={0.7} testID={`rental-${r.id}`}>
                <Card style={{ marginBottom: spacing.sm }}>
                  <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                    <View style={{ flex: 1 }}>
                      <H3>{r.customer_name}</H3>
                      <Text style={[typo.bodySmall, { marginTop: 2 }]}>{r.job_site || "—"}</Text>
                    </View>
                    <StatusBadge label={r.status} />
                  </Row>
                  <Row style={{ marginTop: spacing.sm, gap: spacing.md, flexWrap: "wrap" }}>
                    <Text style={typo.label}>Start <Mono style={{ fontSize: 13 }}>{new Date(r.start_date).toLocaleDateString()}</Mono></Text>
                    <Text style={typo.label}>Items <Mono style={{ fontSize: 13 }}>{returned}/{total}</Mono></Text>
                    {r.lat != null && r.lng != null ? (
                      <Row style={{ gap: 4 }}><Ionicons name="location" size={12} color={colors.primary} /><Text style={typo.caption}>Located</Text></Row>
                    ) : (
                      <Row style={{ gap: 4 }}><Ionicons name="location-outline" size={12} color={colors.inkMuted} /><Text style={[typo.caption, { textTransform: "none", letterSpacing: 0 }]}>No location</Text></Row>
                    )}
                  </Row>
                </Card>
              </TouchableOpacity>
            );
          })}
        </PageBody>
      )}

      <RentalDetailDrawer
        rental={selected}
        onClose={() => { setSelectedId(null); if (params.open) router.setParams({ open: undefined }); }}
        onEdit={editRental}
        onDelete={del}
        onReturn={doReturn}
        onSetLocation={(r) => setLocationTarget(r)}
        onGeneratePDF={generatePDF}
      />

      <RentalForm
        visible={formOpen}
        draft={draft}
        setDraft={setDraft}
        equipment={equipment}
        onClose={() => { setFormOpen(false); setDraft(null); if (params.new) router.setParams({ new: undefined }); }}
        onSave={async () => { await save(draft); setFormOpen(false); setDraft(null); }}
      />

      <LocationPicker
        visible={!!locationTarget}
        initial={locationTarget?.lat != null && locationTarget?.lng != null ? { lat: locationTarget.lat, lng: locationTarget.lng } : null}
        onClose={() => setLocationTarget(null)}
        onSave={async (coords) => { if (locationTarget) { await patchLocation(locationTarget.id, coords); setLocationTarget(null); } }}
      />
    </Screen>
  );
}

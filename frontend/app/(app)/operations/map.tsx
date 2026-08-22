// Map workspace — first-class desktop split layout: map (primary) + a
// filterable, selectable list of job-site locations (secondary). Selecting
// a pin or a list row shows the same quick-view, keeping map and list in
// sync. Phone keeps a full-screen map with a draggable bottom sheet.
import { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { FilterChips } from "@/src/components/data/FilterBar";
import { SplitPane } from "@/src/components/layout/SplitPane";
import { LoadingState } from "@/src/components/feedback/LoadingState";
import { MapCanvas, Pin } from "@/src/components/MapCanvas";
import { useRentals, Rental } from "@/src/features/rentals/useRentals";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, spacing, type as typo, radii } from "@/src/theme";

type FilterKey = "all" | "active" | "missing-location";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Located" },
  { key: "missing-location", label: "Missing location" },
];

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const { isShellWide } = useBreakpoint();
  const { rentals, loading, refresh, generatePDF } = useRentals();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");

  const relevant = useMemo(() => rentals.filter((r) => r.status !== "returned"), [rentals]);
  const pins: Pin[] = useMemo(
    () => relevant.filter((r) => r.lat != null && r.lng != null).map((r) => ({ id: r.id, lat: r.lat!, lng: r.lng!, title: r.customer_name, subtitle: r.job_site, status: r.status })),
    [relevant],
  );
  const withoutLoc = relevant.filter((r) => r.lat == null || r.lng == null).length;

  const listRows = useMemo(() => {
    if (filter === "active") return relevant.filter((r) => r.lat != null && r.lng != null);
    if (filter === "missing-location") return relevant.filter((r) => r.lat == null || r.lng == null);
    return relevant;
  }, [relevant, filter]);

  const selected = relevant.find((r) => r.id === selectedId) || null;

  const openInMaps = (r: Rental) => {
    if (r.lat == null || r.lng == null) return;
    const url = Platform.select({
      ios: `maps://?q=${encodeURIComponent(r.customer_name)}&ll=${r.lat},${r.lng}`,
      android: `geo:${r.lat},${r.lng}?q=${r.lat},${r.lng}(${encodeURIComponent(r.customer_name)})`,
      default: `https://maps.google.com/?q=${r.lat},${r.lng}`,
    })!;
    try {
      const { Linking } = require("react-native");
      Linking.openURL(url);
    } catch {}
  };

  const handlePdf = async (r: Rental) => {
    try { await generatePDF(r); }
    catch (e: any) { Alert.alert("PDF failed", e?.message || "Unable to generate PDF"); }
  };

  const detailPanel = (onBack?: () => void) => selected ? (
    <View style={{ flex: 1 }}>
      {onBack ? (
        <TouchableOpacity onPress={onBack} style={styles.backRow} testID="map-detail-back">
          <Ionicons name="chevron-back" size={18} color={colors.ink} />
          <Text style={{ fontSize: 13, fontWeight: "600", marginLeft: 4 }}>Back to list</Text>
        </TouchableOpacity>
      ) : null}
      <View style={{ padding: spacing.md }}>
        <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <H3>{selected.customer_name}</H3>
            <Text style={[typo.bodySmall, { marginTop: 2 }]}>{selected.job_site || "—"}</Text>
            {selected.lat != null && selected.lng != null ? (
              <Mono style={{ fontSize: 11, color: colors.inkMuted, marginTop: 2 }}>{selected.lat.toFixed(5)}, {selected.lng.toFixed(5)}</Mono>
            ) : null}
          </View>
          <StatusBadge label={selected.status} />
        </Row>

        <SectionLabel style={{ marginTop: spacing.md }}>Equipment on site ({selected.lines.length})</SectionLabel>
        <View style={styles.lineWrap} testID="sheet-lines">
          {selected.lines.map((l) => {
            const remaining = l.qty - l.returned_qty;
            return (
              <Row key={l.equipment_id} style={styles.lineRow}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body}>{l.name}</Text>
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{l.sku}</Mono>
                </View>
                <Mono style={{ fontSize: 15 }}>{remaining}</Mono>
                <Text style={[typo.caption, { marginLeft: 4 }]}>on site</Text>
              </Row>
            );
          })}
        </View>

        {(selected.customer_phone || selected.customer_email) ? (
          <Row style={{ gap: spacing.md, marginTop: spacing.md, flexWrap: "wrap" }}>
            {selected.customer_phone ? <Text style={typo.bodySmall}><Ionicons name="call-outline" size={12} color={colors.primary} /> {selected.customer_phone}</Text> : null}
            {selected.customer_email ? <Text style={typo.bodySmall}><Ionicons name="mail-outline" size={12} color={colors.primary} /> {selected.customer_email}</Text> : null}
          </Row>
        ) : null}

        <Row style={{ gap: spacing.sm, marginTop: spacing.md }}>
          <View style={{ flex: 1 }}><Button title="Open in Maps" onPress={() => openInMaps(selected)} variant="outline" testID="sheet-open-maps" /></View>
          <View style={{ flex: 1 }}><Button title="Delivery PDF" onPress={() => handlePdf(selected)} testID="sheet-pdf" /></View>
        </Row>
      </View>
    </View>
  ) : null;

  const listPanel = (
    <View style={{ flex: 1 }}>
      <View style={styles.listHeader}>
        <Text style={typo.h3}>Job sites</Text>
        <Text style={[typo.bodySmall, { marginTop: 2 }]}>{pins.length} pinned{withoutLoc > 0 ? ` · ${withoutLoc} without location` : ""}</Text>
        <View style={{ marginTop: spacing.sm }}>
          <FilterChips options={FILTERS} value={filter} onChange={(k) => setFilter(k as FilterKey)} testIDPrefix="map-filter" />
        </View>
      </View>
      {listRows.length === 0 ? (
        <View style={{ padding: spacing.lg, alignItems: "center" }}>
          <Ionicons name="location-outline" size={22} color={colors.inkMuted} />
          <Text style={[typo.bodySmall, { marginTop: 6, textAlign: "center" }]}>Nothing matches this filter.</Text>
        </View>
      ) : (
        listRows.map((r) => (
          <TouchableOpacity key={r.id} onPress={() => setSelectedId(r.id)} style={[styles.listRow, r.id === selectedId && styles.listRowActive]} testID={`map-list-${r.id}`}>
            <View style={[styles.dot, { backgroundColor: r.lat != null ? colors.primary : colors.inkMuted }]} />
            <View style={{ flex: 1 }}>
              <Text style={typo.body} numberOfLines={1}>{r.customer_name}</Text>
              <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{r.job_site || "—"}</Text>
            </View>
            <StatusBadge label={r.status} />
          </TouchableOpacity>
        ))
      )}
    </View>
  );

  const mapView = (
    <View style={{ flex: 1 }}>
      <MapCanvas pins={pins} onPinPress={(p) => setSelectedId(p.id)} selectedId={selectedId} />
      {pins.length === 0 && Platform.OS !== "web" ? (
        <View style={styles.emptyOverlay} pointerEvents="none">
          <View style={styles.emptyCard}>
            <Ionicons name="location-outline" size={22} color={colors.primary} />
            <Text style={[typo.h3, { marginTop: 6 }]}>No pinned rentals yet</Text>
            <Text style={[typo.bodySmall, { textAlign: "center", marginTop: 4 }]}>Open a rental and set its location to see it here.</Text>
          </View>
        </View>
      ) : null}
    </View>
  );

  if (loading) {
    return <Screen title="Map" back testID="map-screen"><LoadingState label="Loading job-site locations…" /></Screen>;
  }

  if (isShellWide) {
    return (
      <Screen
        title="Rental Map"
        subtitle={`${pins.length} pinned${withoutLoc > 0 ? ` · ${withoutLoc} without location` : ""}`}
        back
        rightAction={{ icon: "refresh", onPress: refresh, testID: "map-refresh" }}
        scroll={false}
        testID="map-screen"
      >
        <SplitPane primary={mapView} secondary={selected ? detailPanel(() => setSelectedId(null)) : listPanel} secondaryWidth={380} />
      </Screen>
    );
  }

  return (
    <Screen
      title="Rental Map"
      subtitle={`${pins.length} pinned${withoutLoc > 0 ? ` · ${withoutLoc} without location` : ""}`}
      back
      rightAction={{ icon: "refresh", onPress: refresh, testID: "map-refresh" }}
      scroll={false}
      testID="map-screen"
    >
      <View style={{ flex: 1 }}>{mapView}</View>

      {selected ? (
        <View style={styles.sheetBackdrop} pointerEvents="box-none">
          <TouchableOpacity style={StyleSheet.absoluteFillObject as any} activeOpacity={1} onPress={() => setSelectedId(null)} />
          <View style={[styles.sheet, { paddingBottom: 16 + insets.bottom }]}>
            <View style={styles.sheetHandle} />
            {detailPanel()}
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  emptyOverlay: { position: "absolute", top: spacing.lg, left: spacing.lg, right: spacing.lg, alignItems: "center" },
  emptyCard: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.md, alignItems: "center" },
  listHeader: { padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  listRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: spacing.md, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  listRowActive: { backgroundColor: colors.primarySoft },
  dot: { width: 8, height: 8, borderRadius: 4 },
  backRow: { flexDirection: "row", alignItems: "center", padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  lineWrap: { borderTopWidth: 1, borderTopColor: colors.border },
  lineRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 },
  sheetBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(15,23,42,0.35)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, paddingTop: spacing.sm, maxHeight: "80%" },
  sheetHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
});

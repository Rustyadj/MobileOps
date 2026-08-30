import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { Screen } from "@/src/components/Screen";
import { MapCanvas, LocationPicker, Pin } from "@/src/components/MapCanvas";
import { FilterChips } from "@/src/components/data/FilterBar";
import { SearchInput } from "@/src/components/data/SearchInput";
import { SplitPane } from "@/src/components/layout/SplitPane";
import { Button, H3, Mono, Pill, Row, SectionLabel } from "@/src/components/ui";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, radii, spacing, type as typo } from "@/src/theme";
import { equipmentIdentifier, qrCodeDisplay } from "@/src/utils/equipment-identifier";
import { DEFAULT_SHOP, shopPin } from "@/src/config/shop-location";
import { RENTAL_STATUS, isRentalReturned } from "@/src/domain/status";

type Line = {
  equipment_id: string;
  sku: string;
  qr_code?: string | null;
  name: string;
  qty: number;
  daily_rate: number;
  delivered_qty: number;
  returned_qty: number;
  damaged_qty: number;
};

type Rental = {
  id: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  customer_type: "company" | "homeowner";
  job_site: string;
  job_address: string;
  start_date: string;
  due_date?: string | null;
  deposit: number;
  notes: string;
  lines: Line[];
  status: string;
  lat?: number | null;
  lng?: number | null;
};

type Site = {
  brand_name: string;
  tagline: string;
  logo_base64?: string;
  company_address: string;
  company_phone: string;
  company_email: string;
  shop_lat?: number;
  shop_lng?: number;
};

type MapFilter = "all" | "active" | "partially_returned" | "missing";

const isOpenRental = (rental: Rental) => !isRentalReturned(rental.status);
const hasLocation = (rental: Rental) => rental.lat != null && rental.lng != null;

const lineOnSite = (line: Line) => {
  const delivered = line.delivered_qty > 0 ? line.delivered_qty : line.qty;
  return Math.max(0, delivered - line.returned_qty - line.damaged_qty);
};

const rentalUnits = (rental: Rental) => rental.lines.reduce((total, line) => total + lineOnSite(line), 0);

const statusTone = (status: string) => {
  if (status === RENTAL_STATUS.partiallyReturned) return { color: colors.warning, bg: colors.warningSoft };
  if (status === RENTAL_STATUS.returned) return { color: colors.success, bg: colors.successSoft };
  return { color: colors.primary, bg: colors.primarySoft };
};

const displayStatus = (status: string) => status === RENTAL_STATUS.partiallyReturned ? "Partial return" : status.replaceAll("_", " ");

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#039;",
  '"': "&quot;",
})[character] || character);

function RentalListRow({ rental, selected, onPress, onSetLocation }: {
  rental: Rental;
  selected: boolean;
  onPress: () => void;
  onSetLocation: () => void;
}) {
  const tone = statusTone(rental.status);
  const units = rentalUnits(rental);
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.78}
      style={[styles.rentalRow, selected && styles.rentalRowSelected]}
      testID={`map-rental-${rental.id}`}
    >
      <View style={[styles.statusDot, { backgroundColor: tone.color }]} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Row style={{ justifyContent: "space-between", gap: spacing.sm }}>
          <Text style={styles.rentalName} numberOfLines={1}>{rental.customer_name}</Text>
          <Mono style={styles.unitCount}>{units}</Mono>
        </Row>
        <Text style={typo.bodySmall} numberOfLines={1}>{rental.job_site || "Job site not entered"}</Text>
        {rental.job_address ? <Text style={styles.jobAddress} numberOfLines={1}>{rental.job_address}</Text> : null}
        <Row style={{ justifyContent: "space-between", marginTop: 5, gap: spacing.sm }}>
          {hasLocation(rental) ? (
            <Mono style={styles.coordinateText}>{rental.lat!.toFixed(4)}, {rental.lng!.toFixed(4)}</Mono>
          ) : (
            <TouchableOpacity onPress={onSetLocation} style={styles.locationNeeded} testID={`map-set-location-${rental.id}`}>
              <Ionicons name="alert-circle-outline" size={13} color={colors.error} />
              <Text style={styles.locationNeededText}>Set location</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.unitsLabel}>{units} unit{units === 1 ? "" : "s"} on site</Text>
        </Row>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.inkMuted} />
    </TouchableOpacity>
  );
}

function RentalListPanel({ rentals, selectedId, search, filter, totalOpen, pinnedCount, missingCount, shopAddress, onSearch, onFilter, onSelect, onSetLocation }: {
  rentals: Rental[];
  selectedId?: string;
  search: string;
  filter: MapFilter;
  totalOpen: number;
  pinnedCount: number;
  missingCount: number;
  shopAddress: string;
  onSearch: (value: string) => void;
  onFilter: (value: MapFilter) => void;
  onSelect: (rental: Rental) => void;
  onSetLocation: (rental: Rental) => void;
}) {
  const filters = [
    { key: "all", label: `All ${totalOpen}` },
    { key: "active", label: "Active" },
    { key: "partially_returned", label: "Partial" },
    { key: "missing", label: `Needs location ${missingCount}` },
  ];
  return (
    <View style={styles.sidePanel} testID="map-rental-list">
      <View style={styles.panelHeader}>
        <Row style={{ justifyContent: "space-between" }}>
          <View>
            <SectionLabel style={{ marginBottom: 2 }}>Rental locations</SectionLabel>
            <Text style={styles.panelTitle}>{pinnedCount} mapped · {missingCount} need action</Text>
            <Text style={styles.shopAddress} numberOfLines={2}>Shop / Yard · {shopAddress}</Text>
          </View>
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>Live</Text>
          </View>
        </Row>
        <SearchInput value={search} onChangeText={onSearch} placeholder="Customer, site, equipment…" testID="map-search" style={{ marginTop: spacing.md, minWidth: 0 }} />
        <View style={{ marginTop: spacing.sm }}>
          <FilterChips options={filters} value={filter} onChange={(value) => onFilter(value as MapFilter)} testIDPrefix="map-filter" />
        </View>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={rentals.length ? undefined : styles.emptyList} showsVerticalScrollIndicator={false}>
        {rentals.map((rental) => (
          <RentalListRow
            key={rental.id}
            rental={rental}
            selected={selectedId === rental.id}
            onPress={() => onSelect(rental)}
            onSetLocation={() => onSetLocation(rental)}
          />
        ))}
        {rentals.length === 0 ? (
          <View style={{ alignItems: "center" }}>
            <Ionicons name="search-outline" size={24} color={colors.inkMuted} />
            <Text style={[typo.h3, { marginTop: spacing.sm }]}>No matching rentals</Text>
            <Text style={[typo.bodySmall, { textAlign: "center", marginTop: 4 }]}>Try another search or status filter.</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function RentalDetail({ rental, mobile, onBack, onClose, onSetLocation, onOpenMaps, onPdf, onOpenRental }: {
  rental: Rental;
  mobile?: boolean;
  onBack?: () => void;
  onClose?: () => void;
  onSetLocation: () => void;
  onOpenMaps: () => void;
  onPdf: () => void;
  onOpenRental: () => void;
}) {
  const tone = statusTone(rental.status);
  const linesOnSite = rental.lines.filter((line) => lineOnSite(line) > 0);
  const units = rentalUnits(rental);
  return (
    <View style={[styles.detailPanel, mobile && styles.mobileDetail]} testID="map-rental-detail">
      {mobile ? <View style={styles.sheetHandle} /> : null}
      <Row style={{ minHeight: 40, gap: spacing.sm }}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={styles.iconButton} testID="map-detail-back">
            <Ionicons name="arrow-back" size={19} color={colors.ink} />
          </TouchableOpacity>
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <SectionLabel style={{ marginBottom: 2 }}>Rental on site</SectionLabel>
          <H3>{rental.customer_name}</H3>
        </View>
        <Pill color={tone.color} bg={tone.bg}>{displayStatus(rental.status)}</Pill>
        {onClose ? (
          <TouchableOpacity onPress={onClose} style={styles.iconButton} testID="map-detail-close">
            <Ionicons name="close" size={20} color={colors.ink} />
          </TouchableOpacity>
        ) : null}
      </Row>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing.lg }} showsVerticalScrollIndicator={false}>
        <View style={styles.locationCard}>
          <Row style={{ alignItems: "flex-start", gap: spacing.sm }}>
            <View style={[styles.locationIcon, { backgroundColor: hasLocation(rental) ? colors.primarySoft : colors.errorSoft }]}>
              <Ionicons name={hasLocation(rental) ? "location" : "alert-circle"} size={18} color={hasLocation(rental) ? colors.primary : colors.error} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.locationTitle}>{rental.job_site || "Job site not entered"}</Text>
              {rental.job_address ? <Text style={typo.bodySmall}>{rental.job_address}</Text> : null}
              {hasLocation(rental) ? (
                <Mono style={styles.coordinateText}>{rental.lat!.toFixed(6)}, {rental.lng!.toFixed(6)}</Mono>
              ) : (
                <Text style={styles.locationMissingCopy}>This rental is not visible on the map.</Text>
              )}
            </View>
          </Row>
          <Button
            title={hasLocation(rental) ? "Edit map location" : "Set map location"}
            variant={hasLocation(rental) ? "outline" : "primary"}
            onPress={onSetLocation}
            style={{ marginTop: spacing.md }}
            testID="map-detail-set-location"
          />
        </View>

        <Row style={styles.summaryRow}>
          <View>
            <SectionLabel style={{ marginBottom: 3 }}>On site now</SectionLabel>
            <Mono large>{units}</Mono>
          </View>
          <View style={styles.summaryDivider} />
          <View>
            <SectionLabel style={{ marginBottom: 3 }}>Equipment types</SectionLabel>
            <Mono large>{linesOnSite.length}</Mono>
          </View>
        </Row>

        <SectionLabel>Equipment on site</SectionLabel>
        <View style={styles.lineWrap} testID="map-detail-lines">
          {linesOnSite.map((line) => (
            <Row key={line.equipment_id} style={styles.lineRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.lineName} numberOfLines={1}>{line.name}</Text>
                <Mono style={styles.coordinateText}>{equipmentIdentifier(line)}</Mono>
              </View>
              <Mono style={styles.lineQuantity}>{lineOnSite(line)}</Mono>
            </Row>
          ))}
          {linesOnSite.length === 0 ? <Text style={styles.noEquipment}>No equipment is currently on site.</Text> : null}
        </View>

        {(rental.customer_phone || rental.customer_email) ? (
          <View style={styles.contactBlock}>
            <SectionLabel>Contact</SectionLabel>
            {rental.customer_phone ? <Text style={typo.bodySmall}>{rental.customer_phone}</Text> : null}
            {rental.customer_email ? <Text style={typo.bodySmall}>{rental.customer_email}</Text> : null}
          </View>
        ) : null}
        {rental.notes ? (
          <View style={styles.contactBlock}>
            <SectionLabel>Notes</SectionLabel>
            <Text style={typo.bodySmall}>{rental.notes}</Text>
          </View>
        ) : null}

        <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
          {hasLocation(rental) ? <Button title="Open in Maps" variant="outline" onPress={onOpenMaps} testID="map-detail-open-maps" /> : null}
          <Row style={{ gap: spacing.sm }}>
            <View style={{ flex: 1 }}><Button title="Delivery PDF" variant="outline" onPress={onPdf} testID="map-detail-pdf" /></View>
            <View style={{ flex: 1 }}><Button title="Open rental" onPress={onOpenRental} testID="map-detail-open-rental" /></View>
          </Row>
        </View>
      </ScrollView>
    </View>
  );
}

export default function MapScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string }>();
  const insets = useSafeAreaInsets();
  const { isShellWide } = useBreakpoint();
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [selected, setSelected] = useState<Rental | null>(null);
  const [locationTarget, setLocationTarget] = useState<Rental | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MapFilter>("all");
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [nextRentals, nextSite] = await Promise.all([api<Rental[]>("/rentals"), api<Site>("/site")]);
      setRentals(nextRentals);
      setSite(nextSite);
      setSelected((current) => current ? nextRentals.find((rental) => rental.id === current.id) || null : null);
      setError("");
    } catch (loadError: any) {
      setError(loadError?.message || "Rental locations could not be loaded.");
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!params.open) return;
    const target = rentals.find((rental) => rental.id === String(params.open));
    if (target) setSelected(target);
  }, [params.open, rentals]);

  const openRentals = useMemo(() => rentals.filter(isOpenRental), [rentals]);
  const missingCount = useMemo(() => openRentals.filter((rental) => !hasLocation(rental)).length, [openRentals]);
  const pinnedCount = openRentals.length - missingCount;

  const filteredRentals = useMemo(() => {
    const query = search.trim().toLowerCase();
    return openRentals.filter((rental) => {
      if (filter === "missing" && hasLocation(rental)) return false;
      if (filter !== "all" && filter !== "missing" && rental.status !== filter) return false;
      if (!query) return true;
      const equipment = rental.lines.map((line) => `${line.name} ${line.sku} ${line.qr_code || ""}`).join(" ");
      return `${rental.customer_name} ${rental.job_site} ${rental.job_address} ${rental.customer_phone} ${rental.customer_email} ${equipment}`.toLowerCase().includes(query);
    });
  }, [filter, openRentals, search]);

  const rentalPins = useMemo<Pin[]>(() => filteredRentals.filter(hasLocation).map((rental) => ({
    id: rental.id,
    lat: rental.lat!,
    lng: rental.lng!,
    title: rental.customer_type === "homeowner" ? rental.job_site || rental.customer_name : rental.customer_name,
    subtitle: `${rental.job_site || "No job site"}${rental.job_address ? ` · ${rental.job_address}` : ""} · ${rentalUnits(rental)} on site`,
    status: rental.status,
  })), [filteredRentals]);
  const pins = useMemo<Pin[]>(() => [shopPin(site), ...rentalPins], [rentalPins, site]);

  const selectRental = useCallback((rental: Rental) => setSelected(rental), []);
  const onPinPress = useCallback((pin: Pin) => {
    const rental = rentals.find((item) => item.id === pin.id);
    if (rental) setSelected(rental);
  }, [rentals]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const saveLocation = async (coords: { lat: number; lng: number }) => {
    if (!locationTarget) return;
    try {
      const updated = await api<Rental>(`/rentals/${locationTarget.id}/location`, {
        method: "PATCH",
        body: JSON.stringify(coords),
      });
      setRentals((current) => current.map((rental) => rental.id === updated.id ? updated : rental));
      setSelected((current) => current?.id === updated.id ? updated : current);
      setFilter("all");
      setLocationTarget(null);
    } catch (saveError: any) {
      Alert.alert("Location not saved", saveError?.message || "Try again.");
    }
  };

  const openInMaps = async (rental: Rental) => {
    if (!hasLocation(rental)) return;
    const url = Platform.select({
      ios: `maps://?q=${encodeURIComponent(rental.customer_name)}&ll=${rental.lat},${rental.lng}`,
      android: `geo:${rental.lat},${rental.lng}?q=${rental.lat},${rental.lng}(${encodeURIComponent(rental.customer_name)})`,
      default: `https://maps.google.com/?q=${rental.lat},${rental.lng}`,
    })!;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert("Map could not open", "Copy the coordinates from the rental location instead.");
    }
  };

  const generatePDF = async (rental: Rental) => {
    const lineRows = rental.lines.map((line) => (
      `<tr><td>${escapeHtml(qrCodeDisplay(line))}</td><td>${escapeHtml(line.name)}</td><td style="text-align:right">${line.qty}</td></tr>`
    )).join("");
    const logoHtml = site?.logo_base64
      ? `<img src="${escapeHtml(site.logo_base64)}" style="max-height:72px;max-width:160px;object-fit:contain;margin-right:16px"/>`
      : `<div class="tile"></div>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"/><style>
body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial;color:#0F172A;padding:40px}.brand{display:flex;align-items:center;border-bottom:1px solid #E2E8F0;padding-bottom:20px;margin-bottom:28px}.tile{width:6px;height:40px;background:#1E3A8A;margin-right:14px;border-radius:2px}h1{margin:0;font-size:22px}.label{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#94A3B8;font-weight:600}.box{border:1px solid #E2E8F0;padding:16px;margin-bottom:12px;border-radius:6px}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{padding:12px 10px;border-bottom:1px solid #E2E8F0;font-size:13px}th{background:#F8FAFC;text-transform:uppercase;font-size:10px;letter-spacing:.6px;text-align:left;color:#475569}.sig{margin-top:56px;display:flex;gap:32px}.sig div{flex:1;border-top:1px solid #0F172A;padding-top:8px;font-size:11px;text-transform:uppercase}</style></head><body>
<div class="brand">${logoHtml}<div><h1>${escapeHtml(site?.brand_name || "Concrete Form")}</h1><div class="label">Delivery ticket</div></div></div>
<div class="box"><div class="label">Customer</div><div style="font-size:17px;font-weight:600">${escapeHtml(rental.customer_name)}</div><div>${escapeHtml(rental.customer_phone)}${rental.customer_email ? ` · ${escapeHtml(rental.customer_email)}` : ""}</div><div>${escapeHtml(rental.job_site)}</div></div>
<div class="box"><div class="label">Start date</div><div>${escapeHtml(new Date(rental.start_date).toLocaleDateString())}</div></div>
<table><thead><tr><th>QR Code</th><th>Description</th><th style="text-align:right">Qty</th></tr></thead><tbody>${lineRows}</tbody></table>
${rental.notes ? `<div class="box" style="margin-top:24px"><div class="label">Notes</div><div>${escapeHtml(rental.notes)}</div></div>` : ""}<div class="sig"><div>Delivered by</div><div>Received by</div></div></body></html>`;
    try {
      if (Platform.OS === "web") await Print.printAsync({ html });
      else {
        const { uri } = await Print.printToFileAsync({ html });
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: "Delivery Ticket" });
      }
    } catch (pdfError: any) {
      Alert.alert("PDF failed", pdfError?.message || "Unable to generate PDF.");
    }
  };

  const detail = selected ? (
    <RentalDetail
      rental={selected}
      mobile={!isShellWide}
      onBack={isShellWide ? () => setSelected(null) : undefined}
      onClose={!isShellWide ? () => setSelected(null) : undefined}
      onSetLocation={() => setLocationTarget(selected)}
      onOpenMaps={() => openInMaps(selected)}
      onPdf={() => generatePDF(selected)}
      onOpenRental={() => router.push(`/(app)/operations/rentals?open=${selected.id}` as any)}
    />
  ) : null;

  const list = (
    <RentalListPanel
      rentals={filteredRentals}
      selectedId={selected?.id}
      search={search}
      filter={filter}
      totalOpen={openRentals.length}
      pinnedCount={pinnedCount}
      missingCount={missingCount}
      shopAddress={site?.company_address || DEFAULT_SHOP.address}
      onSearch={setSearch}
      onFilter={setFilter}
      onSelect={selectRental}
      onSetLocation={setLocationTarget}
    />
  );

  return (
    <Screen
      title="Rental Map"
      subtitle={`${pinnedCount} rentals mapped · Shop / Yard in Ponder${missingCount ? ` · ${missingCount} need location` : ""}`}
      back
      rightAction={{ icon: "refresh", onPress: onRefresh, testID: "map-refresh" }}
      scroll={false}
      testID="map-screen"
    >
      {initialLoading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[typo.bodySmall, { marginTop: spacing.sm }]}>Loading rental locations…</Text>
        </View>
      ) : (
        <SplitPane
          secondaryWidth={400}
          primary={(
            <View style={styles.mapPane}>
              <MapCanvas
                pins={pins}
                onPinPress={onPinPress}
                center={selected && hasLocation(selected) ? { lat: selected.lat!, lng: selected.lng! } : undefined}
                selectedId={selected?.id}
              />
              <View style={styles.mapSummary} pointerEvents="none">
                <View style={styles.liveDot} />
                <Text style={styles.mapSummaryText}>Shop / Yard + {rentalPins.length} rentals</Text>
                <View style={styles.mapSummaryDivider} />
                <Text style={[styles.mapSummaryText, missingCount > 0 && { color: colors.error }]}>{missingCount} need location</Text>
              </View>
              {error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                  <TouchableOpacity onPress={load}><Text style={styles.retryText}>Retry</Text></TouchableOpacity>
                </View>
              ) : null}
              {rentalPins.length === 0 ? (
                <View style={styles.emptyOverlay} pointerEvents="none">
                  <Ionicons name="location-outline" size={24} color={colors.primary} />
                  <Text style={[typo.h3, { marginTop: 6 }]}>{missingCount ? "Locations need attention" : "Shop / Yard is home base"}</Text>
                  <Text style={[typo.bodySmall, { textAlign: "center", marginTop: 4 }]}>
                    {missingCount ? `${missingCount} active rental${missingCount === 1 ? "" : "s"} must be pinned from the work queue. The Ponder shop remains visible.` : DEFAULT_SHOP.address}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
          secondary={isShellWide && detail ? detail : list}
        />
      )}

      <Modal visible={!isShellWide && !!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setSelected(null)} style={styles.sheetBackdrop}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={[styles.sheet, { paddingBottom: insets.bottom }]}>
            {detail}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <LocationPicker
        visible={!!locationTarget}
        initial={locationTarget && hasLocation(locationTarget) ? { lat: locationTarget.lat!, lng: locationTarget.lng! } : null}
        onClose={() => setLocationTarget(null)}
        onSave={saveLocation}
      />
      {refreshing ? <View style={styles.refreshIndicator}><ActivityIndicator size="small" color={colors.primary} /></View> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loadingState: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bgMuted },
  mapPane: { flex: 1, minHeight: 260, backgroundColor: colors.bgMuted },
  mapSummary: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 11,
    height: 34,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(255,255,255,0.96)",
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  mapSummaryText: { fontSize: 11, fontWeight: "700", color: colors.inkSecondary, textTransform: "uppercase", letterSpacing: 0.45 },
  mapSummaryDivider: { width: 1, height: 14, backgroundColor: colors.border },
  errorBanner: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.errorSoft,
    borderWidth: 1,
    borderColor: colors.error,
  },
  errorText: { ...typo.bodySmall, color: colors.error, flex: 1 },
  retryText: { fontSize: 13, fontWeight: "700", color: colors.error },
  emptyOverlay: {
    position: "absolute",
    top: "38%",
    alignSelf: "center",
    alignItems: "center",
    maxWidth: 320,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(255,255,255,0.96)",
  },
  sidePanel: { flex: 1, backgroundColor: colors.bg },
  panelHeader: { padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  panelTitle: { fontSize: 14, fontWeight: "700", color: colors.ink },
  shopAddress: { marginTop: 4, maxWidth: 280, fontSize: 11, lineHeight: 15, color: colors.accent, fontWeight: "600" },
  liveBadge: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.successSoft, paddingHorizontal: 8, paddingVertical: 5, borderRadius: radii.md },
  liveText: { fontSize: 10, fontWeight: "800", color: colors.success, textTransform: "uppercase", letterSpacing: 0.5 },
  rentalRow: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  rentalRowSelected: { backgroundColor: colors.primarySoft },
  statusDot: { width: 8, height: 8, borderRadius: 4, alignSelf: "flex-start", marginTop: 7 },
  rentalName: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.ink },
  unitCount: { fontSize: 16, fontWeight: "700", color: colors.ink },
  coordinateText: { fontSize: 10.5, color: colors.inkMuted },
  jobAddress: { fontSize: 10.5, color: colors.inkMuted, marginTop: 2 },
  unitsLabel: { fontSize: 10.5, color: colors.inkMuted },
  locationNeeded: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 24 },
  locationNeededText: { fontSize: 11, fontWeight: "700", color: colors.error },
  emptyList: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  detailPanel: { flex: 1, padding: spacing.md, backgroundColor: colors.bg },
  mobileDetail: { maxHeight: "100%" },
  sheetHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginBottom: spacing.sm },
  iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md },
  locationCard: { marginTop: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.bgMuted },
  locationIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radii.md },
  locationTitle: { fontSize: 14, fontWeight: "700", color: colors.ink, marginBottom: 3 },
  locationMissingCopy: { ...typo.bodySmall, color: colors.error },
  summaryRow: { gap: spacing.xl, paddingVertical: spacing.lg },
  summaryDivider: { width: 1, height: 42, backgroundColor: colors.border },
  lineWrap: { borderTopWidth: 1, borderTopColor: colors.border },
  lineRow: { minHeight: 52, paddingVertical: spacing.sm, gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  lineName: { fontSize: 13, fontWeight: "600", color: colors.ink },
  lineQuantity: { fontSize: 18, fontWeight: "700", color: colors.ink },
  noEquipment: { ...typo.bodySmall, paddingVertical: spacing.md },
  contactBlock: { marginTop: spacing.lg },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.38)", justifyContent: "flex-end" },
  sheet: { height: "82%", backgroundColor: colors.bg, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, overflow: "hidden" },
  refreshIndicator: { position: "absolute", right: spacing.md, top: spacing.md, width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: colors.bg },
});

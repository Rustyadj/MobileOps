// Dashboard "Live rental map" panel — wraps the existing MapCanvas with the
// panel chrome (header, live indicator, site filter, refresh/last-updated
// footer) requested by the reference layout. Marker rendering, clustering
// limits, and pin interaction all come from the existing map stack; this
// component adds no fabricated map behavior of its own.
import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii } from "@/src/theme";
import { MapCanvas, Pin } from "@/src/components/MapCanvas";

export const DashboardMap: React.FC<{
  pins: Pin[];
  missingLocationCount: number;
  onPinPress: (pin: Pin) => void;
  onOpenMap: () => void;
  onRefresh: () => void;
  lastUpdated: Date;
  shopAddress: string;
}> = ({ pins, missingLocationCount, onPinPress, onOpenMap, onRefresh, lastUpdated, shopAddress }) => {
  const sites = useMemo(() => Array.from(new Set(pins.map((p) => p.subtitle).filter(Boolean))) as string[], [pins]);
  const [siteFilter, setSiteFilter] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const filteredPins = siteFilter ? pins.filter((p) => p.subtitle === siteFilter) : pins;

  return (
    <View style={styles.panel} testID="dashboard-map-panel">
      <View style={styles.header}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>LIVE RENTAL MAP</Text>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>Live</Text>
        </View>
        <View>
          <TouchableOpacity style={styles.siteFilter} onPress={() => setMenuOpen((o) => !o)} testID="map-site-filter" activeOpacity={0.7}>
            <Ionicons name="filter-outline" size={12} color={colors.inkSecondary} />
            <Text style={styles.siteFilterText} numberOfLines={1}>{siteFilter || "All Sites"}</Text>
            <Ionicons name="chevron-down" size={12} color={colors.inkMuted} />
          </TouchableOpacity>
          {menuOpen ? (
            <>
              <TouchableOpacity style={{ position: "absolute", top: 30, right: 0, width: 260, height: 0 }} activeOpacity={1} onPress={() => setMenuOpen(false)} />
              <View style={styles.siteMenu} testID="map-site-menu">
                <TouchableOpacity style={styles.siteMenuItem} onPress={() => { setSiteFilter(null); setMenuOpen(false); }}>
                  <Text style={styles.siteMenuText}>All Sites</Text>
                </TouchableOpacity>
                {sites.map((s) => (
                  <TouchableOpacity key={s} style={styles.siteMenuItem} onPress={() => { setSiteFilter(s); setMenuOpen(false); }}>
                    <Text style={styles.siteMenuText} numberOfLines={1}>{s}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : null}
        </View>
        <TouchableOpacity onPress={onOpenMap} testID="dashboard-map-open" style={styles.openMap}>
          <Text style={styles.openMapText}>Open map</Text>
          <Ionicons name="arrow-forward" size={12} color={colors.primary} />
        </TouchableOpacity>
      </View>

      <View style={styles.body}>
        <MapCanvas pins={filteredPins} onPinPress={onPinPress} style={{ borderRadius: 0, borderWidth: 0 }} />
      </View>

      <View style={styles.footer}>
        <Text style={[styles.footerText, { flex: 1 }]} numberOfLines={1}>Shop / Yard · {shopAddress}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={styles.footerText}>{Math.max(0, pins.length - 1)} rentals · {missingLocationCount} missing · {lastUpdated.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</Text>
          <TouchableOpacity onPress={onRefresh} testID="dashboard-map-refresh">
            <Ionicons name="refresh" size={13} color={colors.inkSecondary} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  panel: { flex: 1.7, minHeight: 300, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  header: { height: 40, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 11, fontWeight: "800", color: colors.inkSecondary, letterSpacing: 0.5 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  liveText: { fontSize: 10.5, fontWeight: "700", color: colors.success },
  siteFilter: { flexDirection: "row", alignItems: "center", gap: 5, height: 26, paddingHorizontal: 9, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: colors.bgMuted, maxWidth: 150 },
  siteFilterText: { fontSize: 11, color: colors.inkSecondary, fontWeight: "600", flexShrink: 1 },
  siteMenu: { position: "absolute", top: 30, right: 0, width: 200, zIndex: 100, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingVertical: 4, maxHeight: 220 },
  siteMenuItem: { paddingHorizontal: 12, paddingVertical: 8 },
  siteMenuText: { fontSize: 12.5, color: colors.ink },
  openMap: { flexDirection: "row", alignItems: "center", gap: 4 },
  openMapText: { fontSize: 11.5, fontWeight: "700", color: colors.primary },
  body: { flex: 1, minHeight: 0 },
  footer: { minHeight: 28, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontSize: 10.5, color: colors.inkMuted },
});

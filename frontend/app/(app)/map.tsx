import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity, Alert, Platform } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card, Button, Mono, SectionLabel, Pill, Row, H3 } from "@/src/components/ui";
import { MapCanvas, Pin } from "@/src/components/MapCanvas";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo, radii } from "@/src/theme";

type Line = { equipment_id: string; sku: string; name: string; qty: number; daily_rate: number; returned_qty: number };
type Rental = {
  id: string; customer_name: string; customer_phone: string; customer_email: string;
  job_site: string; start_date: string; deposit: number; notes: string;
  lines: Line[]; status: string; lat?: number | null; lng?: number | null;
};
type Site = { brand_name: string; tagline: string; logo_base64: string; company_address: string; company_phone: string; company_email: string };

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [selected, setSelected] = useState<Rental | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api<Rental[]>("/rentals"), api<Site>("/site")]);
      setRentals(r);
      setSite(s);
    } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pins: Pin[] = useMemo(
    () =>
      rentals
        .filter((r) => r.lat != null && r.lng != null && r.status !== "returned")
        .map((r) => ({
          id: r.id,
          lat: r.lat!,
          lng: r.lng!,
          title: r.customer_name,
          subtitle: r.job_site,
          status: r.status,
        })),
    [rentals],
  );

  const onPinPress = (p: Pin) => {
    const r = rentals.find((x) => x.id === p.id);
    if (r) setSelected(r);
  };

  const withoutLoc = rentals.filter((r) => (r.lat == null || r.lng == null) && r.status !== "returned").length;

  const openInMaps = (r: Rental) => {
    if (r.lat == null || r.lng == null) return;
    const url = Platform.select({
      ios: `maps://?q=${encodeURIComponent(r.customer_name)}&ll=${r.lat},${r.lng}`,
      android: `geo:${r.lat},${r.lng}?q=${r.lat},${r.lng}(${encodeURIComponent(r.customer_name)})`,
      default: `https://maps.google.com/?q=${r.lat},${r.lng}`,
    })!;
    try {
      // Best-effort deep link
      const { Linking } = require("react-native");
      Linking.openURL(url);
    } catch {}
  };

  const generatePDF = async (r: Rental) => {
    const lineRows = r.lines.map((l) =>
      `<tr><td>${l.sku}</td><td>${l.name}</td><td style="text-align:right">${l.qty}</td></tr>`
    ).join("");
    const logoHtml = site?.logo_base64
      ? `<img src="${site.logo_base64}" style="max-height:72px;max-width:160px;object-fit:contain;margin-right:16px"/>`
      : `<div class="tile"></div>`;
    const html = `
<!doctype html><html><head><meta charset="utf-8"/><style>
body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial;color:#0F172A;padding:40px;}
.brand{display:flex;align-items:center;border-bottom:1px solid #E2E8F0;padding-bottom:20px;margin-bottom:28px;}
.tile{width:6px;height:40px;background:#1E3A8A;margin-right:14px;border-radius:2px;}
h1{margin:0;font-size:22px;letter-spacing:-0.3px;font-weight:600;}
.label{font-size:10px;text-transform:uppercase;letter-spacing:0.8px;color:#94A3B8;font-weight:600;}
.box{border:1px solid #E2E8F0;padding:16px;margin-bottom:12px;border-radius:6px;}
table{width:100%;border-collapse:collapse;margin-top:8px;}
th,td{padding:12px 10px;border-bottom:1px solid #E2E8F0;font-size:13px;}
th{background:#F8FAFC;text-transform:uppercase;font-size:10px;letter-spacing:0.6px;text-align:left;color:#475569;font-weight:600;}
.sig{margin-top:56px;display:flex;gap:32px;}
.sig div{flex:1;border-top:1px solid #0F172A;padding-top:8px;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:#475569;font-weight:600;}
</style></head><body>
<div class="brand">${logoHtml}<div><h1>${site?.brand_name || "Concrete Form"}</h1><div class="label" style="margin-top:4px">Delivery Ticket</div></div></div>
<div class="box"><div class="label">Customer</div><div style="font-size:17px;font-weight:600;margin-top:4px">${r.customer_name}</div><div style="font-size:13px;color:#475569;margin-top:2px">${r.customer_phone || ""} ${r.customer_email ? " · " + r.customer_email : ""}</div><div style="font-size:13px;color:#475569">${r.job_site || ""}</div></div>
<div class="box"><div class="label">Start date</div><div style="font-size:14px;margin-top:4px">${new Date(r.start_date).toLocaleDateString()}</div></div>
<table><thead><tr><th>SKU</th><th>Description</th><th style="text-align:right">Qty</th></tr></thead><tbody>${lineRows}</tbody></table>
${r.notes ? `<div class="box" style="margin-top:24px"><div class="label">Notes</div><div style="font-size:13px;margin-top:4px">${r.notes}</div></div>` : ""}
<div class="sig"><div>Delivered by</div><div>Received by (signature)</div></div>
</body></html>`;
    try {
      if (Platform.OS === "web") await Print.printAsync({ html });
      else {
        const { uri } = await Print.printToFileAsync({ html });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: "Delivery Ticket" });
        }
      }
    } catch (e: any) { Alert.alert("PDF failed", e?.message || "Unable to generate PDF"); }
  };

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  return (
    <Screen
      title="Rental Map"
      subtitle={`${pins.length} pinned${withoutLoc > 0 ? ` · ${withoutLoc} without location` : ""}`}
      back
      rightAction={{ icon: "refresh", onPress: onRefresh, testID: "map-refresh" }}
      scroll={false}
      testID="map-screen"
    >
      <View style={{ flex: 1 }}>
        <MapCanvas pins={pins} onPinPress={onPinPress} />
        {pins.length === 0 && Platform.OS !== "web" ? (
          <View style={styles.emptyOverlay} pointerEvents="none">
            <View style={styles.emptyCard}>
              <Ionicons name="location-outline" size={22} color={colors.primary} />
              <Text style={[typo.h3, { marginTop: 6 }]}>No pinned rentals yet</Text>
              <Text style={[typo.bodySmall, { textAlign: "center", marginTop: 4 }]}>
                Open a rental and set its location to see it here.
              </Text>
            </View>
          </View>
        ) : null}
      </View>

      <Modal
        visible={!!selected}
        transparent
        animationType="slide"
        onRequestClose={() => setSelected(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setSelected(null)}
          style={styles.sheetBackdrop}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => {}}
            style={[styles.sheet, { paddingBottom: 16 + insets.bottom }]}
          >
            {selected ? (
              <>
                <View style={styles.sheetHandle} />
                <Row style={{ justifyContent: "space-between", marginBottom: spacing.sm, alignItems: "flex-start" }}>
                  <View style={{ flex: 1 }}>
                    <H3>{selected.customer_name}</H3>
                    <Text style={[typo.bodySmall, { marginTop: 2 }]}>{selected.job_site || "—"}</Text>
                    {selected.lat != null && selected.lng != null ? (
                      <Mono style={{ fontSize: 11, color: colors.inkMuted, marginTop: 2 }}>
                        {selected.lat.toFixed(5)}, {selected.lng.toFixed(5)}
                      </Mono>
                    ) : null}
                  </View>
                  <Pill
                    color={selected.status === "returned" ? colors.success : selected.status === "active" ? colors.primary : colors.warning}
                    bg={selected.status === "returned" ? colors.successSoft : selected.status === "active" ? colors.primarySoft : colors.warningSoft}
                  >
                    {selected.status}
                  </Pill>
                </Row>

                <SectionLabel>Equipment on site ({selected.lines.length})</SectionLabel>
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
                  <Row style={{ gap: spacing.md, marginTop: spacing.md }}>
                    {selected.customer_phone ? (
                      <Text style={typo.bodySmall}>
                        <Ionicons name="call-outline" size={12} color={colors.primary} /> {selected.customer_phone}
                      </Text>
                    ) : null}
                    {selected.customer_email ? (
                      <Text style={typo.bodySmall}>
                        <Ionicons name="mail-outline" size={12} color={colors.primary} /> {selected.customer_email}
                      </Text>
                    ) : null}
                  </Row>
                ) : null}

                <Row style={{ gap: spacing.sm, marginTop: spacing.md }}>
                  <View style={{ flex: 1 }}>
                    <Button title="Open in Maps" onPress={() => openInMaps(selected)} variant="outline" testID="sheet-open-maps" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button title="Delivery PDF" onPress={() => generatePDF(selected)} testID="sheet-pdf" />
                  </View>
                </Row>
              </>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  emptyOverlay: {
    position: "absolute",
    top: spacing.lg, left: spacing.lg, right: spacing.lg,
    alignItems: "center",
  },
  emptyCard: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    alignItems: "center",
  },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.35)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    maxHeight: "80%",
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.sm,
  },
  lineWrap: { borderTopWidth: 1, borderTopColor: colors.border },
  lineRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 8,
  },
});

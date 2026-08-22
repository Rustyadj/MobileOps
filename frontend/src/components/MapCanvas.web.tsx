// Web stub for MapCanvas — react-native-maps has no web build.
// Provides same public API used by callers: MapCanvas, LocationPicker, geocodeString, Pin.
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { Button, Row, Input } from "@/src/components/ui";
import { useState } from "react";

export type Pin = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  subtitle?: string;
  status?: string;
};

function statusColor(s?: string) {
  if (s === "returned") return colors.success;
  if (s === "partially_returned") return colors.warning;
  return colors.primary;
}

export const MapCanvas: React.FC<{
  pins: Pin[];
  onPinPress?: (p: Pin) => void;
  center?: { lat: number; lng: number };
  style?: any;
}> = ({ pins, onPinPress, center, style }) => {
  const focus = center || (pins[0] ? { lat: pins[0].lat, lng: pins[0].lng } : null);
  if (!focus) {
    return (
      <View style={[styles.webFallback, style]}>
        <Ionicons name="location-outline" size={30} color={colors.inkMuted} />
        <Text style={[typo.h3, { marginTop: 8 }]}>No rental locations yet</Text>
        <Text style={[typo.bodySmall, { textAlign: "center", marginTop: 4 }]}>Add a job-site location to an active rental.</Text>
      </View>
    );
  }

  const delta = 0.11;
  const bbox = [focus.lng - delta, focus.lat - delta, focus.lng + delta, focus.lat + delta].join(",");
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${focus.lat}%2C${focus.lng}`;
  const iframe = React.createElement("iframe" as any, {
    src,
    title: "Live rental locations",
    loading: "lazy",
    style: { width: "100%", height: "100%", border: 0, backgroundColor: colors.bgMuted },
  });

  return (
    <View style={[styles.webMap, style]} testID="web-live-map">
      {iframe}
      <View style={styles.mapLegend}>
        <View style={styles.legendHeader}>
          <View style={styles.liveDot} />
          <Text style={styles.legendTitle}>{pins.length} live location{pins.length === 1 ? "" : "s"}</Text>
        </View>
        {pins.slice(0, 3).map((p) => (
          <TouchableOpacity key={p.id} onPress={() => onPinPress?.(p)} style={styles.legendRow} testID={`pin-list-${p.id}`}>
            <View style={[styles.pinDot, { backgroundColor: statusColor(p.status) }]} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.legendName} numberOfLines={1}>{p.title}</Text>
              <Text style={styles.legendSub} numberOfLines={1}>{p.subtitle || "No job-site name"}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
};

export const LocationPicker: React.FC<{
  visible: boolean;
  initial?: { lat: number; lng: number } | null;
  onClose: () => void;
  onSave: (coords: { lat: number; lng: number }) => void;
}> = ({ visible, initial, onClose, onSave }) => {
  const [lat, setLat] = useState(initial?.lat != null ? String(initial.lat) : "");
  const [lng, setLng] = useState(initial?.lng != null ? String(initial.lng) : "");
  const save = () => {
    const la = parseFloat(lat);
    const ln = parseFloat(lng);
    if (Number.isNaN(la) || Number.isNaN(ln)) {
      Alert.alert("Invalid coordinates", "Enter numeric latitude and longitude.");
      return;
    }
    onSave({ lat: la, lng: ln });
  };
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn} testID="loc-close">
            <Ionicons name="close" size={22} color={colors.ink} />
          </TouchableOpacity>
          <Text style={typo.h2}>Pick location</Text>
        </View>
        <View style={{ padding: spacing.lg, flex: 1 }}>
          <View style={{ alignItems: "center", marginBottom: spacing.lg }}>
            <Ionicons name="map-outline" size={40} color={colors.inkMuted} />
            <Text style={[typo.h3, { marginTop: 6 }]}>Interactive picker requires a device</Text>
            <Text style={[typo.bodySmall, { textAlign: "center", marginTop: 4 }]}>
              On web, enter coordinates manually. On your phone you will get a tap-to-drop map.
            </Text>
          </View>
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Input label="Latitude" value={lat} onChangeText={setLat} keyboardType="numeric" mono testID="loc-lat-input" />
            </View>
            <View style={{ flex: 1 }}>
              <Input label="Longitude" value={lng} onChangeText={setLng} keyboardType="numeric" mono testID="loc-lng-input" />
            </View>
          </Row>
          <Button title="Save location" onPress={save} testID="loc-save-btn" />
        </View>
      </SafeAreaView>
    </Modal>
  );
};

import { api } from "@/src/api/client";

export type GeocodeResult = { lat: number; lng: number; display_name: string };

export async function geocodeAddress(addr: string): Promise<GeocodeResult[]> {
  if (!addr?.trim()) return [];
  try {
    return await api<GeocodeResult[]>(`/geocode?q=${encodeURIComponent(addr.trim())}`);
  } catch {
    return [];
  }
}

export async function geocodeString(addr: string): Promise<{ lat: number; lng: number } | null> {
  const results = await geocodeAddress(addr);
  return results[0] ? { lat: results[0].lat, lng: results[0].lng } : null;
}

const styles = StyleSheet.create({
  webMap: { flex: 1, minHeight: 240, overflow: "hidden", backgroundColor: colors.bgMuted },
  webFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: spacing.xxl,
    backgroundColor: colors.bgMuted,
    borderRadius: radii.md,
  },
  mapLegend: {
    position: "absolute", left: 12, bottom: 12, width: 230,
    backgroundColor: "rgba(255,255,255,0.96)", borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, padding: 9,
  },
  legendHeader: { flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 5, borderBottomWidth: 1, borderBottomColor: colors.border },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  legendTitle: { fontSize: 10.5, fontWeight: "800", color: colors.inkSecondary, textTransform: "uppercase", letterSpacing: 0.5 },
  legendRow: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 7, borderBottomWidth: 1, borderBottomColor: colors.border },
  legendName: { fontSize: 10.5, fontWeight: "700", color: colors.ink },
  legendSub: { fontSize: 9.5, color: colors.inkMuted, marginTop: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  iconBtn: { padding: 8, minWidth: 40, minHeight: 40, alignItems: "center", justifyContent: "center" },
  pinListRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 10,
  },
  pinDot: { width: 12, height: 12, borderRadius: 6 },
});

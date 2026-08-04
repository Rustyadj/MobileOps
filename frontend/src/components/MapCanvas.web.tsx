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
}> = ({ pins, onPinPress, style }) => (
  <View style={[styles.webFallback, style]}>
    <Ionicons name="map-outline" size={40} color={colors.inkMuted} />
    <Text style={[typo.h3, { marginTop: 8, textAlign: "center" }]}>Map available on device</Text>
    <Text style={[typo.bodySmall, { textAlign: "center", marginTop: 6, paddingHorizontal: spacing.lg }]}>
      Open Concrete Form in Expo Go on your phone (or the installed APK) to view the live rental map.
    </Text>
    {pins.length > 0 ? (
      <View style={{ marginTop: spacing.lg, alignSelf: "stretch", paddingHorizontal: spacing.lg }}>
        <Text style={typo.caption}>Pinned rentals ({pins.length})</Text>
        {pins.map((p) => (
          <TouchableOpacity
            key={p.id}
            onPress={() => onPinPress?.(p)}
            style={styles.pinListRow}
            testID={`pin-list-${p.id}`}
          >
            <View style={[styles.pinDot, { backgroundColor: statusColor(p.status) }]} />
            <View style={{ flex: 1 }}>
              <Text style={typo.body}>{p.title}</Text>
              {p.subtitle ? <Text style={typo.bodySmall}>{p.subtitle}</Text> : null}
            </View>
            <Text style={[typo.caption, { fontFamily: "monospace" }]}>
              {p.lat.toFixed(3)}, {p.lng.toFixed(3)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    ) : null}
  </View>
);

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
              On web, enter coordinates manually. On your phone you'll get a tap-to-drop map.
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
  webFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: spacing.xxl,
    backgroundColor: colors.bgMuted,
    borderRadius: radii.md,
  },
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

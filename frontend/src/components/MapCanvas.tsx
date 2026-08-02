// Map + LocationPicker components.
// Native map via react-native-maps. On web we render a graceful placeholder.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Platform, TouchableOpacity, ActivityIndicator, Modal, Alert } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { Button, Row } from "@/src/components/ui";

// Load native map lazily so web doesn't fail at import time.
let MapView: any = null;
let Marker: any = null;
let PROVIDER_DEFAULT: any = undefined;
if (Platform.OS !== "web") {
  const mod = require("react-native-maps");
  MapView = mod.default;
  Marker = mod.Marker;
  PROVIDER_DEFAULT = mod.PROVIDER_DEFAULT;
}

let Location: any = null;
try {
  Location = require("expo-location");
} catch {}

export type Pin = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  subtitle?: string;
  status?: string;
};

const DEFAULT_REGION = {
  latitude: 39.8283, // continental US center
  longitude: -98.5795,
  latitudeDelta: 45,
  longitudeDelta: 45,
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
  if (Platform.OS === "web" || !MapView) {
    return (
      <View style={[styles.webFallback, style]}>
        <Ionicons name="map-outline" size={40} color={colors.inkMuted} />
        <Text style={[typo.h3, { marginTop: 8, textAlign: "center" }]}>Map available on device</Text>
        <Text style={[typo.bodySmall, { textAlign: "center", marginTop: 6, paddingHorizontal: spacing.lg }]}>
          Open Concrete Form in Expo Go on your phone (or the installed APK) to view live rental locations.
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
                <Text style={[typo.caption, { fontFamily: "monospace" }]}>{p.lat.toFixed(3)}, {p.lng.toFixed(3)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>
    );
  }

  const initial =
    center
      ? { latitude: center.lat, longitude: center.lng, latitudeDelta: 0.1, longitudeDelta: 0.1 }
      : pins.length > 0
      ? { latitude: pins[0].lat, longitude: pins[0].lng, latitudeDelta: 0.5, longitudeDelta: 0.5 }
      : DEFAULT_REGION;

  return (
    <MapView
      provider={PROVIDER_DEFAULT}
      style={[{ flex: 1 }, style]}
      initialRegion={initial}
      showsUserLocation
      showsMyLocationButton
    >
      {pins.map((p) => (
        <Marker
          key={p.id}
          coordinate={{ latitude: p.lat, longitude: p.lng }}
          title={p.title}
          description={p.subtitle}
          pinColor={statusColor(p.status)}
          onPress={() => onPinPress?.(p)}
        />
      ))}
    </MapView>
  );
};

/* -------- LocationPicker modal -------- */
export const LocationPicker: React.FC<{
  visible: boolean;
  initial?: { lat: number; lng: number } | null;
  onClose: () => void;
  onSave: (coords: { lat: number; lng: number }) => void;
}> = ({ visible, initial, onClose, onSave }) => {
  const insets = useSafeAreaInsets();
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(initial || null);
  const [locating, setLocating] = useState(false);
  const mapRef = useRef<any>(null);

  useEffect(() => {
    if (visible) setCoords(initial || null);
  }, [visible, initial]);

  const useCurrentLocation = async () => {
    if (!Location) {
      Alert.alert("Not available", "Location services are not installed.");
      return;
    }
    setLocating(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert("Permission needed", "Please allow location access in Settings to use current location.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setCoords(next);
      if (mapRef.current?.animateToRegion) {
        mapRef.current.animateToRegion({ latitude: next.lat, longitude: next.lng, latitudeDelta: 0.05, longitudeDelta: 0.05 }, 400);
      }
    } catch (e: any) {
      Alert.alert("Location error", e?.message || "Could not fetch location.");
    } finally {
      setLocating(false);
    }
  };

  const geocodeAddress = async (addr: string) => {
    if (!Location || !addr.trim()) return null;
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") return null;
      const res = await Location.geocodeAsync(addr);
      if (res && res[0]) return { lat: res[0].latitude, lng: res[0].longitude };
    } catch {}
    return null;
  };

  const save = () => {
    if (!coords) {
      Alert.alert("No location", "Pick a location before saving.");
      return;
    }
    onSave(coords);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
        <View style={[styles.header, { paddingTop: insets.top }]}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn} testID="loc-close">
            <Ionicons name="close" size={22} color={colors.ink} />
          </TouchableOpacity>
          <Text style={typo.h2}>Pick location</Text>
          <View style={{ flex: 1 }} />
        </View>

        {Platform.OS === "web" || !MapView ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
            <Ionicons name="map-outline" size={40} color={colors.inkMuted} />
            <Text style={[typo.h3, { marginTop: 8 }]}>Map picker requires a device</Text>
            <Text style={[typo.bodySmall, { textAlign: "center", marginTop: 6 }]}>
              On web, you can still paste lat/lng manually below, or open the app on your phone.
            </Text>
          </View>
        ) : (
          <MapView
            ref={mapRef}
            provider={PROVIDER_DEFAULT}
            style={{ flex: 1 }}
            initialRegion={
              coords
                ? { latitude: coords.lat, longitude: coords.lng, latitudeDelta: 0.05, longitudeDelta: 0.05 }
                : DEFAULT_REGION
            }
            onPress={(e: any) => {
              const c = e.nativeEvent.coordinate;
              setCoords({ lat: c.latitude, lng: c.longitude });
            }}
            showsUserLocation
          >
            {coords ? (
              <Marker
                draggable
                coordinate={{ latitude: coords.lat, longitude: coords.lng }}
                pinColor={colors.primary}
                onDragEnd={(e: any) => {
                  const c = e.nativeEvent.coordinate;
                  setCoords({ lat: c.latitude, lng: c.longitude });
                }}
              />
            ) : null}
          </MapView>
        )}

        <View style={styles.pickerFooter}>
          {coords ? (
            <Text style={[typo.bodySmall, { marginBottom: spacing.sm, fontFamily: "monospace" }]}>
              {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
            </Text>
          ) : (
            <Text style={[typo.bodySmall, { marginBottom: spacing.sm }]}>
              Tap the map to drop a pin, or use current location.
            </Text>
          )}
          <Row style={{ gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                title={locating ? "Locating…" : "Use current location"}
                onPress={useCurrentLocation}
                variant="outline"
                loading={locating}
                testID="loc-current-btn"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Save location" onPress={save} testID="loc-save-btn" />
            </View>
          </Row>
        </View>
      </SafeAreaView>
    </Modal>
  );
};

// Named export used by callers that want to geocode a job-site string.
export async function geocodeString(addr: string): Promise<{ lat: number; lng: number } | null> {
  if (!Location || !addr?.trim()) return null;
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") return null;
    const res = await Location.geocodeAsync(addr);
    if (res && res[0]) return { lat: res[0].latitude, lng: res[0].longitude };
  } catch {}
  return null;
}

const styles = StyleSheet.create({
  webFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: spacing.xxl,
    backgroundColor: colors.bgMuted,
    borderWidth: 1,
    borderColor: colors.border,
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
  pickerFooter: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
    backgroundColor: colors.bg,
  },
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

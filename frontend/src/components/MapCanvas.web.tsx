import "leaflet/dist/leaflet.css";
import React, { useEffect, useRef, useState } from "react";
import { Alert, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/src/api/client";
import { Button, Input, Row } from "@/src/components/ui";
import { colors, radii, spacing, type as typo } from "@/src/theme";
import { RENTAL_STATUS } from "@/src/domain/status";

export type Pin = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  subtitle?: string;
  status?: string;
};

type Coordinates = { lat: number; lng: number };

declare global {
  interface Window {
    L?: any;
    __mobileOpsLeafletPromise?: Promise<any>;
  }
}

function ensureLeaflet(): Promise<any> {
  if (window.L) return Promise.resolve(window.L);
  if (window.__mobileOpsLeafletPromise) return window.__mobileOpsLeafletPromise;

  window.__mobileOpsLeafletPromise = import("leaflet").then((module) => {
    const leaflet = module.default || module;
    window.L = leaflet;
    return leaflet;
  });

  return window.__mobileOpsLeafletPromise;
}

function statusColor(status?: string) {
  if (status === "shop") return colors.accent;
  if (status === RENTAL_STATUS.returned) return colors.success;
  if (status === RENTAL_STATUS.partiallyReturned) return colors.warning;
  return colors.primary;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#039;",
    '"': "&quot;",
  })[character] || character);
}

export const MapCanvas: React.FC<{
  pins: Pin[];
  onPinPress?: (pin: Pin) => void;
  onMapPress?: (coords: Coordinates) => void;
  center?: Coordinates;
  selectedId?: string | null;
  style?: any;
}> = ({ pins, onPinPress, onMapPress, center, selectedId, style }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerLayerRef = useRef<any>(null);
  const onPinPressRef = useRef(onPinPress);
  const onMapPressRef = useRef(onMapPress);
  const [mapState, setMapState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => { onPinPressRef.current = onPinPress; }, [onPinPress]);
  useEffect(() => { onMapPressRef.current = onMapPress; }, [onMapPress]);

  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current) return undefined;

    ensureLeaflet()
      .then((L) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true });
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 19,
        }).addTo(map);
        markerLayerRef.current = L.layerGroup().addTo(map);
        map.on("click", (event: any) => {
          onMapPressRef.current?.({ lat: event.latlng.lat, lng: event.latlng.lng });
        });
        map.setView([39.8283, -98.5795], 4);
        mapRef.current = map;
        setMapState("ready");
      })
      .catch(() => {
        if (!cancelled) setMapState("error");
      });

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!L || !map || !layer || mapState !== "ready") return;

    layer.clearLayers();
    const bounds: [number, number][] = [];
    pins.forEach((pin) => {
      const selected = pin.id === selectedId;
      const isShop = pin.status === "shop";
      const marker = L.circleMarker([pin.lat, pin.lng], {
        radius: selected ? 11 : isShop ? 10 : 8,
        color: "#FFFFFF",
        weight: selected ? 4 : 3,
        fillColor: statusColor(pin.status),
        fillOpacity: 1,
      });
      marker.bindTooltip(
        `<strong>${escapeHtml(pin.title)}</strong>${pin.subtitle ? `<br>${escapeHtml(pin.subtitle)}` : ""}`,
        { direction: "top", offset: [0, -8] },
      );
      marker.on("click", () => onPinPressRef.current?.(pin));
      marker.addTo(layer);
      bounds.push([pin.lat, pin.lng]);
    });

    if (center) map.flyTo([center.lat, center.lng], Math.max(map.getZoom(), 13), { duration: 0.5 });
    else if (bounds.length > 1) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
    else if (bounds.length === 1) map.setView(bounds[0], 13);
    else map.setView([39.8283, -98.5795], 4);
    window.setTimeout(() => map.invalidateSize(), 0);
  }, [center, mapState, pins, selectedId]);

  return (
    <View style={[styles.webMap, style]} testID="web-live-map">
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} data-testid="leaflet-map" />
      {mapState === "loading" ? (
        <View style={styles.mapMessage} pointerEvents="none">
          <Ionicons name="map-outline" size={24} color={colors.primary} />
          <Text style={[typo.bodySmall, { marginTop: 6 }]}>Loading live map…</Text>
        </View>
      ) : null}
      {mapState === "error" ? (
        <View style={styles.mapMessage}>
          <Ionicons name="cloud-offline-outline" size={24} color={colors.error} />
          <Text style={[typo.h3, { marginTop: 6 }]}>Map unavailable</Text>
          <Text style={[typo.bodySmall, styles.messageText]}>Rental locations and actions remain available in the list.</Text>
        </View>
      ) : null}
    </View>
  );
};

export const LocationPicker: React.FC<{
  visible: boolean;
  initial?: Coordinates | null;
  onClose: () => void;
  onSave: (coords: Coordinates) => void;
}> = ({ visible, initial, onClose, onSave }) => {
  const [coords, setCoords] = useState<Coordinates | null>(initial || null);
  const [lat, setLat] = useState(initial?.lat != null ? String(initial.lat) : "");
  const [lng, setLng] = useState(initial?.lng != null ? String(initial.lng) : "");

  useEffect(() => {
    if (!visible) return;
    setCoords(initial || null);
    setLat(initial?.lat != null ? String(initial.lat) : "");
    setLng(initial?.lng != null ? String(initial.lng) : "");
  }, [initial, visible]);

  const selectCoordinates = (next: Coordinates) => {
    setCoords(next);
    setLat(next.lat.toFixed(6));
    setLng(next.lng.toFixed(6));
  };

  const save = () => {
    const next = { lat: Number(lat), lng: Number(lng) };
    if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng) || next.lat < -90 || next.lat > 90 || next.lng < -180 || next.lng > 180) {
      Alert.alert("Invalid coordinates", "Latitude must be -90 to 90 and longitude must be -180 to 180.");
      return;
    }
    onSave(next);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.picker} edges={["top"]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn} testID="loc-close">
            <Ionicons name="close" size={22} color={colors.ink} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={typo.h2}>Set rental location</Text>
            <Text style={typo.bodySmall}>Click the map or enter coordinates.</Text>
          </View>
        </View>
        <View style={styles.pickerMap}>
          <MapCanvas
            pins={coords ? [{ id: "location", ...coords, title: "Selected location" }] : []}
            center={coords || undefined}
            selectedId="location"
            onMapPress={selectCoordinates}
          />
        </View>
        <View style={styles.pickerFooter}>
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

export type GeocodeResult = { lat: number; lng: number; display_name: string };

export async function geocodeAddress(addr: string): Promise<GeocodeResult[]> {
  if (!addr?.trim()) return [];
  try {
    return await api<GeocodeResult[]>(`/geocode?q=${encodeURIComponent(addr.trim())}`);
  } catch {
    return [];
  }
}

export async function geocodeString(addr: string): Promise<Coordinates | null> {
  const results = await geocodeAddress(addr);
  return results[0] ? { lat: results[0].lat, lng: results[0].lng } : null;
}

const styles = StyleSheet.create({
  webMap: { flex: 1, minHeight: 240, overflow: "hidden", backgroundColor: colors.bgMuted },
  mapMessage: {
    position: "absolute",
    top: "42%",
    alignSelf: "center",
    alignItems: "center",
    maxWidth: 280,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: "rgba(255,255,255,0.96)",
  },
  messageText: { textAlign: "center", marginTop: 4 },
  picker: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  iconBtn: { padding: 8, minWidth: 40, minHeight: 40, alignItems: "center", justifyContent: "center" },
  pickerMap: { flex: 1, minHeight: 280 },
  pickerFooter: { borderTopWidth: 1, borderTopColor: colors.border, padding: spacing.md, backgroundColor: colors.bg },
});

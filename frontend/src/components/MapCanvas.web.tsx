// Web MapCanvas — real Leaflet + OpenStreetMap map (no API key needed,
// pairs with the existing Nominatim /geocode backend proxy). Same public
// API as the native version (MapCanvas, LocationPicker, geocodeAddress,
// geocodeString, Pin) so callers don't need platform branches.
import "leaflet/dist/leaflet.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { Button, Row, Input } from "@/src/components/ui";
import { api } from "@/src/api/client";

export type Pin = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  subtitle?: string;
  status?: string;
};

const DEFAULT_CENTER: [number, number] = [39.8283, -98.5795]; // continental US
const DEFAULT_ZOOM = 4;

function statusColor(s?: string) {
  if (s === "returned") return colors.success;
  if (s === "partially_returned") return colors.warning;
  return colors.primary;
}

function dotIcon(color: string, selected?: boolean) {
  const size = selected ? 20 : 14;
  return L.divIcon({
    className: "cf-map-pin",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(15,23,42,0.4);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Fits the map to all pins whenever the pin set changes.
const FitToPins: React.FC<{ pins: Pin[] }> = ({ pins }) => {
  const map = useMap();
  useEffect(() => {
    if (pins.length === 0) return;
    if (pins.length === 1) {
      map.setView([pins[0].lat, pins[0].lng], 12);
      return;
    }
    const bounds = L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  }, [pins, map]);
  return null;
};

export const MapCanvas: React.FC<{
  pins: Pin[];
  onPinPress?: (p: Pin) => void;
  center?: { lat: number; lng: number };
  selectedId?: string | null;
  style?: any;
}> = ({ pins, onPinPress, center, selectedId, style }) => {
  const initialCenter: [number, number] = center ? [center.lat, center.lng] : pins[0] ? [pins[0].lat, pins[0].lng] : DEFAULT_CENTER;

  return (
    <View style={[{ flex: 1 }, style]}>
      <MapContainer
        center={initialCenter}
        zoom={pins.length ? 10 : DEFAULT_ZOOM}
        style={{ height: "100%", width: "100%" }}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {!center ? <FitToPins pins={pins} /> : null}
        {pins.map((p) => (
          <Marker
            key={p.id}
            position={[p.lat, p.lng]}
            icon={dotIcon(statusColor(p.status), p.id === selectedId)}
            eventHandlers={{ click: () => onPinPress?.(p) }}
          >
            <Popup>
              <strong>{p.title}</strong>
              {p.subtitle ? <div style={{ fontSize: 12, marginTop: 2 }}>{p.subtitle}</div> : null}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </View>
  );
};

/* -------- LocationPicker modal (web: click-to-drop-pin Leaflet map) -------- */
const ClickCapture: React.FC<{ onPick: (lat: number, lng: number) => void }> = ({ onPick }) => {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
};

const RecenterOnChange: React.FC<{ coords: { lat: number; lng: number } | null }> = ({ coords }) => {
  const map = useMap();
  useEffect(() => {
    if (coords) map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), 12));
  }, [coords, map]);
  return null;
};

export const LocationPicker: React.FC<{
  visible: boolean;
  initial?: { lat: number; lng: number } | null;
  onClose: () => void;
  onSave: (coords: { lat: number; lng: number }) => void;
}> = ({ visible, initial, onClose, onSave }) => {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(initial || null);
  const [locating, setLocating] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (visible) { setCoords(initial || null); setQuery(""); setResults([]); }
  }, [visible, initial]);

  const useCurrentLocation = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      Alert.alert("Not available", "Geolocation is not available in this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLocating(false); },
      () => { Alert.alert("Location error", "Could not get your current location."); setLocating(false); },
      { enableHighAccuracy: false, timeout: 8000 },
    );
  };

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const r = await geocodeAddress(query);
      setResults(r);
      if (r.length === 0) Alert.alert("No matches", "Try a more specific address.");
    } finally { setSearching(false); }
  };

  const save = () => {
    if (!coords) { Alert.alert("No location", "Click the map to drop a pin, or search an address."); return; }
    onSave(coords);
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn} testID="loc-close">
            <Ionicons name="close" size={22} color={colors.ink} />
          </TouchableOpacity>
          <Text style={typo.h2}>Pick location</Text>
        </View>

        <View style={styles.searchBar}>
          <Input
            value={query}
            onChangeText={setQuery}
            placeholder="Search an address…"
            autoCapitalize="words"
            returnKeyType="search"
            onSubmitEditing={search}
            testID="loc-search-input"
            style={{ marginBottom: 0, flex: 1 }}
          />
          <View style={{ width: 100, marginLeft: spacing.sm }}>
            <Button title={searching ? "…" : "Search"} onPress={search} variant="outline" loading={searching} testID="loc-search-btn" />
          </View>
        </View>
        {results.length > 0 ? (
          <View style={styles.resultsWrap}>
            {results.map((r, idx) => (
              <TouchableOpacity key={idx} style={styles.resultRow} onPress={() => { setCoords({ lat: r.lat, lng: r.lng }); setResults([]); setQuery(""); }} testID={`loc-result-${idx}`}>
                <Ionicons name="location-outline" size={14} color={colors.primary} />
                <Text style={{ flex: 1, fontSize: 12.5, marginLeft: 8 }} numberOfLines={1}>{r.display_name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <View style={{ flex: 1 }}>
          <MapContainer center={coords ? [coords.lat, coords.lng] : DEFAULT_CENTER} zoom={coords ? 12 : DEFAULT_ZOOM} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <ClickCapture onPick={(lat, lng) => setCoords({ lat, lng })} />
            <RecenterOnChange coords={coords} />
            {coords ? <Marker position={[coords.lat, coords.lng]} icon={dotIcon(colors.primary, true)} /> : null}
          </MapContainer>
        </View>

        <View style={styles.pickerFooter}>
          {coords ? (
            <Text style={{ marginBottom: spacing.sm, fontFamily: "monospace", fontSize: 13, color: colors.inkSecondary }}>
              {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
            </Text>
          ) : (
            <Text style={[typo.bodySmall, { marginBottom: spacing.sm }]}>Click the map to drop a pin, search an address, or use current location.</Text>
          )}
          <Row style={{ gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button title={locating ? "Locating…" : "Use current location"} onPress={useCurrentLocation} variant="outline" loading={locating} testID="loc-current-btn" />
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  iconBtn: { padding: 8, minWidth: 40, minHeight: 40, alignItems: "center", justifyContent: "center" },
  searchBar: { flexDirection: "row", alignItems: "center", padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  resultsWrap: { borderBottomWidth: 1, borderBottomColor: colors.border, maxHeight: 160 },
  resultRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  pickerFooter: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
    backgroundColor: colors.bg,
  },
});

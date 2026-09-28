// THE equipment selector. Any workflow that needs a piece of equipment picked
// — Repairs, tool checkout, rentals, inventory adjustments, transfers, yard
// counts, shop tasks — uses this and only this. Rule: a user must never have
// to scroll a long list of QR codes to find something.
//
// Four ways in, in priority order:
//   1. plain-language search (name, model, manufacturer, category, notes)
//   2. category filter chips
//   3. QR scan (see ScanField — hardware wedge scanners type + Enter; a
//      camera scanner can be dropped in behind the same onScan contract)
//   4. recently used
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Modal, FlatList, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { SearchInput } from "@/src/components/data/SearchInput";
import { FilterChips } from "@/src/components/data/FilterBar";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import type { LedgerEquipment } from "@/src/hooks/use-equipment-ledger";
import { rollupEquipment } from "@/src/utils/inventory-rollup";
import { BRACING_CATEGORIES, SCAFFOLDING_CATEGORIES } from "@/src/utils/inventory-categories";

const BRACING_KEYS = new Set(BRACING_CATEGORIES.map((c) => c.key));
const SCAFFOLDING_KEYS = new Set(SCAFFOLDING_CATEGORIES.map((c) => c.key));

export const EQUIPMENT_CATEGORY_FILTERS = [
  { key: "all", label: "All" },
  { key: "bracing", label: "Bracing" },
  { key: "scaffolding", label: "Crankups/Shoring" },
  { key: "tool", label: "Tools" },
  { key: "consumable", label: "Consumables" },
  { key: "icf_block", label: "ICF Block" },
];

export function matchesCategoryFilter(item: LedgerEquipment, filter: string): boolean {
  switch (filter) {
    case "all": return true;
    case "bracing": return BRACING_KEYS.has(item.category);
    case "scaffolding": return SCAFFOLDING_KEYS.has(item.category);
    case "tool": return item.category === "tool";
    case "consumable": return item.category === "consumable";
    case "icf_block": return item.category === "icf_block";
    default: return item.category === filter;
  }
}

/** Plain-language match across every identifier an operator might type. */
export function matchesEquipmentQuery(item: LedgerEquipment, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    item.name, item.qr_code, item.serial_number, item.sku, item.model,
    item.category?.replace(/_/g, " "), item.location, item.notes, item.condition,
  ].filter(Boolean).join(" ").toLowerCase();
  // every whitespace-separated term must appear — "multiquip cutter" works
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

/** Exact-identifier lookup for a scan. QR first, then serial, then SKU. */
export function findByScan(equipment: LedgerEquipment[], code: string): LedgerEquipment | undefined {
  const c = code.trim().toLowerCase();
  if (!c) return undefined;
  return equipment.find((e) => (e.qr_code || "").trim().toLowerCase() === c)
    || equipment.find((e) => (e.serial_number || "").trim().toLowerCase() === c)
    || equipment.find((e) => (e.sku || "").trim().toLowerCase() === c);
}

const RECENT_KEY = "cf_recent_equipment";
const RECENT_MAX = 6;

// storage only round-trips scalars, so the recent list is a comma-joined
// string of equipment ids.
export function useRecentEquipment() {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    storage.getItem<string>(RECENT_KEY, "").then((raw) => setIds((raw || "").split(",").filter(Boolean)));
  }, []);
  const remember = useCallback((id: string) => {
    setIds((current) => {
      const next = [id, ...current.filter((x) => x !== id)].slice(0, RECENT_MAX);
      void storage.setItem(RECENT_KEY, next.join(","));
      return next;
    });
  }, []);
  return { recentIds: ids, remember };
}

/** One equipment row: identity first, status second, QR last — never a bare QR list. */
export const EquipmentResultRow: React.FC<{
  item: LedgerEquipment;
  onPress: () => void;
  selected?: boolean;
  testID?: string;
}> = ({ item, onPress, selected, testID }) => {
  const rollup = rollupEquipment(item);
  const statusLabel = rollup.repair > 0 ? "Repair" : rollup.available > 0 ? "Available" : rollup.out > 0 ? "Out" : rollup.reserved > 0 ? "Reserved" : "Unavailable";
  const statusTone = rollup.repair > 0 ? colors.error : rollup.available > 0 ? colors.success : colors.inkSecondary;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.65} style={[styles.resultRow, selected && styles.resultRowSelected]} testID={testID}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.resultName} numberOfLines={1}>{item.name}{item.model ? ` ${item.model}` : ""}</Text>
        <Text style={styles.resultIds} numberOfLines={1}>
          {item.qr_code ? `QR ${item.qr_code}` : "QR not assigned"}
          {item.serial_number ? `  ·  Serial ${item.serial_number}` : ""}
        </Text>
        <Text style={styles.resultMeta} numberOfLines={1}>
          {(item.category || "").replace(/_/g, " ")} • {item.location || "No location"} • <Text style={{ color: statusTone, fontWeight: "700" }}>{statusLabel}</Text>
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.inkMuted} />
    </TouchableOpacity>
  );
};

/**
 * Camera QR scanner with a keyboard/wedge scanner fallback. The callback is
 * disabled immediately after a read because CameraView can report the same
 * code across several adjacent frames.
 */
export const ScanField: React.FC<{ onScan: (code: string) => void; onClose: () => void; visible: boolean }> = ({ onScan, onClose, visible }) => {
  const [code, setCode] = useState("");
  const [scanned, setScanned] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const ref = useRef<TextInput>(null);
  const scanLock = useRef(false);
  const permissionRequested = useRef(false);

  useEffect(() => {
    if (!visible) {
      permissionRequested.current = false;
      return;
    }
    setCode("");
    setScanned(false);
    scanLock.current = false;
    if (!permission?.granted && permission?.canAskAgain !== false && !permissionRequested.current) {
      permissionRequested.current = true;
      void requestPermission();
    }
  }, [visible, permission?.granted, permission?.canAskAgain, requestPermission]);

  if (!visible) return null;

  const submitCode = (value: string) => {
    const clean = value.trim();
    if (!clean || scanLock.current) return;
    scanLock.current = true;
    setScanned(true);
    onScan(clean);
    setCode("");
  };
  const handleBarcode = ({ data }: BarcodeScanningResult) => submitCode(data);

  return (
    <View style={styles.scanner} testID="equipment-scan-bar">
      <View style={styles.scannerHeader}>
        <Text style={styles.scannerTitle}>Scan equipment QR</Text>
        <TouchableOpacity onPress={onClose} testID="equipment-scan-close" accessibilityLabel="Close scanner">
          <Ionicons name="close" size={20} color={colors.ink} />
        </TouchableOpacity>
      </View>

      {!permission ? (
        <View style={styles.cameraMessage}><ActivityIndicator color={colors.primary} /><Text style={styles.cameraMessageText}>Checking camera access…</Text></View>
      ) : permission.granted ? (
        <View style={styles.cameraFrame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scanned ? undefined : handleBarcode}
            testID="equipment-camera-view"
          />
          <View pointerEvents="none" style={styles.scanTarget} />
          <Text pointerEvents="none" style={styles.scanHint}>Hold the equipment tag inside the frame</Text>
        </View>
      ) : (
        <View style={styles.cameraMessage}>
          <Ionicons name="camera-outline" size={24} color={colors.inkSecondary} />
          <Text style={styles.cameraMessageText}>Camera access is needed to scan a QR code.</Text>
          {permission.canAskAgain ? <TouchableOpacity style={styles.permissionBtn} onPress={() => void requestPermission()}><Text style={styles.permissionBtnText}>Allow camera</Text></TouchableOpacity> : null}
        </View>
      )}

      <View style={styles.scanBar}>
        <Ionicons name="keypad-outline" size={18} color={colors.primary} />
        <TextInput
          ref={ref}
          value={code}
          onChangeText={setCode}
          onSubmitEditing={() => submitCode(code)}
          placeholder="Or type / hardware-scan QR, serial, or SKU"
          placeholderTextColor={colors.inkMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.scanInput}
          testID="equipment-scan-input"
        />
      </View>
    </View>
  );
};

/** Search + chips + scan toggle, for embedding at the top of a list screen. */
export const EquipmentSearchBar: React.FC<{
  query: string;
  onQueryChange: (q: string) => void;
  category?: string;
  onCategoryChange?: (key: string) => void;
  categories?: { key: string; label: string }[];
  onScan?: (code: string) => void;
  placeholder?: string;
  right?: React.ReactNode;
  testIDPrefix?: string;
}> = ({ query, onQueryChange, category, onCategoryChange, categories, onScan, placeholder, right, testIDPrefix = "equipment" }) => {
  const [scanning, setScanning] = useState(false);
  return (
    <View style={styles.searchWrap}>
      <View style={styles.searchRow}>
        <SearchInput
          value={query}
          onChangeText={onQueryChange}
          placeholder={placeholder || "Search equipment, QR, serial, model, name, category…"}
          testID={`${testIDPrefix}-search`}
          style={{ flex: 1 }}
        />
        {onScan ? (
          <TouchableOpacity onPress={() => setScanning((v) => !v)} style={[styles.scanBtn, scanning && styles.scanBtnActive]} activeOpacity={0.75} testID={`${testIDPrefix}-scan-btn`} accessibilityLabel="Scan QR code">
            <Ionicons name="qr-code-outline" size={18} color={scanning ? "#FFF" : colors.ink} />
            <Text style={[styles.scanBtnText, scanning && styles.scanBtnTextActive]}>Scan</Text>
          </TouchableOpacity>
        ) : null}
        {right}
      </View>
      {onScan ? <ScanField visible={scanning} onClose={() => setScanning(false)} onScan={(code) => { onScan(code); setScanning(false); }} /> : null}
      {categories && onCategoryChange ? (
        <FilterChips options={categories} value={category || "all"} onChange={onCategoryChange} testIDPrefix={`${testIDPrefix}-filter`} />
      ) : null}
    </View>
  );
};

/** Modal equipment picker for any "choose a piece of equipment" step. */
export const EquipmentPicker: React.FC<{
  visible: boolean;
  equipment: LedgerEquipment[];
  onSelect: (item: LedgerEquipment) => void;
  onClose: () => void;
  title?: string;
  filter?: (item: LedgerEquipment) => boolean;
  testID?: string;
}> = ({ visible, equipment, onSelect, onClose, title = "Select equipment", filter, testID = "equipment-picker" }) => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const { recentIds, remember } = useRecentEquipment();

  useEffect(() => { if (visible) { setQuery(""); setCategory("all"); } }, [visible]);

  const pool = useMemo(() => (filter ? equipment.filter(filter) : equipment), [equipment, filter]);
  const results = useMemo(
    () => pool.filter((item) => matchesCategoryFilter(item, category) && matchesEquipmentQuery(item, query)).slice(0, 60),
    [pool, category, query],
  );
  const recent = useMemo(
    () => recentIds.map((id) => pool.find((item) => item.id === id)).filter((x): x is LedgerEquipment => !!x),
    [recentIds, pool],
  );

  const choose = (item: LedgerEquipment) => { remember(item.id); onSelect(item); };
  const scan = (code: string) => {
    const hit = findByScan(pool, code);
    if (hit) choose(hit);
    else setQuery(code); // no exact match — fall back to showing it as a search
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID={testID}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} testID={`${testID}-close`} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.ink} />
            </TouchableOpacity>
          </View>
          <View style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm }}>
            <EquipmentSearchBar
              query={query} onQueryChange={setQuery}
              category={category} onCategoryChange={setCategory}
              categories={EQUIPMENT_CATEGORY_FILTERS}
              onScan={scan}
              testIDPrefix={testID}
            />
          </View>
          {!query && category === "all" && recent.length ? (
            <View style={styles.recentBlock}>
              <Text style={styles.recentLabel}>RECENTLY USED</Text>
              {recent.map((item) => (
                <EquipmentResultRow key={`recent-${item.id}`} item={item} onPress={() => choose(item)} testID={`${testID}-recent-${item.id}`} />
              ))}
            </View>
          ) : null}
          <FlatList
            data={results}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => <EquipmentResultRow item={item} onPress={() => choose(item)} testID={`${testID}-result-${item.id}`} />}
            ListEmptyComponent={<Text style={styles.empty}>No equipment matches “{query}”. Try a name, model, serial or QR.</Text>}
          />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  searchWrap: { gap: spacing.sm },
  searchRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  scanBtn: { flexDirection: "row", alignItems: "center", gap: 6, height: 40, paddingHorizontal: 14, borderRadius: radii.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.bg },
  scanBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  scanBtnText: { fontSize: 13, fontWeight: "700", color: colors.ink },
  scanBtnTextActive: { color: "#FFF" },
  scanner: { borderRadius: radii.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.bg, overflow: "hidden" },
  scannerHeader: { height: 42, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  scannerTitle: { ...typo.bodySmall, fontWeight: "700", color: colors.ink },
  cameraFrame: { height: 220, overflow: "hidden", backgroundColor: "#08111F", alignItems: "center", justifyContent: "center" },
  scanTarget: { width: 172, height: 172, borderWidth: 2, borderColor: "#FFF", borderRadius: radii.md, backgroundColor: "transparent" },
  scanHint: { position: "absolute", bottom: 10, color: "#FFF", fontSize: 12, fontWeight: "600", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 9, paddingVertical: 5, borderRadius: radii.sm },
  cameraMessage: { minHeight: 130, padding: spacing.md, gap: spacing.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.bgMuted },
  cameraMessageText: { ...typo.bodySmall, color: colors.inkSecondary, textAlign: "center" },
  permissionBtn: { backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: radii.md },
  permissionBtnText: { color: "#FFF", fontSize: 13, fontWeight: "700" },
  scanBar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, height: 44, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.primarySoft },
  scanInput: { flex: 1, fontSize: 14, color: colors.ink, height: "100%" },
  resultRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 9, paddingHorizontal: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, minHeight: 62 },
  resultRowSelected: { backgroundColor: colors.primarySoft },
  resultName: { ...typo.body, fontSize: 14.5, fontWeight: "700" },
  resultIds: { ...typo.bodySmall, fontSize: 11.5, fontFamily: undefined, marginTop: 1 },
  resultMeta: { ...typo.bodySmall, fontSize: 11.5, marginTop: 1, textTransform: "capitalize" },
  backdrop: { flex: 1, backgroundColor: "rgba(6,27,51,0.45)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, maxHeight: "88%", minHeight: "60%", overflow: "hidden" },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, height: 52, borderBottomWidth: 1, borderBottomColor: colors.border },
  sheetTitle: { ...typo.h3, fontSize: 16 },
  recentBlock: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingTop: spacing.sm },
  recentLabel: { ...typo.caption, fontSize: 9.5, paddingHorizontal: spacing.md, marginBottom: 2 },
  empty: { ...typo.bodySmall, padding: spacing.lg, textAlign: "center" },
});

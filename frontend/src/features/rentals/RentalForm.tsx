// New/Edit rental — sectioned instead of one long scroll: Customer, Job
// Site/Location, Equipment, Review. Rendered inside DetailDrawer (wide
// right-side panel on desktop, full-screen sheet on phone) so the same
// component serves both. All existing geocoding/address-search/map-pick/
// quantity/deposit/notes/editing behavior is preserved verbatim.
import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, Input, Button, Mono, SectionLabel, Row, H3 } from "@/src/components/ui";
import { SearchInput } from "@/src/components/data/SearchInput";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { LocationPicker, geocodeString, geocodeAddress, GeocodeResult } from "@/src/components/MapCanvas";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import type { Eq, Line } from "./useRentals";

type Section = "customer" | "site" | "equipment" | "review";
const SECTIONS: { key: Section; label: string }[] = [
  { key: "customer", label: "Customer" },
  { key: "site", label: "Job Site" },
  { key: "equipment", label: "Equipment" },
  { key: "review", label: "Review" },
];

export const RentalForm: React.FC<{
  visible: boolean;
  draft: any;
  setDraft: (updater: any) => void;
  equipment: Eq[];
  onClose: () => void;
  onSave: () => Promise<void>;
}> = ({ visible, draft, setDraft, equipment, onClose, onSave }) => {
  const [section, setSection] = useState<Section>("customer");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addressQuery, setAddressQuery] = useState("");
  const [addressResults, setAddressResults] = useState<GeocodeResult[]>([]);
  const [addressBusy, setAddressBusy] = useState(false);
  const [eqSearch, setEqSearch] = useState("");
  const [qtyPrompt, setQtyPrompt] = useState<{ eq: Eq; qty: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const draftGeocode = async () => {
    if (!draft?.job_site?.trim()) {
      Alert.alert("No address", "Enter a Job Site address first, then tap Geocode.");
      return;
    }
    const coords = await geocodeString(draft.job_site);
    if (coords) setDraft({ ...draft, lat: coords.lat, lng: coords.lng });
    else Alert.alert("Geocode failed", "Couldn't resolve that address. Try 'Pick on map' or search a different address.");
  };

  const searchAddress = async () => {
    const q = addressQuery.trim();
    if (!q) return;
    setAddressBusy(true);
    try {
      const results = await geocodeAddress(q);
      setAddressResults(results);
      if (results.length === 0) Alert.alert("No matches", "Try a more specific address (street, city, state).");
    } finally { setAddressBusy(false); }
  };

  const pickAddress = (r: GeocodeResult) => {
    setDraft({ ...draft, lat: r.lat, lng: r.lng, job_site: draft.job_site?.trim() ? draft.job_site : r.display_name });
    setAddressResults([]);
    setAddressQuery("");
  };

  const addLine = (eq: Eq) => {
    const existing = draft.lines?.find((l: Line) => l.equipment_id === eq.id);
    setQtyPrompt({ eq, qty: existing ? String(existing.qty) : "1" });
  };

  const confirmQty = () => {
    if (!qtyPrompt) return;
    const parsed = parseInt(qtyPrompt.qty, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      Alert.alert("Invalid quantity", "Enter a positive whole number.");
      return;
    }
    const eq = qtyPrompt.eq;
    const currentOnLine = draft.lines?.find((l: Line) => l.equipment_id === eq.id)?.qty || 0;
    const extra = parsed - currentOnLine;
    if (extra > eq.available) {
      Alert.alert("Not enough on hand", `Only ${eq.available} of ${eq.name} available. Reduce the quantity or free up inventory first.`);
      return;
    }
    setDraft((d: any) => {
      const existingLine = d.lines.find((l: Line) => l.equipment_id === eq.id);
      if (existingLine) return { ...d, lines: d.lines.map((l: Line) => l.equipment_id === eq.id ? { ...l, qty: parsed } : l) };
      return { ...d, lines: [...d.lines, { equipment_id: eq.id, sku: eq.sku, name: eq.name, qty: parsed, daily_rate: eq.daily_rate, returned_qty: 0 }] };
    });
    setQtyPrompt(null);
  };

  const updateQty = (id: string, qty: number) => {
    setDraft((d: any) => ({ ...d, lines: d.lines.map((l: Line) => l.equipment_id === id ? { ...l, qty: Math.max(0, qty) } : l).filter((l: Line) => l.qty > 0) }));
  };

  const handleSave = async () => {
    if (!draft.customer_name || draft.lines.length === 0) {
      Alert.alert("Required", "Customer name and at least one line item.");
      setSection(!draft.customer_name ? "customer" : "equipment");
      return;
    }
    setSaving(true);
    try { await onSave(); }
    catch (e: any) { Alert.alert("Save failed", e.message); }
    finally { setSaving(false); }
  };

  const filteredEquipment = useMemo(() => {
    const q = eqSearch.trim().toLowerCase();
    if (!q) return equipment;
    return equipment.filter((e) => e.name.toLowerCase().includes(q) || e.sku.toLowerCase().includes(q));
  }, [equipment, eqSearch]);

  if (!visible || !draft) return null;

  const totalQty = (draft.lines || []).reduce((s: number, l: Line) => s + l.qty, 0);

  return (
    <>
      <DetailDrawer
        visible={visible}
        title={draft.id ? "Edit Rental" : "New Rental"}
        subtitle={draft.customer_name || "New"}
        onClose={onClose}
        width={560}
        testID="rental-form-drawer"
      >
        <View style={styles.tabs} testID="rental-form-tabs">
          {SECTIONS.map((s) => (
            <TouchableOpacity key={s.key} onPress={() => setSection(s.key)} style={[styles.tab, section === s.key && styles.tabActive]} testID={`rental-form-tab-${s.key}`}>
              <Text style={[styles.tabText, section === s.key && styles.tabTextActive]}>{s.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {section === "customer" ? (
          <View>
            <Input label="Customer Name" value={draft.customer_name || ""} onChangeText={(t) => setDraft({ ...draft, customer_name: t })} testID="cust-name" />
            <Input label="Phone" value={draft.customer_phone || ""} onChangeText={(t) => setDraft({ ...draft, customer_phone: t })} keyboardType="phone-pad" mono testID="cust-phone" />
            <Input label="Email" value={draft.customer_email || ""} onChangeText={(t) => setDraft({ ...draft, customer_email: t })} keyboardType="email-address" autoCapitalize="none" testID="cust-email" />
          </View>
        ) : null}

        {section === "site" ? (
          <View>
            <Input label="Job Site" value={draft.job_site || ""} onChangeText={(t) => setDraft({ ...draft, job_site: t })} testID="cust-site" />
            <Input
              label="Start date (yyyy-mm-dd)"
              value={draft.start_date?.slice(0, 10) || ""}
              onChangeText={(t) => setDraft({ ...draft, start_date: new Date(t).toISOString() })}
              mono
              autoCapitalize="none"
              testID="start-date"
            />
            <Input label="Deposit ($)" value={String(draft.deposit ?? 0)} onChangeText={(t) => setDraft({ ...draft, deposit: Number(t) || 0 })} keyboardType="decimal-pad" mono testID="deposit" />
            <Input label="Notes" value={draft.notes || ""} onChangeText={(t) => setDraft({ ...draft, notes: t })} testID="notes" />

            <SectionLabel>Location</SectionLabel>
            <Card style={{ marginBottom: spacing.md }}>
              {draft.lat != null && draft.lng != null ? (
                <Row style={{ gap: 6, marginBottom: spacing.sm }}>
                  <Ionicons name="location" size={14} color={colors.primary} />
                  <Mono style={{ fontSize: 13 }}>{Number(draft.lat).toFixed(5)}, {Number(draft.lng).toFixed(5)}</Mono>
                </Row>
              ) : (
                <Text style={[typo.bodySmall, { marginBottom: spacing.sm }]}>No location set. Search an address, use the Job Site field, or pick on map.</Text>
              )}
              <Input
                label="Search address"
                value={addressQuery}
                onChangeText={setAddressQuery}
                placeholder="123 Main St, Springfield, IL"
                autoCapitalize="words"
                returnKeyType="search"
                onSubmitEditing={searchAddress}
                testID="address-search-input"
              />
              <Button title={addressBusy ? "Searching…" : "Search address"} onPress={searchAddress} variant="outline" loading={addressBusy} testID="address-search-btn" />
              {addressResults.length > 0 ? (
                <View style={styles.resultsWrap} testID="address-results">
                  {addressResults.map((r, idx) => (
                    <TouchableOpacity key={`${r.lat}-${r.lng}-${idx}`} onPress={() => pickAddress(r)} style={styles.resultRow} testID={`address-result-${idx}`}>
                      <Ionicons name="location-outline" size={16} color={colors.primary} />
                      <View style={{ flex: 1 }}>
                        <Text style={[typo.body, { fontSize: 13 }]} numberOfLines={2}>{r.display_name}</Text>
                        <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{r.lat.toFixed(4)}, {r.lng.toFixed(4)}</Mono>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
              <View style={{ height: spacing.sm }} />
              <Row style={{ gap: spacing.sm }}>
                <View style={{ flex: 1 }}><Button title="Pick on map" onPress={() => setPickerOpen(true)} variant="outline" testID="draft-pick-map" /></View>
                <View style={{ flex: 1 }}><Button title="Geocode job site" onPress={draftGeocode} variant="outline" testID="draft-geocode" /></View>
              </Row>
            </Card>
          </View>
        ) : null}

        {section === "equipment" ? (
          <View>
            {(draft.lines || []).length > 0 ? (
              <>
                <SectionLabel>Selected equipment ({draft.lines.length}) · {totalQty} total</SectionLabel>
                {(draft.lines || []).map((l: Line) => (
                  <Card key={l.equipment_id} style={{ marginBottom: spacing.sm }}>
                    <Row style={{ justifyContent: "space-between" }}>
                      <View style={{ flex: 1 }}>
                        <Text style={typo.body}>{l.name}</Text>
                        <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{l.sku} · ${l.daily_rate}/d</Mono>
                      </View>
                      <TouchableOpacity onPress={() => updateQty(l.equipment_id, l.qty - 1)} style={styles.qtyBtn} testID={`qty-minus-${l.sku}`}><Text style={styles.qtyText}>−</Text></TouchableOpacity>
                      <Mono style={{ marginHorizontal: 12, fontSize: 18 }}>{l.qty}</Mono>
                      <TouchableOpacity onPress={() => updateQty(l.equipment_id, l.qty + 1)} style={styles.qtyBtn} testID={`qty-plus-${l.sku}`}><Text style={styles.qtyText}>+</Text></TouchableOpacity>
                    </Row>
                  </Card>
                ))}
                <View style={{ height: spacing.md }} />
              </>
            ) : null}

            <SectionLabel>Add equipment</SectionLabel>
            <SearchInput value={eqSearch} onChangeText={setEqSearch} placeholder="Search by name or SKU…" testID="eq-picker-search" style={{ marginBottom: spacing.sm, width: "100%" }} />
            <View style={{ borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md }} testID="add-eq-list">
              {filteredEquipment.length === 0 ? (
                <Text style={[typo.bodySmall, { padding: spacing.md }]}>No equipment matches &quot;{eqSearch}&quot;.</Text>
              ) : filteredEquipment.map((e) => (
                <TouchableOpacity key={e.id} onPress={() => addLine(e)} style={styles.eqRow} testID={`add-eq-${e.sku}`}>
                  <View style={{ flex: 1 }}>
                    <Text style={typo.body}>{e.name}</Text>
                    <Mono style={{ fontSize: 11, color: e.available > 0 ? colors.inkMuted : colors.error }}>{e.sku} · {e.available} avail · ${e.daily_rate}/d</Mono>
                  </View>
                  <Ionicons name="add-circle" size={26} color={e.available > 0 ? colors.accent : colors.inkMuted} />
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        {section === "review" ? (
          <View>
            <SectionLabel>Summary</SectionLabel>
            <Card style={{ marginBottom: spacing.md }}>
              <Text style={typo.h3}>{draft.customer_name || "—"}</Text>
              <Text style={[typo.bodySmall, { marginTop: 2 }]}>{draft.job_site || "No job site set"}</Text>
              <Row style={{ marginTop: spacing.sm, gap: spacing.lg, flexWrap: "wrap" }}>
                <Text style={typo.label}>Start <Mono style={{ fontSize: 13 }}>{draft.start_date ? new Date(draft.start_date).toLocaleDateString() : "—"}</Mono></Text>
                <Text style={typo.label}>Deposit <Mono style={{ fontSize: 13 }}>${draft.deposit || 0}</Mono></Text>
                <Text style={typo.label}>Items <Mono style={{ fontSize: 13 }}>{totalQty}</Mono></Text>
              </Row>
            </Card>
            <SectionLabel>Line items ({(draft.lines || []).length})</SectionLabel>
            {(draft.lines || []).length === 0 ? (
              <Text style={[typo.bodySmall, { marginBottom: spacing.md }]}>No equipment selected yet — go to the Equipment tab.</Text>
            ) : (draft.lines || []).map((l: Line) => (
              <Row key={l.equipment_id} style={styles.reviewLine}>
                <Text style={{ flex: 1 }}>{l.name}</Text>
                <Mono>{l.qty}</Mono>
              </Row>
            ))}
            {draft.notes ? (
              <>
                <View style={{ height: spacing.sm }} />
                <SectionLabel>Notes</SectionLabel>
                <Text style={typo.body}>{draft.notes}</Text>
              </>
            ) : null}
          </View>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Button title={draft.id ? "Save Changes" : "Save Rental"} onPress={handleSave} loading={saving} testID="save-rental-btn" />
      </DetailDrawer>

      <LocationPicker
        visible={pickerOpen}
        initial={draft.lat != null && draft.lng != null ? { lat: draft.lat, lng: draft.lng } : null}
        onClose={() => setPickerOpen(false)}
        onSave={(coords) => { setDraft({ ...draft, lat: coords.lat, lng: coords.lng }); setPickerOpen(false); }}
      />

      <Modal visible={!!qtyPrompt} transparent animationType="fade" onRequestClose={() => setQtyPrompt(null)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setQtyPrompt(null)} style={styles.qtyBackdrop}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.qtyDialog} testID="qty-dialog">
            {qtyPrompt ? (
              <>
                <H3>{qtyPrompt.eq.name}</H3>
                <Text style={[typo.bodySmall, { marginTop: 4, marginBottom: spacing.md }]}>{qtyPrompt.eq.sku} · {qtyPrompt.eq.available} available</Text>
                <Input
                  label="Quantity"
                  value={qtyPrompt.qty}
                  onChangeText={(t) => setQtyPrompt({ ...qtyPrompt, qty: t.replace(/[^0-9]/g, "") })}
                  keyboardType="number-pad"
                  autoFocus
                  mono
                  returnKeyType="done"
                  onSubmitEditing={confirmQty}
                  testID="qty-dialog-input"
                />
                <Row style={{ gap: spacing.sm }}>
                  <View style={{ flex: 1 }}><Button title="Cancel" onPress={() => setQtyPrompt(null)} variant="outline" testID="qty-dialog-cancel" /></View>
                  <View style={{ flex: 1 }}><Button title="Add" onPress={confirmQty} testID="qty-dialog-confirm" /></View>
                </Row>
              </>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, marginBottom: spacing.lg, overflow: "hidden" },
  tab: { flex: 1, height: 38, alignItems: "center", justifyContent: "center", borderRightWidth: 1, borderRightColor: colors.border },
  tabActive: { backgroundColor: colors.ink },
  tabText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
  tabTextActive: { color: "#FFF" },
  qtyBtn: { width: 36, height: 36, borderWidth: 1, borderColor: colors.ink, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
  qtyText: { fontSize: 20, fontWeight: "800", color: colors.ink },
  eqRow: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  resultsWrap: { marginTop: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 6, overflow: "hidden" },
  resultRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bgMuted },
  reviewLine: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  qtyBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  qtyDialog: { backgroundColor: colors.bg, borderRadius: 8, padding: 20, width: "100%", maxWidth: 360 },
});

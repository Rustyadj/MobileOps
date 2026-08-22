import React, { useState } from "react";
import { View, Alert } from "react-native";
import { Input, Button, SectionLabel, Row } from "@/src/components/ui";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { spacing } from "@/src/theme";
import { CATEGORY_OPTIONS, Vendor } from "./useVendors";

export const VendorForm: React.FC<{
  visible: boolean;
  editing: Partial<Vendor> | null;
  setEditing: (updater: any) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
}> = ({ visible, editing, setEditing, onClose, onSave }) => {
  const [saving, setSaving] = useState(false);
  if (!visible || !editing) return null;

  const toggleCat = (c: string) => {
    setEditing((v: any) => {
      const cur: string[] = v?.categories || [];
      return { ...v, categories: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c] };
    });
  };

  const handleSave = async () => {
    if (!editing.name) { Alert.alert("Required", "Vendor name"); return; }
    setSaving(true);
    try { await onSave(); }
    catch (e: any) { Alert.alert("Save failed", e.message); }
    finally { setSaving(false); }
  };

  return (
    <DetailDrawer visible={visible} title={editing.id ? "Edit Vendor" : "New Vendor"} onClose={onClose} testID="vendor-form-drawer">
      <Input label="Name" value={editing.name || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, name: t }))} testID="v-name" />
      <Input label="Contact" value={editing.contact_name || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, contact_name: t }))} testID="v-contact" />
      <Row style={{ gap: spacing.md }}>
        <View style={{ flex: 1 }}><Input label="Phone" value={editing.phone || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, phone: t }))} keyboardType="phone-pad" mono testID="v-phone" /></View>
        <View style={{ flex: 1 }}><Input label="Email" value={editing.email || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, email: t }))} keyboardType="email-address" autoCapitalize="none" testID="v-email" /></View>
      </Row>
      <Input label="Address" value={editing.address || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, address: t }))} testID="v-address" />
      <SectionLabel>Categories</SectionLabel>
      <Row style={{ gap: 8, flexWrap: "wrap", marginBottom: spacing.md }}>
        {CATEGORY_OPTIONS.map((c) => {
          const active = (editing.categories || []).includes(c);
          return (
            <View key={c} style={{ flexShrink: 0 }}>
              <Button title={c} onPress={() => toggleCat(c)} variant={active ? "primary" : "outline"} fullWidth={false} testID={`v-cat-${c}`} />
            </View>
          );
        })}
      </Row>
      <Input label="Freight Terms" value={editing.freight_terms || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, freight_terms: t }))} testID="v-freight" />
      <Row style={{ gap: spacing.md }}>
        <View style={{ flex: 1 }}><Input label="Truck Capacity" value={editing.truck_capacity || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, truck_capacity: t }))} mono testID="v-truck" /></View>
        <View style={{ flex: 1 }}><Input label="Lead (days)" value={String(editing.lead_time_days ?? 0)} onChangeText={(t) => setEditing((v: any) => ({ ...v, lead_time_days: Number(t) || 0 }))} keyboardType="number-pad" mono testID="v-lead" /></View>
      </Row>
      <Input label="Notes" value={editing.notes || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, notes: t }))} testID="v-notes" />
      <Button title="Save" onPress={handleSave} loading={saving} testID="save-vendor-btn" />
    </DetailDrawer>
  );
};

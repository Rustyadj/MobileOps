// New/Edit equipment — same fields as the original inline modal, moved
// into DetailDrawer so it's a right-side panel on desktop and a
// full-screen sheet on phone.
import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from "react-native";
import { Input, Button, SectionLabel } from "@/src/components/ui";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { colors, spacing } from "@/src/theme";
import { CATEGORIES, Equipment } from "./useEquipment";

export const EquipmentForm: React.FC<{
  visible: boolean;
  editing: Partial<Equipment> | null;
  setEditing: (updater: any) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
}> = ({ visible, editing, setEditing, onClose, onSave }) => {
  const [saving, setSaving] = useState(false);
  if (!visible || !editing) return null;

  const handleSave = async () => {
    if (!editing.sku || !editing.name) { Alert.alert("Required", "SKU and name are required."); return; }
    setSaving(true);
    try { await onSave(); }
    catch (e: any) { Alert.alert("Save failed", e.message); }
    finally { setSaving(false); }
  };

  return (
    <DetailDrawer visible={visible} title={editing.id ? "Edit Equipment" : "Add Equipment"} onClose={onClose} testID="equipment-form-drawer">
      <Input label="SKU" value={editing.sku || ""} onChangeText={(t) => setEditing((e: any) => ({ ...e, sku: t }))} mono testID="edit-sku" />
      <Input label="Name" value={editing.name || ""} onChangeText={(t) => setEditing((e: any) => ({ ...e, name: t }))} testID="edit-name" />
      <SectionLabel>Category</SectionLabel>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>
        {CATEGORIES.filter((c) => c.key !== "all").map((c) => (
          <TouchableOpacity key={c.key} onPress={() => setEditing((e: any) => ({ ...e, category: c.key }))} style={[styles.chip, editing.category === c.key && styles.chipActive]} testID={`edit-cat-${c.key}`}>
            <Text style={[styles.chipText, editing.category === c.key && { color: "#FFF" }]}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <Input label="Condition" value={editing.condition || ""} onChangeText={(t) => setEditing((e: any) => ({ ...e, condition: t }))} testID="edit-condition" />
      <Input label="Location" value={editing.location || ""} onChangeText={(t) => setEditing((e: any) => ({ ...e, location: t }))} testID="edit-location" />
      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Input label="Daily Rate" value={String(editing.daily_rate ?? "")} onChangeText={(t) => setEditing((e: any) => ({ ...e, daily_rate: Number(t) || 0 }))} keyboardType="decimal-pad" mono testID="edit-rate" />
        </View>
        <View style={{ flex: 1 }}>
          <Input label="Quantity" value={String(editing.quantity ?? "")} onChangeText={(t) => setEditing((e: any) => ({ ...e, quantity: Number(t) || 0, available: Number(t) || 0 }))} keyboardType="number-pad" mono testID="edit-quantity" />
        </View>
      </View>
      <Input label="Available" value={String(editing.available ?? "")} onChangeText={(t) => setEditing((e: any) => ({ ...e, available: Number(t) || 0 }))} keyboardType="number-pad" mono testID="edit-available" />
      <Input label="Notes" value={editing.notes || ""} onChangeText={(t) => setEditing((e: any) => ({ ...e, notes: t }))} testID="edit-notes" />
      <Button title="Save" onPress={handleSave} loading={saving} testID="save-equipment-btn" />
    </DetailDrawer>
  );
};

const styles = StyleSheet.create({
  chip: { paddingHorizontal: 14, height: 36, justifyContent: "center", borderWidth: 1, borderColor: colors.border, flexShrink: 0, borderRadius: 6 },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
});

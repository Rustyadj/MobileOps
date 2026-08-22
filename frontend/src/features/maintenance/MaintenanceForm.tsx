import React, { useState } from "react";
import { View, ScrollView, Alert } from "react-native";
import { Input, Button, SectionLabel, Row } from "@/src/components/ui";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { spacing } from "@/src/theme";
import { Eq, STATUSES } from "./useMaintenance";

export const MaintenanceForm: React.FC<{
  visible: boolean;
  editing: any;
  setEditing: (updater: any) => void;
  equipment: Eq[];
  onClose: () => void;
  onSave: () => Promise<void>;
}> = ({ visible, editing, setEditing, equipment, onClose, onSave }) => {
  const [saving, setSaving] = useState(false);
  if (!visible || !editing) return null;

  const handleSave = async () => {
    if (!editing.equipment_id || !editing.issue) { Alert.alert("Required", "Equipment + issue"); return; }
    setSaving(true);
    try { await onSave(); }
    catch (e: any) { Alert.alert("Save failed", e.message); }
    finally { setSaving(false); }
  };

  return (
    <DetailDrawer visible={visible} title={editing.id ? "Edit Service" : "New Service"} onClose={onClose} testID="maintenance-form-drawer">
      <SectionLabel>Equipment</SectionLabel>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>
        {equipment.map((e) => (
          <View key={e.id} style={{ flexShrink: 0 }}>
            <Button title={`${e.sku} — ${e.name}`} onPress={() => setEditing((v: any) => ({ ...v, equipment_id: e.id }))} variant={editing.equipment_id === e.id ? "primary" : "outline"} fullWidth={false} testID={`eq-pick-${e.sku}`} />
          </View>
        ))}
      </ScrollView>
      <Input label="Issue" value={editing.issue || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, issue: t }))} testID="maint-issue" />
      <Input label="Action Taken" value={editing.action_taken || ""} onChangeText={(t) => setEditing((v: any) => ({ ...v, action_taken: t }))} testID="maint-action" />
      <Input label="Cost" value={String(editing.cost ?? 0)} onChangeText={(t) => setEditing((v: any) => ({ ...v, cost: Number(t) || 0 }))} keyboardType="decimal-pad" mono testID="maint-cost" />
      <SectionLabel>Status</SectionLabel>
      <Row style={{ gap: spacing.sm, marginBottom: spacing.md }}>
        {STATUSES.map((s) => (
          <View key={s} style={{ flex: 1 }}>
            <Button title={s.replace("_", " ")} onPress={() => setEditing((v: any) => ({ ...v, status: s }))} variant={editing.status === s ? "primary" : "outline"} testID={`maint-status-${s}`} />
          </View>
        ))}
      </Row>
      <Button title="Save" onPress={handleSave} loading={saving} testID="save-maint-btn" />
    </DetailDrawer>
  );
};

import React, { useState } from "react";
import { View, Alert, Text } from "react-native";
import { Input, Button, Row } from "@/src/components/ui";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { RequiresOnline } from "@/src/components/RequiresOnline";
import { colors, spacing, type as typo } from "@/src/theme";
import { Contact } from "./useVendors";

export const ContactForm: React.FC<{
  visible: boolean;
  editing: Partial<Contact> | null;
  setEditing: (updater: any) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
}> = ({ visible, editing, setEditing, onClose, onSave }) => {
  const [saving, setSaving] = useState(false);
  if (!visible || !editing) return null;

  const handleSave = async () => {
    if (!editing.company?.trim()) { Alert.alert("Required", editing.is_homeowner ? "Job site name" : "Company name"); return; }
    setSaving(true);
    try { await onSave(); }
    catch (e: any) { Alert.alert("Save failed", e.message); }
    finally { setSaving(false); }
  };

  return (
    <DetailDrawer visible={visible} title={editing.id ? "Edit Contact" : "New Contact"} onClose={onClose} testID="contact-form-drawer">
      <Row style={{ gap: spacing.sm, marginBottom: spacing.md }}>
        <View style={{ flex: 1 }}><Button title="Company" variant={!editing.is_homeowner ? "primary" : "outline"} onPress={() => setEditing((value: any) => ({ ...value, is_homeowner: false }))} testID="contact-type-company" /></View>
        <View style={{ flex: 1 }}><Button title="Homeowner" variant={editing.is_homeowner ? "primary" : "outline"} onPress={() => setEditing((value: any) => ({ ...value, is_homeowner: true, follows_current_job: true }))} testID="contact-type-homeowner" /></View>
      </Row>
      <Input label={editing.is_homeowner ? "Job Site Name" : "Company"} value={editing.company || ""} onChangeText={(text) => setEditing((value: any) => ({ ...value, company: text }))} testID="contact-company" />
      {editing.is_homeowner ? <Text style={[typo.bodySmall, { color: colors.inkMuted, marginTop: -spacing.sm, marginBottom: spacing.md }]}>For homeowners, this chosen job-site name is used as the company name everywhere.</Text> : null}
      <Input label="Contact" value={editing.contact || ""} onChangeText={(text) => setEditing((value: any) => ({ ...value, contact: text }))} testID="contact-person" />
      <Row style={{ gap: spacing.md }}>
        <View style={{ flex: 1 }}><Input label="Phone Number" value={editing.phone || ""} onChangeText={(text) => setEditing((value: any) => ({ ...value, phone: text }))} keyboardType="phone-pad" mono testID="contact-phone" /></View>
        <View style={{ flex: 1 }}><Input label="Email" value={editing.email || ""} onChangeText={(text) => setEditing((value: any) => ({ ...value, email: text }))} keyboardType="email-address" autoCapitalize="none" testID="contact-email" /></View>
      </Row>
      <Input label="Business Address" value={editing.business_address || ""} onChangeText={(text) => setEditing((value: any) => ({ ...value, business_address: text }))} testID="contact-business-address" />
      {!editing.is_homeowner ? (
        <View style={{ marginBottom: spacing.md }}>
          <Button title={editing.follows_current_job ? "Address follows current job ✓" : "Use permanent business address"} variant={editing.follows_current_job ? "primary" : "outline"} onPress={() => setEditing((value: any) => ({ ...value, follows_current_job: !value.follows_current_job }))} testID="contact-follow-job" />
          <Text style={[typo.bodySmall, { color: colors.inkMuted, marginTop: spacing.xs }]}>Turn this on for crews that move from one active job to the next.</Text>
        </View>
      ) : null}
      <Input label="Notes" value={editing.notes || ""} onChangeText={(text) => setEditing((value: any) => ({ ...value, notes: text }))} testID="contact-notes" />
      <RequiresOnline><Button title="Save Contact" onPress={handleSave} loading={saving} testID="save-contact-btn" /></RequiresOnline>
    </DetailDrawer>
  );
};

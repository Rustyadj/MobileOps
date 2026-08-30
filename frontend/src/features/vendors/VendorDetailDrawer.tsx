import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Linking, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Mono, Row, Button, SectionLabel } from "@/src/components/ui";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { RequiresOnline } from "@/src/components/RequiresOnline";
import { colors, spacing, type as typo } from "@/src/theme";
import type { Contact } from "./useVendors";

export const ContactDetailDrawer: React.FC<{
  contact: Contact | null;
  onClose: () => void;
  onEdit: (contact: Contact) => void;
  onDelete: (id: string) => Promise<void>;
  onOpenMap: (contact: Contact) => void;
}> = ({ contact, onClose, onEdit, onDelete, onOpenMap }) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!contact) return null;

  const handleDelete = async () => {
    setConfirmDelete(false);
    try { await onDelete(contact.id); onClose(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  return (
    <>
      <DetailDrawer visible={!!contact} title={contact.company} subtitle={contact.contact || undefined} onClose={onClose} testID="contact-detail-drawer">
        <SectionLabel>{contact.is_homeowner ? "Homeowner / Job Site" : "Company"}</SectionLabel>

        {(contact.phone || contact.email) ? (
          <Row style={{ gap: spacing.lg, marginBottom: spacing.md, flexWrap: "wrap" }}>
            {contact.phone ? (
              <TouchableOpacity onPress={() => Linking.openURL(`tel:${contact.phone}`)} testID="drawer-call-contact">
                <Row style={{ gap: 4 }}><Ionicons name="call-outline" size={14} color={colors.accent} /><Mono style={{ fontSize: 13 }}>{contact.phone}</Mono></Row>
              </TouchableOpacity>
            ) : null}
            {contact.email ? (
              <TouchableOpacity onPress={() => Linking.openURL(`mailto:${contact.email}`)} testID="drawer-email-contact">
                <Row style={{ gap: 4 }}><Ionicons name="mail-outline" size={14} color={colors.accent} /><Mono style={{ fontSize: 13 }}>{contact.email}</Mono></Row>
              </TouchableOpacity>
            ) : null}
          </Row>
        ) : null}

        {contact.current_job_site ? (
          <View style={styles.locationCard}>
            <Row style={{ gap: spacing.sm }}>
              <Ionicons name="location" size={18} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={typo.label}>Current Job</Text>
                <Text style={typo.body}>{contact.current_job_site}</Text>
                <Text style={typo.bodySmall}>{contact.current_job_address || "Address not entered"}</Text>
              </View>
            </Row>
            {contact.current_job_lat != null && contact.current_job_lng != null ? <Button title="Show Pin on Map" variant="outline" onPress={() => onOpenMap(contact)} testID="contact-open-map" style={{ marginTop: spacing.sm }} /> : <Text style={[typo.bodySmall, { color: colors.error, marginTop: spacing.sm }]}>This job still needs a map pin.</Text>}
          </View>
        ) : null}

        <SectionLabel>Business Address</SectionLabel>
        <Text style={[typo.body, { marginBottom: spacing.md }]}>{contact.business_address || "Not entered"}</Text>

        {contact.notes ? (
          <>
            <View style={{ height: spacing.md }} />
            <Text style={typo.caption}>Notes</Text>
            <Text style={[typo.body, { marginTop: 4 }]}>{contact.notes}</Text>
          </>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Row style={{ gap: spacing.sm }}>
          <View style={{ flex: 1 }}><Button title="Edit" onPress={() => onEdit(contact)} variant="outline" testID="drawer-edit-contact" /></View>
          <View style={{ flex: 1 }}><RequiresOnline><Button title="Delete" onPress={() => setConfirmDelete(true)} variant="danger" testID="drawer-delete-contact" /></RequiresOnline></View>
        </Row>
      </DetailDrawer>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete this contact?"
        message={`This removes ${contact.company} from the directory. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
        testID="delete-contact-confirm"
      />
    </>
  );
};

const styles = StyleSheet.create({
  grid: { gap: 6 },
  locationCard: { padding: spacing.md, marginBottom: spacing.md, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.primarySoft },
});

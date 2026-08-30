// Contacts — searchable DataTable + DetailDrawer on desktop, cards on phone.
// Matches the Equipment/Maintenance master-detail pattern with deep-link
// support for ?open=<id> and ?new=1.
import { useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Card, Mono, Row, H3 } from "@/src/components/ui";
import { PageHeader } from "@/src/components/layout/PageHeader";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { PageBody } from "@/src/components/layout/PageBody";
import { SearchInput } from "@/src/components/data/SearchInput";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { EmptyState } from "@/src/components/feedback/EmptyState";
import { LoadingState } from "@/src/components/feedback/LoadingState";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useContacts, Contact } from "@/src/features/vendors/useVendors";
import { ContactDetailDrawer } from "@/src/features/vendors/VendorDetailDrawer";
import { ContactForm } from "@/src/features/vendors/VendorForm";
import { colors, spacing, type as typo } from "@/src/theme";

const displayAddress = (contact: Contact) => contact.current_job_address || contact.business_address;

export default function ContactsScreen() {
  const { isShellWide } = useBreakpoint();
  const router = useRouter();
  const params = useLocalSearchParams<{ open?: string; new?: string }>();
  const { contacts, loading, refreshing, load, refresh, save, del } = useContacts();

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Contact> | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (params.open) setSelectedId(String(params.open));
    if (params.new === "1") openNew();
  }, [params.open, params.new]);

  const openNew = () => { setEditing({ company: "", contact: "", is_homeowner: false, follows_current_job: false }); setFormOpen(true); };
  const openEdit = (contact: Contact) => { setSelectedId(null); setEditing(contact); setFormOpen(true); };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter((contact) => {
      if (!q) return true;
      return [contact.company, contact.contact, contact.phone, contact.email, contact.business_address, contact.current_job_site, contact.current_job_address]
        .some((value) => value?.toLowerCase().includes(q));
    });
  }, [contacts, search]);

  const selected = contacts.find((contact) => contact.id === selectedId) || null;

  const columns: ColumnDef<Contact>[] = [
    { key: "company", label: "Company", flex: 1.4, render: (contact) => (
      <View>
        <Text style={typo.body} numberOfLines={1}>{contact.company}</Text>
        {contact.is_homeowner ? <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>Homeowner · job-site name</Text> : null}
      </View>
    ) },
    { key: "contact", label: "Contact", flex: 1.1, render: (contact) => contact.contact || "—" },
    { key: "phone", label: "Phone Number", width: 140, render: (contact) => contact.phone ? <Mono style={{ fontSize: 12 }}>{contact.phone}</Mono> : "—" },
    { key: "email", label: "Email", flex: 1.25, render: (contact) => contact.email || "—" },
    { key: "address", label: "Address", flex: 1.6, render: (contact) => (
      <View><Text style={typo.bodySmall} numberOfLines={1}>{displayAddress(contact) || "—"}</Text>{contact.current_job_site ? <Text style={[typo.bodySmall, { color: colors.primary }]} numberOfLines={1}>Current job · {contact.current_job_site}</Text> : null}</View>
    ) },
  ];

  if (loading) {
    return <Screen title="Contacts" back testID="contacts-screen"><LoadingState label="Loading contacts…" /></Screen>;
  }

  const desktopHeader = (
    <PageHeader
      title="Contacts"
      subtitle={`${contacts.length} companies and homeowners`}
      actions={
        <TouchableOpacity onPress={openNew} testID="add-contact-btn" style={{ backgroundColor: colors.accent, borderColor: colors.accent, height: 38, paddingHorizontal: 16, justifyContent: "center", borderRadius: 6 }}>
          <Text style={{ color: "#FFF", fontWeight: "700", fontSize: 13 }}>+ New Contact</Text>
        </TouchableOpacity>
      }
    />
  );

  return (
    <Screen
      title="Contacts"
      subtitle={`${contacts.length} companies and homeowners`}
      back
      rightAction={{ icon: "add", onPress: openNew, testID: "add-contact-btn" }}
      onRefresh={refresh}
      refreshing={refreshing}
      scroll={isShellWide ? false : true}
      desktopHeader={desktopHeader}
      testID="contacts-screen"
    >
      <PageToolbar>
        <SearchInput value={search} onChangeText={setSearch} placeholder="Search company, contact, phone, email, address…" testID="contacts-search" />
      </PageToolbar>

      {filtered.length === 0 ? (
        <EmptyState icon="people-outline" title="No contacts match" subtitle={contacts.length === 0 ? "Add your first company or homeowner." : "Try a different search."} actionLabel={contacts.length === 0 ? "Add Contact" : undefined} onAction={contacts.length === 0 ? openNew : undefined} testID="contacts-empty" />
      ) : isShellWide ? (
        <View style={{ flex: 1, paddingHorizontal: spacing.xl }}>
          <DataTable columns={columns} rows={filtered} keyExtractor={(contact) => contact.id} onRowPress={(contact) => setSelectedId(contact.id)} rowTestID={(contact) => `contact-row-${contact.id}`} selectedId={selectedId} />
        </View>
      ) : (
        <PageBody scroll={false} testID="contacts-list">
          {filtered.map((contact) => (
            <TouchableOpacity key={contact.id} onPress={() => setSelectedId(contact.id)} activeOpacity={0.7} testID={`contact-row-${contact.id}`}>
              <Card style={{ marginBottom: spacing.sm }}>
                <H3>{contact.company}</H3>
                {contact.contact ? <Text style={[typo.label, { marginTop: 2 }]}>{contact.contact}</Text> : null}
                <Row style={{ gap: spacing.md, marginTop: 8 }}>
                  {contact.phone ? <Text style={typo.label}>Phone <Mono style={{ fontSize: 12 }}>{contact.phone}</Mono></Text> : null}
                  {contact.email ? <Text style={typo.bodySmall}>{contact.email}</Text> : null}
                </Row>
                <Text style={[typo.bodySmall, { marginTop: spacing.sm }]}>{displayAddress(contact) || "No address entered"}</Text>
                {contact.current_job_site ? <Text style={[typo.bodySmall, { color: colors.primary, marginTop: 2 }]}>📍 {contact.current_job_site}</Text> : null}
              </Card>
            </TouchableOpacity>
          ))}
        </PageBody>
      )}

      <ContactDetailDrawer
        contact={selected}
        onClose={() => { setSelectedId(null); if (params.open) router.setParams({ open: undefined }); }}
        onEdit={openEdit}
        onDelete={del}
        onOpenMap={(contact) => router.push(`/(app)/operations/map?open=${contact.current_rental_id}` as any)}
      />

      <ContactForm
        visible={formOpen}
        editing={editing}
        setEditing={setEditing}
        onClose={() => { setFormOpen(false); setEditing(null); if (params.new) router.setParams({ new: undefined }); }}
        onSave={async () => { await save(editing!); setFormOpen(false); setEditing(null); }}
      />
    </Screen>
  );
}

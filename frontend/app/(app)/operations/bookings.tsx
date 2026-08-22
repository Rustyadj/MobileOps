import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Modal, Alert, ScrollView } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Pill, Row, H3 } from "@/src/components/ui";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo } from "@/src/theme";

type Booking = { id: string; customer_name: string; job_site: string; start_date: string; end_date: string; status: string; notes: string };
type CapacityRow = { equipment_id: string; sku: string; name: string; category: string; quantity: number; committed: number; available: number };

export default function BookingsScreen() {
  const [tab, setTab] = useState<"pipeline" | "capacity">("pipeline");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [capDate, setCapDate] = useState(new Date().toISOString().slice(0, 10));
  const [capRows, setCapRows] = useState<CapacityRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setBookings(await api<Booking[]>("/bookings")); } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadCapacity = async () => {
    try {
      const res = await api<{ rows: CapacityRow[] }>(`/bookings/capacity?target_date=${capDate}T00:00:00`);
      setCapRows(res.rows);
    } catch (e: any) { Alert.alert("Error", e.message); }
  };
  useEffect(() => { if (tab === "capacity") loadCapacity(); }, [tab, capDate]); // eslint-disable-line

  const newBooking = () => {
    const now = new Date();
    const end = new Date(now.getTime() + 3 * 86400000);
    setDraft({
      customer_name: "", job_site: "",
      start_date: now.toISOString(), end_date: end.toISOString(),
      status: "tentative", items: [], notes: "",
    });
    setCreating(true);
  };

  const save = async () => {
    if (!draft.customer_name) { Alert.alert("Required", "Customer name"); return; }
    try { await api("/bookings", { method: "POST", body: JSON.stringify(draft) }); setCreating(false); load(); }
    catch (e: any) { Alert.alert("Save failed", e.message); }
  };

  const del = async (id: string) => {
    try { await api(`/bookings/${id}`, { method: "DELETE" }); load(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  return (
    <Screen title="Bookings" subtitle="Pipeline · Capacity" back
      rightAction={tab === "pipeline" ? { icon: "add", onPress: newBooking, testID: "new-booking-btn" } : undefined}
      onRefresh={async () => { setRefreshing(true); await (tab === "pipeline" ? load() : loadCapacity()); setRefreshing(false); }}
      refreshing={refreshing}
      testID="bookings-screen">
      <View style={styles.tabs}>
        <SegBtn label="Pipeline" active={tab === "pipeline"} onPress={() => setTab("pipeline")} testID="tab-pipeline" />
        <SegBtn label="Capacity" active={tab === "capacity"} onPress={() => setTab("capacity")} testID="tab-capacity" />
      </View>

      {tab === "pipeline" ? (
        bookings.length === 0 ? (
          <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No bookings. Tap + to add.</Text></Card>
        ) : bookings.map((b) => (
          <Card key={b.id} style={{ marginBottom: spacing.sm }} testID={`booking-${b.id}`}>
            <Row style={{ justifyContent: "space-between" }}>
              <View style={{ flex: 1 }}>
                <H3>{b.customer_name}</H3>
                <Text style={[typo.label, { marginTop: 2 }]}>{b.job_site || "—"}</Text>
              </View>
              <Pill color={b.status === "confirmed" ? colors.success : b.status === "cancelled" ? colors.error : colors.warning}
                    bg={b.status === "confirmed" ? "#DCFCE7" : b.status === "cancelled" ? "#FEE2E2" : "#FEF3C7"}>
                {b.status}
              </Pill>
            </Row>
            <Row style={{ marginTop: 8, gap: spacing.md }}>
              <Mono style={{ fontSize: 12 }}>{new Date(b.start_date).toLocaleDateString()} → {new Date(b.end_date).toLocaleDateString()}</Mono>
            </Row>
            <Button title="Delete" onPress={() => del(b.id)} variant="outline" testID={`del-booking-${b.id}`} />
          </Card>
        ))
      ) : (
        <>
          <Card style={{ marginBottom: spacing.md }}>
            <Input label="Check date (yyyy-mm-dd)" value={capDate} onChangeText={setCapDate} mono autoCapitalize="none" testID="capacity-date" />
            <Button title="Check Capacity" onPress={loadCapacity} testID="check-capacity-btn" />
          </Card>
          {capRows.length === 0 ? (
            <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No equipment data.</Text></Card>
          ) : capRows.map((r) => (
            <Card key={r.equipment_id} style={{ marginBottom: spacing.sm }} testID={`cap-row-${r.sku}`}>
              <Row style={{ justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Text style={typo.body}>{r.name}</Text>
                  <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{r.sku}</Mono>
                </View>
                <Pill color={r.available > 0 ? colors.success : colors.error} bg={r.available > 0 ? "#DCFCE7" : "#FEE2E2"}>
                  {r.available}/{r.quantity}
                </Pill>
              </Row>
            </Card>
          ))}
        </>
      )}

      <Modal visible={creating} animationType="slide" onRequestClose={() => setCreating(false)}>
        <Screen title="New Booking" back rightAction={{ icon: "close", onPress: () => setCreating(false), testID: "close-new-booking" }}>
          <Input label="Customer Name" value={draft?.customer_name || ""} onChangeText={(t) => setDraft({ ...draft, customer_name: t })} testID="bk-cust" />
          <Input label="Job Site" value={draft?.job_site || ""} onChangeText={(t) => setDraft({ ...draft, job_site: t })} testID="bk-site" />
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}><Input label="Start" value={draft?.start_date?.slice(0,10) || ""} onChangeText={(t) => setDraft({ ...draft, start_date: new Date(t).toISOString() })} mono autoCapitalize="none" testID="bk-start" /></View>
            <View style={{ flex: 1 }}><Input label="End" value={draft?.end_date?.slice(0,10) || ""} onChangeText={(t) => setDraft({ ...draft, end_date: new Date(t).toISOString() })} mono autoCapitalize="none" testID="bk-end" /></View>
          </Row>
          <SectionLabel>Status</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>
            {["tentative","confirmed","cancelled"].map((s) => (
              <SegBtn key={s} label={s} active={draft?.status === s} onPress={() => setDraft({ ...draft, status: s })} testID={`bk-status-${s}`} />
            ))}
          </ScrollView>
          <Input label="Notes" value={draft?.notes || ""} onChangeText={(t) => setDraft({ ...draft, notes: t })} testID="bk-notes" />
          <Button title="Save Booking" onPress={save} testID="save-booking-btn" />
        </Screen>
      </Modal>
    </Screen>
  );
}

const SegBtn: React.FC<{ label: string; active: boolean; onPress: () => void; testID?: string }> = ({ label, active, onPress, testID }) => (
  <View testID={testID} style={{ flexGrow: 1 }}>
    <Button title={label} onPress={onPress} variant={active ? "primary" : "outline"} />
  </View>
);

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", gap: 8, marginBottom: spacing.md },
});

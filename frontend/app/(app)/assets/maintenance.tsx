import { useCallback, useEffect, useState } from "react";
import { View, Text, Modal, Alert, ScrollView } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Pill, Row, H3 } from "@/src/components/ui";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo } from "@/src/theme";

type Eq = { id: string; sku: string; name: string };
type M = { id: string; equipment_id: string; equipment_name: string; issue: string; action_taken: string; cost: number; status: string; serviced_at?: string };

export default function MaintenanceScreen() {
  const [items, setItems] = useState<M[]>([]);
  const [equipment, setEquipment] = useState<Eq[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, e] = await Promise.all([api<M[]>("/maintenance"), api<Eq[]>("/equipment")]);
      setItems(m); setEquipment(e);
    } catch (err) { console.warn(err); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!editing.equipment_id || !editing.issue) { Alert.alert("Required", "Equipment + issue"); return; }
    try {
      const body = {
        equipment_id: editing.equipment_id, issue: editing.issue,
        action_taken: editing.action_taken || "", cost: Number(editing.cost) || 0,
        status: editing.status || "open", serviced_at: editing.serviced_at || null,
      };
      if (editing.id) await api(`/maintenance/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/maintenance", { method: "POST", body: JSON.stringify(body) });
      setEditing(null); load();
    } catch (e: any) { Alert.alert("Save failed", e.message); }
  };

  const del = async (id: string) => {
    try { await api(`/maintenance/${id}`, { method: "DELETE" }); load(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  return (
    <Screen title="Maintenance" subtitle={`${items.length} entries`} back
      rightAction={{ icon: "add", onPress: () => setEditing({ equipment_id: equipment[0]?.id || "", issue: "", action_taken: "", cost: 0, status: "open" }), testID: "new-maint-btn" }}
      onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
      refreshing={refreshing} testID="maintenance-screen">

      {items.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No service entries.</Text></Card>
      ) : items.map((m) => (
        <Card key={m.id} style={{ marginBottom: spacing.sm }} testID={`maint-${m.id}`}>
          <Row style={{ justifyContent: "space-between" }}>
            <View style={{ flex: 1 }}>
              <H3>{m.equipment_name || "Equipment"}</H3>
              <Text style={[typo.body, { marginTop: 4 }]}>{m.issue}</Text>
            </View>
            <Pill color={m.status === "resolved" ? colors.success : m.status === "in_progress" ? colors.warning : colors.error}
                  bg={m.status === "resolved" ? "#DCFCE7" : m.status === "in_progress" ? "#FEF3C7" : "#FEE2E2"}>
              {m.status}
            </Pill>
          </Row>
          {m.action_taken ? <Text style={[typo.body, { color: colors.inkSecondary, marginTop: 4 }]}>↪ {m.action_taken}</Text> : null}
          <Row style={{ marginTop: 8, gap: spacing.md }}>
            <Text style={typo.label}>Cost <Mono style={{ fontSize: 13 }}>${m.cost.toFixed(2)}</Mono></Text>
          </Row>
          <Row style={{ gap: spacing.sm, marginTop: spacing.sm }}>
            <View style={{ flex: 1 }}><Button title="Edit" onPress={() => setEditing(m)} variant="outline" testID={`edit-maint-${m.id}`} /></View>
            <View style={{ flex: 1 }}><Button title="Delete" onPress={() => del(m.id)} variant="danger" testID={`del-maint-${m.id}`} /></View>
          </Row>
        </Card>
      ))}

      <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
        <Screen title={editing?.id ? "Edit Service" : "New Service"} back rightAction={{ icon: "close", onPress: () => setEditing(null), testID: "close-maint-edit" }}>
          <SectionLabel>Equipment</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>
            {equipment.map((e) => (
              <View key={e.id} style={{ flexShrink: 0 }}>
                <Button title={`${e.sku} — ${e.name}`} onPress={() => setEditing({ ...editing, equipment_id: e.id })} variant={editing?.equipment_id === e.id ? "primary" : "outline"} fullWidth={false} testID={`eq-pick-${e.sku}`} />
              </View>
            ))}
          </ScrollView>
          <Input label="Issue" value={editing?.issue || ""} onChangeText={(t) => setEditing({ ...editing, issue: t })} testID="maint-issue" />
          <Input label="Action Taken" value={editing?.action_taken || ""} onChangeText={(t) => setEditing({ ...editing, action_taken: t })} testID="maint-action" />
          <Input label="Cost" value={String(editing?.cost ?? 0)} onChangeText={(t) => setEditing({ ...editing, cost: Number(t) || 0 })} keyboardType="decimal-pad" mono testID="maint-cost" />
          <SectionLabel>Status</SectionLabel>
          <Row style={{ gap: spacing.sm, marginBottom: spacing.md }}>
            {["open","in_progress","resolved"].map((s) => (
              <View key={s} style={{ flex: 1 }}>
                <Button title={s.replace("_"," ")} onPress={() => setEditing({ ...editing, status: s })} variant={editing?.status === s ? "primary" : "outline"} testID={`maint-status-${s}`} />
              </View>
            ))}
          </Row>
          <Button title="Save" onPress={save} testID="save-maint-btn" />
        </Screen>
      </Modal>
    </Screen>
  );
}

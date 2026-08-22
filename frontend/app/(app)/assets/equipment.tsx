import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Pill, Row, H2, H3 } from "@/src/components/ui";
import { Ionicons } from "@expo/vector-icons";
import { api, apiBaseUrl, getAccessToken } from "@/src/api/client";
import { colors, spacing, type as typo } from "@/src/theme";

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "strongback", label: "Strongback" },
  { key: "turnbuckle", label: "Turnbuckle" },
  { key: "walkboard_bracket", label: "Walkboard" },
  { key: "hand_rail", label: "Hand Rail" },
  { key: "tb_extension", label: "TB Ext" },
  { key: "crankup_scaffold", label: "Scaffold" },
];

type Equipment = {
  id: string; sku: string; name: string; category: string;
  condition: string; location: string; daily_rate: number;
  quantity: number; available: number; notes: string;
};

const blank: Partial<Equipment> = {
  sku: "", name: "", category: "strongback", condition: "good",
  location: "", daily_rate: 0, quantity: 1, available: 1, notes: "",
};

export default function EquipmentScreen() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [cat, setCat] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Partial<Equipment> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Equipment[]>("/equipment");
      setItems(data);
    } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const filtered = cat === "all" ? items : items.filter((i) => i.category === cat);

  const save = async () => {
    if (!editing) return;
    try {
      const body = {
        sku: editing.sku || "", name: editing.name || "", category: editing.category || "strongback",
        condition: editing.condition || "good", location: editing.location || "",
        daily_rate: Number(editing.daily_rate) || 0,
        quantity: Number(editing.quantity) || 1,
        available: Number(editing.available ?? editing.quantity ?? 1),
        notes: editing.notes || "",
      };
      if (editing.id) {
        await api(`/equipment/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/equipment", { method: "POST", body: JSON.stringify(body) });
      }
      setEditing(null);
      load();
    } catch (e: any) { Alert.alert("Save failed", e.message); }
  };

  const del = async (id: string) => {
    try { await api(`/equipment/${id}`, { method: "DELETE" }); load(); }
    catch (e: any) { Alert.alert("Delete failed", e.message); }
  };

  const exportCSV = async () => {
    try {
      const tok = getAccessToken();
      const resp = await fetch(`${apiBaseUrl()}/equipment/export.csv`, { headers: { Authorization: `Bearer ${tok}` } });
      const text = await resp.text();
      if (Platform.OS === "web") {
        const blob = new Blob([text], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "equipment.csv"; a.click();
        URL.revokeObjectURL(url);
      } else {
        const path = (FileSystem.documentDirectory || "") + "equipment.csv";
        await FileSystem.writeAsStringAsync(path, text);
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
      }
    } catch (e: any) { Alert.alert("Export failed", e.message); }
  };

  const importCSV = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ["text/csv", "text/comma-separated-values", "application/csv", "*/*"] });
      if (res.canceled || !res.assets?.[0]) return;
      const file = res.assets[0];
      const form = new FormData();
      // RN file
      // @ts-ignore
      form.append("file", { uri: file.uri, name: file.name || "equipment.csv", type: file.mimeType || "text/csv" } as any);
      const tok = getAccessToken();
      const resp = await fetch(`${apiBaseUrl()}/equipment/import.csv`, {
        method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: form as any,
      });
      const j = await resp.json();
      Alert.alert("Imported", `${j.imported} rows`);
      load();
    } catch (e: any) { Alert.alert("Import failed", e.message); }
  };

  return (
    <Screen
      title="Equipment"
      subtitle={`${items.length} SKUs · ${items.reduce((s, i) => s + i.available, 0)} avail`}
      back
      rightAction={{ icon: "add", onPress: () => setEditing({ ...blank }), testID: "add-equipment-btn" }}
      onRefresh={onRefresh}
      refreshing={refreshing}
      testID="equipment-screen"
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} style={{ marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
        {CATEGORIES.map((c) => (
          <TouchableOpacity key={c.key} onPress={() => setCat(c.key)} style={[styles.chip, cat === c.key && styles.chipActive]} testID={`cat-${c.key}`}>
            <Text style={[styles.chipText, cat === c.key && { color: "#FFF" }]}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <Row style={{ gap: spacing.sm, marginBottom: spacing.md }}>
        <View style={{ flex: 1 }}><Button title="Import CSV" onPress={importCSV} variant="outline" testID="import-csv-btn" /></View>
        <View style={{ flex: 1 }}><Button title="Export CSV" onPress={exportCSV} variant="outline" testID="export-csv-btn" /></View>
      </Row>

      {filtered.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No equipment in this category.</Text></Card>
      ) : filtered.map((it) => (
        <Card key={it.id} style={{ marginBottom: spacing.sm }} testID={`equipment-row-${it.sku}`}>
          <Row style={{ marginBottom: 4, gap: 8, alignItems: "flex-start" }}>
            <View style={{ flex: 1 }}>
              <Mono style={{ fontSize: 11, color: colors.inkMuted }}>{it.sku}</Mono>
              <H3>{it.name}</H3>
              <Text style={[typo.label, { marginTop: 2 }]}>{it.category.replace(/_/g, " ")} · {it.location || "—"}</Text>
            </View>
            <Pill color={it.available > 0 ? colors.success : colors.error} bg={it.available > 0 ? "#DCFCE7" : "#FEE2E2"}>
              {it.available}/{it.quantity}
            </Pill>
          </Row>
          <Row style={{ gap: spacing.md, marginTop: 8 }}>
            <Text style={typo.label}>Cond <Mono style={{ fontSize: 13 }}>{it.condition}</Mono></Text>
            <Text style={typo.label}>Rate <Mono style={{ fontSize: 13 }}>${it.daily_rate}/d</Mono></Text>
          </Row>
          <Row style={{ gap: spacing.sm, marginTop: spacing.sm }}>
            <View style={{ flex: 1 }}><Button title="Edit" onPress={() => setEditing(it)} variant="outline" testID={`edit-${it.sku}`} /></View>
            <View style={{ flex: 1 }}><Button title="Delete" onPress={() => del(it.id)} variant="danger" testID={`delete-${it.sku}`} /></View>
          </Row>
        </Card>
      ))}

      <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
        <Screen
          title={editing?.id ? "Edit Equipment" : "Add Equipment"}
          back
          rightAction={{ icon: "close", onPress: () => setEditing(null), testID: "close-edit" }}
          testID="equipment-edit-screen"
        >
          <Input label="SKU" value={editing?.sku || ""} onChangeText={(t) => setEditing((e) => ({ ...e!, sku: t }))} mono testID="edit-sku" />
          <Input label="Name" value={editing?.name || ""} onChangeText={(t) => setEditing((e) => ({ ...e!, name: t }))} testID="edit-name" />
          <SectionLabel>Category</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>
            {CATEGORIES.filter((c) => c.key !== "all").map((c) => (
              <TouchableOpacity key={c.key} onPress={() => setEditing((e) => ({ ...e!, category: c.key }))} style={[styles.chip, editing?.category === c.key && styles.chipActive]} testID={`edit-cat-${c.key}`}>
                <Text style={[styles.chipText, editing?.category === c.key && { color: "#FFF" }]}>{c.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <Input label="Condition" value={editing?.condition || ""} onChangeText={(t) => setEditing((e) => ({ ...e!, condition: t }))} testID="edit-condition" />
          <Input label="Location" value={editing?.location || ""} onChangeText={(t) => setEditing((e) => ({ ...e!, location: t }))} testID="edit-location" />
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Input label="Daily Rate" value={String(editing?.daily_rate ?? "")} onChangeText={(t) => setEditing((e) => ({ ...e!, daily_rate: Number(t) || 0 }))} keyboardType="decimal-pad" mono testID="edit-rate" />
            </View>
            <View style={{ flex: 1 }}>
              <Input label="Quantity" value={String(editing?.quantity ?? "")} onChangeText={(t) => setEditing((e) => ({ ...e!, quantity: Number(t) || 0, available: Number(t) || 0 }))} keyboardType="number-pad" mono testID="edit-quantity" />
            </View>
          </Row>
          <Input label="Available" value={String(editing?.available ?? "")} onChangeText={(t) => setEditing((e) => ({ ...e!, available: Number(t) || 0 }))} keyboardType="number-pad" mono testID="edit-available" />
          <Input label="Notes" value={editing?.notes || ""} onChangeText={(t) => setEditing((e) => ({ ...e!, notes: t }))} testID="edit-notes" />
          <Button title="Save" onPress={save} testID="save-equipment-btn" />
        </Screen>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chip: { paddingHorizontal: 14, height: 36, justifyContent: "center", borderWidth: 1, borderColor: colors.border, flexShrink: 0 },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
});

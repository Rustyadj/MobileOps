// Yard Inventory — what's physically on hand at each yard location, at a
// glance. Groups the equipment list by location instead of by asset, since
// "what do we have at Yard B right now" is a different question than
// "how many strongbacks do we own total" (that's Equipment).
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Mono, H3, Row } from "@/src/components/ui";
import { FilterChips } from "@/src/components/data/FilterBar";
import { api } from "@/src/api/client";
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type Equipment = { id: string; sku: string; qr_code?: string | null; name: string; category: string; location: string; available: number; quantity: number };

export default function YardInventoryScreen() {
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [location, setLocation] = useState("all");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setEquipment(await api<Equipment[]>("/equipment"));
    } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const locationOptions = useMemo(() => [
    { key: "all", label: "All locations" },
    ...Array.from(new Set(equipment.map((e) => e.location).filter(Boolean))).sort().map((v) => ({ key: v, label: v })),
  ], [equipment]);

  const grouped = useMemo(() => {
    const byLocation = new Map<string, Equipment[]>();
    for (const item of equipment) {
      if (!item.available) continue;
      const key = item.location || "Unassigned";
      if (location !== "all" && key !== location) continue;
      if (!byLocation.has(key)) byLocation.set(key, []);
      byLocation.get(key)!.push(item);
    }
    return Array.from(byLocation.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [equipment, location]);

  return (
    <Screen title="Yard Inventory" subtitle="Available stock by location" back onRefresh={onRefresh} refreshing={refreshing} testID="yard-inventory-screen">
      <FilterChips options={locationOptions} value={location} onChange={setLocation} testIDPrefix="yard-location" />
      <View style={{ height: spacing.md }} />
      {grouped.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No available stock at this location.</Text></Card>
      ) : grouped.map(([loc, items]) => (
        <Card key={loc} style={{ marginBottom: spacing.md }} testID={`yard-group-${loc}`}>
          <Row style={{ justifyContent: "space-between", marginBottom: spacing.sm }}>
            <H3>{loc}</H3>
            <Mono style={{ fontSize: 13, color: colors.inkMuted }}>{items.reduce((s, i) => s + i.available, 0)} units</Mono>
          </Row>
          {items.map((item) => (
            <Row key={item.id} style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <Text style={typo.body} numberOfLines={1}>{item.name}</Text>
                <Mono style={{ fontSize: 10.5, color: colors.inkMuted }}>{equipmentIdentifier(item)}</Mono>
              </View>
              <Mono style={{ fontSize: 13, fontWeight: "700" }}>{item.available}</Mono>
            </Row>
          ))}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  itemRow: { justifyContent: "space-between", alignItems: "center", paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
});

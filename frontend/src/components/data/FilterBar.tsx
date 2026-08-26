// Horizontal chip filter group — category/location/condition/status filters
// used across Equipment, Rentals, Bookings, Maintenance list views.
import React from "react";
import { Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { colors, radii } from "@/src/theme";

export type FilterOption = { key: string; label: string; accessibilityLabel?: string };

export const FilterChips: React.FC<{
  options: FilterOption[];
  value: string;
  onChange: (key: string) => void;
  testIDPrefix?: string;
}> = ({ options, value, onChange, testIDPrefix = "filter" }) => (
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
    {options.map((o) => {
      const active = o.key === value;
      return (
        <TouchableOpacity
          key={o.key}
          onPress={() => onChange(o.key)}
          style={[styles.chip, active && styles.chipActive]}
          testID={`${testIDPrefix}-${o.key}`}
          accessibilityRole="button"
          accessibilityLabel={o.accessibilityLabel || o.label}
          accessibilityState={{ selected: active }}
        >
          <Text style={[styles.chipText, active && styles.chipTextActive]}>{o.label}</Text>
        </TouchableOpacity>
      );
    })}
  </ScrollView>
);

const styles = StyleSheet.create({
  row: { gap: 8, paddingVertical: 2 },
  chip: { height: 32, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.inkSecondary },
  chipTextActive: { color: "#FFF" },
});

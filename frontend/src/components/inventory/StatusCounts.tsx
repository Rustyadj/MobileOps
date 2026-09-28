// Dense Total / Yard / Out / Reserved / Available / Repair readout.
// Always fed by rollupEquipment/sumRollups so every screen shows the same
// numbers off the same ledger cache — never a page-local calculation.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import type { InventoryRollup } from "@/src/utils/inventory-rollup";

type Cell = { key: string; label: string; value: number; tone?: string; emphasis?: boolean };

export function statusCells(rollup: InventoryRollup, opts: { showMissing?: boolean } = {}): Cell[] {
  const cells: Cell[] = [
    { key: "total", label: "Total Owned", value: rollup.total },
    { key: "yard", label: "At Yard", value: rollup.atYard },
    { key: "out", label: "Out", value: rollup.out },
    { key: "reserved", label: "Reserved", value: rollup.reserved, tone: rollup.reserved > 0 ? colors.warning : undefined },
    { key: "available", label: "Available", value: rollup.available, tone: rollup.available > 0 ? colors.success : colors.inkMuted, emphasis: true },
    { key: "repair", label: "Repair / Damaged", value: rollup.repair, tone: rollup.repair > 0 ? colors.error : undefined },
  ];
  if (rollup.awaitingInspection > 0) {
    cells.push({ key: "inspection", label: "Awaiting Inspection", value: rollup.awaitingInspection, tone: colors.warning });
  }
  if (opts.showMissing !== false && rollup.missing > 0) {
    cells.push({ key: "missing", label: "Missing", value: rollup.missing, tone: colors.error });
  }
  return cells;
}

/** Full-width status board — used on category landing pages. */
export const StatusBoard: React.FC<{ rollup: InventoryRollup; testID?: string }> = ({ rollup, testID }) => (
  <View style={styles.board} testID={testID}>
    {statusCells(rollup).map((cell) => (
      <View key={cell.key} style={styles.boardCell}>
        <Text style={[styles.boardValue, cell.tone ? { color: cell.tone } : null, cell.emphasis && styles.boardValueEmphasis]}>{cell.value}</Text>
        <Text style={styles.boardLabel}>{cell.label}</Text>
      </View>
    ))}
  </View>
);

/** Compact inline strip — used on each equipment-type row. */
export const StatusStrip: React.FC<{ rollup: InventoryRollup; testID?: string }> = ({ rollup, testID }) => (
  <View style={styles.strip} testID={testID}>
    <Chip label="Total" value={rollup.total} />
    <Chip label="Yard" value={rollup.atYard} />
    <Chip label="Out" value={rollup.out} />
    <Chip label="Rsvd" value={rollup.reserved} tone={rollup.reserved > 0 ? colors.warning : undefined} />
    <Chip label="Avail" value={rollup.available} tone={rollup.available > 0 ? colors.success : colors.inkMuted} strong />
    <Chip label="Repair" value={rollup.repair} tone={rollup.repair > 0 ? colors.error : undefined} />
    {rollup.missing > 0 ? <Chip label="Missing" value={rollup.missing} tone={colors.error} /> : null}
  </View>
);

const Chip: React.FC<{ label: string; value: number; tone?: string; strong?: boolean }> = ({ label, value, tone, strong }) => (
  <View style={styles.chip}>
    <Text style={[styles.chipValue, tone ? { color: tone } : null, strong && styles.chipValueStrong]}>{value}</Text>
    <Text style={styles.chipLabel}>{label}</Text>
  </View>
);

// Reminder rendered under a status board so nobody reads "At Yard" as
// "rentable" — the two differ by reservations, repairs and inspections.
export const AvailabilityNote: React.FC = () => (
  <Text style={styles.note}>
    Available = At Yard − Reserved − Repair/Damaged − Awaiting Inspection. At Yard alone is not what you can rent out.
  </Text>
);

const styles = StyleSheet.create({
  board: {
    flexDirection: "row", flexWrap: "wrap",
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    backgroundColor: colors.bg, overflow: "hidden",
  },
  boardCell: { flexGrow: 1, flexBasis: 104, minWidth: 96, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRightWidth: 1, borderRightColor: colors.border },
  boardValue: { fontSize: 22, fontWeight: "800", color: colors.ink, letterSpacing: -0.5 },
  boardValueEmphasis: { fontSize: 26 },
  boardLabel: { ...typo.caption, fontSize: 9.5, marginTop: 1 },
  strip: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: 6 },
  chip: { minWidth: 44 },
  chipValue: { fontSize: 14, fontWeight: "700", color: colors.ink },
  chipValueStrong: { fontSize: 16, fontWeight: "800" },
  chipLabel: { ...typo.caption, fontSize: 9, marginTop: 0 },
  note: { ...typo.bodySmall, fontSize: 11.5, color: colors.inkMuted, marginTop: spacing.xs },
});

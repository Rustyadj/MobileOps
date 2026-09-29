// Dashboard "where is everything" board: what's on rent at job sites, what's
// going out next, what needs picking up, and returns still to be checked in.
// Built from rentals AND dispatches — the Rentals planning board (dispatches
// with planning_only) is where most live jobs are tracked, so rentals alone
// would read as an idle fleet.
import React, { useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { NextMovement } from "@/src/components/dashboard/WhatsNext";
import { isDispatchLive, isRentalOpen } from "@/src/domain/status";
import { colors, radii } from "@/src/theme";

export type BoardRental = { id: string; customer_name: string; job_site: string; start_date: string; due_date?: string | null; status: string };
type BoardDispatch = NextMovement & { planning_only?: boolean };

export type BoardTab = "on_rent" | "going_out" | "pickups" | "verify";
export type BoardRow = {
  key: string; kind: "rental" | "dispatch"; id: string;
  customer: string; site: string; date?: string | null; status: string; late: boolean;
};

const TABS: { key: BoardTab; label: string; dateLabel: string; empty: string }[] = [
  { key: "on_rent", label: "On rent", dateLabel: "Out since", empty: "Nothing out on rent." },
  { key: "going_out", label: "Going out", dateLabel: "Scheduled", empty: "No deliveries scheduled." },
  { key: "pickups", label: "Pickups", dateLabel: "Pickup", empty: "No pickups pending." },
  { key: "verify", label: "Check in", dateLabel: "Picked up", empty: "No returns waiting on check-in." },
];

const ON_RENT_STATUSES = ["active_rental", "moved_to_other_jobs"];
const VERIFY_STATUSES = ["picked_up_needs_verification", "at_yard"];

function tabForDispatch(item: BoardDispatch): BoardTab {
  if (item.direction === "outbound") return "going_out";
  if (ON_RENT_STATUSES.includes(item.status)) return "on_rent";
  if (VERIFY_STATUSES.includes(item.status)) return "verify";
  return "pickups";
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const dateLabel = (value?: string | null) => value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "No date";
const siteKey = (row: BoardRow) => `${row.customer.trim().toLowerCase()}|${row.site.trim().toLowerCase()}`;

export function buildRentalsBoard(rentals: BoardRental[], dispatches: BoardDispatch[]): Record<BoardTab, BoardRow[]> {
  const today = startOfToday();
  const board: Record<BoardTab, BoardRow[]> = { on_rent: [], going_out: [], pickups: [], verify: [] };
  for (const rental of rentals) {
    if (!isRentalOpen(rental.status)) continue;
    board.on_rent.push({
      key: `rental-${rental.id}`, kind: "rental", id: rental.id,
      customer: rental.customer_name || rental.job_site || "Rental", site: rental.job_site || "—",
      date: rental.start_date, status: rental.status,
      late: !!rental.due_date && new Date(rental.due_date) < today,
    });
  }
  for (const item of dispatches) {
    if (!isDispatchLive(item.status)) continue;
    const tab = tabForDispatch(item);
    board[tab].push({
      key: `dispatch-${item.id}`, kind: "dispatch", id: item.id,
      customer: item.customer_name || item.job_site || "Dispatch", site: item.job_site || "—",
      date: item.scheduled_date, status: item.status,
      late: (tab === "going_out" || tab === "pickups") && !!item.scheduled_date && new Date(item.scheduled_date) < today,
    });
  }
  // The planning board and live dispatches can both carry the same job
  // (e.g. a planning "needs pickup" plus a scheduled pickup) — show it once,
  // preferring the dated entry.
  for (const tab of Object.keys(board) as BoardTab[]) {
    const byKey = new Map<string, BoardRow>();
    for (const row of board[tab]) {
      const existing = byKey.get(siteKey(row));
      if (!existing || (!existing.date && row.date)) byKey.set(siteKey(row), row);
    }
    const rows = [...byKey.values()];
    const time = (row: BoardRow) => row.date ? +new Date(row.date) : Number.MAX_SAFE_INTEGER;
    // On rent: longest out first. Everything else: soonest first, undated last.
    board[tab] = tab === "on_rent" ? rows.sort((a, b) => (a.date ? +new Date(a.date) : 0) - (b.date ? +new Date(b.date) : 0)) : rows.sort((a, b) => time(a) - time(b));
  }
  return board;
}

export function RentalsBoard({
  rentals, dispatches, compact = false, limit = 6, onPressRow, onViewAll,
}: {
  rentals: BoardRental[];
  dispatches: BoardDispatch[];
  compact?: boolean;
  limit?: number;
  onPressRow: (row: BoardRow) => void;
  onViewAll: (tab: BoardTab) => void;
}) {
  const board = useMemo(() => buildRentalsBoard(rentals, dispatches), [rentals, dispatches]);
  const [tab, setTab] = useState<BoardTab>("on_rent");
  const active = TABS.find((entry) => entry.key === tab)!;
  const rows = board[tab].slice(0, limit);
  const hidden = board[tab].length - rows.length;

  return (
    <View style={styles.panel} testID="dashboard-rentals-board">
      <View style={styles.header}>
        <Ionicons name="swap-horizontal-outline" size={16} color={colors.primary} style={{ marginRight: 7 }} />
        <Text style={styles.title}>Rentals</Text>
        <TouchableOpacity onPress={() => onViewAll(tab)} style={styles.headerAction} accessibilityRole="button" testID="rentals-board-view-all">
          <Text style={styles.headerActionText}>View All  →</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.tabs} role="tablist">
        {TABS.map((entry) => {
          const selected = entry.key === tab;
          const count = board[entry.key].length;
          const lateCount = board[entry.key].filter((row) => row.late).length;
          return (
            <TouchableOpacity key={entry.key} onPress={() => setTab(entry.key)} style={[styles.tab, selected && styles.tabActive]} role="tab" aria-selected={selected} testID={`rentals-board-tab-${entry.key}`}>
              <Text style={[styles.tabCount, selected && styles.tabCountActive, lateCount > 0 && entry.key !== "on_rent" && styles.tabCountLate]}>{count}</Text>
              <Text style={[styles.tabLabel, selected && styles.tabLabelActive]} numberOfLines={1}>{entry.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {!compact ? (
        <View style={styles.colHeaderRow}>
          <Text style={[styles.colHeader, { flex: 1.4 }]}>CUSTOMER / JOB</Text>
          <Text style={[styles.colHeader, { flex: 1.1 }]}>SITE</Text>
          <Text style={[styles.colHeader, { flex: 0.8 }]}>{active.dateLabel.toUpperCase()}</Text>
          <Text style={[styles.colHeader, { flex: 1.1 }]}>STATUS</Text>
        </View>
      ) : null}

      <View style={styles.body}>
        {rows.length === 0 ? <Text style={styles.empty}>{active.empty}</Text> : rows.map((row) => (
          <TouchableOpacity key={row.key} style={styles.row} onPress={() => onPressRow(row)} activeOpacity={0.6} testID={`rentals-board-row-${row.id}`}>
            {compact ? (
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.cellStrong} numberOfLines={1}>{row.customer}</Text>
                <Text style={styles.cellMuted} numberOfLines={1}>{row.site} · <Text style={row.late && styles.lateText}>{dateLabel(row.date)}{row.late ? " · late" : ""}</Text></Text>
              </View>
            ) : (
              <>
                <Text style={[styles.cellStrong, { flex: 1.4 }]} numberOfLines={1}>{row.customer}</Text>
                <Text style={[styles.cell, { flex: 1.1 }]} numberOfLines={1}>{row.site}</Text>
                <Text style={[styles.cell, { flex: 0.8 }, row.late && styles.lateText]} numberOfLines={1}>{dateLabel(row.date)}{row.late ? " · late" : ""}</Text>
              </>
            )}
            <View style={compact ? undefined : { flex: 1.1, alignItems: "flex-start" }}>
              <StatusBadge label={row.status.replace(/_/g, " ")} tone={row.late ? "error" : undefined} />
            </View>
          </TouchableOpacity>
        ))}
        {hidden > 0 ? (
          <TouchableOpacity onPress={() => onViewAll(tab)} style={styles.moreRow}><Text style={styles.moreText}>+{hidden} more</Text></TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minWidth: 0, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, overflow: "hidden" },
  header: { height: 36, flexDirection: "row", alignItems: "center", paddingHorizontal: 11, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 13, fontWeight: "800", color: colors.ink, letterSpacing: -0.1 },
  headerAction: { marginLeft: "auto", minHeight: 30, justifyContent: "center" },
  headerActionText: { fontSize: 11, fontWeight: "700", color: colors.primary },
  tabs: { flexDirection: "row", gap: 6, padding: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  tab: { flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 8, paddingVertical: 5, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, justifyContent: "center" },
  tabActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  tabCount: { fontSize: 17, lineHeight: 20, fontWeight: "800", color: colors.ink, fontVariant: ["tabular-nums"] },
  tabCountActive: { color: colors.primary },
  tabCountLate: { color: colors.error },
  tabLabel: { fontSize: 10.5, fontWeight: "700", color: colors.inkSecondary },
  tabLabelActive: { color: colors.primary },
  colHeaderRow: { flexDirection: "row", gap: 10, paddingHorizontal: 11, paddingVertical: 6, backgroundColor: colors.bgMuted, borderBottomWidth: 1, borderBottomColor: colors.border },
  colHeader: { fontSize: 9.5, fontWeight: "800", color: colors.inkMuted, letterSpacing: 0.5 },
  body: { flex: 1 },
  row: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 11, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.border },
  cell: { fontSize: 11.5, color: colors.ink },
  cellStrong: { fontSize: 11.5, color: colors.ink, fontWeight: "700" },
  cellMuted: { fontSize: 10.5, color: colors.inkMuted, marginTop: 1 },
  lateText: { color: colors.error, fontWeight: "700" },
  empty: { padding: 20, textAlign: "center", color: colors.inkMuted, fontSize: 12 },
  moreRow: { paddingVertical: 7, alignItems: "center" },
  moreText: { fontSize: 11, fontWeight: "700", color: colors.primary },
});

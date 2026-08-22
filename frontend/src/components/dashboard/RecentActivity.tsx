// Full-width "Recent Activity" table below the dashboard's operational
// panels. The backend's /dashboard/stats only returns {type, title, ts} —
// "Related To" is parsed from the title's own "Kind — Subject" format, and
// "Performed By" is left blank rather than inventing an attributed user,
// since the backend does not record who performed an action.
import React from "react";
import { Text, StyleSheet } from "react-native";
import { colors } from "@/src/theme";
import { OperationalTable, OpColumn } from "./OperationalTable";

export type ActivityRow = { type: string; title: string; ts: string };

const KIND_LABEL: Record<string, string> = {
  rental: "Rental created",
  maintenance: "Service logged",
};

function relatedTo(title: string): string {
  const parts = title.split(" — ");
  return parts.length > 1 ? parts[1] : "—";
}

export const RecentActivity: React.FC<{
  rows: ActivityRow[];
  onViewAll: () => void;
  onRowPress: (row: ActivityRow) => void;
}> = ({ rows, onViewAll, onRowPress }) => {
  const columns: OpColumn<ActivityRow & { _i: number }>[] = [
    { key: "time", label: "Time", width: 90, render: (r) => <Text style={styles.time}>{new Date(r.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</Text> },
    { key: "activity", label: "Activity", flex: 1.1, render: (r) => <Text style={styles.cell} numberOfLines={1}>{KIND_LABEL[r.type] || r.type}</Text> },
    { key: "details", label: "Details", flex: 2, render: (r) => <Text style={styles.cell} numberOfLines={1}>{r.title}</Text> },
    { key: "related", label: "Related to", flex: 1.2, render: (r) => <Text style={styles.link} numberOfLines={1}>{relatedTo(r.title)}</Text> },
    { key: "performed", label: "Performed by", flex: 1, render: () => <Text style={styles.muted}>—</Text> },
  ];

  const withIndex = rows.map((r, i) => ({ ...r, _i: i }));

  return (
    <OperationalTable
      title="Recent Activity"
      columns={columns}
      rows={withIndex}
      keyExtractor={(r) => `${r.type}-${r.ts}-${r._i}`}
      onRowPress={onRowPress}
      emptyLabel="No activity yet."
      viewAllLabel="View all"
      onViewAll={onViewAll}
      testID="dashboard-recent-activity"
      fullWidth
    />
  );
};

const styles = StyleSheet.create({
  time: { fontSize: 11.5, color: colors.inkMuted, fontFamily: "monospace" },
  cell: { fontSize: 12, color: colors.ink },
  link: { fontSize: 12, color: colors.primary, fontWeight: "600" },
  muted: { fontSize: 12, color: colors.inkMuted },
});

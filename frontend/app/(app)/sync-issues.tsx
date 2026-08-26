// Review screen for queued actions that couldn't sync (terminal HTTP
// failure — 409 conflict, 403/422 rejected) — the "never silently vanish"
// requirement from the offline-sync plan. Actions still waiting on
// connectivity (network failure, backing off) don't show up here; they're
// just pending, not a problem to review.
import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Row, Button } from "@/src/components/ui";
import { colors, spacing, type as typo } from "@/src/theme";
import { failedRows, subscribeQueueChanged, retryFailed, discardFailed } from "@/src/sync/syncEngine";
import type { QueueRow } from "@/src/sync/queue";

function describe(row: QueueRow): string {
  const action = row.kind === "create" ? "Create" : row.method === "DELETE" ? "Delete" : "Update";
  return `${action} — ${row.entity_type.replace(/_/g, " ")}`;
}

export default function SyncIssuesScreen() {
  const [rows, setRows] = useState<QueueRow[]>(() => failedRows());

  useEffect(() => {
    const refresh = () => setRows(failedRows());
    refresh();
    return subscribeQueueChanged(refresh);
  }, []);

  return (
    <Screen title="Sync Issues" subtitle={`${rows.length} action${rows.length === 1 ? "" : "s"} couldn't sync`} back testID="sync-issues-screen">
      {rows.length === 0 ? (
        <Card><Text style={[typo.body, { color: colors.inkMuted }]}>Nothing to review — everything queued has synced.</Text></Card>
      ) : rows.map((row) => (
        <Card key={row.id} style={{ marginBottom: spacing.sm }} testID={`sync-issue-${row.id}`}>
          <Text style={typo.h3}>{describe(row)}</Text>
          <Text style={[typo.mono, styles.reason]} numberOfLines={3}>{row.last_error || "Sync failed"}</Text>
          <Text style={[typo.label, { marginTop: spacing.xs }]}>Queued {new Date(row.created_at).toLocaleString()}</Text>
          <Row style={{ gap: spacing.sm, marginTop: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button title="Retry" onPress={() => retryFailed(row.id)} variant="outline" testID={`sync-issue-retry-${row.id}`} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Discard" onPress={() => discardFailed(row.id)} variant="danger" testID={`sync-issue-discard-${row.id}`} />
            </View>
          </Row>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  reason: { marginTop: spacing.xs, fontSize: 12, color: colors.error },
});

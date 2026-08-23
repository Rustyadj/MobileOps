// Bracing Engine — on desktop, inputs sit in a left column with results
// persistently visible on the right instead of forcing repeated scrolling
// to check output after every edit. Mobile keeps the original single
// scrolling column. Calculation logic and engineering warnings unchanged.
import { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Button, Card, H3, Input, Mono, SectionLabel, Pill, Row } from "@/src/components/ui";
import { SplitPane } from "@/src/components/layout/SplitPane";
import { EmptyState } from "@/src/components/feedback/EmptyState";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo } from "@/src/theme";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";

type WallRun = { name: string; corners: string; linear_ft: string; wall_height: string };
type RunResult = {
  name: string; corners: number; linear_ft: number; wall_height: number;
  strongbacks: number; braces: number; brace_length: number | null; engineer_required: boolean;
};
type Result = {
  runs: RunResult[];
  total_strongbacks: number;
  total_braces: number;
  braces_by_length: Record<string, number>;
  engineer_required: boolean;
};

export default function BracingScreen() {
  const { isShellWide } = useBreakpoint();
  const [runs, setRuns] = useState<WallRun[]>([
    { name: "Run A", corners: "4", linear_ft: "60", wall_height: "9" },
  ]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update = (i: number, key: keyof WallRun, v: string) =>
    setRuns((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));

  const addRun = () =>
    setRuns((rs) => [...rs, { name: `Run ${String.fromCharCode(65 + rs.length)}`, corners: "0", linear_ft: "0", wall_height: "8" }]);

  const removeRun = (i: number) => setRuns((rs) => rs.filter((_, idx) => idx !== i));

  const calculate = async () => {
    setErr(null);
    setBusy(true);
    try {
      const body = {
        runs: runs.map((r) => ({
          name: r.name,
          corners: parseInt(r.corners || "0", 10),
          linear_ft: parseFloat(r.linear_ft || "0"),
          wall_height: parseFloat(r.wall_height || "0"),
        })),
      };
      const res = await api<Result>("/bracing/calculate", { method: "POST", body: JSON.stringify(body) });
      setResult(res);
    } catch (e: any) {
      setErr(e.message || "Calculation failed");
    } finally {
      setBusy(false);
    }
  };

  const inputsContent = (
    <View style={isShellWide ? { padding: spacing.lg } : undefined}>
      <SectionLabel>Rule</SectionLabel>
      <Card style={{ marginBottom: spacing.md }}>
        <Text style={typo.body}>1 strongback per corner. 1 brace every 4 ft of wall (round up). Brace length set by wall height:
          <Text style={[typo.mono, { fontSize: 13 }]}> ≤10′→10′, 10–12′→12′, 12–16′→16′, 16–20′→20′</Text>. Above 20′ flags engineer required.
        </Text>
      </Card>

      {runs.map((r, i) => (
        <Card key={i} style={{ marginBottom: spacing.md }} testID={`run-card-${i}`}>
          <Row style={{ justifyContent: "space-between", marginBottom: spacing.sm }}>
            <H3>{r.name}</H3>
            {runs.length > 1 ? (
              <TouchableOpacity onPress={() => removeRun(i)} testID={`remove-run-${i}`}>
                <Ionicons name="close" size={22} color={colors.error} />
              </TouchableOpacity>
            ) : null}
          </Row>
          <Input label="Name" value={r.name} onChangeText={(t) => update(i, "name", t)} testID={`run-name-${i}`} />
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Input label="Corners" value={r.corners} onChangeText={(t) => update(i, "corners", t)} keyboardType="number-pad" mono testID={`run-corners-${i}`} />
            </View>
            <View style={{ flex: 1 }}>
              <Input label="Wall Ht (ft)" value={r.wall_height} onChangeText={(t) => update(i, "wall_height", t)} keyboardType="decimal-pad" mono testID={`run-height-${i}`} />
            </View>
          </Row>
          <Input label="Linear ft of wall" value={r.linear_ft} onChangeText={(t) => update(i, "linear_ft", t)} keyboardType="decimal-pad" mono testID={`run-linearft-${i}`} />
        </Card>
      ))}

      <Button title="+ Add Wall Run" onPress={addRun} variant="outline" testID="add-run-btn" />
      <View style={{ height: spacing.md }} />
      <Button title="Calculate" onPress={calculate} loading={busy} testID="calculate-btn" />

      {err ? (
        <View style={[styles.errBox, { marginTop: spacing.md }]}>
          <Text style={{ color: colors.error, fontWeight: "700" }}>{err}</Text>
        </View>
      ) : null}
    </View>
  );

  const resultsContent = result ? (
    <View style={isShellWide ? { padding: spacing.lg } : { marginTop: spacing.lg }} testID="bracing-results">
      <SectionLabel>Totals</SectionLabel>
      <View style={styles.totalsRow}>
        <TotalTile label="Strongbacks" value={`${result.total_strongbacks}`} />
        <TotalTile label="Braces" value={`${result.total_braces}`} accent />
      </View>

      {result.engineer_required ? (
        <View style={styles.warn} testID="engineer-warning">
          <Ionicons name="warning" size={18} color={colors.warning} />
          <Text style={{ color: colors.ink, fontWeight: "700", marginLeft: 8, flex: 1 }}>
            One or more walls exceed 20′ — engineer required for those runs.
          </Text>
        </View>
      ) : null}

      <SectionLabel>Order list — Braces by length</SectionLabel>
      <Card>
        {Object.keys(result.braces_by_length).length === 0 ? (
          <Text style={[typo.body, { color: colors.inkMuted }]}>No braces required.</Text>
        ) : (
          Object.entries(result.braces_by_length).map(([len, qty]) => (
            <Row key={len} style={styles.row}>
              <Mono>{len}′ braces</Mono>
              <View style={{ flex: 1 }} />
              <Mono large>{qty}</Mono>
            </Row>
          ))
        )}
      </Card>

      <View style={{ height: spacing.md }} />
      <SectionLabel>Per-run breakdown</SectionLabel>
      {result.runs.map((rr, i) => (
        <Card key={i} style={{ marginBottom: spacing.sm }}>
          <Row style={{ justifyContent: "space-between", marginBottom: 4 }}>
            <H3>{rr.name}</H3>
            {rr.engineer_required ? (
              <Pill color={colors.warning} bg="#FEF3C7">Engineer</Pill>
            ) : (
              <Pill>{rr.brace_length}′ braces</Pill>
            )}
          </Row>
          <Text style={typo.body}>
            <Mono>{rr.corners}</Mono> corners · <Mono>{rr.linear_ft}</Mono> lf · <Mono>{rr.wall_height}</Mono>′ ht
          </Text>
          <Row style={{ marginTop: 6, gap: spacing.lg }}>
            <Text style={typo.label}>SB <Mono style={{ fontSize: 14 }}>{rr.strongbacks}</Mono></Text>
            <Text style={typo.label}>BR <Mono style={{ fontSize: 14 }}>{rr.braces}</Mono></Text>
          </Row>
        </Card>
      ))}
    </View>
  ) : isShellWide ? (
    <View style={{ padding: spacing.lg }}>
      <EmptyState icon="construct-outline" title="No results yet" subtitle="Enter wall runs on the left and tap Calculate." />
    </View>
  ) : null;

  if (isShellWide) {
    return (
      <Screen title="Bracing Engine" subtitle="Strongbacks + braces by wall run" back scroll={false} testID="bracing-screen">
        <SplitPane
          primary={<ScrollView showsVerticalScrollIndicator={false}>{inputsContent}</ScrollView>}
          secondary={<ScrollView showsVerticalScrollIndicator={false}>{resultsContent}</ScrollView>}
          secondaryWidth={420}
        />
      </Screen>
    );
  }

  return (
    <Screen title="Bracing Engine" subtitle="Strongbacks + braces by wall run" back testID="bracing-screen">
      {inputsContent}
      {resultsContent}
    </Screen>
  );
}

const TotalTile: React.FC<{ label: string; value: string; accent?: boolean }> = ({ label, value, accent }) => (
  <View style={[styles.tile, accent && { backgroundColor: colors.ink }]}>
    <Text style={[typo.label, accent && { color: "#FFF", opacity: 0.7 }]}>{label}</Text>
    <Mono large style={accent ? { color: colors.orange } : undefined}>{value}</Mono>
  </View>
);

const styles = StyleSheet.create({
  totalsRow: { flexDirection: "row", gap: 12, marginBottom: spacing.lg },
  tile: { flex: 1, borderWidth: 2, borderColor: colors.ink, padding: 14, backgroundColor: colors.bg },
  warn: { flexDirection: "row", alignItems: "center", borderWidth: 2, borderColor: colors.warning, backgroundColor: "#FEF3C7", padding: spacing.md, marginBottom: spacing.md },
  row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  errBox: { borderWidth: 2, borderColor: colors.error, backgroundColor: "#FEF2F2", padding: spacing.md },
});

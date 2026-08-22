import { useState, useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, Mono, SectionLabel, Pill, Row } from "@/src/components/ui";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, type as typo } from "@/src/theme";
import {
  parseFeetInches, formatFtInFrac, formatDecimalFt, formatTotalInches,
  icfConcreteCubicYards, areaSqFt, icfBlockCount, ICF_BLOCK_PRESETS, rebarTakeoff, REBAR_WEIGHT,
} from "@/src/utils/construction-math";

type TabKey = "icf" | "convert" | "area" | "blocks" | "rebar" | "dimmath";

const TABS: { key: TabKey; label: string }[] = [
  { key: "icf", label: "ICF Wall" },
  { key: "convert", label: "Ft-In" },
  { key: "area", label: "Area" },
  { key: "blocks", label: "Blocks" },
  { key: "rebar", label: "Rebar" },
  { key: "dimmath", label: "Dim Math" },
];

export default function CalculatorScreen() {
  const [tab, setTab] = useState<TabKey>("icf");
  return (
    <Screen title="Calculator" subtitle="Construction Master · Imperial" back testID="calculator-screen">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabRow}
        style={{ marginHorizontal: -spacing.lg, marginBottom: spacing.md }}
      >
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            onPress={() => setTab(t.key)}
            style={[styles.tab, tab === t.key && styles.tabActive]}
            testID={`tab-${t.key}`}
          >
            <Text style={[styles.tabText, tab === t.key && { color: colors.orange }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {tab === "icf" && <ICFTab />}
      {tab === "convert" && <ConvertTab />}
      {tab === "area" && <AreaTab />}
      {tab === "blocks" && <BlocksTab />}
      {tab === "rebar" && <RebarTab />}
      {tab === "dimmath" && <DimMathTab />}
    </Screen>
  );
}

/* ----- ICF Wall Concrete ----- */
function ICFTab() {
  const [length, setLength] = useState("40");
  const [height, setHeight] = useState("9");
  const [core, setCore] = useState("6");
  const [waste, setWaste] = useState("10");
  const cy = useMemo(() => icfConcreteCubicYards(
    parseFloat(length || "0"), parseFloat(height || "0"),
    parseFloat(core || "0"), parseFloat(waste || "0"),
  ), [length, height, core, waste]);
  return (
    <>
      <SectionLabel>ICF wall concrete</SectionLabel>
      <Card style={{ marginBottom: spacing.md }}>
        <Input label="Wall length (ft)" value={length} onChangeText={setLength} keyboardType="decimal-pad" mono testID="icf-length" />
        <Input label="Wall height (ft)" value={height} onChangeText={setHeight} keyboardType="decimal-pad" mono testID="icf-height" />
        <Input label="Core thickness (in)" value={core} onChangeText={setCore} keyboardType="decimal-pad" mono testID="icf-core" />
        <Input label="Waste %" value={waste} onChangeText={setWaste} keyboardType="decimal-pad" mono testID="icf-waste" />
      </Card>
      <ResultTile label="Concrete required" value={`${cy.toFixed(2)} cy`} testID="icf-result" />
    </>
  );
}

/* ----- Ft-In <-> Decimal converter ----- */
function ConvertTab() {
  const [input, setInput] = useState("12'6 1/2\"");
  const inches = parseFeetInches(input);
  return (
    <>
      <SectionLabel>Convert</SectionLabel>
      <Card>
        <Input
          label={`Input (e.g. 12'6 1/2" or 12.5)`}
          value={input}
          onChangeText={setInput}
          mono
          autoCapitalize="none"
          testID="convert-input"
        />
        <View style={{ height: spacing.sm }} />
        <ResultRow label="Ft-In-Frac" value={formatFtInFrac(inches)} testID="convert-ftin" />
        <ResultRow label="Decimal feet" value={formatDecimalFt(inches)} testID="convert-decft" />
        <ResultRow label="Total inches" value={formatTotalInches(inches)} testID="convert-totin" />
      </Card>
    </>
  );
}

/* ----- Area ----- */
function AreaTab() {
  const [length, setLength] = useState("20");
  const [width, setWidth] = useState("12");
  const [waste, setWaste] = useState("5");
  const sqft = areaSqFt(parseFloat(length || "0"), parseFloat(width || "0"), parseFloat(waste || "0"));
  return (
    <>
      <SectionLabel>Area</SectionLabel>
      <Card style={{ marginBottom: spacing.md }}>
        <Input label="Length (ft)" value={length} onChangeText={setLength} keyboardType="decimal-pad" mono testID="area-length" />
        <Input label="Width (ft)" value={width} onChangeText={setWidth} keyboardType="decimal-pad" mono testID="area-width" />
        <Input label="Waste %" value={waste} onChangeText={setWaste} keyboardType="decimal-pad" mono testID="area-waste" />
      </Card>
      <ResultTile label="Area" value={`${sqft.toFixed(2)} sq ft`} testID="area-result" />
    </>
  );
}

/* ----- ICF Block count ----- */
function BlocksTab() {
  const [preset, setPreset] = useState<string>("Standard");
  const [length, setLength] = useState("40");
  const [height, setHeight] = useState("9");
  const [openings, setOpenings] = useState("32");
  const [waste, setWaste] = useState("8");
  const [customL, setCustomL] = useState("48");
  const [customH, setCustomH] = useState("16");
  const isCustom = preset === "Custom";
  const bl = isCustom ? parseFloat(customL || "0") : ICF_BLOCK_PRESETS[preset].length_in;
  const bh = isCustom ? parseFloat(customH || "0") : ICF_BLOCK_PRESETS[preset].height_in;
  const blocks = icfBlockCount(
    parseFloat(length || "0"), parseFloat(height || "0"), bl, bh,
    parseFloat(openings || "0"), parseFloat(waste || "0"),
  );
  return (
    <>
      <SectionLabel>ICF block presets</SectionLabel>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }} style={{ marginBottom: spacing.md }}>
        {[...Object.keys(ICF_BLOCK_PRESETS), "Custom"].map((p) => (
          <TouchableOpacity
            key={p}
            onPress={() => setPreset(p)}
            style={[styles.chip, preset === p && styles.chipActive]}
            testID={`block-preset-${p}`}
          >
            <Text style={[styles.chipText, preset === p && { color: "#FFF" }]}>{p}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <Card style={{ marginBottom: spacing.md }}>
        {isCustom && (
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Input label="Block L (in)" value={customL} onChangeText={setCustomL} keyboardType="decimal-pad" mono testID="block-customL" />
            </View>
            <View style={{ flex: 1 }}>
              <Input label="Block H (in)" value={customH} onChangeText={setCustomH} keyboardType="decimal-pad" mono testID="block-customH" />
            </View>
          </Row>
        )}
        <Input label="Wall length (ft)" value={length} onChangeText={setLength} keyboardType="decimal-pad" mono testID="block-length" />
        <Input label="Wall height (ft)" value={height} onChangeText={setHeight} keyboardType="decimal-pad" mono testID="block-height" />
        <Input label="Openings (sq ft)" value={openings} onChangeText={setOpenings} keyboardType="decimal-pad" mono testID="block-openings" />
        <Input label="Waste %" value={waste} onChangeText={setWaste} keyboardType="decimal-pad" mono testID="block-waste" />
      </Card>
      <ResultTile label={`${preset} blocks needed`} value={`${blocks}`} testID="block-result" />
    </>
  );
}

/* ----- Rebar takeoff (multi-run) ----- */
type RebarRun = { name: string; length: string; height: string; vert: string; horiz: string };

function RebarTab() {
  const [runs, setRuns] = useState<RebarRun[]>([
    { name: "Run A", length: "40", height: "9", vert: "12", horiz: "16" },
  ]);
  const [bar, setBar] = useState("5");
  const [stick, setStick] = useState("20");

  const update = (i: number, key: keyof RebarRun, v: string) =>
    setRuns((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));

  const addRun = () =>
    setRuns((rs) => [
      ...rs,
      { name: `Run ${String.fromCharCode(65 + rs.length)}`, length: "0", height: "0", vert: "12", horiz: "16" },
    ]);

  const removeRun = (i: number) => setRuns((rs) => rs.filter((_, idx) => idx !== i));

  const perRun = runs.map((r) =>
    rebarTakeoff(
      parseFloat(r.length || "0"), parseFloat(r.height || "0"),
      parseFloat(r.vert || "0"), parseFloat(r.horiz || "0"),
      bar, parseFloat(stick || "0"),
    ),
  );
  const totals = perRun.reduce(
    (acc, o) => ({
      vertBars: acc.vertBars + o.vertBars,
      horizBars: acc.horizBars + o.horizBars,
      totalLf: acc.totalLf + o.totalLf,
      weightLb: acc.weightLb + o.weightLb,
      sticks: acc.sticks + o.sticks,
    }),
    { vertBars: 0, horizBars: 0, totalLf: 0, weightLb: 0, sticks: 0 },
  );

  return (
    <>
      <SectionLabel>Rebar takeoff — wall runs</SectionLabel>

      {runs.map((r, i) => (
        <Card key={i} style={{ marginBottom: spacing.md }} testID={`rebar-run-card-${i}`}>
          <Row style={{ justifyContent: "space-between", marginBottom: spacing.sm }}>
            <Text style={[typo.h3, { fontSize: 16 }]}>{r.name}</Text>
            {runs.length > 1 ? (
              <TouchableOpacity onPress={() => removeRun(i)} testID={`rebar-remove-run-${i}`}>
                <Ionicons name="close" size={22} color={colors.error} />
              </TouchableOpacity>
            ) : null}
          </Row>
          <Input label="Name" value={r.name} onChangeText={(t) => update(i, "name", t)} testID={`rebar-run-name-${i}`} />
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Input label="Wall L (ft)" value={r.length} onChangeText={(t) => update(i, "length", t)} keyboardType="decimal-pad" mono testID={`rebar-run-length-${i}`} />
            </View>
            <View style={{ flex: 1 }}>
              <Input label="Wall H (ft)" value={r.height} onChangeText={(t) => update(i, "height", t)} keyboardType="decimal-pad" mono testID={`rebar-run-height-${i}`} />
            </View>
          </Row>
          <Row style={{ gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Input label="Vert spacing (in)" value={r.vert} onChangeText={(t) => update(i, "vert", t)} keyboardType="decimal-pad" mono testID={`rebar-run-vert-${i}`} />
            </View>
            <View style={{ flex: 1 }}>
              <Input label="Horiz spacing (in)" value={r.horiz} onChangeText={(t) => update(i, "horiz", t)} keyboardType="decimal-pad" mono testID={`rebar-run-horiz-${i}`} />
            </View>
          </Row>
          <Row style={{ gap: spacing.md, marginTop: 4 }}>
            <Text style={typo.label}>Vert <Mono style={{ fontSize: 13 }}>{perRun[i].vertBars}</Mono></Text>
            <Text style={typo.label}>Horiz <Mono style={{ fontSize: 13 }}>{perRun[i].horizBars}</Mono></Text>
            <Text style={typo.label}>LF <Mono style={{ fontSize: 13 }}>{perRun[i].totalLf.toFixed(1)}</Mono></Text>
          </Row>
        </Card>
      ))}

      <Button title="+ Add Wall Run" onPress={addRun} variant="outline" testID="rebar-add-run" />

      <View style={{ height: spacing.md }} />
      <SectionLabel>Bar size</SectionLabel>
      <Card style={{ marginBottom: spacing.md }}>
        <View style={{ flexDirection: "row", gap: 8, marginBottom: spacing.md }}>
          {Object.keys(REBAR_WEIGHT).map((b) => (
            <TouchableOpacity
              key={b}
              onPress={() => setBar(b)}
              style={[styles.chip, bar === b && styles.chipActive, { flex: 1, alignItems: "center" }]}
              testID={`rebar-bar-${b}`}
            >
              <Text style={[styles.chipText, bar === b && { color: "#FFF" }]}>#{b}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Input label="Stick length (ft)" value={stick} onChangeText={setStick} keyboardType="decimal-pad" mono testID="rebar-stick" />
      </Card>

      <SectionLabel>Totals — all runs</SectionLabel>
      <View style={styles.grid2}>
        <ResultTile label="Vert bars" value={`${totals.vertBars}`} testID="rebar-vertbars" />
        <ResultTile label="Horiz bars" value={`${totals.horizBars}`} testID="rebar-horizbars" />
      </View>
      <View style={styles.grid2}>
        <ResultTile label="Total lf" value={`${totals.totalLf.toFixed(1)}`} testID="rebar-totallf" />
        <ResultTile label="Weight (lb)" value={`${totals.weightLb.toFixed(1)}`} testID="rebar-weight" />
      </View>
      <ResultTile label="Sticks needed" value={`${totals.sticks}`} accent testID="rebar-sticks" />
    </>
  );
}

/* ----- Dimension Math (running tape) ----- */
function DimMathTab() {
  const [tape, setTape] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [scaleFactor, setScaleFactor] = useState("");

  const total = useMemo(() => tape.reduce((acc, t) => {
    if (t.startsWith("-")) return acc - parseFeetInches(t.slice(1));
    return acc + parseFeetInches(t);
  }, 0), [tape]);

  const add = () => { if (input.trim()) { setTape((t) => [...t, input.trim()]); setInput(""); } };
  const sub = () => { if (input.trim()) { setTape((t) => [...t, "-" + input.trim()]); setInput(""); } };
  const clear = () => { setTape([]); setInput(""); };
  const scaled = scaleFactor ? total * parseFloat(scaleFactor) : total;
  const divided = scaleFactor && parseFloat(scaleFactor) !== 0 ? total / parseFloat(scaleFactor) : total;

  return (
    <>
      <SectionLabel>Running tape</SectionLabel>
      <Card style={{ marginBottom: spacing.md }}>
        <Input label={`Dimension (e.g. 12'6", 8-3 1/2)`} value={input} onChangeText={setInput} mono autoCapitalize="none" testID="dim-input" />
        <Row style={{ gap: spacing.sm }}>
          <View style={{ flex: 1 }}><Button title="+ Add" onPress={add} variant="primary" testID="dim-add" /></View>
          <View style={{ flex: 1 }}><Button title="− Subtract" onPress={sub} variant="secondary" testID="dim-sub" /></View>
        </Row>
        <View style={{ height: spacing.sm }} />
        <Button title="Clear Tape" onPress={clear} variant="outline" testID="dim-clear" />
      </Card>

      <SectionLabel>Tape</SectionLabel>
      <Card style={{ marginBottom: spacing.md }}>
        {tape.length === 0 ? (
          <Text style={[typo.body, { color: colors.inkMuted }]}>Empty. Add a dimension above.</Text>
        ) : tape.map((t, i) => (
          <Row key={i} style={styles.tapeRow}>
            <Mono>{t.startsWith("-") ? "−" : "+"}</Mono>
            <Mono style={{ marginLeft: 10, flex: 1 }}>{t.replace(/^-/, "")}</Mono>
            <Mono style={{ color: colors.inkSecondary }}>{formatFtInFrac(parseFeetInches(t.replace(/^-/, "")))}</Mono>
          </Row>
        ))}
      </Card>

      <SectionLabel>Total</SectionLabel>
      <Card style={{ marginBottom: spacing.md }}>
        <ResultRow label="Ft-In" value={formatFtInFrac(total)} testID="dim-total-ftin" />
        <ResultRow label="Decimal ft" value={formatDecimalFt(total)} testID="dim-total-decft" />
        <ResultRow label="Total in" value={formatTotalInches(total)} testID="dim-total-in" />
      </Card>

      <SectionLabel>Scale × ÷</SectionLabel>
      <Card>
        <Input label="Factor" value={scaleFactor} onChangeText={setScaleFactor} keyboardType="decimal-pad" mono testID="dim-scale" />
        <ResultRow label={`Total × ${scaleFactor || "?"}`} value={formatFtInFrac(scaled)} testID="dim-mul" />
        <ResultRow label={`Total ÷ ${scaleFactor || "?"}`} value={formatFtInFrac(divided)} testID="dim-div" />
      </Card>
    </>
  );
}

/* ----- helpers ----- */
const ResultTile: React.FC<{ label: string; value: string; accent?: boolean; testID?: string }> = ({ label, value, accent, testID }) => (
  <View style={[styles.resultTile, accent && { backgroundColor: colors.ink }]} testID={testID}>
    <Text style={[typo.label, accent && { color: "#FFF", opacity: 0.7 }]}>{label}</Text>
    <Mono large style={accent ? { color: colors.orange } : undefined}>{value}</Mono>
  </View>
);

const ResultRow: React.FC<{ label: string; value: string; testID?: string }> = ({ label, value, testID }) => (
  <Row style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }} testID={testID}>
    <Text style={[typo.label, { width: 110 }]}>{label}</Text>
    <Mono style={{ flex: 1, textAlign: "right" }}>{value}</Mono>
  </Row>
);

const styles = StyleSheet.create({
  tabRow: { paddingHorizontal: spacing.lg, gap: 8 },
  tab: { paddingHorizontal: 14, height: 40, justifyContent: "center", borderWidth: 2, borderColor: colors.border, backgroundColor: colors.bg, flexShrink: 0 },
  tabActive: { borderColor: colors.orange },
  tabText: { fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6, color: colors.inkSecondary },
  chip: { paddingHorizontal: 12, height: 36, justifyContent: "center", borderWidth: 1, borderColor: colors.border, flexShrink: 0 },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 12, fontWeight: "700", color: colors.inkSecondary },
  resultTile: { borderWidth: 2, borderColor: colors.ink, padding: 14, marginBottom: spacing.md, flex: 1 },
  grid2: { flexDirection: "row", gap: 12, marginBottom: 0 },
  tapeRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
});

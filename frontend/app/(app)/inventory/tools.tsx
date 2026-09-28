// Inventory > Tools. Individually tracked assets with a custody model:
// who has it, which crew, which job, since when, due back when.
//
// Search-first and scan-second (see EquipmentSearchBar) — scanning a tag
// while standing next to a tool jumps straight to its check-in/out sheet.
import { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, SectionLabel, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { StatusBadge, type StatusTone } from "@/src/components/data/StatusBadge";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { EmptyState } from "@/src/components/feedback/EmptyState";
import { EquipmentSearchBar, findByScan, matchesEquipmentQuery } from "@/src/components/equipment/EquipmentSearch";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { usePermissions } from "@/src/hooks/use-permissions";
import { useEquipmentLedger, type LedgerEquipment } from "@/src/hooks/use-equipment-ledger";
import { RequiresOnline } from "@/src/components/RequiresOnline";
import { api } from "@/src/api/client";
import { toolType as classifyToolType, TOOL_TYPE_LABELS } from "@/src/utils/equipment-taxonomy";
import { rollupEquipment } from "@/src/utils/inventory-rollup";
import { StatusBoard } from "@/src/components/inventory/StatusCounts";
import { colors, fonts, radii, spacing, type as typo } from "@/src/theme";

type ToolStatus = "available" | "checked_out" | "assigned" | "repair" | "missing";

const STATUS_LABELS: Record<ToolStatus, string> = {
  available: "Available",
  checked_out: "Checked Out",
  assigned: "Assigned",
  repair: "Repair",
  missing: "Missing",
};
const STATUS_TONES: Record<ToolStatus, StatusTone> = {
  available: "success",
  checked_out: "warning",
  assigned: "info",
  repair: "error",
  missing: "error",
};

// Derived from the ledger buckets, never stored separately. "Assigned" means
// the tool is spoken for (reserved/staged for a job) but hasn't left the yard;
// "Checked Out" means it physically has.
export function toolStatus(item: LedgerEquipment): ToolStatus {
  const r = rollupEquipment(item);
  if (r.missing > 0) return "missing";
  if (r.repair > 0) return "repair";
  if ((item.checked_out ?? 0) > 0) return "checked_out";
  if (r.reserved > 0) return "assigned";
  if (r.available > 0) return "available";
  return "checked_out";
}

const STATUS_CHIPS = [
  { key: "all", label: "All" },
  { key: "available", label: "Available" },
  { key: "checked_out", label: "Checked Out" },
  { key: "assigned", label: "Assigned" },
  { key: "repair", label: "Repair" },
  { key: "missing", label: "Missing" },
  { key: "overdue", label: "Overdue" },
];

const TOOL_TYPE_OPTIONS = [
  { key: "all", label: "All tool types" },
  ...Object.entries(TOOL_TYPE_LABELS).map(([key, label]) => ({ key, label })),
];

const shortDate = (v?: string | null) => v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
const isOverdue = (item: LedgerEquipment & { expected_return_at?: string | null }) =>
  !!item.expected_return_at && new Date(item.expected_return_at).getTime() < Date.now() && (item.checked_out ?? 0) > 0;
const toolTypeOf = (tool: LedgerEquipment) => classifyToolType({
  category: tool.category,
  name: tool.name,
  model: tool.model || "",
  notes: tool.notes || "",
});

type Tool = LedgerEquipment & {
  checked_out_crew?: string;
  checked_out_job?: string;
  checked_out_at?: string | null;
  expected_return_at?: string | null;
};
type LedgerRow = { id: string; qty: number; from_bucket: string; to_bucket: string; reason: string; note: string; created_by: string; created_at: string };

export default function ToolInventoryScreen() {
  const router = useRouter();
  const { isShellWide, width } = useBreakpoint();
  const { canEdit } = usePermissions();
  const ledger = useEquipmentLedger();

  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("all");
  const [toolType, setToolType] = useState("all");
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [custody, setCustody] = useState<LedgerRow[]>([]);
  const [busy, setBusy] = useState(false);

  const tools = useMemo<Tool[]>(() => ledger.equipment.filter((item) => item.category === "tool"), [ledger.equipment]);
  const rollup = useMemo(() => ledger.forPredicate((item) => item.category === "tool"), [ledger]);
  const selected = tools.find((t) => t.id === selectedId) || null;

  const openTool = useCallback(async (tool: Tool) => {
    setSelectedId(tool.id);
    setCustody([]);
    try {
      setCustody(await api<LedgerRow[]>(`/equipment/${tool.id}/ledger`));
    } catch {
      // custody log is supplementary — the sheet still works without it
    }
  }, []);

  const filtered = useMemo(() => tools.filter((tool) => {
    if (chip === "overdue") { if (!isOverdue(tool)) return false; }
    else if (chip !== "all" && toolStatus(tool) !== chip) return false;
    if (toolType !== "all" && toolTypeOf(tool) !== toolType) return false;
    if (!matchesEquipmentQuery(tool, query)) return false;
    return true;
  }).sort((a, b) => {
    const byBrand = manufacturerOf(a).localeCompare(manufacturerOf(b), undefined, { sensitivity: "base" });
    return byBrand || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  }), [tools, chip, query, toolType]);

  const toolsByBrand = useMemo(() => filtered.reduce<Record<string, Tool[]>>((groups, tool) => {
    const brand = manufacturerOf(tool);
    (groups[brand] ||= []).push(tool);
    return groups;
  }, {}), [filtered]);
  const brandGroups = useMemo(() => Object.entries(toolsByBrand), [toolsByBrand]);

  const overdueCount = useMemo(() => tools.filter(isOverdue).length, [tools]);

  const onScan = (code: string) => {
    const hit = findByScan(tools, code);
    if (hit) openTool(hit);
    else setQuery(code);
  };

  const act = async (path: string, body: unknown) => {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/equipment/${selected.id}${path}`, { method: "POST", body: JSON.stringify(body) });
      ledger.onRefresh();
      const tool = selected;
      setCustody(await api<LedgerRow[]>(`/equipment/${tool.id}/ledger`).catch(() => []));
    } catch (e: any) {
      Alert.alert("Action failed", e.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ColumnDef<Tool>[]>(() => {
    const identity: ColumnDef<Tool>[] = [
      { key: "tool", label: "Tool", flex: 1.6, render: (tool) => (
        <View style={{ minWidth: 0 }}>
          <Text style={styles.rowName} numberOfLines={1}>{tool.name}{tool.model ? ` ${tool.model}` : ""}</Text>
          <Text style={styles.rowIds} numberOfLines={1}>
            {tool.qr_code ? `QR ${tool.qr_code}` : "QR not assigned"}{tool.serial_number ? ` | Serial ${tool.serial_number}` : ""}
          </Text>
        </View>
      ) },
      { key: "status", label: "Status", width: 124, render: (tool) => {
        const s = toolStatus(tool);
        return <StatusBadge label={STATUS_LABELS[s]} tone={STATUS_TONES[s]} />;
      } },
    ];
    if (width < 1180) return identity;
    return [
      ...identity,
      { key: "type", label: "Type", width: 140, render: (tool) => <Text style={typo.bodySmall} numberOfLines={1}>{TOOL_TYPE_LABELS[toolTypeOf(tool)] || "Tool"}</Text> },
      { key: "assignee", label: "Assigned To", width: 140, render: (tool) => <Text style={typo.bodySmall} numberOfLines={1}>{tool.checked_out_to || "—"}</Text> },
      { key: "crew", label: "Crew / Job", width: 160, render: (tool) => <Text style={typo.bodySmall} numberOfLines={1}>{[tool.checked_out_crew, tool.checked_out_job].filter(Boolean).join(" · ") || "—"}</Text> },
      { key: "since", label: "Out Since", width: 100, render: (tool) => <Text style={typo.bodySmall}>{shortDate(tool.checked_out_at)}</Text> },
      { key: "due", label: "Due Back", width: 104, render: (tool) => (
        <Text style={[typo.bodySmall, isOverdue(tool) && styles.overdue]}>{shortDate(tool.expected_return_at)}</Text>
      ) },
      { key: "location", label: "Location", width: 110, render: (tool) => <Text style={typo.bodySmall} numberOfLines={1}>{tool.location || (tool.checked_out ? "In field" : "—")}</Text> },
    ];
  }, [width]);

  return (
    <Screen
      title="Tools"
      subtitle={`${tools.length} tracked · ${rollup.available} available${overdueCount ? ` · ${overdueCount} overdue` : ""}`}
      onRefresh={ledger.onRefresh}
      refreshing={ledger.refreshing}
      testID="tools-index-screen"
      scroll={!isShellWide}
    >
      <View style={isShellWide ? styles.desktopWorkspace : undefined}>
        <View style={isShellWide ? styles.gutter : undefined}>
          <StatusBoard rollup={rollup} testID="tools-status" />
          <View style={{ height: spacing.md }} />
          <EquipmentSearchBar
            query={query}
            onQueryChange={setQuery}
            category={chip}
            onCategoryChange={setChip}
            categories={STATUS_CHIPS}
            onScan={onScan}
            placeholder="Search tool, QR, serial, model, manufacturer…"
            testIDPrefix="tools"
          />
          <ToolTypeSelect
            value={toolType}
            open={typeMenuOpen}
            onToggle={() => setTypeMenuOpen((open) => !open)}
            onChange={(nextType) => { setToolType(nextType); setTypeMenuOpen(false); }}
          />
        </View>

        {isShellWide ? (
          <View style={styles.tableWrap}>
            <DataTable columns={columns} rows={filtered} keyExtractor={(t) => t.id}
              rowTestID={(t) => `tool-${t.id}`} onRowPress={openTool} selectedId={selectedId}
              emptyLabel="No tools match this search." />
          </View>
        ) : filtered.length === 0 ? (
          <EmptyState icon="search-outline" title="No tools match" subtitle="Try a name, model or serial — or scan the tag." testID="tools-empty" />
        ) : brandGroups.map(([brand, brandTools]) => (
          <View key={brand} style={styles.brandGroup}>
            <Text style={styles.brandHeading}>{brand}</Text>
            {brandTools.map((tool) => <ToolCard key={tool.id} tool={tool} onPress={() => openTool(tool)} />)}
          </View>
        ))}
      </View>

      <DetailDrawer
        visible={!!selected}
        title={selected ? `${selected.name}${selected.model ? ` ${selected.model}` : ""}` : "Tool"}
        subtitle={selected ? STATUS_LABELS[toolStatus(selected)] : undefined}
        onClose={() => setSelectedId(null)}
        testID="tool-detail-drawer"
      >
        {selected ? (
          <ToolDetail tool={selected} custody={custody} canEdit={canEdit} busy={busy} onAct={act}
            onOpenRepairs={() => { setSelectedId(null); router.push("/(app)/shop/maintenance" as any); }} />
        ) : null}
      </DetailDrawer>
    </Screen>
  );
}

const ToolTypeSelect: React.FC<{
  value: string;
  open: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}> = ({ value, open, onToggle, onChange }) => {
  const selected = TOOL_TYPE_OPTIONS.find((option) => option.key === value) || TOOL_TYPE_OPTIONS[0];
  return (
    <View style={styles.typeSelect}>
      <TouchableOpacity
        onPress={onToggle}
        style={styles.typeSelectButton}
        testID="tools-type-select"
        accessibilityRole="button"
        accessibilityLabel={`Tool type: ${selected.label}`}
        accessibilityState={{ expanded: open }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.typeSelectLabel}>TOOL TYPE</Text>
          <Text style={styles.typeSelectValue} numberOfLines={1}>{selected.label}</Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.inkSecondary} />
      </TouchableOpacity>
      {open ? (
        <View style={styles.typeMenu}>
          {TOOL_TYPE_OPTIONS.map((option) => {
            const active = option.key === value;
            return (
              <TouchableOpacity key={option.key} onPress={() => onChange(option.key)} style={[styles.typeMenuOption, active && styles.typeMenuOptionActive]} testID={`tools-type-${option.key}`} accessibilityRole="button" accessibilityState={{ selected: active }}>
                <Text style={[styles.typeMenuText, active && styles.typeMenuTextActive]}>{option.label}</Text>
                {active ? <Ionicons name="checkmark" size={16} color={colors.primary} /> : null}
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
    </View>
  );
};

const ToolCard: React.FC<{ tool: Tool; onPress: () => void }> = ({ tool, onPress }) => {
  const status = toolStatus(tool);
  return (
    <TouchableOpacity onPress={onPress} testID={`tool-${tool.id}`}>
      <Card style={{ marginBottom: spacing.sm }}>
        <Row style={{ justifyContent: "space-between", alignItems: "flex-start", gap: spacing.sm }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <H3>{tool.name}{tool.model ? ` ${tool.model}` : ""}</H3>
            <Text style={styles.rowIds} numberOfLines={1}>
              {tool.qr_code ? `QR ${tool.qr_code}` : "QR not assigned"}{tool.serial_number ? ` | Serial ${tool.serial_number}` : ""}
            </Text>
          </View>
          <StatusBadge label={STATUS_LABELS[status]} tone={STATUS_TONES[status]} />
        </Row>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {tool.checked_out_to ? `${tool.checked_out_to}${tool.checked_out_crew ? ` · ${tool.checked_out_crew}` : ""}${tool.checked_out_job ? ` · ${tool.checked_out_job}` : ""}` : tool.location || "Yard"}
        </Text>
        {tool.checked_out ? <Text style={[styles.rowMeta, isOverdue(tool) && styles.overdue]}>Out since {shortDate(tool.checked_out_at)} · due {shortDate(tool.expected_return_at)}</Text> : null}
      </Card>
    </TouchableOpacity>
  );
};

const ToolDetail: React.FC<{
  tool: Tool;
  custody: LedgerRow[];
  canEdit: boolean;
  busy: boolean;
  onAct: (path: string, body: unknown) => void;
  onOpenRepairs: () => void;
}> = ({ tool, custody, canEdit, busy, onAct, onOpenRepairs }) => {
  const [assignee, setAssignee] = useState(tool.checked_out_to || "");
  const [crew, setCrew] = useState(tool.checked_out_crew || "");
  const [job, setJob] = useState(tool.checked_out_job || "");
  const [due, setDue] = useState((tool.expected_return_at || "").slice(0, 10));
  const [note, setNote] = useState("");
  const out = (tool.checked_out ?? 0) > 0;

  return (
    <View>
      <SectionLabel>Identity</SectionLabel>
      <View style={styles.factGrid}>
        <Fact label="Tool name" value={tool.name} />
        <Fact label="Manufacturer" value={manufacturerOf(tool)} />
        <Fact label="Model" value={tool.model || "—"} />
        <Fact label="Serial number" value={tool.serial_number || "—"} />
        <Fact label="QR / Asset ID" value={tool.qr_code || "Not assigned"} />
        <Fact label="Condition" value={tool.condition || "unknown"} />
      </View>

      <SectionLabel style={{ marginTop: spacing.md }}>Current custody</SectionLabel>
      <View style={styles.factGrid}>
        <Fact label="Status" value={STATUS_LABELS[toolStatus(tool)]} />
        <Fact label="Location" value={tool.location || (out ? "In field" : "Yard")} />
        <Fact label="Assigned person" value={tool.checked_out_to || "—"} />
        <Fact label="Assigned crew" value={tool.checked_out_crew || "—"} />
        <Fact label="Assigned job" value={tool.checked_out_job || "—"} />
        <Fact label="Checked out" value={shortDate(tool.checked_out_at)} />
        <Fact label="Expected return" value={shortDate(tool.expected_return_at)} />
      </View>
      {tool.notes ? <Text style={[typo.bodySmall, { marginTop: spacing.sm }]}>{tool.notes}</Text> : null}

      {canEdit ? (
        <>
          <SectionLabel style={{ marginTop: spacing.lg }}>{out ? "Check in" : "Check out"}</SectionLabel>
          {out ? (
            <>
              <Input value={note} onChangeText={setNote} placeholder="Condition notes on return (optional)" testID="tool-checkin-note" />
              <RequiresOnline>
                <Button title="Check In to Yard" onPress={() => onAct("/checkin", { qty: 1, note })} loading={busy} testID="tool-checkin-btn" />
              </RequiresOnline>
              <Button title="Report a Problem" onPress={onOpenRepairs} variant="outline" style={{ marginTop: spacing.sm }} testID="tool-report-repair" />
            </>
          ) : (
            <>
              <Input label="Assigned person" value={assignee} onChangeText={setAssignee} placeholder="Who is taking it?" testID="tool-assignee" />
              <Input label="Crew" value={crew} onChangeText={setCrew} placeholder="Crew" testID="tool-crew" />
              <Input label="Job" value={job} onChangeText={setJob} placeholder="Job site / project" testID="tool-job" />
              <Input label="Expected return (YYYY-MM-DD)" value={due} onChangeText={setDue} placeholder="2026-09-30" mono testID="tool-expected-return" />
              <RequiresOnline>
                <Button
                  title="Check Out"
                  loading={busy}
                  onPress={() => {
                    if (!assignee.trim()) { Alert.alert("Who has it?", "An assigned person is required."); return; }
                    onAct("/checkout", {
                      checked_out_to: assignee.trim(), qty: 1, crew: crew.trim(), job: job.trim(),
                      expected_return_at: due.trim() ? `${due.trim()}T12:00:00Z` : null,
                    });
                  }}
                  testID="tool-checkout-btn"
                />
              </RequiresOnline>
            </>
          )}
        </>
      ) : null}

      <SectionLabel style={{ marginTop: spacing.lg }}>Custody history</SectionLabel>
      {custody.length === 0 ? (
        <Text style={typo.bodySmall}>No movements recorded yet.</Text>
      ) : custody.map((entry) => (
        <View key={entry.id} style={styles.historyRow}>
          <Text style={styles.historyDetail}>
            {entry.reason.replace(/_/g, " ")} · {entry.from_bucket.replace(/_/g, " ")} → {entry.to_bucket.replace(/_/g, " ")}
          </Text>
          {entry.note ? <Text style={styles.historyNote}>{entry.note}</Text> : null}
          <Text style={styles.historyMeta}>{entry.created_by || "system"} · {new Date(entry.created_at).toLocaleString()}</Text>
        </View>
      ))}
    </View>
  );
};

// Manufacturer isn't its own column on Equipment — it is inferred from the
// leading words in this shop's tool names. Keep known two-word brands together
// so the default grouping matches how the shelves are labelled.
const manufacturerOf = (tool: Tool) => {
  const name = tool.name.trim();
  if (/^metabo\s+hpt\b/i.test(name)) return "Metabo HPT";
  if (/^dewalt\b/i.test(name)) return "DeWalt";
  if (/^milwaukee\b/i.test(name)) return "Milwaukee";
  return name.split(/\s+/)[0] || "Other";
};

const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.fact}>
    <Text style={styles.factLabel}>{label}</Text>
    <Text style={styles.factValue}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg },
  gutter: { paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, marginBottom: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", backgroundColor: colors.bg },
  typeSelect: { marginTop: spacing.sm, position: "relative", zIndex: 5 },
  typeSelectButton: { minHeight: 52, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radii.md, backgroundColor: colors.bg },
  typeSelectLabel: { ...typo.caption, fontSize: 9.5, letterSpacing: 0.65 },
  typeSelectValue: { ...typo.body, fontSize: 14, fontWeight: "700", marginTop: 1 },
  typeMenu: { marginTop: 4, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", backgroundColor: colors.bg, elevation: 4, shadowColor: "#0F172A", shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
  typeMenuOption: { minHeight: 42, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: colors.border },
  typeMenuOptionActive: { backgroundColor: colors.bgMuted },
  typeMenuText: { ...typo.bodySmall, fontSize: 13, fontWeight: "600" },
  typeMenuTextActive: { color: colors.primary, fontWeight: "700" },
  brandGroup: { marginTop: spacing.lg },
  brandHeading: { ...typo.caption, fontSize: 10.5, letterSpacing: 0.75, color: colors.inkSecondary, fontWeight: "800", marginBottom: spacing.xs },
  rowName: { ...typo.body, fontSize: 14, fontWeight: "700" },
  rowIds: { fontFamily: fonts.mono, fontSize: 11.5, color: colors.inkMuted, marginTop: 2 },
  rowMeta: { ...typo.bodySmall, fontSize: 11.5, marginTop: 3 },
  overdue: { color: colors.error, fontWeight: "700" },
  factGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  fact: { minWidth: 130, flexGrow: 1, flexBasis: 130 },
  factLabel: { ...typo.caption, fontSize: 9.5 },
  factValue: { ...typo.body, fontSize: 13.5, fontWeight: "600", marginTop: 1, textTransform: "capitalize" },
  historyRow: { paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.border },
  historyDetail: { ...typo.body, fontSize: 13.5, textTransform: "capitalize" },
  historyNote: { ...typo.bodySmall, fontSize: 12, marginTop: 1 },
  historyMeta: { ...typo.bodySmall, fontSize: 11, marginTop: 1 },
});

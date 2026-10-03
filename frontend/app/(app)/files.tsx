// Admin > Files & Imports. Generate Excel / PDF / CSV reports, re-download recent files, and (admins only)
// import inventory from an Excel or table-based PDF file. Imports are always a two-step: preview first
// (nothing is written), then an explicit, hash-bound confirmation.
import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { AdminTabs } from "@/src/components/shell/AdminTabs";
import { Card, Button, Input, SectionLabel, Row, Pill } from "@/src/components/ui";
import { ConfirmDialog } from "@/src/components/feedback/ConfirmDialog";
import { EmptyState } from "@/src/components/feedback/EmptyState";
import { usePermissions } from "@/src/hooks/use-permissions";
import { api, apiBlob, apiUpload } from "@/src/api/client";
import { saveBlob } from "@/src/utils/save-file";
import { colors, radii, spacing, type as typo } from "@/src/theme";

type StoredFile = {
  id: string; filename: string; format: string; dataset: string; record_count: number; size_bytes: number;
  created_at: string; created_by_name: string; expires_at: string;
};
type PlanRow = {
  row: number; action: string; key?: string; errors?: string[]; existing_name?: string;
  diff?: Record<string, [unknown, unknown]>; data?: Record<string, unknown>;
};
type ImportPreview = {
  import_id: string; status: string; filename: string; dataset: string; source: string; on_duplicate: string; plan_hash: string;
  summary: { total: number; create: number; update: number; unchanged: number; skip_duplicate: number; error: number };
  mapping: Record<string, string | null>; ignored_columns: string[]; warnings: string[]; blocking_errors: string[];
  errors: PlanRow[]; errors_truncated: number; rows: PlanRow[]; result?: { created: number; updated: number } | null;
};

const REPORTS: { key: string; label: string; filter?: { key: string; label: string } }[] = [
  { key: "equipment", label: "Inventory", filter: { key: "location", label: "Location" } },
  { key: "tools", label: "Tools", filter: { key: "checked_out_to", label: "Assigned to" } },
  { key: "assignments", label: "Assigned tools", filter: { key: "checked_out_to", label: "Assigned to" } },
  { key: "damaged", label: "Damaged" },
  { key: "rentals", label: "Rentals", filter: { key: "status", label: "Status" } },
  { key: "returns", label: "Returns (inbound)", filter: { key: "status", label: "Status" } },
  { key: "outbound", label: "Outbound", filter: { key: "status", label: "Status" } },
  { key: "shop_tasks", label: "Shop tasks", filter: { key: "assignee", label: "Assignee" } },
  { key: "consumables", label: "Consumables" },
  { key: "block", label: "Block" },
];
const FORMATS = [{ key: "xlsx", label: "Excel" }, { key: "pdf", label: "PDF" }, { key: "csv", label: "CSV" }];
const IMPORTS = [
  { key: "equipment", label: "Inventory" }, { key: "tools", label: "Tools" },
  { key: "consumables", label: "Consumables" }, { key: "block", label: "Block" },
];
const FORMAT_ICON: Record<string, any> = { xlsx: "grid-outline", pdf: "document-text-outline", csv: "list-outline" };

const sizeLabel = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const whenLabel = (iso: string) => new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`).toLocaleString();
const show = (v: unknown) => (v === "" || v === null || v === undefined ? "—" : String(v));

const Chip: React.FC<{ label: string; active: boolean; onPress: () => void; testID?: string }> = ({ label, active, onPress, testID }) => (
  <TouchableOpacity
    onPress={onPress} style={[styles.chip, active && styles.chipActive]} activeOpacity={0.7} testID={testID}
    accessibilityRole="radio" accessibilityState={{ selected: active }}
  >
    <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
  </TouchableOpacity>
);

export default function FilesScreen() {
  const { canAdmin } = usePermissions();
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [report, setReport] = useState(REPORTS[0]);
  const [format, setFormat] = useState("xlsx");
  const [filterValue, setFilterValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [importKind, setImportKind] = useState("equipment");
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "update">("skip");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ created: number; updated: number } | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      setFiles(await api<StoredFile[]>("/files"));
      setLoadError(null);
    } catch (e: any) { setLoadError(e.message); }
  }, []);
  useEffect(() => { loadFiles(); }, [loadFiles]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try { await work(); } catch (e: any) { setNotice({ tone: "error", text: e.message || "Something went wrong." }); } finally { setBusy(null); }
  };

  const generate = () => run("generate", async () => {
    const qs = report.filter && filterValue.trim() ? `?${report.filter.key}=${encodeURIComponent(filterValue.trim())}` : "";
    const { blob, filename } = await apiBlob(`/exports/${report.key}/${format}${qs}`);
    await saveBlob(blob, filename);
    setNotice({ tone: "ok", text: `${filename} is ready.` });
    loadFiles();
  });

  const download = (file: StoredFile) => run(file.id, async () => {
    const { blob, filename } = await apiBlob(`/files/${file.id}/download`);
    await saveBlob(blob, filename);
  });

  const pickAndStage = () => run("stage", async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/pdf"], copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const file = res.assets[0];
    const form = new FormData();
    if (Platform.OS === "web") {
      const webFile: Blob | undefined = file.file ?? (await fetch(file.uri).then((r) => r.blob()));
      if (!webFile) throw new Error("The selected file could not be read.");
      form.append("file", webFile, file.name);
    } else {
      form.append("file", { uri: file.uri, name: file.name, type: file.mimeType || "application/octet-stream" } as any);
    }
    form.append("dataset", importKind);
    form.append("on_duplicate", onDuplicate);
    setDone(null);
    setSkipInvalid(false);
    setPreview(await apiUpload<ImportPreview>("/imports", form));
  });

  const reviewSheet = () => preview && run("report", async () => {
    const { blob, filename } = await apiBlob(`/imports/${preview.import_id}/report.xlsx`);
    await saveBlob(blob, filename);
  });

  const discard = () => preview && run("discard", async () => {
    await api(`/imports/${preview.import_id}/cancel`, { method: "POST" });
    setPreview(null);
  });

  const apply = () => preview && run("commit", async () => {
    setConfirming(false);
    try {
      const out = await api<{ result: { created: number; updated: number } }>(`/imports/${preview.import_id}/commit`, {
        method: "POST", body: JSON.stringify({ plan_hash: preview.plan_hash, skip_invalid_rows: skipInvalid }),
      });
      setDone(out.result);
      setPreview(null);
    } catch (e: any) {
      // A refused or rolled-back commit leaves the preview unusable; make that explicit instead of leaving a dead button.
      setPreview(null);
      throw e;
    }
  });

  const s = preview?.summary;
  const writable = s ? s.create + s.update : 0;
  const blocked = !!preview && (preview.blocking_errors.length > 0 || writable === 0 || (s!.error > 0 && !skipInvalid));
  const changes = (preview?.rows ?? []).filter((r) => r.action === "update" || (r.action === "skip_duplicate" && r.diff && Object.keys(r.diff).length)).slice(0, 5);

  return (
    <Screen title="Files & Imports" subtitle="Reports, downloads and spreadsheet imports" testID="files-screen" tabs={<AdminTabs active="files" />}>
      {notice ? (
        <View style={[styles.notice, notice.tone === "error" ? styles.noticeError : styles.noticeOk]} accessibilityRole="alert" testID="files-notice">
          <Ionicons name={notice.tone === "error" ? "alert-circle-outline" : "checkmark-circle-outline"} size={18} color={notice.tone === "error" ? colors.error : colors.success} />
          <Text style={[typo.bodySmall, { flex: 1, color: colors.ink }]}>{notice.text}</Text>
        </View>
      ) : null}

      <SectionLabel>Create a report</SectionLabel>
      <Card testID="report-card">
        <View style={styles.chips}>
          {REPORTS.map((r) => <Chip key={r.key} label={r.label} active={r.key === report.key} onPress={() => { setReport(r); setFilterValue(""); }} testID={`report-${r.key}`} />)}
        </View>
        <View style={[styles.chips, { marginTop: spacing.md }]}>
          {FORMATS.map((f) => <Chip key={f.key} label={f.label} active={f.key === format} onPress={() => setFormat(f.key)} testID={`format-${f.key}`} />)}
        </View>
        {report.filter ? (
          <View style={{ marginTop: spacing.md }}>
            <Input label={`Only ${report.filter.label.toLowerCase()} (optional)`} value={filterValue} onChangeText={setFilterValue} placeholder="e.g. Nick" autoCapitalize="none" testID="report-filter" />
          </View>
        ) : null}
        <View style={{ marginTop: spacing.md }}>
          <Button title={busy === "generate" ? "Preparing…" : `Download ${report.label} (${FORMATS.find((f) => f.key === format)!.label})`} onPress={generate} loading={busy === "generate"} testID="report-generate" />
        </View>
      </Card>

      <SectionLabel style={{ marginTop: spacing.lg }}>Recent files</SectionLabel>
      {loadError ? (
        <Card><Text style={[typo.bodySmall, { color: colors.error }]}>{loadError}</Text><View style={{ marginTop: spacing.sm }}><Button title="Retry" variant="outline" onPress={loadFiles} /></View></Card>
      ) : files === null ? (
        <Card><Text style={typo.bodySmall}>Loading…</Text></Card>
      ) : files.length === 0 ? (
        <Card><EmptyState icon="document-outline" title="No files yet" subtitle="Reports you create here, or that Nathan prepares for you, are kept for 14 days." testID="files-empty" /></Card>
      ) : (
        <Card testID="files-list">
          {files.map((f, i) => (
            <View key={f.id} style={[styles.fileRow, i > 0 && styles.fileRowBorder]}>
              <Ionicons name={FORMAT_ICON[f.format] || "document-outline"} size={22} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={typo.body} numberOfLines={1}>{f.filename}</Text>
                <Text style={typo.bodySmall} numberOfLines={1}>{f.record_count} record{f.record_count === 1 ? "" : "s"} · {sizeLabel(f.size_bytes)} · {whenLabel(f.created_at)}{canAdmin ? ` · ${f.created_by_name}` : ""}</Text>
              </View>
              <Button title="Download" variant="outline" fullWidth={false} onPress={() => download(f)} loading={busy === f.id} testID={`file-download-${f.id}`} />
            </View>
          ))}
        </Card>
      )}

      {canAdmin ? (
        <>
          <SectionLabel style={{ marginTop: spacing.lg }}>Import from Excel or PDF</SectionLabel>
          <Card testID="import-card">
            <Text style={typo.bodySmall}>
              Pick a file to preview it. Nothing in MobileOps changes until you review the preview and apply it. Existing records are skipped unless you choose to update them, and stock counts and locations are never changed by an import.
            </Text>
            <View style={[styles.chips, { marginTop: spacing.md }]}>
              {IMPORTS.map((i) => <Chip key={i.key} label={i.label} active={i.key === importKind} onPress={() => setImportKind(i.key)} testID={`import-${i.key}`} />)}
            </View>
            <View style={[styles.chips, { marginTop: spacing.md }]}>
              <Chip label="Skip records that already exist" active={onDuplicate === "skip"} onPress={() => setOnDuplicate("skip")} testID="dup-skip" />
              <Chip label="Update matching records" active={onDuplicate === "update"} onPress={() => setOnDuplicate("update")} testID="dup-update" />
            </View>
            <View style={{ marginTop: spacing.md }}>
              <Button title="Choose file to preview" onPress={pickAndStage} loading={busy === "stage"} testID="import-pick" />
            </View>
          </Card>

          {done ? (
            <Card testID="import-done">
              <Row style={{ gap: spacing.sm, alignItems: "center" }}>
                <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                <Text style={typo.body}>Import applied: {done.created} created, {done.updated} updated.</Text>
              </Row>
            </Card>
          ) : null}

          {preview ? (
            <Card testID="import-preview">
              <Text style={typo.h3} numberOfLines={1}>{preview.filename}</Text>
              <Text style={[typo.bodySmall, { marginTop: 2 }]}>Preview only — nothing has been changed.{preview.source === "pdf" ? " Values were extracted from the PDF; check them carefully." : ""}</Text>
              <View style={[styles.chips, { marginTop: spacing.md }]}>
                <Pill color={colors.success} bg={colors.successSoft}>{s!.create} new</Pill>
                <Pill color={colors.info} bg={colors.primarySoft}>{s!.update} to update</Pill>
                <Pill>{s!.skip_duplicate} existing skipped</Pill>
                {s!.unchanged ? <Pill>{s!.unchanged} unchanged</Pill> : null}
                {s!.error ? <Pill color={colors.error} bg={colors.errorSoft}>{s!.error} invalid</Pill> : null}
              </View>

              {preview.blocking_errors.map((m) => <Text key={m} style={[typo.bodySmall, styles.problem]}>{m}</Text>)}
              {preview.warnings.map((m) => <Text key={m} style={[typo.bodySmall, { marginTop: spacing.sm }]}>{m}</Text>)}
              {preview.ignored_columns.length ? <Text style={[typo.bodySmall, { marginTop: spacing.sm }]}>Ignored columns: {preview.ignored_columns.join(", ")}</Text> : null}

              {preview.errors.length ? (
                <View style={{ marginTop: spacing.md }}>
                  <SectionLabel>Rows that can&apos;t be imported</SectionLabel>
                  {preview.errors.slice(0, 8).map((r) => <Text key={r.row} style={[typo.bodySmall, styles.problem]}>Row {r.row}: {(r.errors || []).join("; ")}</Text>)}
                  {preview.errors.length > 8 || preview.errors_truncated ? <Text style={typo.bodySmall}>…and more. Download the full review for every row.</Text> : null}
                </View>
              ) : null}

              {changes.length ? (
                <View style={{ marginTop: spacing.md }}>
                  <SectionLabel>{onDuplicate === "update" ? "Changes to existing records" : "Differences found (not applied)"}</SectionLabel>
                  {changes.map((r) => (
                    <Text key={r.row} style={typo.bodySmall}>
                      Row {r.row} · {r.existing_name}: {Object.entries(r.diff || {}).map(([k, [a, b]]) => `${k} ${show(a)} → ${show(b)}`).join(", ")}
                    </Text>
                  ))}
                </View>
              ) : null}

              {s!.error > 0 && preview.blocking_errors.length === 0 ? (
                <View style={[styles.chips, { marginTop: spacing.md }]}>
                  <Chip label={`Skip the ${s!.error} invalid row${s!.error === 1 ? "" : "s"} and import the rest`} active={skipInvalid} onPress={() => setSkipInvalid((v) => !v)} testID="skip-invalid" />
                </View>
              ) : null}

              <View style={styles.actions}>
                <View style={{ flex: 1 }}><Button title="Review all rows (Excel)" variant="outline" onPress={reviewSheet} loading={busy === "report"} testID="import-review" /></View>
                <View style={{ flex: 1 }}><Button title="Discard" variant="outline" onPress={discard} loading={busy === "discard"} testID="import-discard" /></View>
                <View style={{ flex: 1 }}><Button title="Apply import" onPress={() => setConfirming(true)} disabled={blocked} loading={busy === "commit"} testID="import-apply" /></View>
              </View>
            </Card>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        visible={confirming} destructive={false} confirmLabel="Apply import" title="Apply this import?"
        message={s ? `This will create ${s.create} and update ${s.update} record${s.create + s.update === 1 ? "" : "s"}${skipInvalid && s.error ? `, skipping ${s.error} invalid row${s.error === 1 ? "" : "s"}` : ""}. Everything is applied together or not at all.` : ""}
        onConfirm={apply} onCancel={() => setConfirming(false)} testID="import-confirm"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, justifyContent: "center" },
  chipActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { ...typo.bodySmall, color: colors.ink },
  chipTextActive: { color: colors.primary, fontWeight: "700" },
  fileRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  fileRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  notice: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, borderRadius: radii.md, marginBottom: spacing.md },
  noticeOk: { backgroundColor: colors.successSoft },
  noticeError: { backgroundColor: colors.errorSoft },
  problem: { color: colors.error, marginTop: spacing.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.lg },
});

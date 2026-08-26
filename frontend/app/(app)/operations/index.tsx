// Jobs — the unified Booking + Rental + Dispatch lifecycle, composed
// read-only from GET /api/jobs (see backend/server.py's derive_job_status
// and frontend/src/domain/job.ts). This is now the primary Operations
// screen: Dispatch/Rentals/Bookings/Returns still exist as routes (deep
// links from here, and from the Dashboard, still work) but are no longer
// primary nav destinations — Jobs is where you triage what's happening
// across every job, then drill into the screen that actually handles the
// action you need (return, schedule pickup, edit, advance dispatch).
//
// Live-fetch only for now, not wired into the offline SQLite cache
// (useCachedResource) — that cache is a versioned, migration-backed
// subsystem (see src/db/sqlite.ts) and adding a resource to it deserves its
// own pass, not a side effect of this screen. Matches how operations/
// capacity.tsx already fetches live rather than through the cache.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card, Mono, Row, H3 } from "@/src/components/ui";
import { DataTable, ColumnDef } from "@/src/components/data/DataTable";
import { SearchInput } from "@/src/components/data/SearchInput";
import { StatusBadge, StatusTone } from "@/src/components/data/StatusBadge";
import { PageToolbar } from "@/src/components/layout/PageToolbar";
import { DetailDrawer } from "@/src/components/overlays/DetailDrawer";
import { ErrorState } from "@/src/components/feedback/ErrorState";
import { api } from "@/src/api/client";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { Job, JobLine, JOB_STATUS, JobStatus } from "@/src/domain/job";
import { colors, spacing, type as typo, radii } from "@/src/theme";

type JobTab = "pipeline" | "active" | "pickup" | "inbound" | "closed";

const TAB_STATUSES: Record<JobTab, JobStatus[]> = {
  pipeline: [JOB_STATUS.planned, JOB_STATUS.reserved, JOB_STATUS.staging, JOB_STATUS.outbound],
  active: [JOB_STATUS.onJob],
  pickup: [JOB_STATUS.pickupRequested],
  inbound: [JOB_STATUS.inbound, JOB_STATUS.inspection],
  closed: [JOB_STATUS.closed],
};
const TAB_ORDER: JobTab[] = ["pipeline", "active", "pickup", "inbound", "closed"];
const TAB_LABELS: Record<JobTab, string> = {
  pipeline: "Pipeline", active: "Active", pickup: "Pickup", inbound: "Inbound", closed: "Closed",
};

const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  [JOB_STATUS.planned]: "Planned",
  [JOB_STATUS.reserved]: "Reserved",
  [JOB_STATUS.staging]: "Staging",
  [JOB_STATUS.outbound]: "Outbound",
  [JOB_STATUS.onJob]: "On Job",
  [JOB_STATUS.pickupRequested]: "Pickup Requested",
  [JOB_STATUS.inbound]: "Inbound",
  [JOB_STATUS.inspection]: "Inspection",
  [JOB_STATUS.closed]: "Closed",
};
const JOB_STATUS_TONE: Record<JobStatus, StatusTone> = {
  [JOB_STATUS.planned]: "neutral",
  [JOB_STATUS.reserved]: "info",
  [JOB_STATUS.staging]: "warning",
  [JOB_STATUS.outbound]: "accent",
  [JOB_STATUS.onJob]: "info",
  [JOB_STATUS.pickupRequested]: "warning",
  [JOB_STATUS.inbound]: "accent",
  [JOB_STATUS.inspection]: "warning",
  [JOB_STATUS.closed]: "success",
};

const shortDate = (v?: string | null) => v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
const jobUnits = (job: Job) => job.rental_id ? job.qty_outstanding : job.lines.reduce((sum, l) => sum + l.qty_ordered, 0);
const qtyReturned = (job: Job) => job.lines.reduce((sum, l) => sum + l.qty_returned, 0);
// Partial return is a quantity condition, not a lifecycle stage: some of
// this job's units are back, some aren't — surfaced as a badge regardless
// of which tab (Active or Inbound) the job's derived status puts it in.
const isPartialReturn = (job: Job) => job.rental_id != null && qtyReturned(job) > 0 && job.qty_outstanding > 0;

export default function JobsScreen() {
  const router = useRouter();
  const { isShellWide, width } = useBreakpoint();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<JobTab>("pipeline");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Job | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Job[]>("/jobs");
      setJobs(data);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const counts = useMemo(() => {
    const out: Record<JobTab, number> = { pipeline: 0, active: 0, pickup: 0, inbound: 0, closed: 0 };
    for (const job of jobs) {
      const t = TAB_ORDER.find((candidate) => TAB_STATUSES[candidate].includes(job.status));
      if (t) out[t] += 1;
    }
    return out;
  }, [jobs]);

  const filtered = useMemo(() => {
    const statuses = TAB_STATUSES[tab];
    const query = search.trim().toLowerCase();
    return jobs
      .filter((job) => statuses.includes(job.status))
      .filter((job) => !query || [job.customer_name, job.job_site, ...job.lines.map((l) => l.name)].some((v) => v?.toLowerCase().includes(query)))
      .sort((a, b) => +new Date(b.start_date || 0) - +new Date(a.start_date || 0));
  }, [jobs, tab, search]);

  const selectTab = (next: JobTab) => { setTab(next); setSelected(null); };

  const columns = useMemo<ColumnDef<Job>[]>(() => {
    const identity: ColumnDef<Job>[] = [
      { key: "status", label: "Status", width: width < 1280 ? 110 : 130, render: (job) => <StatusBadge label={JOB_STATUS_LABEL[job.status]} tone={JOB_STATUS_TONE[job.status]} /> },
      { key: "customer_name", label: "Customer", flex: 1.1, render: (job) => job.customer_name },
      { key: "job_site", label: "Job Site", flex: 1.3, render: (job) => job.job_site || "—" },
    ];
    if (width < 1280) {
      return [...identity, { key: "units", label: "Units", width: 60, align: "right", render: (job) => <Mono style={styles.tableMono}>{jobUnits(job)}</Mono> }];
    }
    return [
      ...identity,
      { key: "start_date", label: "Start", width: 100, render: (job) => shortDate(job.start_date) },
      { key: "units", label: "Units", width: 70, align: "right", render: (job) => <Mono style={styles.tableMono}>{jobUnits(job)}</Mono> },
      { key: "partial", label: "Condition", width: 130, render: (job) => isPartialReturn(job) ? <StatusBadge label="Partial return" tone="warning" /> : <Text style={styles.tableMuted}>—</Text> },
    ];
  }, [width]);

  return (
    <Screen title="Jobs" subtitle={`${jobs.length} total`} onRefresh={onRefresh} refreshing={refreshing} testID="jobs-screen" scroll={!isShellWide}>
      {loadError ? <ErrorState message="Couldn't load jobs." onRetry={load} testID="jobs-load-error" /> : null}

      {isShellWide ? (
        <View style={styles.desktopWorkspace}>
          <JobTabs tab={tab} counts={counts} onChange={selectTab} desktop />
          <PageToolbar>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search customer, site, equipment…" testID="jobs-search" style={{ flex: 1, maxWidth: 420 }} />
          </PageToolbar>
          <View style={styles.tableWrap}>
            <DataTable
              columns={columns}
              rows={filtered}
              keyExtractor={(job) => job.id}
              rowTestID={(job) => `job-${job.id}`}
              onRowPress={setSelected}
              selectedId={selected?.id}
              emptyLabel={`No jobs in ${TAB_LABELS[tab]}.`}
            />
          </View>
        </View>
      ) : (
        <>
          <JobTabs tab={tab} counts={counts} onChange={selectTab} />
          {!loading && filtered.length === 0 ? (
            <Card><Text style={[typo.body, { color: colors.inkMuted }]}>No jobs in {TAB_LABELS[tab]}.</Text></Card>
          ) : filtered.map((job) => (
            <TouchableOpacity key={job.id} onPress={() => setSelected(job)} activeOpacity={0.7} testID={`job-${job.id}`}>
              <Card style={{ marginBottom: spacing.sm }}>
                <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <View style={{ flex: 1 }}>
                    <H3>{job.customer_name}</H3>
                    <Text style={[typo.bodySmall, { marginTop: 2 }]}>{job.job_site || "—"}</Text>
                  </View>
                  <StatusBadge label={JOB_STATUS_LABEL[job.status]} tone={JOB_STATUS_TONE[job.status]} />
                </Row>
                <Row style={{ marginTop: spacing.sm, gap: spacing.md, flexWrap: "wrap" }}>
                  <Text style={typo.label}>Start <Mono style={{ fontSize: 13 }}>{shortDate(job.start_date)}</Mono></Text>
                  <Text style={typo.label}>Units <Mono style={{ fontSize: 13 }}>{jobUnits(job)}</Mono></Text>
                  {isPartialReturn(job) ? <StatusBadge label="Partial return" tone="warning" /> : null}
                </Row>
              </Card>
            </TouchableOpacity>
          ))}
        </>
      )}

      <DetailDrawer
        visible={isShellWide && !!selected}
        title={selected?.customer_name || "Job detail"}
        subtitle={selected?.job_site || undefined}
        onClose={() => setSelected(null)}
        width={460}
        testID="job-detail-drawer"
      >
        {selected ? <JobDetail job={selected} router={router} /> : null}
      </DetailDrawer>
    </Screen>
  );
}

const JobTabs: React.FC<{
  tab: JobTab;
  counts: Record<JobTab, number>;
  onChange: (tab: JobTab) => void;
  desktop?: boolean;
}> = ({ tab, counts, onChange, desktop = false }) => (
  <View style={[styles.tabs, desktop && styles.tabsDesktop]} testID="jobs-tabs">
    {TAB_ORDER.map((value) => {
      const active = tab === value;
      return (
        <TouchableOpacity
          key={value}
          onPress={() => onChange(value)}
          style={[styles.tab, active && styles.tabActive]}
          activeOpacity={0.72}
          testID={`jobs-tab-${value}`}
        >
          <Text style={[styles.tabText, active && styles.tabTextActive]}>{TAB_LABELS[value]}</Text>
          <View style={[styles.tabCount, active && styles.tabCountActive]}><Text style={[styles.tabCountText, active && styles.tabCountTextActive]}>{counts[value]}</Text></View>
        </TouchableOpacity>
      );
    })}
  </View>
);

const JobDetail: React.FC<{ job: Job; router: ReturnType<typeof useRouter> }> = ({ job, router }) => (
  <View>
    <View style={styles.detailStatusRow}>
      <StatusBadge label={JOB_STATUS_LABEL[job.status]} tone={JOB_STATUS_TONE[job.status]} />
      <Text style={styles.detailMuted}>{jobUnits(job)} units</Text>
    </View>
    {isPartialReturn(job) ? (
      <View style={styles.partialBanner}>
        <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
        <Text style={styles.partialBannerText}>Partial return — {job.qty_outstanding} of {job.lines.reduce((s, l) => s + l.qty_delivered, 0)} units still on site</Text>
      </View>
    ) : null}
    <View style={styles.detailSection}>
      <Text style={styles.detailLabel}>Start</Text>
      <Text style={styles.detailTitle}>{shortDate(job.start_date)}</Text>
    </View>
    <View style={styles.detailSection}>
      <Text style={styles.detailLabel}>Equipment ({job.lines.length})</Text>
      {job.lines.map((line) => <JobLineRow key={line.equipment_id} line={line} />)}
    </View>
    <View style={styles.drawerActions}>
      {job.booking_id ? <ActionLink label="Open Booking" onPress={() => router.push(`/(app)/operations/bookings?open=${job.booking_id}` as any)} /> : null}
      {job.active_outbound_dispatch_id ? <ActionLink label="Open Outbound Dispatch" onPress={() => router.push(`/(app)/operations/dispatch?open=${job.active_outbound_dispatch_id}` as any)} /> : null}
      {job.rental_id ? <ActionLink label="Open Rental" onPress={() => router.push(`/(app)/operations/rentals?open=${job.rental_id}` as any)} /> : null}
      {job.active_inbound_dispatch_id ? <ActionLink label="Open Pickup Dispatch" onPress={() => router.push(`/(app)/operations/dispatch?open=${job.active_inbound_dispatch_id}` as any)} /> : null}
    </View>
  </View>
);

const ActionLink: React.FC<{ label: string; onPress: () => void }> = ({ label, onPress }) => (
  <TouchableOpacity onPress={onPress} style={styles.actionLink} activeOpacity={0.7}>
    <Text style={styles.actionLinkText}>{label}</Text>
    <Ionicons name="chevron-forward" size={16} color={colors.primary} />
  </TouchableOpacity>
);

const JobLineRow: React.FC<{ line: JobLine }> = ({ line }) => (
  <View style={styles.detailLine}>
    <Text style={styles.detailTitle} numberOfLines={1}>{line.name}</Text>
    <Mono style={styles.detailSku}>{line.sku}</Mono>
    <View style={styles.lifecycleStrip} testID={`job-line-lifecycle-${line.equipment_id}`}>
      {([
        ["Ordered", line.qty_ordered],
        ["Delivered", line.qty_delivered],
        ["On Site", line.qty_on_site],
        ["Returned", line.qty_returned],
        ["Damaged", line.qty_damaged],
      ] as const).map(([label, value]) => (
        <View key={label} style={styles.lifecycleMetric}>
          <Text style={styles.lifecycleLabel}>{label}</Text>
          <Mono style={[styles.lifecycleValue, label === "Damaged" && value > 0 && styles.lifecycleDamaged]}>{value}</Mono>
        </View>
      ))}
    </View>
  </View>
);

const styles = StyleSheet.create({
  desktopWorkspace: { flex: 1, paddingTop: spacing.lg },
  tabs: { flexDirection: "row", gap: spacing.xs, marginBottom: spacing.md, flexWrap: "wrap" },
  tabsDesktop: { paddingHorizontal: spacing.xl },
  tab: { height: 38, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  tabActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  tabText: { fontSize: 13, fontWeight: "700", color: colors.inkSecondary },
  tabTextActive: { color: colors.primary },
  tabCount: { minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.bgTint },
  tabCountActive: { backgroundColor: colors.bg },
  tabCountText: { fontSize: 10.5, fontWeight: "800", color: colors.inkMuted },
  tabCountTextActive: { color: colors.primary },
  tableWrap: { flex: 1, marginHorizontal: spacing.xl, marginBottom: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", backgroundColor: colors.bg },
  tableMono: { fontSize: 12 },
  tableMuted: { fontSize: 12, color: colors.inkMuted },
  detailStatusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  detailMuted: { ...typo.bodySmall, fontSize: 12 },
  partialBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.warningSoft, borderRadius: radii.sm, padding: spacing.sm, marginTop: spacing.md },
  partialBannerText: { flex: 1, fontSize: 12, fontWeight: "600", color: colors.warning },
  detailSection: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  detailLabel: { ...typo.caption, color: colors.inkSecondary, marginBottom: 6 },
  detailTitle: { ...typo.body, fontWeight: "700" },
  detailSku: { fontSize: 10.5, color: colors.inkMuted },
  detailLine: { paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  lifecycleStrip: { width: "100%", flexDirection: "row", marginTop: 10, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, overflow: "hidden" },
  lifecycleMetric: { flex: 1, minWidth: 0, alignItems: "center", paddingVertical: 7, paddingHorizontal: 2, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
  lifecycleLabel: { fontSize: 8.5, fontWeight: "700", color: colors.inkMuted, textTransform: "uppercase", letterSpacing: 0.25 },
  lifecycleValue: { fontSize: 13, fontWeight: "700", marginTop: 2 },
  lifecycleDamaged: { color: colors.error },
  drawerActions: { paddingTop: spacing.lg, gap: spacing.xs },
  actionLink: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  actionLinkText: { fontSize: 13, fontWeight: "700", color: colors.primary },
});

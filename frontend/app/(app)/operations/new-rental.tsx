// Rentals > New Rental. The shorthand entry screen.
//
// One typed line is the interface: "9.18.26? / Carrollton / 84 - 16's / 84 Ext
// / 168 TB / Marco". The text is never rewritten — it is saved verbatim as the
// dispatch's raw_text — and everything structured underneath it is derived.
//
// Three layers, kept strictly apart:
//   ORDER   — the typed line. The only thing that becomes inventory demand.
//   NOTES   — context about the rental. Never read as requested stock.
//   REVIEW  — deterministic projection from the backend, then Nathan2's reading
//             of whether the numbers describe a real operational problem.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { Input, Button, Mono, SectionLabel } from "@/src/components/ui";
import { RentalTabs } from "@/src/components/rentals/RentalTabs";
import { RequiresOnline } from "@/src/components/RequiresOnline";
import { usePermissions } from "@/src/hooks/use-permissions";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo, radii, fonts } from "@/src/theme";
import {
  parseRentalOrder, resolveOrder, type CatalogItem, type ResolvedLine,
} from "@/src/utils/rental-shorthand";

type ForecastLine = {
  equipment_id: string; name: string; requested_qty: number;
  available_now: number; projected_available: number; projected_shortage: number;
  projected_available_excluding_tentative: number; tentative_demand_qty: number;
  returns_before_request: { qty: number; expected_date: string }[];
  warnings: string[];
};
type Review = { state: "green" | "amber" | "red"; reasoning: string; source: string; unavailable_reason?: string };
type ReviewResponse = { forecast: { lines: ForecastLine[] }; review: Review };

const REVIEW_COPY = {
  green: { label: "PROJECTED OK", tone: colors.success, soft: colors.successSoft },
  amber: { label: "AT RISK", tone: colors.warning, soft: colors.warningSoft },
  red: { label: "SHORTAGE", tone: colors.error, soft: colors.errorSoft },
};

export default function NewRentalScreen() {
  const router = useRouter();
  const { canEdit } = usePermissions();
  const [orderText, setOrderText] = useState("");
  const [notes, setNotes] = useState("");
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [dateOverride, setDateOverride] = useState<string | null>(null);
  const [locationOverride, setLocationOverride] = useState<string | null>(null);
  const [contactOverride, setContactOverride] = useState<string | null>(null);
  // equipment_id chosen by hand for a line the shorthand left ambiguous,
  // keyed by the line's position in the order text.
  const [variantChoice, setVariantChoice] = useState<Record<number, string>>({});
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<CatalogItem[]>("/equipment").then(setCatalog).catch(() => setCatalog([]));
  }, []);

  const order = useMemo(() => parseRentalOrder(orderText), [orderText]);
  const resolved = useMemo(() => resolveOrder(order, catalog), [order, catalog]);

  const dateText = dateOverride ?? order.date?.raw ?? "";
  const locationText = locationOverride ?? order.location?.raw ?? "";
  const contactText = contactOverride ?? order.contact?.raw ?? "";
  const dateConfirmed = dateOverride != null ? !dateOverride.trim().endsWith("?") : (order.date?.confirmed ?? true);
  // A hand-typed date field is re-parsed so "9.18.26?" works there too.
  const isoDate = dateOverride != null ? parseRentalOrder(dateOverride).date?.iso ?? null : order.date?.iso ?? null;

  /** The equipment id each line will reserve — resolved, or chosen by hand. */
  const lineEquipmentId = useCallback(
    (item: ResolvedLine, index: number) => variantChoice[index] ?? item.match?.id ?? null,
    [variantChoice],
  );

  const requestedLines = useMemo(() => resolved.flatMap((item, index) => {
    const equipmentId = lineEquipmentId(item, index);
    return equipmentId && item.line.qty ? [{ equipment_id: equipmentId, qty: item.line.qty }] : [];
  }), [resolved, lineEquipmentId]);

  // Debounced so a burst of typing produces one availability check, not one
  // per keystroke. A stale response never overwrites a newer one.
  const requestSeq = useRef(0);
  const requestKey = `${isoDate}|${JSON.stringify(requestedLines)}|${notes}`;
  useEffect(() => {
    if (!isoDate || requestedLines.length === 0) { setReview(null); setChecking(false); return; }
    const seq = ++requestSeq.current;
    setChecking(true);
    const timer = setTimeout(() => {
      api<ReviewResponse>("/rentals/shorthand/review", {
        method: "POST",
        body: JSON.stringify({
          order_text: orderText, notes, customer_name: locationText,
          requested_date: `${isoDate}T12:00:00Z`, date_confirmed: dateConfirmed,
          requested_lines: requestedLines,
        }),
      })
        .then((response) => { if (seq === requestSeq.current) setReview(response); })
        .catch(() => { if (seq === requestSeq.current) setReview(null); })
        .finally(() => { if (seq === requestSeq.current) setChecking(false); });
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const forecastByEquipment = useMemo(() => Object.fromEntries(
    (review?.forecast.lines || []).map((line) => [line.equipment_id, line]),
  ), [review]);

  const save = async () => {
    if (!isoDate) { Alert.alert("Date needed", "Add a date such as 9.18.26 — a '?' marks it unconfirmed."); return; }
    if (!locationText.trim()) { Alert.alert("Location needed", "Add the job location."); return; }
    if (requestedLines.length === 0) { Alert.alert("Order needed", "No equipment was recognized in the order line."); return; }

    const unresolved = resolved.filter((item, index) => item.line.qty && !lineEquipmentId(item, index));
    // An unconfirmed date or an unpicked variant is tentative demand: it lands
    // on the calendar and in the forecast, but reserves nothing.
    const planningOnly = !dateConfirmed || unresolved.length > 0;

    setSaving(true);
    try {
      await api("/dispatches", {
        method: "POST",
        body: JSON.stringify({
          direction: "outbound",
          scheduled_date: `${isoDate}T12:00:00Z`,
          customer_name: locationText.trim(),
          job_site: locationText.trim(),
          driver_name: contactText.trim(),
          lines: resolved.flatMap((item, index) => {
            const equipmentId = lineEquipmentId(item, index);
            const match = catalog.find((entry) => entry.id === equipmentId);
            return equipmentId && item.line.qty && match
              ? [{ equipment_id: equipmentId, sku: match.sku, name: match.name, qty: item.line.qty }]
              : [];
          }),
          // Verbatim typed text and the pieces read out of it.
          raw_text: orderText,
          source_date_text: dateText,
          date_confirmed: dateConfirmed,
          requirements: unresolved.map((item) => item.line.raw).concat(order.unrecognized.map((item) => item.raw)),
          planning_only: planningOnly,
          notes,
        }),
      });
      router.replace("/(app)/operations/outbound" as any);
    } catch (cause: any) {
      Alert.alert("Save failed", cause?.message || "The rental could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const state = review?.review.state;
  const verdict = state ? REVIEW_COPY[state] : null;

  return (
    <Screen title="New Rental" subtitle="Type the order the way you write it" back clampWidth
      tabs={<RentalTabs active="outbound" />} testID="new-rental-screen">

      <SectionLabel>Date</SectionLabel>
      <Input
        value={dateText}
        onChangeText={setDateOverride}
        placeholder="9.18.26?"
        mono autoCapitalize="none" testID="new-rental-date"
        style={!dateConfirmed ? styles.unconfirmedField : undefined}
      />
      {dateText && !isoDate ? <Text style={styles.fieldHint}>Not a readable date yet.</Text> : null}
      {!dateConfirmed && isoDate ? <Text style={[styles.fieldHint, styles.amberText]}>Unconfirmed — counted as tentative demand.</Text> : null}

      <SectionLabel>Location / Address</SectionLabel>
      <Input value={locationText} onChangeText={setLocationOverride} placeholder="Carrollton" testID="new-rental-location" />

      <SectionLabel>Order</SectionLabel>
      <Input
        value={orderText}
        onChangeText={setOrderText}
        placeholder="9.18.26? / Carrollton / 84 - 16's / 84 Ext / 168 TB / Marco"
        multiline numberOfLines={3} autoCapitalize="none" autoCorrect={false}
        style={styles.orderField} testID="new-rental-order"
      />

      {resolved.length || order.unrecognized.length ? (
        <View style={styles.parsed} testID="new-rental-parsed">
          {resolved.map((item, index) => (
            <ParsedRow
              key={`${item.line.span[0]}-${index}`}
              resolved={item}
              chosen={variantChoice[index]}
              onChoose={(equipmentId) => setVariantChoice((current) => ({ ...current, [index]: equipmentId }))}
            />
          ))}
          {order.unrecognized.map((segment) => (
            <Text key={segment.span[0]} style={styles.unparsedRow} testID="new-rental-unparsed">
              {segment.raw} — not read as equipment
            </Text>
          ))}
        </View>
      ) : null}

      <SectionLabel>Notes</SectionLabel>
      <Input
        value={notes}
        onChangeText={setNotes}
        placeholder="May substitute 12's for 16's if necessary…"
        multiline numberOfLines={3}
        style={styles.notesField} testID="new-rental-notes"
      />
      <Text style={styles.fieldHint}>Context about the rental. Never counted as requested inventory.</Text>

      <SectionLabel>Availability</SectionLabel>
      {checking ? (
        <View style={styles.checking}><ActivityIndicator size="small" color={colors.inkMuted} /><Text style={styles.fieldHint}>Checking inventory…</Text></View>
      ) : null}
      {!checking && !review ? (
        <Text style={styles.fieldHint}>Add a date and an order line to project availability.</Text>
      ) : null}
      {review ? (
        <View testID="new-rental-availability">
          {resolved.map((item, index) => {
            const line = forecastByEquipment[lineEquipmentId(item, index) || ""];
            if (!line) return null;
            return <AvailabilityBlock key={`${item.line.span[0]}-${index}`} line={line} />;
          })}
          {verdict ? (
            <View style={[styles.verdict, { backgroundColor: verdict.soft, borderColor: verdict.tone }]} testID={`new-rental-verdict-${state}`}>
              <Text style={[styles.verdictLabel, { color: verdict.tone }]}>{verdict.label}</Text>
              {review.review.reasoning ? <Text style={styles.verdictReason}>{review.review.reasoning}</Text> : null}
              <Text style={styles.verdictSource}>
                {review.review.unavailable_reason || `Nathan2 review · numbers from MobileOps inventory`}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <SectionLabel>Contact</SectionLabel>
      {contactText || contactOverride != null ? (
        <Input value={contactText} onChangeText={setContactOverride} placeholder="Marco" testID="new-rental-contact" />
      ) : (
        <TouchableOpacity onPress={() => setContactOverride("")} style={styles.addContact} testID="new-rental-add-contact">
          <Text style={styles.addContactText}>+ Add Contact</Text>
        </TouchableOpacity>
      )}

      {canEdit ? (
        <RequiresOnline>
          <Button title="Save Rental" onPress={save} loading={saving} testID="save-rental-btn" style={{ marginTop: spacing.md }} />
        </RequiresOnline>
      ) : null}
    </Screen>
  );
}

const ParsedRow: React.FC<{ resolved: ResolvedLine; chosen?: string; onChoose: (id: string) => void }> = ({ resolved, chosen, onChoose }) => {
  const { line, candidates, variantUnspecified } = resolved;
  const chosenItem = candidates.find((item) => item.id === chosen);
  return (
    <View style={styles.parsedRow}>
      <Text style={styles.parsedText}>
        <Mono>{line.qty ?? "?"}</Mono>
        {` × ${chosenItem?.name ?? line.equipment?.label ?? line.raw}`}
        {line.uncertain ? " — unsure" : ""}
        {variantUnspecified && !chosenItem ? " — Variant Unspecified" : ""}
      </Text>
      {variantUnspecified && !chosenItem ? (
        <View style={styles.variantRow}>
          {candidates.map((item) => (
            <TouchableOpacity key={item.id} onPress={() => onChoose(item.id)} style={styles.variantChip} testID={`variant-${item.sku}`}>
              <Text style={styles.variantChipText}>{item.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {!line.equipment || candidates.length === 0 ? (
        <Text style={styles.fieldHint}>No matching equipment in inventory.</Text>
      ) : null}
    </View>
  );
};

/**
 * The compact per-item projection:
 *   120 Gen 2 TB / 94 available now / +50 expected back / 144 projected
 * Shortages are always shown — never rolled up or hidden behind the verdict.
 */
const AvailabilityBlock: React.FC<{ line: ForecastLine }> = ({ line }) => {
  const expectedBack = line.returns_before_request.reduce((sum, item) => sum + item.qty, 0);
  const short = line.projected_shortage > 0;
  return (
    <View style={styles.availability} testID={`availability-${line.equipment_id}`}>
      <Text style={styles.availabilityTitle}><Mono>{line.requested_qty}</Mono> {line.name}</Text>
      <Text style={styles.availabilityRow}>{line.available_now} available now</Text>
      {expectedBack ? <Text style={styles.availabilityRow}>+{expectedBack} expected back</Text> : null}
      {line.tentative_demand_qty ? <Text style={[styles.availabilityRow, styles.amberText]}>−{line.tentative_demand_qty} held by tentative rentals</Text> : null}
      <Text style={styles.availabilityRow}>{line.projected_available} projected</Text>
      <Text style={[styles.availabilityVerdict, { color: short ? colors.error : colors.success }]}>
        {short ? `⚠ SHORT ${line.projected_shortage}` : "✓ PROJECTED OK"}
      </Text>
      {line.warnings.map((warning) => <Text key={warning} style={styles.fieldHint}>{warning}</Text>)}
    </View>
  );
};

const styles = StyleSheet.create({
  orderField: { minHeight: 76, textAlignVertical: "top", fontFamily: fonts.mono },
  notesField: { minHeight: 76, textAlignVertical: "top" },
  unconfirmedField: { borderColor: colors.warning, color: colors.warning },
  fieldHint: { ...typo.caption, color: colors.inkMuted, marginTop: spacing.xs },
  amberText: { color: colors.warning },
  parsed: { marginTop: spacing.sm, paddingLeft: spacing.sm, borderLeftWidth: 2, borderLeftColor: colors.border, gap: spacing.xs },
  parsedRow: { paddingVertical: 2 },
  parsedText: { ...typo.bodySmall, color: colors.inkSecondary },
  unparsedRow: { ...typo.bodySmall, color: colors.inkMuted, fontStyle: "italic", paddingVertical: 2 },
  variantRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  variantChip: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm },
  variantChipText: { ...typo.caption, color: colors.ink },
  checking: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  availability: { marginBottom: spacing.md },
  availabilityTitle: { ...typo.body, fontWeight: "600" },
  availabilityRow: { ...typo.bodySmall, color: colors.inkSecondary },
  availabilityVerdict: { ...typo.bodySmall, fontWeight: "700", marginTop: 2 },
  verdict: { borderWidth: 1, borderRadius: radii.md, padding: spacing.md, marginTop: spacing.sm },
  verdictLabel: { ...typo.body, fontWeight: "800", letterSpacing: 0.5 },
  verdictReason: { ...typo.bodySmall, color: colors.ink, marginTop: spacing.xs },
  verdictSource: { ...typo.caption, color: colors.inkMuted, marginTop: spacing.xs },
  addContact: { paddingVertical: spacing.sm },
  addContactText: { ...typo.body, color: colors.primary, fontWeight: "600" },
});

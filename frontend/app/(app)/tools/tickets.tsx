import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, StyleSheet, Text, View } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Screen } from "@/src/components/Screen";
import { Button, Card, Mono, Row, SectionLabel } from "@/src/components/ui";
import { SearchInput } from "@/src/components/data/SearchInput";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { api } from "@/src/api/client";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useCachedResource } from "@/src/hooks/use-cached-resource";
import { buildDeliveryTicketHtml, DeliveryTicketSite } from "@/src/utils/delivery-ticket";
import { colors, spacing, type as typo } from "@/src/theme";

type DispatchLine = { equipment_id: string; sku: string; name: string; qty: number };
type Dispatch = {
  id: string;
  direction: "outbound" | "inbound";
  status: string;
  scheduled_date?: string | null;
  customer_name: string;
  job_site: string;
  driver_name: string;
  truck: string;
  trailer: string;
  crew: string;
  lines: DispatchLine[];
  planning_only?: boolean;
  requirements?: string[];
  source_date_text?: string;
  notes: string;
};

const shortDate = (dispatch: Dispatch) => {
  if (dispatch.source_date_text) return dispatch.source_date_text;
  if (!dispatch.scheduled_date) return "Not scheduled";
  const date = new Date(dispatch.scheduled_date);
  return Number.isNaN(date.getTime())
    ? dispatch.scheduled_date
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

const unitCount = (dispatch: Dispatch) => dispatch.lines.reduce((total, line) => total + line.qty, 0);

export default function DeliveryTicketsScreen() {
  const { isPhone } = useBreakpoint();
  const fetchDispatches = useCallback(() => api<Dispatch[]>("/dispatches"), []);
  const dispatchesRes = useCachedResource<Dispatch>("dispatches", fetchDispatches);
  const [site, setSite] = useState<DeliveryTicketSite | null>(null);
  const [search, setSearch] = useState("");
  const [printingId, setPrintingId] = useState<string | null>(null);

  useEffect(() => {
    api<DeliveryTicketSite>("/site").then(setSite).catch(() => setSite(null));
  }, []);

  const deliveries = useMemo(() => {
    const query = search.trim().toLowerCase();
    return dispatchesRes.data
      .filter((dispatch) => dispatch.direction === "outbound" && dispatch.status !== "cancelled")
      .filter((dispatch) => {
        if (!query) return true;
        return [dispatch.customer_name, dispatch.job_site, dispatch.driver_name, dispatch.truck, dispatch.notes, ...dispatch.lines.map((line) => `${line.sku} ${line.name}`)]
          .some((value) => value?.toLowerCase().includes(query));
      })
      .sort((a, b) => String(b.scheduled_date || b.source_date_text || "").localeCompare(String(a.scheduled_date || a.source_date_text || "")));
  }, [dispatchesRes.data, search]);

  const createTicket = async (dispatch: Dispatch) => {
    if (dispatch.lines.length === 0 && !(dispatch.requirements || []).length) {
      Alert.alert("Nothing to put on the ticket", "Add equipment to this delivery before creating its ticket.");
      return;
    }
    setPrintingId(dispatch.id);
    const html = buildDeliveryTicketHtml({
      id: dispatch.id,
      customerName: dispatch.customer_name,
      jobSite: dispatch.job_site,
      scheduledDate: dispatch.scheduled_date,
      status: dispatch.status,
      driverName: dispatch.driver_name,
      truck: dispatch.truck,
      trailer: dispatch.trailer,
      crew: dispatch.crew,
      notes: dispatch.notes,
      lines: dispatch.lines,
      requirements: dispatch.requirements,
      planningOnly: dispatch.planning_only,
    }, site);
    try {
      if (Platform.OS === "web") {
        await Print.printAsync({ html });
      } else {
        const { uri } = await Print.printToFileAsync({ html });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: "Delivery Ticket" });
        } else {
          Alert.alert("Ticket created", `The PDF was saved to ${uri}`);
        }
      }
    } catch (error: any) {
      Alert.alert("Ticket failed", error?.message || "Unable to create the delivery ticket.");
    } finally {
      setPrintingId(null);
    }
  };

  return (
    <Screen
      title="Create Ticket"
      subtitle="Delivery tickets with every scheduled item"
      back
      refreshing={dispatchesRes.refreshing}
      onRefresh={dispatchesRes.onRefresh}
      testID="delivery-tickets-screen"
      clampWidth
    >
      <SearchInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search customer, job site, driver, or equipment…"
        testID="delivery-ticket-search"
        style={styles.search}
      />

      <SectionLabel>{deliveries.length} outbound {deliveries.length === 1 ? "delivery" : "deliveries"}</SectionLabel>
      {deliveries.length === 0 ? (
        <Card><Text style={typo.body}>No outbound deliveries match this search.</Text></Card>
      ) : deliveries.map((dispatch) => {
        const units = unitCount(dispatch);
        const details = dispatch.planning_only
          ? `${dispatch.requirements?.length || 0} planned requirements`
          : `${dispatch.lines.length} item types · ${units} total units`;
        return (
          <Card key={dispatch.id} style={[styles.deliveryCard, isPhone && styles.deliveryCardPhone]} testID={`delivery-ticket-${dispatch.id}`}>
            <View style={styles.deliveryMain}>
              <Row style={styles.headingRow}>
                <Text style={[typo.h3, styles.customerName]}>{dispatch.customer_name}</Text>
                <StatusBadge label={dispatch.planning_only ? "planning" : dispatch.status} />
              </Row>
              <Text style={[typo.bodySmall, styles.jobSite]}>{dispatch.job_site || "No job site entered"}</Text>
              <Row style={styles.metaRow}>
                <Mono style={styles.metaText}>{shortDate(dispatch)}</Mono>
                <Text style={styles.metaText}>{details}</Text>
              </Row>
              {dispatch.lines.length ? (
                <Text style={styles.items} numberOfLines={2}>
                  {dispatch.lines.map((line) => `${line.qty}× ${line.sku || line.name}`).join("  ·  ")}
                </Text>
              ) : dispatch.requirements?.length ? (
                <Text style={styles.items} numberOfLines={2}>{dispatch.requirements.join("  ·  ")}</Text>
              ) : null}
            </View>
            <Button
              title={printingId === dispatch.id ? "Creating…" : "Create Ticket"}
              onPress={() => createTicket(dispatch)}
              disabled={printingId !== null}
              fullWidth={isPhone}
              style={[styles.createButton, isPhone && styles.createButtonPhone]}
              testID={`create-delivery-ticket-${dispatch.id}`}
            />
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { marginBottom: spacing.lg, maxWidth: 520 },
  deliveryCard: { marginBottom: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.md },
  deliveryCardPhone: { flexDirection: "column", alignItems: "stretch" },
  deliveryMain: { flex: 1, minWidth: 0 },
  customerName: { flex: 1 },
  headingRow: { justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  jobSite: { color: colors.inkSecondary, marginTop: 3 },
  metaRow: { gap: spacing.md, marginTop: spacing.sm, flexWrap: "wrap" },
  metaText: { fontSize: 11, color: colors.inkMuted },
  items: { ...typo.bodySmall, color: colors.inkSecondary, marginTop: spacing.sm },
  createButton: { minWidth: 132 },
  createButtonPhone: { width: "100%" },
});

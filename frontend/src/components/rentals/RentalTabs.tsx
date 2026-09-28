// The Rentals section's only navigation: Inbound | Outbound | Active | History.
// Rendered at the top of each of the four Rentals routes. The sidebar carries
// a single "Rentals" row — these never appear there.
import React from "react";
import { SectionTabs } from "@/src/components/layout/SectionTabs";

export type RentalTabKey = "inbound" | "outbound" | "active" | "history";

export const RENTAL_TAB_ROUTES: Record<RentalTabKey, string> = {
  inbound: "/(app)/operations/inbound",
  outbound: "/(app)/operations/outbound",
  active: "/(app)/operations/rentals",
  history: "/(app)/operations/history",
};

export const RentalTabs: React.FC<{ active: RentalTabKey; counts?: Partial<Record<RentalTabKey, number>> }> = ({ active, counts }) => (
  <SectionTabs
    testID="rental-tabs"
    active={active}
    tabs={[
      { key: "inbound", label: "Inbound", route: RENTAL_TAB_ROUTES.inbound, count: counts?.inbound },
      { key: "outbound", label: "Outbound", route: RENTAL_TAB_ROUTES.outbound, count: counts?.outbound },
      { key: "active", label: "Active", route: RENTAL_TAB_ROUTES.active, count: counts?.active },
      { key: "history", label: "History", route: RENTAL_TAB_ROUTES.history, count: counts?.history },
    ]}
  />
);

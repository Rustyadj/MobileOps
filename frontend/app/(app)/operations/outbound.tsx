// Rentals > Outbound. Deliveries and pickups leaving the yard, plus planned
// rentals not yet delivered — with per-job unit totals and a readiness flag
// so shortages are obvious before the truck loads.
import { DispatchScreen } from "./dispatch";
import { RentalTabs } from "@/src/components/rentals/RentalTabs";

export default function OutboundScreen() {
  return (
    <DispatchScreen
      initialDirection="outbound"
      title="Rentals"
      tabs={<RentalTabs active="outbound" />}
    />
  );
}

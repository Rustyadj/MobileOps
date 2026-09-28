// Rentals > History. Completed/returned rentals with full return history,
// searchable by customer, job site, rental ID, date or equipment.
import { RentalsScreen } from "./rentals";

export default function RentalHistoryScreen() {
  return <RentalsScreen initialView="history" />;
}

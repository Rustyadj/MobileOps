// Rentals > Active lives at /operations/rentals (the section's default tab).
// Redirect kept so older deep links keep resolving.
import { Redirect } from "expo-router";

export default function ActiveRentalsRedirect() {
  return <Redirect href="/(app)/operations/rentals" />;
}

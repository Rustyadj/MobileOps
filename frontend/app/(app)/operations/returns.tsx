// Returns are part of Rentals > Inbound — there is no separate Returns
// destination. Kept as a redirect so existing deep links (dashboard
// "returning today" items, saved bookmarks) keep working.
import { Redirect } from "expo-router";

export default function ReturnsRedirect() {
  return <Redirect href="/(app)/operations/inbound" />;
}

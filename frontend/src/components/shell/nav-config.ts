// Single source of truth for the app's information architecture.
// Consumed by Sidebar (desktop), MobileBottomNav + Menu (phone), and the
// CommandMenu (global search / jump-to). Keep routes in sync with app/(app)/*.
//
// IA rule: the sidebar lists MAJOR SECTIONS ONLY. Detailed workflows
// (Inbound/Outbound/Active/History, Bracing, Tools, Yard Count, Repairs, …)
// live *inside* their parent section as in-page tabs or landing cards, and
// must never be duplicated as sidebar rows.
import type { Ionicons } from "@expo/vector-icons";

export type IconName = React.ComponentProps<typeof Ionicons>["name"];

export type NavItem = {
  key: string;
  label: string;
  route: string;
  icon: IconName;
  testID: string;
  /** Route prefixes that should light this section up as active. */
  match?: string[];
};

export const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "Dashboard", route: "/(app)", icon: "grid-outline", testID: "nav-dashboard", match: [] },
  { key: "whiteboard", label: "Live Feed", route: "/(app)/whiteboard", icon: "chatbubbles-outline", testID: "nav-whiteboard", match: ["/whiteboard"] },
  { key: "rentals", label: "Rentals", route: "/(app)/operations/rentals", icon: "swap-horizontal-outline", testID: "nav-rentals", match: ["/operations"] },
  { key: "inventory", label: "Inventory", route: "/(app)/inventory", icon: "cube-outline", testID: "nav-inventory", match: ["/inventory"] },
  { key: "shop", label: "Shop", route: "/(app)/shop", icon: "construct-outline", testID: "nav-shop", match: ["/shop"] },
  { key: "utilities", label: "Utilities", route: "/(app)/tools", icon: "calculator-outline", testID: "nav-utilities", match: ["/tools"] },
  { key: "admin", label: "Admin", route: "/(app)/site-admin", icon: "settings-outline", testID: "nav-admin", match: ["/site-admin", "/contacts", "/vendors", "/sync-issues"] },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_ITEMS;

// Secondary destinations reachable from inside a section (or the phone Menu).
// Kept out of the sidebar on purpose — listed here so the CommandMenu and the
// mobile Menu can still jump straight to them.
export type SubNavItem = { key: string; label: string; route: string; icon: IconName; section: string; testID: string };

export const SUB_NAV_ITEMS: SubNavItem[] = [
  { key: "rentals-inbound", label: "Rentals · Inbound", route: "/(app)/operations/inbound", icon: "arrow-down-outline", section: "rentals", testID: "sub-rentals-inbound" },
  { key: "rentals-outbound", label: "Rentals · Outbound", route: "/(app)/operations/outbound", icon: "arrow-up-outline", section: "rentals", testID: "sub-rentals-outbound" },
  { key: "rentals-active", label: "Rentals · Active", route: "/(app)/operations/rentals", icon: "location-outline", section: "rentals", testID: "sub-rentals-active" },
  { key: "rentals-history", label: "Rentals · History", route: "/(app)/operations/history", icon: "time-outline", section: "rentals", testID: "sub-rentals-history" },
  { key: "rentals-bookings", label: "Rentals · Bookings", route: "/(app)/operations/bookings", icon: "calendar-outline", section: "rentals", testID: "sub-rentals-bookings" },
  { key: "rentals-capacity", label: "Rentals · Capacity", route: "/(app)/operations/capacity", icon: "analytics-outline", section: "rentals", testID: "sub-rentals-capacity" },
  { key: "rentals-map", label: "Rentals · Map", route: "/(app)/operations/map", icon: "map-outline", section: "rentals", testID: "sub-rentals-map" },
  { key: "inventory-bracing", label: "Inventory · Bracing", route: "/(app)/inventory/bracing", icon: "construct-outline", section: "inventory", testID: "sub-inventory-bracing" },
  { key: "inventory-scaffolding", label: "Inventory · Crankups & Shoring", route: "/(app)/inventory/scaffolding", icon: "grid-outline", section: "inventory", testID: "sub-inventory-scaffolding" },
  { key: "inventory-tools", label: "Inventory · Tools", route: "/(app)/inventory/tools", icon: "hammer-outline", section: "inventory", testID: "sub-inventory-tools" },
  { key: "inventory-consumables", label: "Inventory · Consumables", route: "/(app)/inventory/consumables", icon: "flask-outline", section: "inventory", testID: "sub-inventory-consumables" },
  { key: "inventory-block", label: "Inventory · ICF Block", route: "/(app)/inventory/block", icon: "layers-outline", section: "inventory", testID: "sub-inventory-block" },
  { key: "inventory-counts", label: "Inventory · Yard Count", route: "/(app)/inventory/counts", icon: "clipboard-outline", section: "inventory", testID: "sub-inventory-counts" },
  { key: "inventory-transfers", label: "Inventory · Transfers", route: "/(app)/inventory/transfers", icon: "swap-horizontal-outline", section: "inventory", testID: "sub-inventory-transfers" },
  { key: "shop-tasks", label: "Shop · Tasks", route: "/(app)/shop/tasks", icon: "checkbox-outline", section: "shop", testID: "sub-shop-tasks" },
  { key: "shop-staging", label: "Shop · Prep / Staging", route: "/(app)/shop/staging", icon: "cube-outline", section: "shop", testID: "sub-shop-staging" },
  { key: "shop-repairs", label: "Shop · Repairs", route: "/(app)/shop/maintenance", icon: "build-outline", section: "shop", testID: "sub-shop-repairs" },
  { key: "shop-notes", label: "Shop · Notes", route: "/(app)/shop/notes", icon: "document-text-outline", section: "shop", testID: "sub-shop-notes" },
  { key: "utilities-calculator", label: "Utilities · Calculator", route: "/(app)/tools/calculator", icon: "calculator-outline", section: "utilities", testID: "sub-utilities-calculator" },
  { key: "utilities-tickets", label: "Utilities · Create Ticket", route: "/(app)/tools/tickets", icon: "receipt-outline", section: "utilities", testID: "sub-utilities-tickets" },
  { key: "admin-contacts", label: "Admin · Contacts", route: "/(app)/contacts", icon: "people-outline", section: "admin", testID: "sub-admin-contacts" },
  { key: "admin-sync", label: "Admin · Sync Issues", route: "/(app)/sync-issues", icon: "cloud-offline-outline", section: "admin", testID: "sub-admin-sync" },
  { key: "admin-site", label: "Admin · Site Settings", route: "/(app)/site-admin", icon: "settings-outline", section: "admin", testID: "sub-admin-site" },
];

// Mobile bottom nav: 5 destinations max, mirroring the sidebar's top of list.
// Utilities/Admin and every sub-workflow live behind Menu.
export const MOBILE_TABS: { key: string; label: string; route: string; icon: IconName; testID: string }[] = [
  { key: "dashboard", label: "Home", route: "/(app)", icon: "grid-outline", testID: "tab-home" },
  { key: "rentals", label: "Rentals", route: "/(app)/operations/rentals", icon: "swap-horizontal-outline", testID: "tab-rentals" },
  { key: "inventory", label: "Inventory", route: "/(app)/inventory", icon: "cube-outline", testID: "tab-inventory" },
  { key: "shop", label: "Shop", route: "/(app)/shop", icon: "construct-outline", testID: "tab-shop" },
  { key: "menu", label: "Menu", route: "/(app)/menu", icon: "menu-outline", testID: "tab-menu" },
];

// Route-prefix -> which sidebar section (and mobile tab) should read as active.
export function activeSectionForPath(pathname: string): string {
  if (pathname.startsWith("/menu")) return "menu";
  for (const item of NAV_ITEMS) {
    for (const prefix of item.match || []) {
      if (pathname.startsWith(prefix)) return item.key;
    }
  }
  return "dashboard";
}

const SECTION_LABEL: Record<string, string> = Object.fromEntries(NAV_ITEMS.map((i) => [i.key, i.label]));

// TopBar breadcrumb: section label + page label for the current path.
export function breadcrumbForPath(pathname: string): { section: string; page: string } {
  const sectionKey = activeSectionForPath(pathname);
  const section = SECTION_LABEL[sectionKey] || "Overview";

  const normalized = pathname === "/" ? "/(app)" : `/(app)${pathname}`;
  const sub = SUB_NAV_ITEMS.find((item) => item.route === normalized);
  if (sub) return { section, page: sub.label.split(" · ").pop() as string };
  const top = NAV_ITEMS.find((item) => item.route === normalized);
  if (top) return { section, page: top.label };

  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "Dashboard";
  const page = last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { section, page };
}

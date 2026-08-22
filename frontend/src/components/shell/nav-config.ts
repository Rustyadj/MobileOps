// Single source of truth for the app's information architecture.
// Consumed by Sidebar (desktop), MobileBottomNav + Menu (phone), and the
// CommandMenu (global search / jump-to). Keep routes in sync with app/(app)/*.
import type { Ionicons } from "@expo/vector-icons";

export type IconName = React.ComponentProps<typeof Ionicons>["name"];

export type NavItem = {
  key: string;
  label: string;
  route: string;
  icon: IconName;
  testID: string;
};

export type NavSection = {
  key: string;
  label: string;
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    key: "overview",
    label: "Overview",
    items: [
      { key: "dashboard", label: "Dashboard", route: "/(app)", icon: "grid-outline", testID: "nav-dashboard" },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    items: [
      { key: "map", label: "Map", route: "/(app)/operations/map", icon: "map-outline", testID: "nav-map" },
      { key: "rentals", label: "Rentals", route: "/(app)/operations/rentals", icon: "receipt-outline", testID: "nav-rentals" },
      { key: "bookings", label: "Bookings / Upcoming Jobs", route: "/(app)/operations/bookings", icon: "calendar-outline", testID: "nav-bookings" },
      { key: "returns", label: "Returns", route: "/(app)/operations/returns", icon: "arrow-undo-outline", testID: "nav-returns" },
    ],
  },
  {
    key: "inventory",
    label: "Inventory",
    items: [
      { key: "equipment", label: "Equipment", route: "/(app)/inventory/equipment", icon: "cube-outline", testID: "nav-equipment" },
      { key: "yard", label: "Yard Inventory", route: "/(app)/inventory/yard", icon: "business-outline", testID: "nav-yard" },
      { key: "transfers", label: "Transfers", route: "/(app)/inventory/transfers", icon: "swap-horizontal-outline", testID: "nav-transfers" },
      { key: "counts", label: "Inventory Counts", route: "/(app)/inventory/counts", icon: "clipboard-outline", testID: "nav-counts" },
    ],
  },
  {
    key: "shop",
    label: "Shop",
    items: [
      { key: "tasks", label: "Tasks", route: "/(app)/shop/tasks", icon: "checkbox-outline", testID: "nav-shop-tasks" },
      { key: "staging", label: "Staging / Loadout", route: "/(app)/shop/staging", icon: "cube-outline", testID: "nav-staging" },
      { key: "inspections", label: "Inspections", route: "/(app)/shop/inspections", icon: "search-outline", testID: "nav-inspections" },
      { key: "maintenance", label: "Maintenance / Repairs", route: "/(app)/shop/maintenance", icon: "build-outline", testID: "nav-maintenance" },
    ],
  },
  {
    key: "tools",
    label: "Tools",
    items: [
      { key: "bracing", label: "Bracing", route: "/(app)/tools/bracing", icon: "construct-outline", testID: "nav-bracing" },
      { key: "calculator", label: "Calculator", route: "/(app)/tools/calculator", icon: "calculator-outline", testID: "nav-calculator" },
    ],
  },
  {
    key: "vendors",
    label: "Vendors",
    items: [
      { key: "vendors", label: "Vendors", route: "/(app)/vendors", icon: "business-outline", testID: "nav-vendors" },
    ],
  },
  {
    key: "admin",
    label: "Admin",
    items: [
      { key: "site-admin", label: "Site Admin", route: "/(app)/site-admin", icon: "settings-outline", testID: "nav-site-admin" },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

// Mobile bottom nav: 5 destinations max. Shop work is first-class, so it
// gets its own tab instead of being buried under Menu. Operations/Inventory/
// Shop land on their section overview; Menu exposes everything else (Tools,
// Vendors, Admin, account).
export const MOBILE_TABS: { key: string; label: string; route: string; icon: IconName; testID: string }[] = [
  { key: "home", label: "Home", route: "/(app)", icon: "grid-outline", testID: "tab-home" },
  { key: "operations", label: "Operations", route: "/(app)/operations", icon: "speedometer-outline", testID: "tab-operations" },
  { key: "inventory", label: "Inventory", route: "/(app)/inventory", icon: "cube-outline", testID: "tab-inventory" },
  { key: "shop", label: "Shop", route: "/(app)/shop", icon: "construct-outline", testID: "tab-shop" },
  { key: "menu", label: "Menu", route: "/(app)/menu", icon: "menu-outline", testID: "tab-menu" },
];

// Route-prefix -> which mobile tab (and sidebar section) should read as active.
export function activeSectionForPath(pathname: string): string {
  if (pathname.startsWith("/operations")) return "operations";
  if (pathname.startsWith("/inventory")) return "inventory";
  if (pathname.startsWith("/shop")) return "shop";
  if (pathname.startsWith("/tools")) return "tools";
  if (pathname.startsWith("/vendors")) return "vendors";
  if (pathname.startsWith("/site-admin")) return "admin";
  if (pathname.startsWith("/menu")) return "menu";
  return "overview";
}

// TopBar breadcrumb: section label + page label for the current path.
// Falls back to humanizing the last path segment for un-registered routes
// (e.g. a rental/equipment detail screen reached by id).
export function breadcrumbForPath(pathname: string): { section: string; page: string } {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      const path = item.route === "/(app)" ? "/" : item.route.replace("/(app)", "");
      if (pathname === path) return { section: section.label, page: item.label };
    }
  }
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "Dashboard";
  const humanized = last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const sectionKey = activeSectionForPath(pathname);
  const section = NAV_SECTIONS.find((s) => s.key === sectionKey);
  return { section: section?.label || "Overview", page: humanized };
}

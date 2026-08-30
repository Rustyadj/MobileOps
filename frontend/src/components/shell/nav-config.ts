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
      { key: "whiteboard", label: "Dispatch", route: "/(app)/whiteboard", icon: "chatbubbles-outline", testID: "nav-whiteboard" },
    ],
  },
  {
    key: "operations",
    label: "Rentals",
    items: [
      { key: "outbound", label: "Outbound", route: "/(app)/operations/outbound", icon: "arrow-up-outline", testID: "nav-outbound" },
      { key: "active-rentals", label: "Active", route: "/(app)/operations/active", icon: "location-outline", testID: "nav-active-rentals" },
      { key: "inbound", label: "Inbound", route: "/(app)/operations/inbound", icon: "arrow-down-outline", testID: "nav-inbound" },
      { key: "returns", label: "Returns", route: "/(app)/operations/returns", icon: "return-down-back-outline", testID: "nav-returns" },
      { key: "rental-history", label: "History", route: "/(app)/operations/history", icon: "time-outline", testID: "nav-rental-history" },
    ],
  },
  {
    key: "inventory",
    label: "Inventory",
    items: [
      { key: "bracing-inventory", label: "Bracing", route: "/(app)/inventory/bracing", icon: "construct-outline", testID: "nav-inventory-bracing" },
      { key: "scaffolding-inventory", label: "Scaffolding", route: "/(app)/inventory/scaffolding", icon: "grid-outline", testID: "nav-inventory-scaffolding" },
      { key: "tool-inventory", label: "Tools", route: "/(app)/inventory/tools", icon: "hammer-outline", testID: "nav-inventory-tools" },
      { key: "consumables-inventory", label: "Consumables", route: "/(app)/inventory/consumables", icon: "flask-outline", testID: "nav-inventory-consumables" },
      { key: "block-inventory", label: "Block", route: "/(app)/inventory/block", icon: "layers-outline", testID: "nav-inventory-block" },
      { key: "damaged-inventory", label: "Damaged", route: "/(app)/inventory/damaged", icon: "warning-outline", testID: "nav-inventory-damaged" },
      { key: "yard-count", label: "Yard Count", route: "/(app)/inventory/counts", icon: "clipboard-outline", testID: "nav-yard-count" },
    ],
  },
  {
    key: "shop",
    label: "Shop",
    items: [
      { key: "tasks", label: "Tasks", route: "/(app)/shop/tasks", icon: "checkbox-outline", testID: "nav-shop-tasks" },
      { key: "staging", label: "Prep", route: "/(app)/shop/staging", icon: "cube-outline", testID: "nav-staging" },
      { key: "maintenance", label: "Repairs", route: "/(app)/shop/maintenance", icon: "build-outline", testID: "nav-maintenance" },
      { key: "shop-notes", label: "Notes", route: "/(app)/shop/notes", icon: "document-text-outline", testID: "nav-shop-notes" },
    ],
  },
  {
    key: "tools",
    label: "Utilities",
    items: [
      { key: "create-ticket", label: "Create Ticket", route: "/(app)/tools/tickets", icon: "receipt-outline", testID: "nav-create-ticket" },
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
// gets its own tab instead of being buried under Menu. Rentals/Inventory/
// Shop land on their section overview; Menu exposes everything else (Tools,
// Vendors, Admin, account).
export const MOBILE_TABS: { key: string; label: string; route: string; icon: IconName; testID: string }[] = [
  { key: "home", label: "Home", route: "/(app)", icon: "grid-outline", testID: "tab-home" },
  { key: "rentals", label: "Rentals", route: "/(app)/operations/active", icon: "swap-horizontal-outline", testID: "tab-rentals" },
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

// Concrete Form — Corporate design tokens.
// Professional operations-platform palette: white / slate / navy foundation,
// with a restrained safety-orange accent reserved for high-value actions,
// active states, and field alerts. Semantic tokens only — no ad-hoc colors.
import { Platform } from "react-native";

export const colors = {
  bg: "#FFFFFF",             // surface
  bgMuted: "#F5F7FA",        // app workspace background
  bgTint: "#F1F5F9",         // slate-100
  ink: "#122033",            // primary text
  inkSecondary: "#5B677A",   // secondary/muted text
  inkMuted: "#94A3B8",       // slate-400
  inverse: "#FFFFFF",
  primary: "#0B6CF2",        // enterprise blue — brand accent, active states, links
  primaryHover: "#0958CC",
  primarySoft: "#EAF2FE",
  border: "#DDE3EA",
  borderStrong: "#CBD5E1",   // slate-300
  success: "#22A447",
  successSoft: "#ECFDF5",
  warning: "#F59E0B",
  warningSoft: "#FFFBEB",
  error: "#E43D30",
  errorSoft: "#FEF2F2",
  info: "#0284C7",
  // Sidebar — dark navy, matched against the reference operations console.
  sidebar: "#061B33",
  sidebarBorder: "#132A47",
  sidebarActive: "#0B6CF2",
  sidebarItemMuted: "#8CA0BA",
  sidebarText: "#F8FAFC",
  // Restrained accent reserved for field alerts / high-value CTAs distinct
  // from the primary brand blue.
  accent: "#EA580C",
  accentHover: "#C2410C",
  accentSoft: "#FFF7ED",
  orange: "#EA580C",         // alias kept for existing call sites
  orangeHover: "#C2410C",
};

export const radii = { none: 0, sm: 4, md: 6, lg: 8, xl: 12 };

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };

// Responsive breakpoints (px, min-width). Phone < tablet; tablet is
// master/detail territory; desktop gets the full sidebar+topbar shell.
export const breakpoints = {
  tablet: 768,
  desktop: 1024,
  wide: 1440,
};

// Desktop working canvas — don't let content stretch edge-to-edge on huge displays.
export const maxContentWidth = 1600;

export const fonts = {
  display: Platform.select({ ios: "System", android: "sans-serif-medium", default: "System" })!,
  body: Platform.select({ ios: "System", android: "sans-serif", default: "System" })!,
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" })!,
};

export const shadows = {
  card: Platform.select({
    ios: { shadowColor: "#0F172A", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3 },
    android: { elevation: 1 },
    default: {},
  })!,
};

export const type = {
  h1: { fontFamily: fonts.display, fontWeight: "700" as const, fontSize: 28, letterSpacing: -0.4, color: colors.ink },
  h2: { fontFamily: fonts.display, fontWeight: "700" as const, fontSize: 20, letterSpacing: -0.2, color: colors.ink },
  h3: { fontFamily: fonts.display, fontWeight: "600" as const, fontSize: 16, color: colors.ink, letterSpacing: -0.1 },
  body: { fontFamily: fonts.body, fontSize: 15, color: colors.ink, lineHeight: 22 },
  bodySmall: { fontFamily: fonts.body, fontSize: 13, color: colors.inkSecondary, lineHeight: 18 },
  label: { fontFamily: fonts.body, fontSize: 12, fontWeight: "600" as const, color: colors.inkSecondary, letterSpacing: 0.2 },
  caption: { fontFamily: fonts.body, fontSize: 11, fontWeight: "500" as const, color: colors.inkMuted, textTransform: "uppercase" as const, letterSpacing: 0.8 },
  mono: { fontFamily: fonts.mono, fontSize: 15, color: colors.ink },
  monoLarge: { fontFamily: fonts.mono, fontSize: 26, color: colors.ink, fontWeight: "600" as const },
};

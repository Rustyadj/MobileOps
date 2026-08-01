// Concrete Form — Corporate design tokens.
// Professional navy palette, restrained typography, subtle rounded corners.
import { Platform } from "react-native";

export const colors = {
  bg: "#FFFFFF",
  bgMuted: "#F8FAFC",       // slate-50
  bgTint: "#F1F5F9",        // slate-100
  ink: "#0F172A",           // slate-900
  inkSecondary: "#475569",  // slate-600
  inkMuted: "#94A3B8",      // slate-400
  inverse: "#FFFFFF",
  primary: "#1E3A8A",       // blue-900 — main accent
  primaryHover: "#1E40AF",  // blue-800
  primarySoft: "#EFF6FF",   // blue-50
  border: "#E2E8F0",        // slate-200
  borderStrong: "#CBD5E1",  // slate-300
  success: "#059669",       // emerald-600
  successSoft: "#ECFDF5",   // emerald-50
  warning: "#D97706",       // amber-600
  warningSoft: "#FFFBEB",   // amber-50
  error: "#DC2626",
  errorSoft: "#FEF2F2",
  info: "#0284C7",
  // legacy alias (kept so any lingering ref doesn't break)
  orange: "#1E3A8A",
  orangeHover: "#1E40AF",
};

export const radii = { none: 0, sm: 4, md: 6, lg: 8, xl: 12 };

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };

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

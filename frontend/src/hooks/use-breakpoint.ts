// Responsive breakpoint hook — drives the shell (sidebar vs bottom nav) and
// every screen's phone/tablet/desktop layout switch.
import { useWindowDimensions } from "react-native";
import { breakpoints } from "@/src/theme";

export type Breakpoint = "phone" | "tablet" | "desktop" | "wide";

export function breakpointFor(width: number): Breakpoint {
  if (width >= breakpoints.wide) return "wide";
  if (width >= breakpoints.desktop) return "desktop";
  if (width >= breakpoints.tablet) return "tablet";
  return "phone";
}

export function useBreakpoint() {
  const { width, height } = useWindowDimensions();
  const bp = breakpointFor(width);
  return {
    width,
    height,
    bp,
    isPhone: bp === "phone",
    isTablet: bp === "tablet",
    isDesktop: bp === "desktop" || bp === "wide",
    // "wide enough for a persistent sidebar shell" — tablet-landscape and up.
    isShellWide: width >= breakpoints.tablet,
  };
}

// Responsive application shell.
// Phone: full-screen content + MobileBottomNav (screens keep their own header).
// Tablet/desktop: persistent Sidebar + TopBar wrapping the routed Stack.
import React from "react";
import { View, StyleSheet } from "react-native";
import { colors } from "@/src/theme";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { MobileBottomNav } from "./MobileBottomNav";
import { ModuleRail } from "./ModuleRail";
import { CommandMenu } from "@/src/components/overlays/CommandMenu";
import { CommandMenuProvider } from "@/src/context/CommandMenuContext";

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isShellWide } = useBreakpoint();

  return (
    <CommandMenuProvider>
      <View style={styles.root}>
        {isShellWide ? (
          <View style={styles.desktopRow}>
            <Sidebar />
            <View style={{ flex: 1, minWidth: 0 }}>
              <TopBar />
              <ModuleRail />
              <View style={{ flex: 1 }}>{children}</View>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <View style={{ flex: 1 }}>{children}</View>
            <MobileBottomNav />
          </View>
        )}
        <CommandMenu />
      </View>
    </CommandMenuProvider>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgMuted },
  desktopRow: { flex: 1, flexDirection: "row" },
});

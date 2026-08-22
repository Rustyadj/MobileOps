// Global command menu: Cmd/Ctrl+K search + the global "+ New" action.
// Desktop: popover/palette. Mobile: bottom sheet (rendered by CommandMenu).
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Platform } from "react-native";

export type CommandMenuMode = "search" | "new" | null;

type Ctx = {
  mode: CommandMenuMode;
  openSearch: () => void;
  openNew: () => void;
  close: () => void;
};

const CommandMenuCtx = createContext<Ctx | undefined>(undefined);

export const CommandMenuProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<CommandMenuMode>(null);

  const openSearch = useCallback(() => setMode("search"), []);
  const openNew = useCallback(() => setMode("new"), []);
  const close = useCallback(() => setMode(null), []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMode((m) => (m === "search" ? null : "search"));
      } else if (e.key === "Escape") {
        setMode(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return <CommandMenuCtx.Provider value={{ mode, openSearch, openNew, close }}>{children}</CommandMenuCtx.Provider>;
};

export function useCommandMenu() {
  const ctx = useContext(CommandMenuCtx);
  if (!ctx) throw new Error("useCommandMenu must be used inside CommandMenuProvider");
  return ctx;
}

// Shared collapsed/expanded state for the desktop sidebar — persisted so it
// survives reloads, and shared between the Sidebar's own control and the
// TopBar's hamburger toggle.
import { useCallback, useEffect, useState } from "react";
import { storage } from "@/src/utils/storage";

const COLLAPSE_KEY = "cf_sidebar_collapsed";

// Module-level listeners so the Sidebar and TopBar (separate hook instances)
// stay in sync without lifting state through AppShell.
const listeners = new Set<(v: boolean) => void>();
let current = false;

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(current);

  useEffect(() => {
    storage.getItem<boolean>(COLLAPSE_KEY, false).then((v) => {
      current = !!v;
      setCollapsed(current);
    });
    const listener = (v: boolean) => setCollapsed(v);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  const toggle = useCallback(() => {
    current = !current;
    storage.setItem(COLLAPSE_KEY, current);
    listeners.forEach((l) => l(current));
  }, []);

  return { collapsed, toggle };
}

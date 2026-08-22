// Global command menu — Cmd/Ctrl+K search (desktop popover / mobile sheet)
// and the global "+ New" action. Mounted once at the app shell root.
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Modal, FlatList, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useCommandMenu } from "@/src/context/CommandMenuContext";
import { searchAll, SearchResult } from "@/src/utils/global-search";

const NEW_ACTIONS: { key: string; label: string; icon: any; route: string; testID: string }[] = [
  { key: "rental", label: "New Rental", icon: "receipt-outline", route: "/(app)/operations/rentals?new=1", testID: "new-action-rental" },
  { key: "booking", label: "New Booking", icon: "calendar-outline", route: "/(app)/operations/bookings?new=1", testID: "new-action-booking" },
  { key: "equipment", label: "New Equipment", icon: "cube-outline", route: "/(app)/assets/equipment?new=1", testID: "new-action-equipment" },
  { key: "maintenance", label: "New Maintenance Entry", icon: "build-outline", route: "/(app)/assets/maintenance?new=1", testID: "new-action-maintenance" },
];

const TYPE_ICON: Record<SearchResult["type"], any> = {
  equipment: "cube-outline",
  rental: "receipt-outline",
  booking: "calendar-outline",
  vendor: "business-outline",
};

export const CommandMenu: React.FC = () => {
  const { mode, close } = useCommandMenu();
  const router = useRouter();
  const { isShellWide } = useBreakpoint();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mode !== "search") return;
    setQuery("");
    setLoading(true);
    searchAll("").then((r) => { setResults(r); setLoading(false); });
  }, [mode]);

  useEffect(() => {
    if (mode !== "search") return;
    setLoading(true);
    const t = setTimeout(() => {
      searchAll(query).then((r) => { setResults(r); setLoading(false); });
    }, 150);
    return () => clearTimeout(t);
  }, [query, mode]);

  const goTo = (route: string) => {
    close();
    router.push(route as any);
  };

  if (!mode) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={close} testID="command-menu-backdrop">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={[styles.panel, isShellWide ? styles.panelDesktop : styles.panelMobile]}
        >
          {mode === "search" ? (
            <>
              <View style={styles.searchRow}>
                <Ionicons name="search" size={18} color={colors.inkMuted} />
                <TextInput
                  autoFocus
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search rentals, bookings, equipment, vendors…"
                  placeholderTextColor={colors.inkMuted}
                  style={styles.searchInput}
                  testID="command-menu-search-input"
                />
                {loading ? <ActivityIndicator size="small" color={colors.inkMuted} /> : null}
                {isShellWide ? (
                  <View style={styles.kbdHint}><Text style={styles.kbdHintText}>ESC</Text></View>
                ) : (
                  <TouchableOpacity onPress={close} testID="command-menu-close"><Ionicons name="close" size={20} color={colors.inkMuted} /></TouchableOpacity>
                )}
              </View>
              <FlatList
                data={results}
                keyExtractor={(item) => `${item.type}-${item.id}`}
                keyboardShouldPersistTaps="handled"
                style={{ maxHeight: 380 }}
                ListEmptyComponent={
                  !loading ? (
                    <Text style={styles.emptyText}>No matches. Try a different search.</Text>
                  ) : null
                }
                renderItem={({ item }) => (
                  <TouchableOpacity style={styles.resultRow} onPress={() => goTo(item.route)} testID={`search-result-${item.type}-${item.id}`}>
                    <View style={styles.resultIcon}>
                      <Ionicons name={TYPE_ICON[item.type]} size={16} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={typo.body} numberOfLines={1}>{item.title}</Text>
                      <Text style={[typo.bodySmall, { marginTop: 1 }]} numberOfLines={1}>{item.subtitle}</Text>
                    </View>
                  </TouchableOpacity>
                )}
              />
            </>
          ) : (
            <>
              <View style={styles.newHeader}>
                <Text style={typo.h3}>New…</Text>
                <TouchableOpacity onPress={close} testID="command-menu-close-new"><Ionicons name="close" size={20} color={colors.inkMuted} /></TouchableOpacity>
              </View>
              {NEW_ACTIONS.map((a) => (
                <TouchableOpacity key={a.key} style={styles.resultRow} onPress={() => goTo(a.route)} testID={a.testID}>
                  <View style={[styles.resultIcon, { backgroundColor: colors.accentSoft }]}>
                    <Ionicons name={a.icon} size={16} color={colors.accent} />
                  </View>
                  <Text style={typo.body}>{a.label}</Text>
                </TouchableOpacity>
              ))}
            </>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)" },
  panel: { backgroundColor: colors.bg, borderRadius: radii.lg, overflow: "hidden" },
  panelDesktop: { position: "absolute", top: 96, left: "50%", marginLeft: -290, width: 580, maxWidth: "90%", borderWidth: 1, borderColor: colors.border },
  panelMobile: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, maxHeight: "80%" },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: spacing.md, height: 52, borderBottomWidth: 1, borderBottomColor: colors.border },
  searchInput: { flex: 1, fontSize: 15, color: colors.ink, height: "100%" },
  kbdHint: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 6, paddingVertical: 2 },
  kbdHintText: { fontSize: 10, fontWeight: "700", color: colors.inkMuted, letterSpacing: 0.5 },
  emptyText: { ...typo.bodySmall, textAlign: "center", padding: spacing.lg },
  resultRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: spacing.md, minHeight: 52, borderBottomWidth: 1, borderBottomColor: colors.border },
  resultIcon: { width: 32, height: 32, borderRadius: radii.md, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  newHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, height: 52, borderBottomWidth: 1, borderBottomColor: colors.border },
});

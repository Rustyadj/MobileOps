import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card } from "@/src/components/ui";
import { ErrorState } from "@/src/components/feedback/ErrorState";
import { colors, spacing, type as typo, radii } from "@/src/theme";

export type CategoryCardItem = {
  label: string;
  sub: string;
  route: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  testID: string;
};

type Props = {
  title: string;
  subtitle: string;
  testID: string;
  items: CategoryCardItem[];
  loadError?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  emptyLabel?: string;
  back?: boolean;
};

// Shared "group landing" screen: a list of tappable cards, each opening a
// filtered inventory list. Used by the Inventory root tab and the Bracing,
// Crankups/Shoring, and Tools landing pages so their card UI stays identical.
export function CategoryCardGrid({ title, subtitle, testID, items, loadError, refreshing, onRefresh, emptyLabel, back = true }: Props) {
  const router = useRouter();
  return (
    <Screen title={title} subtitle={subtitle} back={back} onRefresh={onRefresh} refreshing={refreshing} testID={testID}>
      {loadError ? <ErrorState message="Couldn't load inventory counts." onRetry={onRefresh} testID={`${testID}-error`} /> : null}
      {items.length ? items.map((it) => (
        <TouchableOpacity key={it.route} onPress={() => router.push(it.route as any)} activeOpacity={0.6} testID={it.testID}>
          <Card style={{ marginBottom: spacing.sm, flexDirection: "row", alignItems: "center" }}>
            <View style={{ width: 40, height: 40, borderRadius: radii.md, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", marginRight: spacing.md }}>
              <Ionicons name={it.icon} size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={typo.h3}>{it.label}</Text>
              <Text style={[typo.bodySmall, { marginTop: 2 }]}>{it.sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.inkMuted} />
          </Card>
        </TouchableOpacity>
      )) : emptyLabel ? <Text style={[typo.bodySmall, { marginBottom: spacing.md }]}>{emptyLabel}</Text> : null}
    </Screen>
  );
}

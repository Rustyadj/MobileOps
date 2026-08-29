// Tools section landing — mobile "Tools" tab target; also reachable from the
// desktop sidebar. Bracing and Calculator keep all existing calc logic;
// this screen is just the section entry point.
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card } from "@/src/components/ui";
import { colors, spacing, type as typo, radii } from "@/src/theme";

const ITEMS = [
  { label: "Create Ticket", sub: "Print or share a complete ticket for any delivery", route: "/(app)/tools/tickets", icon: "receipt-outline" as const, testID: "tools-create-ticket" },
  { label: "Bracing Engine", sub: "Strongbacks + braces by wall run", route: "/(app)/tools/bracing", icon: "construct-outline" as const, testID: "tools-bracing" },
  { label: "Calculator", sub: "ICF concrete, blocks, rebar, ft-in math", route: "/(app)/tools/calculator", icon: "calculator-outline" as const, testID: "tools-calculator" },
];

export default function ToolsIndex() {
  const router = useRouter();
  return (
    <Screen title="Utilities" subtitle="Delivery tickets · Bracing · Calculator" testID="tools-index-screen">
      {ITEMS.map((it) => (
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
      ))}
    </Screen>
  );
}

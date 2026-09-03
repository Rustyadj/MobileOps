import type { Ionicons } from "@expo/vector-icons";
import { TOOL_TYPE_LABELS } from "./equipment-taxonomy";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

export type InventoryCategoryCard = { key: string; label: string; icon: IconName; route: string };

// Bracing group — landing page at /inventory/bracing links out to these.
export const BRACING_CATEGORIES: InventoryCategoryCard[] = [
  { key: "strongback", label: "Stiffbacks", icon: "remove-outline", route: "/(app)/inventory/stiffbacks" },
  { key: "turnbuckle", label: "Turnbuckles", icon: "sync-outline", route: "/(app)/inventory/turnbuckles" },
  { key: "walkboard_bracket", label: "Walk-Board Brackets", icon: "walk-outline", route: "/(app)/inventory/walkboard-brackets" },
  { key: "hand_rail", label: "Handrails", icon: "hand-left-outline", route: "/(app)/inventory/handrails" },
  { key: "tb_extension", label: "Extensions", icon: "resize-outline", route: "/(app)/inventory/extensions" },
];

// Crankups/Shoring group — landing page at /inventory/scaffolding links out to these.
export const SCAFFOLDING_CATEGORIES: InventoryCategoryCard[] = [
  { key: "crankup_scaffold", label: "Crankups", icon: "trending-up-outline", route: "/(app)/inventory/crankups" },
  { key: "shoring_post", label: "Shoring", icon: "shield-outline", route: "/(app)/inventory/shoring" },
];

// Icons per fine-grained tool type (labels live in equipment-taxonomy.ts
// alongside the classifier so the two stay in sync).
export const TOOL_TYPE_ICONS: Record<string, IconName> = {
  battery_charger: "battery-charging-outline",
  circular_saw: "disc-outline",
  sawzall: "pulse-outline",
  miter_saw: "cut-outline",
  table_saw: "grid-outline",
  band_saw: "infinite-outline",
  jigsaw: "extension-puzzle-outline",
  other_saw: "cut-outline",
  hammer_drill: "hammer-outline",
  impact: "flash-outline",
  drill: "build-outline",
  grinder: "settings-outline",
  compressor: "speedometer-outline",
  laser_level: "scan-outline",
  concrete_tools: "cube-outline",
  nailer: "git-commit-outline",
  blower: "cloud-outline",
  other_tools: "ellipsis-horizontal-circle-outline",
};
// Preserves TOOL_TYPE_LABELS' declared order so cards read Battery/Charger,
// saw types, drills, then everything else — matching how the yard thinks
// about tool categories rather than an alphabetical shuffle.
export const TOOL_TYPE_ORDER = Object.keys(TOOL_TYPE_LABELS);

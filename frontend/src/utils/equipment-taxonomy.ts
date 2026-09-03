export type EquipmentTab = "all" | "tool" | "bracing" | "icf_block";

export type EquipmentTaxonomyItem = {
  category: string;
  name: string;
  model: string;
  notes: string;
};

export const TOOL_FAMILY_OPTIONS = [
  { key: "all", label: "All Tools" },
  { key: "drills_impacts", label: "Drills / Impacts" },
  { key: "batteries_chargers", label: "Batteries / Chargers" },
  { key: "saws", label: "Saws" },
  { key: "grinders", label: "Grinders" },
  { key: "levels_lasers", label: "Levels / Lasers" },
  { key: "concrete_tools", label: "Concrete Tools" },
  { key: "site_tools", label: "Site Tools" },
  { key: "other_tools", label: "Other Tools" },
];

export const BRACING_FAMILY_OPTIONS = [
  { key: "all", label: "All Bracing" },
  { key: "sb", label: "SB", accessibilityLabel: "SB — Stiffbacks" },
  { key: "tb", label: "TB", accessibilityLabel: "TB — Turnbuckles" },
  { key: "wbb", label: "WBB", accessibilityLabel: "WBB — Walk-Board Brackets" },
  { key: "hr", label: "HR", accessibilityLabel: "HR — Handrails" },
  { key: "ext", label: "EXT", accessibilityLabel: "EXT — Extensions" },
];

export const ICF_BLOCK_FAMILY_OPTIONS = [
  { key: "all", label: "All ICF Block" },
  { key: "nudura", label: "Nudura" },
  { key: "foxblocks", label: "FoxBlocks" },
  { key: "amvic", label: "Amvic" },
  { key: "buildblock", label: "BuildBlock" },
];

const BRACING_CATEGORIES = new Set([
  "strongback", "turnbuckle", "walkboard_bracket", "hand_rail",
  "tb_extension", "crankup_scaffold", "shoring_post",
]);

export const toolFamily = (item: EquipmentTaxonomyItem) => {
  const value = `${item.name} ${item.model} ${item.notes}`.toLowerCase();
  if (/battery|charger|power supply|adapter/.test(value)) return "batteries_chargers";
  if (/hammer drill|rotary hammer|impact|drill|driver/.test(value)) return "drills_impacts";
  if (/band ?saw|miter saw|table saw|circular saw|chop saw|sawzall|reciprocating|\bsaw\b/.test(value)) return "saws";
  if (/grinder/.test(value)) return "grinders";
  if (/laser|level/.test(value)) return "levels_lasers";
  if (/rebar|vibrator|concrete/.test(value)) return "concrete_tools";
  if (/air compressor|blower|grease gun|light|ladder|chalk line|nailer/.test(value)) return "site_tools";
  return "other_tools";
};

// Finer-grained tool classification than toolFamily — one bucket per
// recognizable tool type (Circular Saw, Sawzall, Grinder, …) so the
// Inventory landing screen can show a card per type instead of one lumped
// "Tools" card. Order matters: more specific patterns are checked first.
export const TOOL_TYPE_LABELS: Record<string, string> = {
  battery_charger: "Battery / Charger",
  circular_saw: "Circular Saw",
  sawzall: "Sawzall",
  miter_saw: "Miter / Chop Saw",
  table_saw: "Table Saw",
  band_saw: "Band Saw",
  jigsaw: "Jigsaw",
  other_saw: "Other Saw",
  hammer_drill: "Hammer Drill",
  impact: "Impact Wrench / Driver",
  drill: "Drill",
  grinder: "Grinder",
  compressor: "Air Compressor",
  laser_level: "Laser / Level",
  concrete_tools: "Concrete / Rebar Tools",
  nailer: "Nailer",
  blower: "Blower",
  other_tools: "Other Tools",
};

export const toolType = (item: EquipmentTaxonomyItem): string => {
  const value = `${item.name} ${item.model} ${item.notes}`.toLowerCase();
  if (/battery|charger|power supply|\badapter\b/.test(value)) return "battery_charger";
  if (/circular saw/.test(value)) return "circular_saw";
  if (/sawzall|reciprocating/.test(value)) return "sawzall";
  if (/miter saw|chop saw/.test(value)) return "miter_saw";
  if (/table saw/.test(value)) return "table_saw";
  if (/band ?saw/.test(value)) return "band_saw";
  if (/jigsaw/.test(value)) return "jigsaw";
  if (/\bsaw\b/.test(value)) return "other_saw";
  if (/hammer drill|rotary hammer/.test(value)) return "hammer_drill";
  if (/impact/.test(value)) return "impact";
  if (/\bdrill\b|driver/.test(value)) return "drill";
  if (/grinder/.test(value)) return "grinder";
  if (/air compressor|\bcompressor\b/.test(value)) return "compressor";
  if (/laser|\blevel\b/.test(value)) return "laser_level";
  if (/rebar|vibrator/.test(value)) return "concrete_tools";
  if (/nailer/.test(value)) return "nailer";
  if (/blower/.test(value)) return "blower";
  return "other_tools";
};

export const bracingFamily = (item: EquipmentTaxonomyItem) => ({
  strongback: "sb",
  turnbuckle: "tb",
  walkboard_bracket: "wbb",
  hand_rail: "hr",
  tb_extension: "ext",
} as Record<string, string>)[item.category] || "other";

export const icfBlockFamily = (item: EquipmentTaxonomyItem) => {
  const category = item.category.toLowerCase();
  const value = `${category} ${item.name} ${item.model} ${item.notes}`.toLowerCase();
  if (category === "nudura" || value.includes("nudura")) return "nudura";
  if (category === "foxblocks" || category === "fox_blocks" || /fox\s*blocks?/.test(value)) return "foxblocks";
  if (category === "amvic" || value.includes("amvic")) return "amvic";
  if (category === "buildblock" || category === "build_block" || /build\s*block/.test(value)) return "buildblock";
  return "other";
};

export const isICFBlock = (item: EquipmentTaxonomyItem) => item.category.toLowerCase().startsWith("icf_block")
  || ["nudura", "foxblocks", "fox_blocks", "amvic", "buildblock", "build_block"].includes(item.category.toLowerCase());

export const matchesEquipmentTab = (item: EquipmentTaxonomyItem, tab: EquipmentTab) => tab === "all"
  || (tab === "tool" && item.category === "tool")
  || (tab === "bracing" && BRACING_CATEGORIES.has(item.category))
  || (tab === "icf_block" && isICFBlock(item));

export const matchesEquipmentFamily = (item: EquipmentTaxonomyItem, tab: EquipmentTab, family: string) => family === "all"
  || (tab === "tool" && toolFamily(item) === family)
  || (tab === "bracing" && bracingFamily(item) === family)
  || (tab === "icf_block" && icfBlockFamily(item) === family);

export const familyOptionsFor = (tab: EquipmentTab) => tab === "tool"
  ? TOOL_FAMILY_OPTIONS
  : tab === "bracing"
    ? BRACING_FAMILY_OPTIONS
    : tab === "icf_block"
      ? ICF_BLOCK_FAMILY_OPTIONS
      : [];

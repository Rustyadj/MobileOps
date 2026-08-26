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

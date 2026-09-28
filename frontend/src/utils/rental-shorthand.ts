// Shorthand rental parsing. Operators write outbound rentals as one line —
//   9.18.26? / Carrollton / 84 - 16's / 84 Ext / 168 TB / Marco
// — and this module reads that text without ever rewriting it. Every parsed
// piece carries the exact source substring it came from, so the typed text
// stays the record of truth and the structured result is only a derived view.
//
// Nothing here touches inventory. Quantities produced by the parser are fed to
// the deterministic forecast engine (backend/rental_availability.py); this file
// only decides *what* was asked for.

export type BracingCategory =
  | "strongback"
  | "turnbuckle"
  | "walkboard_bracket"
  | "hand_rail"
  | "tb_extension"
  | "crankup_scaffold"
  | "shoring_post";

export type Generation = "gen1" | "gen2";
export type Color = "green" | "yellow";
export type Brand = "nudura" | "reachcraft";
export type Material = "steel" | "aluminum";

export type ParsedEquipment = {
  category: BracingCategory;
  /** Operator-facing label built from what was actually written. */
  label: string;
  /** Stiffback / extension length in feet, when written ("16's", "20 ft"). */
  sizeFt?: number;
  generation?: Generation;
  color?: Color;
  brand?: Brand;
  material?: Material;
  /** True when the variant is narrow enough to name one catalog item. */
  variantSpecified: boolean;
};

export type ParsedLine = {
  /** Exact source text of this segment, untouched. */
  raw: string;
  /** Character offsets of `raw` inside the original order text. */
  span: [number, number];
  qty: number | null;
  equipment: ParsedEquipment | null;
  /** The segment carried a `?` — the operator is unsure of this piece. */
  uncertain: boolean;
};

export type ParsedDate = {
  raw: string;
  span: [number, number];
  /** ISO yyyy-mm-dd, or null when the text is not a resolvable date. */
  iso: string | null;
  /** A trailing `?` means the date is not locked in. */
  confirmed: boolean;
};

export type ParsedOrder = {
  /** The typed text, verbatim. */
  raw: string;
  date: ParsedDate | null;
  location: { raw: string; span: [number, number] } | null;
  contact: { raw: string; span: [number, number] } | null;
  lines: ParsedLine[];
  /** Segments that carried no recognizable equipment — never counted. */
  unrecognized: { raw: string; span: [number, number] }[];
};

type Segment = { raw: string; span: [number, number] };

// The year is required. Without it "10 - 16's" (ten sixteen-foot stiffbacks)
// would read as October 16th, and a mis-read date is worse than none.
const DATE_PATTERN = /^\s*(\d{1,2})\s*([./-])\s*(\d{1,2})\s*\2\s*(\d{2,4})\s*(\??)/;

// `/` and `,` always separate. A `.` only separates when it ends a word rather
// than sitting inside a date or a decimal, so "9.18.26" and "8.5" survive.
const SEPARATOR = /\s*(?:[/,]|\.(?=\s|$))\s*/g;

const splitSegments = (text: string, offset: number): Segment[] => {
  const out: Segment[] = [];
  let cursor = 0;
  SEPARATOR.lastIndex = 0;
  for (let match = SEPARATOR.exec(text); match; match = SEPARATOR.exec(text)) {
    out.push(sliceSegment(text, cursor, match.index, offset));
    cursor = SEPARATOR.lastIndex;
  }
  out.push(sliceSegment(text, cursor, text.length, offset));
  return out.filter((segment) => segment.raw.length > 0);
};

const sliceSegment = (text: string, from: number, to: number, offset: number): Segment => {
  const chunk = text.slice(from, to);
  const lead = chunk.length - chunk.trimStart().length;
  const trimmed = chunk.trim();
  return { raw: trimmed, span: [offset + from + lead, offset + from + lead + trimmed.length] };
};

/** Four-digit year, or a two-digit year read as 20xx. */
const fullYear = (value: string | undefined, today: Date) => {
  if (!value) return today.getFullYear();
  const numeric = Number(value);
  return value.length <= 2 ? 2000 + numeric : numeric;
};

const parseDate = (text: string, today: Date): ParsedDate | null => {
  const match = DATE_PATTERN.exec(text);
  if (!match) return null;
  const raw = match[0].trim();
  const lead = match[0].length - match[0].trimStart().length;
  const [month, day] = [Number(match[1]), Number(match[3])];
  // Out-of-range values are not a date at all; an in-range but non-existent
  // day (2.31.26) stays a date whose text we keep and whose value is null.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = fullYear(match[4], today);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return {
    raw,
    span: [lead, lead + raw.length],
    iso: candidate.getUTCDate() === day ? candidate.toISOString().slice(0, 10) : null,
    confirmed: match[5] !== "?",
  };
};

const CATEGORY_PATTERNS: { category: BracingCategory; pattern: RegExp }[] = [
  { category: "crankup_scaffold", pattern: /\bcrank\s*-?\s*ups?\b|\bcu\b|\bscaffold/i },
  { category: "shoring_post", pattern: /\bshoring\b|\bshore\s*posts?\b/i },
  { category: "turnbuckle", pattern: /\btbs?\b|\bturn\s*-?\s*buckles?\b/i },
  { category: "walkboard_bracket", pattern: /\bwbb?s?\b|\bwalk\s*-?\s*boards?\b|\bbrackets?\b/i },
  { category: "hand_rail", pattern: /\bhrs?\b|\bhand\s*-?\s*rails?\b/i },
  { category: "tb_extension", pattern: /\bexts?\b|\bextensions?\b/i },
  { category: "strongback", pattern: /\bsbs?\b|\bstiff\s*-?\s*backs?\b|\bstrong\s*-?\s*backs?\b/i },
];

const CATEGORY_LABELS: Record<BracingCategory, string> = {
  strongback: "Stiffbacks",
  turnbuckle: "Turnbuckles",
  walkboard_bracket: "Walk-Board Brackets",
  hand_rail: "Handrails",
  tb_extension: "Extensions",
  crankup_scaffold: "Crank-Ups",
  shoring_post: "Shoring Posts",
};

/** `16's`, `16s`, `16'`, `16 ft` — a bare length implies stiffbacks. */
const SIZE_PATTERN = /\b(\d{1,2})\s*(?:'\s*s?|s\b|\bft\b|\bfoot\b|\bfeet\b)/i;
const QTY_PATTERN = /^(\d{1,5})\s*(?:[-–—xX×]\s*)?/;

const detectVariants = (text: string) => {
  const generation: Generation | undefined = /\bg\s*2\b|\bgen\s*2\b/i.test(text)
    ? "gen2"
    : /\bg\s*1\b|\bgen\s*1\b/i.test(text) ? "gen1" : undefined;
  const color: Color | undefined = /\byellow\b|\bylw\b/i.test(text)
    ? "yellow"
    : /\bgreen\b/i.test(text) ? "green" : undefined;
  const brand: Brand | undefined = /\brc\b|\bre[ae]ch\s*craft\b/i.test(text)
    ? "reachcraft"
    : /\bnudura\b/i.test(text) ? "nudura" : undefined;
  const material: Material | undefined = /\balum(?:inum)?\b|\bal\b/i.test(text)
    ? "aluminum"
    : /\bsteel\b/i.test(text) ? "steel" : undefined;
  return { generation, color, brand, material };
};

const classify = (text: string): ParsedEquipment | null => {
  const size = SIZE_PATTERN.exec(text);
  const sizeFt = size ? Number(size[1]) : undefined;
  const named = CATEGORY_PATTERNS.find((entry) => entry.pattern.test(text));
  // A bare length with no noun ("84 - 16's") is the yard's shorthand for
  // stiffbacks of that length.
  const category = named?.category ?? (sizeFt !== undefined ? "strongback" : null);
  if (!category) return null;

  const { generation, color, brand, material } = detectVariants(text);
  // Gen 2 bracing is the pair that comes in green and yellow, so a Gen 2 line
  // is only fully specified once a color is written.
  const variantSpecified = generation === "gen2"
    ? Boolean(color)
    : Boolean(generation || brand || (category === "strongback" && material));

  const parts = [
    sizeFt !== undefined ? `${sizeFt}'` : null,
    brand === "reachcraft" ? "ReachCraft" : brand === "nudura" ? "Nudura" : null,
    generation === "gen2" ? "Gen 2" : generation === "gen1" ? "Gen 1" : null,
    color === "yellow" ? "Yellow" : color === "green" ? "Green" : null,
    material === "aluminum" ? "Aluminum" : material === "steel" ? "Steel" : null,
    CATEGORY_LABELS[category],
  ].filter(Boolean);

  return { category, label: parts.join(" "), sizeFt, generation, color, brand, material, variantSpecified };
};

/** A trailing one-or-two-word name with no digits reads as the contact. */
const looksLikeName = (segment: Segment) =>
  /^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)?$/.test(segment.raw)
  && !classify(segment.raw)
  && segment.raw.length <= 24;

export function parseRentalOrder(text: string, options: { today?: Date } = {}): ParsedOrder {
  const today = options.today ?? new Date();
  const date = parseDate(text, today);
  const rest = date ? text.slice(date.span[1]) : text;
  const restOffset = date ? date.span[1] : 0;
  const segments = splitSegments(rest.replace(/^\s*[/,]\s*/, (match) => " ".repeat(match.length)), restOffset);

  const lines: ParsedLine[] = [];
  const unrecognized: Segment[] = [];
  let location: Segment | null = null;
  let contact: Segment | null = null;

  segments.forEach((segment, index) => {
    const qtyMatch = QTY_PATTERN.exec(segment.raw);
    const qty = qtyMatch ? Number(qtyMatch[1]) : null;
    const equipment = classify(qtyMatch ? segment.raw.slice(qtyMatch[0].length) : segment.raw);

    if (equipment) {
      lines.push({ raw: segment.raw, span: segment.span, qty, equipment, uncertain: segment.raw.includes("?") });
      return;
    }
    // The first non-equipment segment is the job location; a trailing name is
    // the contact. Anything else stays unrecognized rather than being guessed
    // into an inventory requirement.
    if (!location && index === 0) { location = segment; return; }
    if (index === segments.length - 1 && looksLikeName(segment)) { contact = segment; return; }
    unrecognized.push(segment);
  });

  return { raw: text, date, location, contact, lines, unrecognized };
}

/** Requirement rows ready for the availability forecast. */
export const requestedQuantities = (order: ParsedOrder) =>
  order.lines.filter((line) => line.qty != null && line.qty > 0);

// --------------------------------------------------------------------------
// Catalog resolution
// --------------------------------------------------------------------------
// Parsing says "84 Gen 2 Walk-Board Brackets". Reserving stock needs one
// equipment id. Where the shorthand names a variant we resolve it; where it
// doesn't, we return every candidate and say so, rather than silently picking
// one and reserving the wrong colour.

export type CatalogItem = {
  id: string;
  sku: string;
  name: string;
  category: string;
  available?: number;
};

export type ResolvedLine = {
  line: ParsedLine;
  /** Chosen when exactly one catalog item fits the written variant. */
  match: CatalogItem | null;
  /** Every catalog item compatible with what was written. */
  candidates: CatalogItem[];
  /** True when the variant was left open — "Gen 2 WBB" with no colour. */
  variantUnspecified: boolean;
};

const catalogTraits = (item: CatalogItem) => {
  const text = `${item.name} ${item.sku}`;
  const { generation, color, brand, material } = detectVariants(text);
  const size = SIZE_PATTERN.exec(text) || /—\s*(\d{1,2})\s*ft/i.exec(text);
  return { generation, color, brand, material, sizeFt: size ? Number(size[1]) : undefined };
};

export function resolveLine(line: ParsedLine, catalog: CatalogItem[]): ResolvedLine {
  const wanted = line.equipment;
  if (!wanted) return { line, match: null, candidates: [], variantUnspecified: false };

  const candidates = catalog.filter((item) => {
    if (item.category !== wanted.category) return false;
    const traits = catalogTraits(item);
    if (wanted.sizeFt !== undefined && traits.sizeFt !== wanted.sizeFt) return false;
    if (wanted.generation && traits.generation !== wanted.generation) return false;
    if (wanted.color && traits.color !== wanted.color) return false;
    if (wanted.brand && traits.brand !== wanted.brand) return false;
    if (wanted.material && traits.material !== wanted.material) return false;
    return true;
  });

  return {
    line,
    match: candidates.length === 1 ? candidates[0] : null,
    candidates,
    variantUnspecified: candidates.length > 1,
  };
}

export const resolveOrder = (order: ParsedOrder, catalog: CatalogItem[]) =>
  order.lines.map((line) => resolveLine(line, catalog));

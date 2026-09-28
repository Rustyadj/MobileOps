// Run with: yarn test:parser  (compiles the TS module, then executes these).
import test from "node:test";
import assert from "node:assert/strict";
import { parseRentalOrder } from "../../../.test-build/rental-shorthand.js";

const today = new Date(Date.UTC(2026, 8, 13));
const parse = (text) => parseRentalOrder(text, { today });

test("parses the Carrollton line", () => {
  const order = parse("9.18.26? / Carrollton / 84 - 16's / 84 Ext / Gen 2 Yellow? or G1? available / Marco");
  assert.equal(order.date.iso, "2026-09-18");
  assert.equal(order.date.confirmed, false);
  assert.equal(order.date.raw, "9.18.26?");
  assert.equal(order.location.raw, "Carrollton");
  assert.equal(order.contact.raw, "Marco");
  assert.deepEqual(order.lines.map((l) => [l.qty, l.equipment.label]), [
    [84, "16' Stiffbacks"],
    [84, "Extensions"],
  ]);
  assert.deepEqual(order.unrecognized.map((s) => s.raw), ["Gen 2 Yellow? or G1? available"]);
});

test("parses the Mesquite line", () => {
  const order = parse("9.11.26? / Mesquite / 140 - 16's / 140 Ext / 280 TB / 165 WBB / 165 HR / Jon");
  assert.equal(order.date.iso, "2026-09-11");
  assert.equal(order.location.raw, "Mesquite");
  assert.equal(order.contact.raw, "Jon");
  assert.deepEqual(order.lines.map((l) => [l.qty, l.equipment.category]), [
    [140, "strongback"], [140, "tb_extension"], [280, "turnbuckle"],
    [165, "walkboard_bracket"], [165, "hand_rail"],
  ]);
});

test("a date with no ? is confirmed", () => {
  assert.equal(parse("9.18.26 / Mesquite / 10 TB").date.confirmed, true);
});

test("Gen 2 without a color is not a specified variant", () => {
  const [line] = parse("84 Gen 2 WBB").lines;
  assert.equal(line.equipment.generation, "gen2");
  assert.equal(line.equipment.variantSpecified, false);
  assert.equal(line.equipment.label, "Gen 2 Walk-Board Brackets");
});

test("Gen 2 with a color is specified", () => {
  const [line] = parse("120 Gen 2 Yellow TB").lines;
  assert.equal(line.equipment.color, "yellow");
  assert.equal(line.equipment.variantSpecified, true);
});

test("ReachCraft and aluminum variants are read", () => {
  assert.equal(parse("240 TB RC").lines[0].equipment.brand, "reachcraft");
  assert.equal(parse("12 aluminum 12's").lines[0].equipment.material, "aluminum");
});

test("commas and sentence periods also separate", () => {
  const order = parse("9.18.26 / Carrollton, 84 - 16's. 168 TB / Marco");
  assert.equal(order.lines.length, 2);
  assert.equal(order.location.raw, "Carrollton");
});

test("spans point back into the original text", () => {
  const text = "9.18.26? / Carrollton / 84 - 16's";
  const order = parse(text);
  assert.equal(text.slice(...order.lines[0].span), "84 - 16's");
  assert.equal(text.slice(...order.location.span), "Carrollton");
});

test("a segment carrying ? is flagged uncertain", () => {
  assert.equal(parse("9.18.26 / Denton / 84 TB?").lines[0].uncertain, true);
});

test("an impossible date resolves to null but keeps its text", () => {
  const date = parse("2.31.26 / Denton / 10 TB").date;
  assert.equal(date.iso, null);
  assert.equal(date.raw, "2.31.26");
});

test("empty text parses to an empty order", () => {
  const order = parse("");
  assert.equal(order.date, null);
  assert.deepEqual(order.lines, []);
});

// --- catalog resolution ---
const CATALOG = [
  { id: "sb16", sku: "SB-1601", name: "Steel Stiffback — 16 ft", category: "strongback" },
  { id: "sb12", sku: "SB-1201", name: "Steel Stiffback — 12 ft", category: "strongback" },
  { id: "asb12", sku: "ASB-1201", name: "Aluminum Stiffback — 12 ft", category: "strongback" },
  { id: "g2tb", sku: "G2TB", name: "Nudura Gen 2 Green Turnbuckle", category: "turnbuckle" },
  { id: "g2tby", sku: "G2TBY", name: "Nudura Gen 2 Yellow Turnbuckle", category: "turnbuckle" },
  { id: "tb1", sku: "TB-001", name: "Nudura Gen 1 Turnbuckle", category: "turnbuckle" },
  { id: "wb2", sku: "WB-002", name: "Nudura Gen 2 Green Walk-Board Bracket", category: "walkboard_bracket" },
  { id: "wby2", sku: "WBY-002", name: "Nudura Gen 2 Yellow Walk-Board Bracket", category: "walkboard_bracket" },
];

const { resolveLine } = await import("../../../.test-build/rental-shorthand.js");
const resolveText = (text) => resolveLine(parse(text).lines[0], CATALOG);

test("a written length resolves one stiffback", () => {
  assert.equal(resolveText("84 - 16's").match.id, "sb16");
});

test("Gen 2 without a colour stays unresolved with both candidates", () => {
  const resolved = resolveText("84 Gen 2 WBB");
  assert.equal(resolved.match, null);
  assert.equal(resolved.variantUnspecified, true);
  assert.deepEqual(resolved.candidates.map((c) => c.id).sort(), ["wb2", "wby2"]);
});

test("Gen 2 Yellow resolves exactly one turnbuckle", () => {
  assert.equal(resolveText("120 Gen 2 Yellow TB").match.id, "g2tby");
});

test("aluminum narrows a duplicated length", () => {
  assert.equal(resolveText("12 aluminum 12's").match.id, "asb12");
});

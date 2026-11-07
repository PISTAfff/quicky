import { test } from "node:test";
import assert from "node:assert/strict";
import { bbox, clampSize, hits, resizeBy, scaleAbout, topAt, translate, type Item } from "../src/lib/ink.ts";

const pen: Item = { kind: "pen", color: "#000", size: 4, pts: [[10, 10], [50, 10]] };
const rect: Item = { kind: "rect", color: "#000", size: 2, a: [100, 100], b: [200, 150] };
const text: Item = { kind: "text", color: "#000", size: 20, at: [300, 300], text: "Hi", w: 40, h: 24, font: "Fredoka", outline: 1, outlineColor: "auto", spacing: 2, leading: 1.2 };
// Text grows in proportion, like the canvas would measure it.
const measure = (t: Extract<Item, { kind: "text" }>) => ({ w: 2 * t.size, h: t.size * t.leading });

test("the topmost item under the pointer is picked", () => {
  assert.equal(topAt([pen, rect, text], [30, 11]), 0);
  assert.equal(topAt([pen, rect, text], [150, 100]), 1);
  // Inside a rectangle isn't on it.
  assert.equal(topAt([pen, rect, text], [150, 125]), null);
  assert.equal(topAt([pen, rect, text], [310, 310]), 2);
  // Overlapping: the one drawn last.
  assert.equal(topAt([pen, { ...pen, color: "#f00" }], [30, 10]), 1);
  assert.ok(hits(pen, [30, 12], 0));
  assert.ok(!hits(pen, [30, 20], 0));
});

test("boxes include the stroke", () => {
  assert.deepEqual(bbox(rect), { x: 99, y: 99, w: 102, h: 52 });
  assert.deepEqual(bbox(text), { x: 300, y: 300, w: 40, h: 24 });
  assert.deepEqual(bbox(pen), { x: 8, y: 8, w: 44, h: 4 });
});

test("moving keeps the shape", () => {
  const r = translate(rect, 10, -5) as Extract<Item, { kind: "rect" }>;
  assert.deepEqual([r.a, r.b], [[110, 95], [210, 145]]);
  assert.deepEqual((translate(text, 1, 1) as Extract<Item, { kind: "text" }>).at, [301, 301]);
  // The original is left as it was (undo keeps it).
  assert.deepEqual(rect.a, [100, 100]);
});

test("the zoom shortcut thickens strokes and grows shapes and text around their middle", () => {
  const p = resizeBy(pen, 2, measure);
  assert.equal(p.size, 8);
  assert.deepEqual((p as typeof pen).pts, pen.pts);
  const r = resizeBy(rect, 2, measure) as Extract<Item, { kind: "rect" }>;
  assert.deepEqual([r.a, r.b], [[50, 75], [250, 175]]);
  assert.equal(r.size, 2);
  const t = resizeBy(text, 2, measure) as Extract<Item, { kind: "text" }>;
  assert.equal(t.size, 40);
  assert.equal(t.spacing, 4);
  assert.equal(t.w, 80);
});

test("sizes stay within each tool's range", () => {
  assert.equal(clampSize("pen", 0.2), 1);
  assert.equal(clampSize("text", 999), 200);
  assert.equal(clampSize("hl", 12.345), 12.3);
  const tiny = scaleAbout(text, [300, 300], 0.01, measure) as Extract<Item, { kind: "text" }>;
  assert.equal(tiny.size, 10);
  // The position scales by what the size really changed.
  assert.deepEqual(tiny.at, [300, 300]);
});

// The screen tools' drawing as data: the items (strokes, shapes, text labels) and the geometry
// for picking one, its box, and moving or resizing it. Pure (no DOM, no Tauri), so `tests/` can
// run it; `draw.ts` paints and measures.

export type Pt = [number, number];
export type Tool = "pen" | "hl" | "eraser" | "rect" | "ellipse" | "line" | "arrow" | "text" | "spot" | "laser";
/** How a text label is drawn: its font, outline (0 none, 1 thin, 2 thick) and the outline's
 *  colour ("auto": ink or white, whichever stands out from the fill), letter spacing (px) and
 *  line height (times the size). */
export interface TextStyle {
  font: "Fredoka" | "Nunito";
  outline: 0 | 1 | 2;
  outlineColor: "auto" | "ink" | "white";
  spacing: number;
  leading: number;
}
export type Item =
  | { kind: "pen" | "hl"; color: string; size: number; pts: Pt[] }
  | { kind: "rect" | "ellipse" | "line" | "arrow"; color: string; size: number; a: Pt; b: Pt }
  | ({ kind: "text"; color: string; size: number; at: Pt; text: string; w: number; h: number } & TextStyle);
export type Box = { x: number; y: number; w: number; h: number };

/** Each tool's smallest and largest size (stroke width; the eraser's and spotlight's radius; text height). */
export const SIZE_RANGE: Record<Tool, [number, number]> = {
  pen: [1, 60], hl: [6, 90], eraser: [4, 120], rect: [1, 40], ellipse: [1, 40], line: [1, 40], arrow: [1, 40],
  text: [10, 200], spot: [40, 500], laser: [2, 20],
};
export const clampSize = (t: Tool, v: number) => Math.round(Math.max(SIZE_RANGE[t][0], Math.min(SIZE_RANGE[t][1], v)) * 10) / 10;

export const norm = (a: Pt, b: Pt): [number, number, number, number] => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];

export function segDist([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt) {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The line an item is drawn along (for hitting it). */
export function outline(it: Item): Pt[] {
  if (it.kind === "pen" || it.kind === "hl") return it.pts;
  if (it.kind === "line" || it.kind === "arrow") return [it.a, it.b];
  if (it.kind === "rect") {
    const [x, y, w, h] = norm(it.a, it.b);
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  }
  if (it.kind === "ellipse") {
    const [x, y, w, h] = norm(it.a, it.b);
    return Array.from({ length: 49 }, (_, i) => [x + w / 2 + (w / 2) * Math.cos((i / 48) * Math.PI * 2), y + h / 2 + (h / 2) * Math.sin((i / 48) * Math.PI * 2)] as Pt);
  }
  return [];
}

/** The point is within `r` of the item (on its line; anywhere on a text label). */
export function hits(it: Item, p: Pt, r: number) {
  if (it.kind === "text") return p[0] >= it.at[0] - r && p[0] <= it.at[0] + it.w + r && p[1] >= it.at[1] - r && p[1] <= it.at[1] + it.h + r;
  const o = outline(it);
  const reach = r + it.size / 2;
  if (o.length === 1) return Math.hypot(p[0] - o[0][0], p[1] - o[0][1]) <= reach;
  for (let i = 1; i < o.length; i++) if (segDist(p, o[i - 1], o[i]) <= reach) return true;
  return false;
}

/** The topmost item at a point (the last drawn wins), or null. */
export function topAt(items: Item[], p: Pt, r = 6): number | null {
  for (let i = items.length - 1; i >= 0; i--) if (hits(items[i], p, r)) return i;
  return null;
}

/** The box an item covers, its stroke included. */
export function bbox(it: Item): Box {
  if (it.kind === "text") return { x: it.at[0], y: it.at[1], w: it.w, h: it.h };
  const pts = "pts" in it ? it.pts : [it.a, it.b];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  // An arrow's head reaches past its end.
  const pad = it.kind === "arrow" ? Math.max(14, it.size * 3.6) / 2 + it.size / 2 : it.size / 2;
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

const move = (p: Pt, dx: number, dy: number): Pt => [p[0] + dx, p[1] + dy];
const about = (p: Pt, c: Pt, k: number): Pt => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];

/** The item moved by dx, dy. */
export function translate(it: Item, dx: number, dy: number): Item {
  if (it.kind === "text") return { ...it, at: move(it.at, dx, dy) };
  if ("pts" in it) return { ...it, pts: it.pts.map((p) => move(p, dx, dy)) };
  return { ...it, a: move(it.a, dx, dy), b: move(it.b, dx, dy) };
}

/** The item grown (k > 1) or shrunk around a point: its shape, and a text label's size and
 *  spacing (a stroke's width stays). `measure` gives a text label's new box. */
export function scaleAbout(it: Item, c: Pt, k: number, measure: (t: Extract<Item, { kind: "text" }>) => { w: number; h: number }): Item {
  if (it.kind === "text") {
    const size = clampSize("text", it.size * k);
    const real = size / it.size;
    const t = { ...it, at: about(it.at, c, real), size, spacing: Math.round(it.spacing * real * 10) / 10 };
    return { ...t, ...measure(t) };
  }
  if ("pts" in it) return { ...it, pts: it.pts.map((p) => about(p, c, k)) };
  return { ...it, a: about(it.a, c, k), b: about(it.b, c, k) };
}

/** The zoom shortcut on a chosen item: text and shapes grow or shrink around their middle,
 *  strokes get thicker or thinner. */
export function resizeBy(it: Item, k: number, measure: (t: Extract<Item, { kind: "text" }>) => { w: number; h: number }): Item {
  if (it.kind === "pen" || it.kind === "hl") return { ...it, size: clampSize(it.kind, it.size * k) };
  const b = bbox(it);
  return scaleAbout(it, [b.x + b.w / 2, b.y + b.h / 2], k, measure);
}

// The screen tools (`draw.rs`, `record.rs`): a see-through window over every screen with a
// floating toolbar and three modes, Screenshot every time it opens unless another is picked:
// - Screenshot: the screen frozen as it was; drag an area (handles adjust it, Shift keeps it
//   square), click a window, or take a whole screen; draw on it if wanted; Enter copies and saves.
// - Draw: pen, highlighter, eraser, shapes, arrows, text, a spotlight and a laser over the live
//   screen, with click-through to keep the drawing up while using the apps underneath.
// - Record: choose an area the same way, then a 3-2-1 and it's recorded to an MP4 (Rust does the
//   video; the microphone's sound comes from here when turned on), with a stop bar beside it.
// The drawing is a list of items (in CSS px) painted onto a canvas, so undo, the eraser and the
// screenshot are simple. Leaving destroys the window, and the drawing with it.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { followTheme } from "./lib/theme-colors";
import { sfx } from "./lib/sfx";
import { OS } from "./lib/platform";
import { bbox, clampSize, hits, norm, resizeBy, scaleAbout, topAt, translate, type Box, type Item, type Pt, type TextStyle, type Tool } from "./lib/ink";

followTheme();

type Mode = "shot" | "draw" | "record";
type Phase = "select" | "chosen" | "countdown" | "recording" | "done";
type TextItem = Extract<Item, { kind: "text" }>;
interface Info {
  geometry: { width: number; height: number; screen: number[]; screens: number[][]; windows: number[][]; mode: Mode } | null;
  canCapture: boolean;
  canRecord: boolean;
}

/** Each tool's three preset sizes (stroke width; the eraser's radius; text height; the
 *  spotlight's radius). The zoom shortcut sets any size in between (`SIZE_RANGE`). */
const SIZES: Record<Tool, [number, number, number]> = {
  pen: [3, 6, 12], hl: [14, 24, 38], eraser: [10, 22, 42], rect: [3, 5, 9], ellipse: [3, 5, 9], line: [3, 5, 9], arrow: [3, 5, 9],
  text: [20, 32, 52], spot: [100, 160, 240], laser: [4, 6, 9],
};
/** The colours: Quicky's accent first, then a few that show up on anything. */
const COLORS = ["accent", "#ff4757", "#ffc531", "#22c55e", "#3b82f6", "#2b2540", "#ffffff"];
const COLOR_NAMES = ["Quicky's colour", "Red", "Yellow", "Green", "Blue", "Ink", "White"];
const LASER = "#ff2d55";
const MOD = OS === "mac" ? "⌘" : "Ctrl+";
const SYSTEM = OS === "mac" ? "macOS" : "Linux";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const frozen = $<HTMLCanvasElement>("frozen");
const ink = $<HTMLCanvasElement>("ink");
const live = $<HTMLCanvasElement>("live");
const veil = $<HTMLCanvasElement>("veil");
const spot = $("spot");
const textBox = $<HTMLTextAreaElement>("text");
const bar = $("bar");
const hintEl = $("hint");
const act = $("act");
const countEl = $("count");
const recbar = $("recbar");
const card = $("card");
const toastEl = $("toast");
const inkCtx = ink.getContext("2d")!;
const liveCtx = live.getContext("2d")!;
const veilCtx = veil.getContext("2d")!;

let info: Info = { geometry: null, canCapture: false, canRecord: false };
let mode: Mode = "draw";
let phase: Phase = "select";
/** The chosen area, and the window or screen the pointer would pick with a click. */
let sel: Box | null = null;
let hover: Box | null = null;
/** Screenshot: drawing on the chosen area instead of adjusting it. */
let annotate = false;
let windowsCss: Box[] = [];
let tool: Tool = "pen";
let colorIndex = 0;
/** Each tool's size now (a preset, or what the zoom shortcut made it). */
const toolSize = Object.fromEntries(Object.entries(SIZES).map(([t, s]) => [t, s[1]])) as Record<Tool, number>;
/** How new text labels look (and the picked one, when it's text). */
const textStyle: TextStyle = { font: "Fredoka", outline: 1, outlineColor: "auto", spacing: 0, leading: 1.2 };
/** The placed item picked again (index into `items`), to move, resize, restyle or delete. */
let picked: number | null = null;
/** The text label being edited again (its index), while the text box is open on it. */
let editing: number | null = null;
let items: Item[] = [];
const undoStack: Item[][] = [];
const redoStack: Item[][] = [];
let through = false;

const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#6d4cff";
const color = () => (COLORS[colorIndex] === "accent" ? accent() : COLORS[colorIndex]);
const size = (t: Tool = tool) => toolSize[t];
/** Physical px per CSS px: the screens' real size over the page's (not devicePixelRatio, which
 *  is off when screens of different scales are side by side). */
const physScale = () => (info.geometry ? info.geometry.width / innerWidth : devicePixelRatio || 1);
const toCss = (r: number[]): Box => {
  const s = physScale();
  return { x: r[0] / s, y: r[1] / s, w: r[2] / s, h: r[3] / s };
};
const startScreen = (): Box => (info.geometry ? toCss(info.geometry.screen) : { x: 0, y: 0, w: innerWidth, h: innerHeight });
const canDraw = () => (mode === "draw" || (mode === "shot" && annotate)) && phase !== "done" && phase !== "countdown" && phase !== "recording";
const selecting = () => ((mode === "shot" && !annotate) || mode === "record") && (phase === "select" || phase === "chosen");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const two = (n: number) => String(n).padStart(2, "0");
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} at ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
};

// ---- painting ---------------------------------------------------------------------------------

/** The canvases match the window's real pixels; items are kept in CSS px. */
function fit() {
  const dpr = devicePixelRatio || 1;
  for (const c of [ink, live, veil]) {
    c.width = Math.round(innerWidth * dpr);
    c.height = Math.round(innerHeight * dpr);
  }
  for (const c of [inkCtx, liveCtx, veilCtx]) c.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
  renderVeil();
}

/** Light colours get a dark halo and dark ones a light halo, so text reads on any background. */
function halo(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#2b2540" : "#ffffff";
}

const font = (px: number, family: TextStyle["font"] = "Fredoka") =>
  `${family === "Nunito" ? 800 : 600} ${px}px ${family}, ${family === "Nunito" ? "Fredoka" : "Nunito"}, system-ui, sans-serif`;
/** The outline's width for a size (none, thin, thick) and its colour. */
const outlineWidth = (t: Pick<TextItem, "size" | "outline">) => (t.outline === 0 ? 0 : t.outline === 1 ? Math.max(2, t.size / 8) : Math.max(4, t.size / 4));
const outlineColor = (t: Pick<TextItem, "color" | "outlineColor">) => (t.outlineColor === "ink" ? "#2b2540" : t.outlineColor === "white" ? "#ffffff" : halo(t.color));

/** A text label's box as drawn (its spacing and outline included). */
function measure(t: TextItem) {
  inkCtx.save();
  inkCtx.font = font(t.size, t.font);
  inkCtx.letterSpacing = `${t.spacing}px`;
  const lines = t.text.split("\n");
  const w = Math.max(...lines.map((l) => inkCtx.measureText(l).width));
  inkCtx.restore();
  const o = outlineWidth(t);
  return { w: w + o, h: (lines.length - 1) * t.size * t.leading + t.size * 1.2 + o };
}

function paint(c: CanvasRenderingContext2D, it: Item) {
  c.save();
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = c.fillStyle = it.color;
  c.lineWidth = it.size;
  if (it.kind === "pen" || it.kind === "hl") {
    // The highlighter is one see-through path, so it doesn't get darker where it crosses itself.
    if (it.kind === "hl") c.globalAlpha = 0.38;
    const p = it.pts;
    c.beginPath();
    if (p.length === 1) {
      c.arc(p[0][0], p[0][1], it.size / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      c.moveTo(p[0][0], p[0][1]);
      // Smooth: curves through the middles of the points, each point a control.
      for (let i = 1; i < p.length - 1; i++) c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      c.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      c.stroke();
    }
  } else if (it.kind === "rect" || it.kind === "ellipse") {
    const [x, y, w, h] = norm(it.a, it.b);
    c.beginPath();
    if (it.kind === "rect") c.roundRect(x, y, w, h, Math.min(6, w / 2, h / 2));
    else c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    c.stroke();
  } else if (it.kind === "line" || it.kind === "arrow") {
    const [ax, ay] = it.a;
    let [bx, by] = it.b;
    const ang = Math.atan2(by - ay, bx - ax);
    const head = Math.max(14, it.size * 3.6);
    const len = Math.hypot(bx - ax, by - ay);
    if (it.kind === "arrow" && len > 1) {
      // The head is a filled triangle; the shaft stops inside it so its round end doesn't poke out.
      c.beginPath();
      c.moveTo(bx, by);
      c.lineTo(bx - head * Math.cos(ang - 0.45), by - head * Math.sin(ang - 0.45));
      c.lineTo(bx - head * Math.cos(ang + 0.45), by - head * Math.sin(ang + 0.45));
      c.closePath();
      c.lineWidth = Math.max(2, it.size / 2);
      c.fill();
      c.stroke();
      c.lineWidth = it.size;
      const back = Math.min(len, head * 0.7);
      bx -= back * Math.cos(ang);
      by -= back * Math.sin(ang);
    }
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.stroke();
  } else if (it.kind === "text") {
    c.font = font(it.size, it.font);
    c.letterSpacing = `${it.spacing}px`;
    c.textBaseline = "top";
    const ow = outlineWidth(it);
    c.lineWidth = ow;
    c.strokeStyle = outlineColor(it);
    it.text.split("\n").forEach((line, i) => {
      const x = it.at[0] + ow / 2, y = it.at[1] + ow / 2 + i * it.size * it.leading;
      if (ow) c.strokeText(line, x, y);
      c.fillText(line, x, y);
    });
  }
  c.restore();
}

function clearCanvas(c: CanvasRenderingContext2D, el: HTMLCanvasElement) {
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, el.width, el.height);
  c.restore();
}

function render() {
  clearCanvas(inkCtx, ink);
  // A text label being edited is shown by the text box instead.
  items.forEach((it, i) => i !== editing && paint(inkCtx, it));
  refreshButtons();
}

// ---- the chosen area --------------------------------------------------------------------------

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];
function handlePoint(b: Box, h: Handle): Pt {
  const x = h.includes("w") ? b.x : h.includes("e") ? b.x + b.w : b.x + b.w / 2;
  const y = h.includes("n") ? b.y : h.includes("s") ? b.y + b.h : b.y + b.h / 2;
  return [x, y];
}
const handleAt = (b: Box, p: Pt) => HANDLES.find((h) => {
  const [x, y] = handlePoint(b, h);
  return Math.abs(p[0] - x) <= 9 && Math.abs(p[1] - y) <= 9;
});
const inside = (b: Box, p: Pt) => p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h;
const physSize = (b: Box) => `${Math.round(b.w * physScale())} × ${Math.round(b.h * physScale())}`;

function renderVeil() {
  clearCanvas(veilCtx, veil);
  if (mode === "draw" || phase === "done") return;
  const c = veilCtx;
  if (phase === "countdown" || phase === "recording") {
    // Recording: a red frame just outside the area (the window is kept out of the video).
    if (!sel) return;
    c.save();
    c.strokeStyle = "#ff3b4e";
    c.lineWidth = 3;
    c.setLineDash([10, 6]);
    c.strokeRect(sel.x - 3, sel.y - 3, sel.w + 6, sel.h + 6);
    c.restore();
    return;
  }
  c.save();
  c.fillStyle = "rgba(16, 12, 30, 0.45)";
  c.fillRect(0, 0, innerWidth, innerHeight);
  const b = sel ?? hover;
  if (b) {
    c.clearRect(b.x, b.y, b.w, b.h);
    c.strokeStyle = accent();
    c.lineWidth = 2;
    c.strokeRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2);
  }
  if (sel && !annotate && phase === "chosen") {
    c.fillStyle = "#ffffff";
    c.strokeStyle = "#2b2540";
    c.lineWidth = 2;
    for (const h of HANDLES) {
      const [x, y] = handlePoint(sel, h);
      c.fillRect(x - 5, y - 5, 10, 10);
      c.strokeRect(x - 5, y - 5, 10, 10);
    }
  }
  if (b) {
    // The size in real pixels, in a little pill above the area (inside when there's no room).
    const label = physSize(b);
    c.font = "800 12px Nunito, system-ui, sans-serif";
    const w = c.measureText(label).width + 16;
    const y = b.y >= 30 ? b.y - 28 : b.y + 6;
    c.fillStyle = "#2b2540";
    c.beginPath();
    c.roundRect(b.x, y, w, 22, 8);
    c.fill();
    c.fillStyle = "#ffffff";
    c.textBaseline = "middle";
    c.fillText(label, b.x + 8, y + 11);
  }
  c.restore();
}

let selDrag: { kind: "new" | "move" | Handle; start: Pt; orig: Box | null; moved: boolean; had: boolean } | null = null;

function startSelect(p: Pt) {
  const h = sel && phase === "chosen" ? handleAt(sel, p) : undefined;
  const had = !!sel && phase === "chosen";
  if (sel && h) selDrag = { kind: h, start: p, orig: { ...sel }, moved: false, had };
  else if (sel && had && inside(sel, p)) selDrag = { kind: "move", start: p, orig: { ...sel }, moved: false, had };
  else selDrag = { kind: "new", start: p, orig: null, moved: false, had };
}

function moveSelect(p: Pt) {
  const d = selDrag!;
  const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
  if (!d.moved && Math.hypot(dx, dy) < 4) return;
  d.moved = true;
  if (d.kind === "new") {
    let [x2, y2] = p;
    if (shift) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      x2 = d.start[0] + Math.sign(dx || 1) * s;
      y2 = d.start[1] + Math.sign(dy || 1) * s;
    }
    const [x, y, w, h] = norm(d.start, [x2, y2]);
    sel = { x, y, w, h };
  } else if (d.kind === "move") {
    const o = d.orig!;
    sel = { ...o, x: Math.max(0, Math.min(innerWidth - o.w, o.x + dx)), y: Math.max(0, Math.min(innerHeight - o.h, o.y + dy)) };
  } else {
    const o = d.orig!;
    let [l, t, r, b] = [o.x, o.y, o.x + o.w, o.y + o.h];
    if (d.kind.includes("w")) l += dx;
    if (d.kind.includes("e")) r += dx;
    if (d.kind.includes("n")) t += dy;
    if (d.kind.includes("s")) b += dy;
    sel = { x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t) };
  }
  phase = "chosen";
  hover = null;
  layout();
}

function endSelect(p: Pt) {
  const d = selDrag!;
  selDrag = null;
  if (d.kind === "new" && !d.moved) {
    // A click outside the chosen area lets go of it; otherwise it picks the window under the
    // pointer, or the whole screen.
    sel = d.had ? null : (hover ?? screenAt(p));
  }
  if (sel && (sel.w < 8 || sel.h < 8)) sel = null;
  phase = sel ? "chosen" : "select";
  hover = null;
  layout();
}

function screenAt(p: Pt): Box {
  const screens = (info.geometry?.screens ?? []).map(toCss);
  return screens.find((s) => inside(s, p)) ?? startScreen();
}

function hoverAt(p: Pt) {
  const w = windowsCss.find((b) => inside(b, p)) ?? null;
  if (w?.x !== hover?.x || w?.y !== hover?.y || w?.w !== hover?.w || w?.h !== hover?.h) {
    hover = w;
    renderVeil();
  }
}

function selectCursor(p: Pt) {
  if (!sel || phase !== "chosen") return (document.body.style.cursor = "");
  const h = handleAt(sel, p);
  const cursors: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
  document.body.style.cursor = h ? cursors[h] : inside(sel, p) ? "move" : "";
}

// ---- history ----------------------------------------------------------------------------------

function commit(next: Item[], before = items) {
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  items = next;
  render();
}
function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  picked = null;
  redoStack.push(items);
  items = prev;
  sfx.undo();
  render();
}
function redo() {
  const next = redoStack.pop();
  if (!next) return;
  picked = null;
  undoStack.push(items);
  items = next;
  sfx.tap();
  render();
}
function clear() {
  if (!items.length) return;
  pick(null);
  commit([]);
  sfx.delete();
}

// ---- the eraser: takes away whole items it touches ---------------------------------------------

function eraseAt(p: Pt) {
  const left = items.filter((it) => !hits(it, p, size("eraser")));
  if (left.length !== items.length) {
    items = left;
    render();
  }
}

// ---- pointer ----------------------------------------------------------------------------------

let drawing: Item | null = null;
let erasing: { before: Item[] } | null = null;
let pointer: Pt | null = null;
let shift = false;
/** The laser's trail: where the pointer was, and when. */
const trail: { p: Pt; t: number }[] = [];
let frame = 0;

/** Shift keeps shapes square and round, and lines at 45° steps. */
function constrain(kind: Tool, a: Pt, b: Pt): Pt {
  if (!shift) return b;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (kind === "rect" || kind === "ellipse") {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [a[0] + Math.sign(dx || 1) * d, a[1] + Math.sign(dy || 1) * d];
  }
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [a[0] + len * Math.cos(ang), a[1] + len * Math.sin(ang)];
}

const at = (e: MouseEvent): Pt => [e.clientX, e.clientY];

function liveFrame() {
  frame = 0;
  clearCanvas(liveCtx, live);
  if (drawing) paint(liveCtx, drawing);
  if (!canDraw()) return;
  const pb = pickedBox();
  if (pb && editing === null) {
    // The picked item: a dashed frame with a handle at each corner (drag them to resize).
    const b = pad(pb);
    liveCtx.save();
    liveCtx.strokeStyle = accent();
    liveCtx.lineWidth = 2;
    liveCtx.setLineDash([6, 4]);
    liveCtx.strokeRect(b.x, b.y, b.w, b.h);
    liveCtx.setLineDash([]);
    liveCtx.fillStyle = "#ffffff";
    liveCtx.strokeStyle = "#2b2540";
    for (const [x, y] of corners(b)) {
      liveCtx.fillRect(x - 5, y - 5, 10, 10);
      liveCtx.strokeRect(x - 5, y - 5, 10, 10);
    }
    liveCtx.restore();
  }
  if (tool === "eraser" && pointer && !through) {
    liveCtx.save();
    liveCtx.beginPath();
    liveCtx.arc(pointer[0], pointer[1], size("eraser"), 0, Math.PI * 2);
    liveCtx.fillStyle = "rgba(255,255,255,0.25)";
    liveCtx.fill();
    liveCtx.lineWidth = 2;
    liveCtx.strokeStyle = "#2b2540";
    liveCtx.stroke();
    liveCtx.restore();
  }
  if (tool === "laser") {
    // A fading trail behind a glowing dot.
    const now = performance.now();
    const LIFE = 650;
    while (trail.length && now - trail[0].t > LIFE) trail.shift();
    liveCtx.save();
    liveCtx.lineCap = liveCtx.lineJoin = "round";
    liveCtx.shadowColor = LASER;
    liveCtx.shadowBlur = 14;
    for (let i = 1; i < trail.length; i++) {
      const k = 1 - (now - trail[i].t) / LIFE;
      liveCtx.strokeStyle = `rgba(255, 45, 85, ${k})`;
      liveCtx.lineWidth = size("laser") * (0.35 + 0.65 * k);
      liveCtx.beginPath();
      liveCtx.moveTo(trail[i - 1].p[0], trail[i - 1].p[1]);
      liveCtx.lineTo(trail[i].p[0], trail[i].p[1]);
      liveCtx.stroke();
    }
    if (pointer) {
      liveCtx.fillStyle = LASER;
      liveCtx.beginPath();
      liveCtx.arc(pointer[0], pointer[1], size("laser") * 1.1, 0, Math.PI * 2);
      liveCtx.fill();
      liveCtx.shadowBlur = 0;
      liveCtx.fillStyle = "#fff";
      liveCtx.beginPath();
      liveCtx.arc(pointer[0], pointer[1], size("laser") * 0.4, 0, Math.PI * 2);
      liveCtx.fill();
    }
    liveCtx.restore();
    if (trail.length) schedule();
  }
}
const schedule = () => void (frame ||= requestAnimationFrame(liveFrame));

function moveSpot() {
  if (tool !== "spot" || !pointer || !canDraw()) return;
  const r = size("spot");
  spot.style.background = `radial-gradient(circle ${r}px at ${pointer[0]}px ${pointer[1]}px, transparent 97%, rgba(16, 12, 30, 0.66) 100%)`;
}

const onUi = (e: Event) => [bar, hintEl, act, recbar, card, textBox, $("textbar")].some((el) => el.contains(e.target as Node));

// ---- picking placed items again ---------------------------------------------------------------

/** Moving or resizing the picked item: the items before, where the drag began, the item as it
 *  was, and the corner it resizes from (null: moving). */
let itemDrag: { before: Item[]; start: Pt; orig: Item; anchor: Pt | null; moved: boolean } | null = null;
/** Where a press began, to tell a click on a placed item (picks it) from drawing. */
let pressAt: Pt | null = null;

const pad = (b: Box): Box => ({ x: b.x - 6, y: b.y - 6, w: b.w + 12, h: b.h + 12 });
const corners = (b: Box): Pt[] => [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
const pickedItem = () => (picked !== null ? (items[picked] ?? null) : null);
const pickedBox = () => {
  const it = pickedItem();
  return it ? bbox(it) : null;
};

/** Picks a placed item (null: none). The toolbar shows its colour, and its text style. */
function pick(i: number | null) {
  picked = i;
  const it = pickedItem();
  if (it) {
    const ci = COLORS.findIndex((c) => (c === "accent" ? accent() : c) === it.color);
    if (ci >= 0) colorIndex = ci;
    if (it.kind === "text") Object.assign(textStyle, { font: it.font, outline: it.outline, outlineColor: it.outlineColor, spacing: it.spacing, leading: it.leading });
  }
  refreshButtons();
  layoutTextBar();
  schedule();
}

/** Changes the picked item, as one step to undo. */
function changePicked(fn: (it: Item) => Item) {
  const it = pickedItem();
  if (!it || picked === null) return false;
  const next = items.slice();
  next[picked] = fn(it);
  commit(next);
  return true;
}

/** A text label with its box measured again (after its words, size or style changed). */
const remeasure = (it: Item): Item => (it.kind === "text" ? { ...it, ...measure(it) } : it);

addEventListener("pointerdown", (e) => {
  if (onUi(e) || e.button !== 0 || through || phase === "done" || phase === "countdown" || phase === "recording") return;
  pointer = at(e);
  if (selecting()) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    startSelect(pointer);
    return;
  }
  if (!canDraw()) return;
  if (tool === "spot" || tool === "laser") return;
  // The picked item: drag it to move it, or a corner to resize it.
  const pb = pickedBox();
  if (pb && tool !== "eraser" && editing === null) {
    const b = pad(pb);
    const cs = corners(b);
    const p = pointer;
    const corner = cs.findIndex((c) => Math.abs(c[0] - p[0]) <= 9 && Math.abs(c[1] - p[1]) <= 9);
    if (corner >= 0 || (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h)) {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      itemDrag = { before: items, start: p, orig: pickedItem()!, anchor: corner >= 0 ? cs[(corner + 2) % 4] : null, moved: false };
      return;
    }
  }
  if (tool === "text") {
    e.preventDefault();
    if (textBox.classList.contains("on")) return finishText();
    // On a placed item: pick it (double-click a label to change its words); elsewhere: a new label.
    const hit = topAt(items, pointer);
    if (hit !== null) return pick(hit);
    pick(null);
    return startText(pointer);
  }
  pick(null);
  pressAt = pointer;
  (e.target as Element).setPointerCapture?.(e.pointerId);
  if (tool === "eraser") {
    erasing = { before: items };
    eraseAt(pointer);
  } else if (tool === "pen" || tool === "hl") {
    drawing = { kind: tool, color: color(), size: size(), pts: [pointer] };
  } else {
    drawing = { kind: tool, color: color(), size: size(), a: pointer, b: pointer };
  }
  schedule();
});

addEventListener("pointermove", (e) => {
  if (through) return;
  if (selDrag) return moveSelect(at(e));
  if (selecting()) {
    const p = at(e);
    pointer = p;
    if (phase === "select" && !onUi(e)) hoverAt(p);
    selectCursor(p);
    return;
  }
  if (itemDrag && picked !== null) {
    const p = at(e);
    const d = itemDrag;
    if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < 3) return;
    d.moved = true;
    let next: Item;
    if (!d.anchor) next = translate(d.orig, p[0] - d.start[0], p[1] - d.start[1]);
    else {
      // From the opposite corner: as far as the pointer is now, over as far as it began.
      const k = Math.hypot(p[0] - d.anchor[0], p[1] - d.anchor[1]) / Math.max(1, Math.hypot(d.start[0] - d.anchor[0], d.start[1] - d.anchor[1]));
      next = scaleAbout(d.orig, d.anchor, Math.max(0.05, k), measure);
    }
    items = d.before.slice();
    items[picked] = next;
    render();
    schedule();
    return;
  }
  const events = e.getCoalescedEvents?.() ?? [e];
  for (const ev of events.length ? events : [e]) {
    const p = at(ev);
    pointer = p;
    if (drawing && (drawing.kind === "pen" || drawing.kind === "hl")) {
      const last = drawing.pts[drawing.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.5) drawing.pts.push(p);
    } else if (drawing && "a" in drawing) {
      drawing.b = constrain(drawing.kind, drawing.a, p);
    } else if (erasing) {
      eraseAt(p);
    }
    if (tool === "laser" && canDraw()) trail.push({ p, t: performance.now() });
  }
  moveSpot();
  schedule();
});

addEventListener("pointerup", (e) => {
  if (selDrag) return endSelect(at(e));
  if (itemDrag) {
    const d = itemDrag;
    itemDrag = null;
    if (d.moved) commit(items, d.before);
    return schedule();
  }
  if (drawing) {
    const d = drawing;
    drawing = null;
    const start = pressAt;
    pressAt = null;
    const p = at(e);
    const near = (q: Pt) => !!start && Math.hypot(q[0] - start[0], q[1] - start[1]) < 3;
    const still = near(p) && ("pts" in d ? d.pts.every(near) : true);
    // A click on a placed item picks it instead of drawing a dot.
    const hit = still && start ? topAt(items, start) : null;
    if (hit !== null) pick(hit);
    // A click with a shape tool draws nothing.
    else if (!("a" in d) || Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) > 3) commit([...items, d]);
  }
  if (erasing) {
    if (erasing.before !== items) commit(items, erasing.before);
    erasing = null;
  }
  schedule();
});
// The pointer left the window (to another screen's edge, or the taskbar).
addEventListener("pointerout", (e) => {
  if (e.relatedTarget) return;
  pointer = null;
  schedule();
});
// Double-click a placed label to change its words.
addEventListener("dblclick", (e) => {
  if (onUi(e) || !canDraw()) return;
  const hit = topAt(items, at(e));
  if (hit !== null && items[hit].kind === "text") editText(hit);
});

// ---- the zoom shortcut: Ctrl + wheel (or a touchpad pinch, or Ctrl + / Ctrl -) ------------------

const sizeBubble = $("sizebubble");
let bubbleTimer = 0;
let zoomBefore: Item[] | null = null;
let zoomTimer = 0;
function showSize(text: string, p: Pt | null) {
  sizeBubble.textContent = text;
  sizeBubble.hidden = false;
  const [x, y] = p ?? [innerWidth / 2, innerHeight / 2];
  sizeBubble.style.left = `${Math.min(innerWidth - 90, x + 18)}px`;
  sizeBubble.style.top = `${Math.max(6, y - 36)}px`;
  clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => (sizeBubble.hidden = true), 800);
}

/** Grows (k > 1) or shrinks the picked item, else the tool's size. */
function zoomBy(k: number, p: Pt | null) {
  if (!canDraw()) return;
  const it = pickedItem();
  if (it?.kind === "text" && editing !== null) {
    // The words being typed: their size.
    const next = clampSize("text", it.size * k);
    items[editing] = { ...it, size: next };
    textBox.style.fontSize = `${next}px`;
    growText();
    return showSize(`${Math.round(next)} px`, p);
  }
  if (it && picked !== null && editing === null) {
    // One step to undo for the whole gesture.
    zoomBefore ??= items;
    items = items.slice();
    items[picked] = resizeBy(it, k, measure);
    render();
    schedule();
    showSize(`${Math.round(items[picked].size)} px`, p);
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(() => {
      if (zoomBefore) commit(items, zoomBefore);
      zoomBefore = null;
    }, 450);
    return;
  }
  toolSize[tool] = clampSize(tool, toolSize[tool] * k);
  if (textBox.classList.contains("on")) {
    textBox.style.fontSize = `${size("text")}px`;
    growText();
  }
  moveSpot();
  schedule();
  refreshButtons();
  showSize(`${Math.round(toolSize[tool])} px`, p);
}

addEventListener(
  "wheel",
  (e) => {
    // Plain scrolling does nothing here; with Ctrl or ⌘ (a touchpad pinch sends Ctrl) it sizes.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002));
    zoomBy(Math.max(0.5, Math.min(2, k)), [e.clientX, e.clientY]);
  },
  { passive: false },
);

// ---- text -------------------------------------------------------------------------------------

let textAt: Pt = [0, 0];
/** The text box takes a label's look, so typing shows what will be drawn. */
function styleTextBox(t: { size: number; color: string } & TextStyle) {
  const oc = outlineColor(t);
  const ow = outlineWidth(t) / 2;
  Object.assign(textBox.style, {
    fontSize: `${t.size}px`,
    color: t.color,
    fontFamily: `${t.font}, system-ui, sans-serif`,
    fontWeight: t.font === "Nunito" ? "800" : "600",
    letterSpacing: `${t.spacing}px`,
    lineHeight: String(t.leading),
    textShadow: ow ? `${ow}px 0 ${oc}, -${ow}px 0 ${oc}, 0 ${ow}px ${oc}, 0 -${ow}px ${oc}, ${ow}px ${ow}px ${oc}, -${ow}px -${ow}px ${oc}` : "none",
  });
  growText();
}
function startText(p: Pt) {
  textAt = p;
  editing = null;
  Object.assign(textBox.style, { left: `${p[0]}px`, top: `${p[1]}px` });
  textBox.value = "";
  textBox.classList.add("on");
  styleTextBox({ size: size("text"), color: color(), ...textStyle });
  layoutTextBar();
  setTimeout(() => textBox.focus(), 0);
}
/** Opens a placed label's words again. */
function editText(i: number) {
  const it = items[i];
  if (it?.kind !== "text") return;
  finishText();
  pick(i);
  editing = i;
  textAt = it.at;
  const ow = outlineWidth(it) / 2;
  Object.assign(textBox.style, { left: `${it.at[0] + ow}px`, top: `${it.at[1] + ow}px` });
  textBox.value = it.text;
  textBox.classList.add("on");
  styleTextBox(it);
  render();
  schedule();
  setTimeout(() => {
    textBox.focus();
    textBox.select();
  }, 0);
}
function growText() {
  textBox.style.width = "0px";
  textBox.style.height = "0px";
  textBox.style.width = `${Math.max(40, textBox.scrollWidth + 4)}px`;
  textBox.style.height = `${textBox.scrollHeight}px`;
}
textBox.addEventListener("input", growText);
function finishText() {
  if (!textBox.classList.contains("on")) return;
  const text = textBox.value.replace(/\s+$/, "");
  textBox.classList.remove("on");
  textBox.blur();
  const i = editing;
  editing = null;
  if (i !== null) {
    // A placed label: its new words (or gone, when they were all taken out).
    const it = items[i];
    if (it?.kind !== "text") return render();
    if (!text.trim()) {
      pick(null);
      return commit(items.filter((_, j) => j !== i));
    }
    const next = items.slice();
    next[i] = remeasure({ ...it, text });
    commit(next);
    return pick(i);
  }
  render();
  if (!text.trim()) return layoutTextBar();
  const t: TextItem = { kind: "text", color: color(), size: size("text"), at: textAt, text, w: 0, h: 0, ...textStyle };
  commit([...items, remeasure(t)]);
  layoutTextBar();
}
textBox.addEventListener("blur", () => finishText());

// ---- the text style bar: font, outline, letter and line spacing ---------------------------------

const textBar = $("textbar");
// Clicking the bars keeps the words being typed open (the text box keeps its focus).
for (const el of [textBar, bar]) el.addEventListener("mousedown", (e) => textBox.classList.contains("on") && e.preventDefault());
function setTextStyle(patch: Partial<TextStyle>) {
  Object.assign(textStyle, patch);
  const it = pickedItem();
  if (textBox.classList.contains("on")) {
    styleTextBox({ size: it && editing !== null ? it.size : size("text"), color: it && editing !== null ? it.color : color(), ...textStyle });
    if (it?.kind === "text" && editing !== null) {
      // Changed while its words are open: kept with the words when they're done.
      items = items.slice();
      items[editing] = remeasure({ ...it, ...patch });
    }
  } else if (it?.kind === "text") changePicked((x) => remeasure({ ...x, ...patch }));
  sfx.tap();
  layoutTextBar();
  // Keys go back to the words being typed.
  if (textBox.classList.contains("on")) setTimeout(() => textBox.focus(), 0);
}

/** Shown under the toolbar while the Text tool is on or a label is picked. */
function layoutTextBar() {
  const show = canDraw() && !through && (tool === "text" || pickedItem()?.kind === "text");
  textBar.hidden = !show;
  if (!show) return;
  textBar.replaceChildren();
  const label = (t: string) => textBar.append(Object.assign(document.createElement("span"), { className: "muted", textContent: t }));
  const choice = (text: string, title: string, on: boolean, run: () => void) => {
    const b = button(textBar, "", title, run, `wide${on ? " on" : ""}`, text);
    b.setAttribute("aria-pressed", String(on));
  };
  label("Font");
  choice("Fredoka", "Rounded letters", textStyle.font === "Fredoka", () => setTextStyle({ font: "Fredoka" }));
  choice("Nunito", "Plain letters", textStyle.font === "Nunito", () => setTextStyle({ font: "Nunito" }));
  label("Outline");
  ([[0, "None"], [1, "Thin"], [2, "Thick"]] as const).forEach(([o, name]) => choice(name, `${name} outline`, textStyle.outline === o, () => setTextStyle({ outline: o })));
  if (textStyle.outline) {
    const next = { auto: "ink", ink: "white", white: "auto" } as const;
    const names = { auto: "Auto colour", ink: "Ink", white: "White" };
    choice(names[textStyle.outlineColor], "The outline's colour (auto picks ink or white to stand out from the text)", false, () => setTextStyle({ outlineColor: next[textStyle.outlineColor] }));
  }
  const stepper = (name: string, value: string, minus: () => void, plus: () => void) => {
    label(name);
    button(textBar, "", `Less ${name.toLowerCase()} spacing`, minus, "wide step", "−");
    textBar.append(Object.assign(document.createElement("span"), { className: "value", textContent: value }));
    button(textBar, "", `More ${name.toLowerCase()} spacing`, plus, "wide step", "+");
  };
  const sp = (v: number) => Math.max(-4, Math.min(40, Math.round(v * 10) / 10));
  stepper("Letters", `${textStyle.spacing}`, () => setTextStyle({ spacing: sp(textStyle.spacing - 1) }), () => setTextStyle({ spacing: sp(textStyle.spacing + 1) }));
  const ld = (v: number) => Math.max(0.8, Math.min(3, Math.round(v * 10) / 10));
  stepper("Lines", `${textStyle.leading.toFixed(1)}×`, () => setTextStyle({ leading: ld(textStyle.leading - 0.1) }), () => setTextStyle({ leading: ld(textStyle.leading + 0.1) }));
  const b = bar.getBoundingClientRect();
  placeNear(textBar, b.left, b.bottom + 10);
}

// ---- buttons ----------------------------------------------------------------------------------

const ICONS: Record<string, string> = {
  grip: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  pen: '<path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20z"/><path d="M14 7l3 3"/>',
  hl: '<path d="M8 14l-3 3v3h3l3-3"/><path d="M8 14l7.5-9.5 4.5 4.5L11 17z"/><path d="M13 21h7"/>',
  eraser: '<path d="M8 20h12"/><path d="M4.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8.5z"/><path d="M9 11l5 5"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>',
  text: '<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  spot: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  laser: '<path d="M4 20l7.5-7.5"/><circle cx="15.5" cy="8.5" r="3.2"/><path d="M15.5 2.5v1.3M21.5 8.5h-1.3M19.7 4.3l-.9.9"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  clear: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  through: '<path d="M6 3l12 8.5-5.2 1.3 3 5.6-2.4 1.3-3-5.6L6.3 17.6z"/>',
  shot: '<path d="M4 8.5h3.2L9 6h6l1.8 2.5H20V19H4z"/><circle cx="12" cy="13.5" r="3.4"/>',
  record: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  full: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  again: '<path d="M4 4l16 16"/><rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  click: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="2.5 3"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function button(parent: HTMLElement, icon: string, title: string, run: () => void, cls = "", text = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = title;
  if (!text) b.setAttribute("aria-label", title.replace(/ \(.*\)$/, ""));
  b.innerHTML = icon;
  if (text) b.append(text);
  b.addEventListener("click", () => {
    run();
    // Keys go back to the page, not the button.
    b.blur();
  });
  parent.append(b);
  return b;
}
const sep = (parent: HTMLElement) => parent.append(Object.assign(document.createElement("span"), { className: "sep" }));

const TOOLS: [Tool, string, string][] = [
  ["pen", "Pen", "P"], ["hl", "Highlighter", "H"], ["eraser", "Eraser", "E"],
  ["rect", "Rectangle", "R"], ["ellipse", "Ellipse", "O"], ["line", "Line", "L"], ["arrow", "Arrow", "A"], ["text", "Text", "T"],
  ["spot", "Spotlight", "S"], ["laser", "Laser pointer", "X"],
];
const toolButtons = new Map<Tool, HTMLButtonElement>();
const modeButtons = new Map<Mode, HTMLButtonElement>();
const colorButtons: HTMLButtonElement[] = [];
const sizeButtons: HTMLButtonElement[] = [];
let undoBtn: HTMLButtonElement, redoBtn: HTMLButtonElement, clearBtn: HTMLButtonElement, throughBtn: HTMLButtonElement;
let toolsGroup: HTMLElement;

function buildBar() {
  const grip = button(bar, svg("grip"), "Drag to move the toolbar", () => {}, "grip");
  grip.addEventListener("pointerdown", startBarDrag);
  const modes = document.createElement("div");
  modes.className = "modes";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Mode");
  bar.append(modes);
  const MODE_INFO: [Mode, string, string, boolean, string][] = [
    ["shot", "shot", "Screenshot", info.canCapture, `Screenshots aren't available on ${SYSTEM} yet`],
    ["draw", "pen", "Draw", true, ""],
    ["record", "record", "Record", info.canRecord, `Recording the screen isn't available on ${SYSTEM} yet`],
  ];
  for (const [m, icon, name, ok, why] of MODE_INFO) {
    const b = button(modes, svg(icon), ok ? name : why, () => void setMode(m), "", name);
    b.disabled = !ok;
    modeButtons.set(m, b);
  }
  toolsGroup = document.createElement("div");
  toolsGroup.className = "tools";
  bar.append(toolsGroup);
  sep(toolsGroup);
  for (const [i, [t, name, key]] of TOOLS.entries()) {
    if (i === 3 || i === 8) sep(toolsGroup);
    toolButtons.set(t, button(toolsGroup, svg(t), `${name} (${key})`, () => setTool(t)));
  }
  sep(toolsGroup);
  COLORS.forEach((_, i) => colorButtons.push(button(toolsGroup, "", COLOR_NAMES[i], () => setColor(i), "swatch")));
  sep(toolsGroup);
  [0, 1, 2].forEach((i) => {
    const b = button(toolsGroup, "", `${["Small", "Medium", "Large"][i]} (${i + 1})`, () => setSize(i), "size");
    // Sized through the style object: the page's CSP drops style attributes in markup.
    const dot = document.createElement("i");
    dot.style.width = dot.style.height = `${5 + i * 4}px`;
    b.append(dot);
    sizeButtons.push(b);
  });
  sep(toolsGroup);
  undoBtn = button(toolsGroup, svg("undo"), `Undo (${MOD}Z)`, undo);
  redoBtn = button(toolsGroup, svg("redo"), `Redo (${MOD}Y)`, redo);
  clearBtn = button(toolsGroup, svg("clear"), "Clear the drawing (Delete)", clear);
  throughBtn = button(toolsGroup, svg("through"), "Click-through: keep the drawing and use the apps underneath", () => setThrough(!through));
  sep(bar);
  button(bar, svg("close"), "Leave (Esc)", leave, "close");
  refreshButtons();
}

function refreshButtons() {
  if (!undoBtn) return;
  for (const [m, b] of modeButtons) {
    b.classList.toggle("on", m === mode);
    b.setAttribute("aria-pressed", String(m === mode));
  }
  toolsGroup.hidden = !canDraw();
  throughBtn.hidden = mode !== "draw";
  for (const [t, b] of toolButtons) {
    b.classList.toggle("on", t === tool);
    b.setAttribute("aria-pressed", String(t === tool));
    // The spotlight and laser are for presenting the live screen.
    b.hidden = mode === "shot" && (t === "spot" || t === "laser");
  }
  colorButtons.forEach((b, i) => {
    const c = COLORS[i] === "accent" ? accent() : COLORS[i];
    b.style.setProperty("--c", c);
    b.style.background = c;
    b.classList.toggle("on", i === colorIndex);
    b.setAttribute("aria-pressed", String(i === colorIndex));
    // The laser has its own red, and the spotlight and eraser no colour (a picked item has one).
    b.disabled = !pickedItem() && (tool === "spot" || tool === "laser" || tool === "eraser");
  });
  const it = pickedItem();
  const sizeOf = it ? it.size : toolSize[tool];
  const presets = SIZES[it ? it.kind : tool];
  sizeButtons.forEach((b, i) => {
    const on = Math.abs(sizeOf - presets[i]) < 0.05;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  undoBtn.disabled = !undoStack.length;
  redoBtn.disabled = !redoStack.length;
  clearBtn.disabled = !items.length;
  throughBtn.classList.toggle("on", through);
  throughBtn.setAttribute("aria-pressed", String(through));
}

/** The body's classes for the cursor and the spotlight follow the tool, while drawing. */
function toolClasses() {
  const on = canDraw() && !through;
  for (const t of ["spot", "laser", "eraser", "text"] as const) document.body.classList.toggle(t, on && tool === t);
}

function setTool(t: Tool) {
  finishText();
  pick(null);
  if (through && (t === "spot" || t === "laser")) setThrough(false);
  tool = t;
  trail.length = 0;
  toolClasses();
  moveSpot();
  schedule();
  sfx.tap();
  refreshButtons();
  layoutTextBar();
}
function setColor(i: number) {
  colorIndex = i;
  if (textBox.classList.contains("on")) textBox.style.color = color();
  if (editing === null) changePicked((it) => ({ ...it, color: color() }));
  else items[editing] = { ...items[editing], color: color() };
  refreshButtons();
}
function setSize(i: number) {
  const it = pickedItem();
  if (it && editing === null) {
    // The picked item takes its kind's preset (text: its height; the rest: their line).
    changePicked((x) => remeasure({ ...x, size: SIZES[x.kind][i] }));
  } else if (it && editing !== null) {
    items[editing] = { ...it, size: SIZES.text[i] };
    textBox.style.fontSize = `${SIZES.text[i]}px`;
    growText();
  } else {
    toolSize[tool] = SIZES[tool][i];
    if (textBox.classList.contains("on")) {
      textBox.style.fontSize = `${size("text")}px`;
      growText();
    }
  }
  moveSpot();
  schedule();
  refreshButtons();
}

/** Click-through (Draw): the drawing stays, the pointer reaches the apps underneath except over
 *  the toolbar (Rust watches it, since this page doesn't hear the pointer then). */
function setThrough(on: boolean) {
  finishText();
  through = on;
  if (on && (tool === "spot" || tool === "laser")) setTool("pen");
  document.body.classList.toggle("through", on);
  toolClasses();
  drawing = null;
  pointer = null;
  schedule();
  catchOnly(on ? bar : null);
  toast(on ? "Click-through on: use your apps, the drawing stays" : "Drawing again");
  refreshButtons();
}

/** Lets the pointer through everywhere except over `el` (null: catches it everywhere again). */
function catchOnly(el: HTMLElement | null) {
  if (el) reportRect(el);
  void invoke("draw_passthrough", { on: !!el });
}
function reportRect(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const s = physScale();
  void invoke("draw_toolbar", { rect: [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * s)) }).catch(() => {});
}

// ---- modes ------------------------------------------------------------------------------------

/** The frozen screen shown under Screenshot (taken before this window was on screen, or again
 *  with it stepped aside). */
let frozenFresh = false;
async function loadFrozen() {
  const g = info.geometry;
  if (!g) return false;
  const buf = await invoke<ArrayBuffer>("draw_frozen").catch(() => null);
  if (!buf || buf.byteLength !== g.width * g.height * 4) return false;
  frozen.width = g.width;
  frozen.height = g.height;
  frozen.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(buf), g.width, g.height), 0, 0);
  return true;
}

function loadWindows() {
  windowsCss = (info.geometry?.windows ?? []).map(toCss);
}

async function setMode(m: Mode) {
  if (phase === "countdown" || phase === "recording" || phase === "done") return;
  if (m === mode && !(m === "shot" && annotate)) return;
  finishText();
  if (through) setThrough(false);
  sel = null;
  hover = null;
  annotate = false;
  phase = "select";
  if (m === "shot" && !frozenFresh) {
    // The screen as it is now, without this window (the drawing stays, on top).
    const ok = await invoke("draw_refreeze").then(() => loadFrozen()).catch(() => false);
    if (!ok) return toast("Couldn't take a picture of the screen");
    frozenFresh = true;
  }
  if (m !== "shot") frozenFresh = false;
  if (m !== "draw" && info.geometry) info.geometry.windows = await invoke<number[][]>("draw_windows").catch(() => []);
  loadWindows();
  mode = m;
  document.body.classList.toggle("frozen", m === "shot");
  sfx.tap();
  layout();
}

/** Puts every bar where it belongs for the mode and phase. */
function layout() {
  toolClasses();
  refreshButtons();
  layoutTextBar();
  renderVeil();
  schedule();
  const ui = phase !== "done" && phase !== "countdown" && phase !== "recording";
  bar.hidden = !ui;
  // Screenshot and Record, nothing chosen yet: how to choose.
  hintEl.hidden = !(ui && selecting() && phase === "select");
  if (!hintEl.hidden) {
    hintEl.replaceChildren();
    const words = document.createElement("span");
    words.textContent = mode === "shot" ? "Drag to choose an area, or click a window" : "Drag to choose what to record, or click a window";
    hintEl.append(words);
    button(hintEl, svg("full"), "The whole screen", () => {
      sel = pointer ? screenAt(pointer) : startScreen();
      phase = "chosen";
      layout();
    }, "wide", "Full screen");
    const esc = document.createElement("span");
    esc.className = "muted";
    esc.textContent = "Esc leaves";
    hintEl.append(esc);
    const b = bar.getBoundingClientRect();
    placeNear(hintEl, b.left + b.width / 2 - hintEl.offsetWidth / 2, b.bottom + 10);
  }
  // Something chosen: what to do with it.
  act.hidden = !(ui && sel && phase === "chosen" && mode !== "draw");
  if (!act.hidden) buildAct();
}

function placeNear(el: HTMLElement, x: number, y: number) {
  el.style.left = `${Math.max(6, Math.min(innerWidth - el.offsetWidth - 10, x))}px`;
  el.style.top = `${Math.max(6, Math.min(innerHeight - el.offsetHeight - 10, y))}px`;
}

/** Beside the chosen area: below it, else above it, else inside its bottom. */
function placeBy(el: HTMLElement, b: Box) {
  const h = el.offsetHeight;
  const below = b.y + b.h + 12;
  const above = b.y - h - 12;
  const y = below + h < innerHeight - 6 ? below : above > 6 ? above : b.y + b.h - h - 12;
  placeNear(el, b.x + b.w - el.offsetWidth, y);
}

let mic = false;
let clicks = false;
function buildAct() {
  act.replaceChildren();
  button(act, svg("again"), "Choose again (Esc)", () => {
    sel = null;
    annotate = false;
    phase = "select";
    layout();
  });
  if (mode === "shot") {
    button(act, svg("pen"), annotate ? "Back to adjusting the area" : "Draw on it before saving", () => {
      finishText();
      annotate = !annotate;
      layout();
    }, `wide${annotate ? " on" : ""}`, annotate ? "Done drawing" : "Draw on it");
    button(act, svg("check"), "Copy and save (Enter)", () => void capture(), "wide primary", "Copy & save");
  } else {
    button(act, svg("mic"), mic ? "The microphone is recorded too" : "Record the microphone too", () => {
      mic = !mic;
      buildAct();
    }, `wide${mic ? " on" : ""}`, mic ? "Mic on" : "Mic off");
    button(act, svg("click"), clicks ? "Clicks get a ring in the video" : "Show a ring where you click", () => {
      clicks = !clicks;
      buildAct();
    }, `wide${clicks ? " on" : ""}`, clicks ? "Clicks shown" : "Show clicks");
    button(act, svg("record"), "Start recording (Enter)", () => void startRecording(), "wide primary", "Record");
  }
  placeBy(act, sel!);
}

// ---- screenshot -------------------------------------------------------------------------------

async function capture() {
  if (!sel || mode !== "shot") return;
  finishText();
  const s = physScale();
  const r = {
    x: Math.max(0, Math.round(sel.x * s)),
    y: Math.max(0, Math.round(sel.y * s)),
    w: Math.min(frozen.width, Math.round(sel.w * s)),
    h: Math.min(frozen.height, Math.round(sel.h * s)),
  };
  if (r.w < 2 || r.h < 2) return;
  const out = document.createElement("canvas");
  out.width = r.w;
  out.height = r.h;
  const c = out.getContext("2d")!;
  c.drawImage(frozen, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const k = ink.width / innerWidth;
  c.drawImage(ink, sel.x * k, sel.y * k, sel.w * k, sel.h * k, 0, 0, r.w, r.h);
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
  if (!blob) return toast("Couldn't make the picture");
  try {
    const saved = await invoke<{ path: string; folder: string; copied: boolean }>("draw_save_png", new Uint8Array(await blob.arrayBuffer()), {
      headers: { "x-name": `Screenshot ${stamp()}` },
    });
    sfx.shutter();
    document.body.append(Object.assign(document.createElement("div"), { className: "flash", onanimationend: (ev: Event) => (ev.target as HTMLElement).remove() }));
    showDone({ kind: "shot", ...saved, thumb: URL.createObjectURL(blob) });
  } catch (err) {
    toast(String(err instanceof Error ? err.message : err), 4000);
  }
}

// ---- recording --------------------------------------------------------------------------------

let micStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let pending: Int16Array[] = [];
let pendingLen = 0;
let recStarted = 0;
let pausedFor = 0;
let pausedAt = 0;
let clock = 0;

function stopMic() {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  void audioCtx?.close().catch(() => {});
  audioCtx = null;
  pending = [];
  pendingLen = 0;
}

function flushAudio() {
  if (!pendingLen) return;
  const all = new Int16Array(pendingLen);
  let o = 0;
  for (const p of pending) {
    all.set(p, o);
    o += p.length;
  }
  pending = [];
  pendingLen = 0;
  void invoke("rec_audio", new Uint8Array(all.buffer)).catch(() => {});
}

/** The microphone's sound to Rust, as 16-bit mono PCM at 48 kHz, about five times a second. */
function pumpMic(stream: MediaStream) {
  audioCtx = new AudioContext({ sampleRate: 48_000 });
  const src = audioCtx.createMediaStreamSource(stream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    if (pausedAt) return;
    const f = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
    pending.push(pcm);
    pendingLen += pcm.length;
    if (pendingLen >= 9600) flushAudio();
  };
  src.connect(proc);
  proc.connect(audioCtx.destination);
}

async function startRecording() {
  if (!sel || mode !== "record" || phase !== "chosen") return;
  phase = "countdown";
  layout();
  if (mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
    } catch {
      mic = false;
      toast("Quicky couldn't use the microphone, so this recording has no sound", 4000);
    }
  }
  // 3, 2, 1 in the middle of the area.
  countEl.hidden = false;
  countEl.style.left = `${sel.x + sel.w / 2}px`;
  countEl.style.top = `${sel.y + sel.h / 2}px`;
  for (const n of [3, 2, 1]) {
    countEl.textContent = String(n);
    countEl.classList.remove("tick");
    void countEl.offsetWidth;
    countEl.classList.add("tick");
    sfx.countTick();
    await sleep(700);
  }
  countEl.hidden = true;
  sfx.screenRecStart();
  await sleep(300);
  const s = physScale();
  const rect = [sel.x, sel.y, sel.w, sel.h].map((v) => Math.round(v * s));
  try {
    await invoke("rec_start", { rect, mic: !!micStream, clicks, name: `Recording ${stamp()}` });
  } catch (err) {
    stopMic();
    phase = "chosen";
    layout();
    return toast(String(err instanceof Error ? err.message : err), 4000);
  }
  if (micStream) pumpMic(micStream);
  phase = "recording";
  recStarted = performance.now();
  pausedFor = 0;
  pausedAt = 0;
  buildRecbar();
  document.body.classList.add("through");
  catchOnly(recbar);
  clock = window.setInterval(tickClock, 250);
}

let timeEl: HTMLElement;
let pauseBtn: HTMLButtonElement;
function buildRecbar() {
  recbar.replaceChildren();
  recbar.classList.remove("paused");
  recbar.append(Object.assign(document.createElement("span"), { className: "dot" }));
  timeEl = Object.assign(document.createElement("span"), { className: "time", textContent: "0:00" });
  recbar.append(timeEl);
  pauseBtn = button(recbar, svg("pause"), "Pause", () => togglePause());
  button(recbar, svg("stop"), "Stop and save", () => void stopRecording(), "wide stop", "Stop");
  recbar.hidden = false;
  placeBy(recbar, { ...sel!, y: sel!.y - 3, h: sel!.h + 6 });
}

function tickClock() {
  const now = pausedAt || performance.now();
  const secs = Math.floor((now - recStarted - pausedFor) / 1000);
  timeEl.textContent = `${Math.floor(secs / 60)}:${two(secs % 60)}`;
}

function togglePause() {
  if (phase !== "recording") return;
  if (pausedAt) {
    pausedFor += performance.now() - pausedAt;
    pausedAt = 0;
  } else {
    flushAudio();
    pausedAt = performance.now();
  }
  void invoke("rec_pause", { paused: !!pausedAt });
  recbar.classList.toggle("paused", !!pausedAt);
  pauseBtn.innerHTML = svg(pausedAt ? "play" : "pause");
  pauseBtn.title = pausedAt ? "Resume" : "Pause";
  pauseBtn.setAttribute("aria-label", pauseBtn.title);
  sfx.tap();
}

let stopping = false;
async function stopRecording() {
  if (phase !== "recording" || stopping) return;
  stopping = true;
  clearInterval(clock);
  flushAudio();
  stopMic();
  recbar.hidden = true;
  try {
    const saved = await invoke<{ path: string; folder: string }>("rec_stop");
    sfx.screenRecStop();
    showDone({ kind: "video", ...saved, copied: false });
  } catch (err) {
    showDone({ kind: "error", path: "", folder: "", copied: false, error: String(err instanceof Error ? err.message : err) });
  } finally {
    stopping = false;
  }
}

// The shortcut pressed while recording: stop and save.
void getCurrentWindow().listen("draw-stop", () => {
  if (phase === "recording") void stopRecording();
  else leave();
});

// ---- after: what was saved --------------------------------------------------------------------

let doneTimer = 0;
function showDone(d: { kind: "shot" | "video" | "error"; path: string; folder: string; copied: boolean; thumb?: string; error?: string }) {
  phase = "done";
  finishText();
  for (const el of [frozen, ink, live, veil, spot]) el.style.display = "none";
  document.body.classList.remove("frozen");
  document.body.classList.add("through");
  layout();
  card.replaceChildren();
  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("b");
  title.textContent = d.kind === "error" ? "The recording couldn't be saved" : d.kind === "video" ? "Recording saved" : d.copied ? "Copied and saved" : "Saved";
  head.append(title);
  button(head, svg("close"), "Close", leave, "ib");
  card.append(head);
  if (d.kind === "shot" && d.thumb) card.append(Object.assign(document.createElement("img"), { src: d.thumb, alt: "The screenshot" }));
  if (d.kind === "video") card.append(Object.assign(document.createElement("div"), { className: "film", innerHTML: svg("film") }));
  const where = document.createElement("div");
  where.className = "where";
  where.textContent = d.kind === "error" ? (d.error ?? "") : `In ${d.folder}`;
  card.append(where);
  if (d.kind !== "error") {
    const row = document.createElement("div");
    row.className = "row";
    button(row, svg("open"), d.kind === "video" ? "Play it" : "Open it", () => void invoke("draw_open_file", { path: d.path }).then(leave).catch((e) => toast(String(e))), "wide", "Open");
    button(row, svg("folder"), "Show it in its folder", () => void invoke("draw_reveal", { path: d.path }).then(leave).catch((e) => toast(String(e))), "wide", "Open folder");
    if (d.kind === "video") {
      button(row, svg("copy"), "Copy where it's saved", () => {
        void navigator.clipboard.writeText(d.path).then(() => toast("Copied")).catch(() => toast("Couldn't copy"));
      }, "wide", "Copy path");
    }
    card.append(row);
  }
  card.hidden = false;
  const s = startScreen();
  card.style.left = `${s.x + s.w - card.offsetWidth - 24}px`;
  card.style.top = `${s.y + s.h - card.offsetHeight - 64}px`;
  catchOnly(card);
  // Goes away by itself, unless the pointer is on it.
  const later = (ms: number) => {
    clearTimeout(doneTimer);
    doneTimer = window.setTimeout(leave, ms);
  };
  later(d.kind === "error" ? 12000 : 7000);
  card.onpointerenter = () => clearTimeout(doneTimer);
  card.onpointerleave = () => later(3000);
}

// ---- moving the toolbar -----------------------------------------------------------------------

const BAR_KEY = "quicky-draw-bar";
function placeBar(x: number, y: number) {
  // Its own size, not its box on screen (smaller while it pops in).
  x = Math.max(4, Math.min(innerWidth - bar.offsetWidth - 8, x));
  y = Math.max(4, Math.min(innerHeight - bar.offsetHeight - 8, y));
  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
  if (through) reportRect(bar);
}
function startBarDrag(e: PointerEvent) {
  const grip = e.currentTarget as HTMLElement;
  grip.setPointerCapture(e.pointerId);
  const r = bar.getBoundingClientRect();
  const off = [e.clientX - r.left, e.clientY - r.top];
  const move = (ev: PointerEvent) => {
    placeBar(ev.clientX - off[0], ev.clientY - off[1]);
    if (!hintEl.hidden) layout();
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    const b = bar.getBoundingClientRect();
    try {
      localStorage.setItem(BAR_KEY, JSON.stringify({ x: b.left, y: b.top, w: innerWidth, h: innerHeight }));
    } catch {}
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
}

// ---- keys -------------------------------------------------------------------------------------

const KEYS: Record<string, Tool> = { p: "pen", h: "hl", e: "eraser", r: "rect", o: "ellipse", a: "arrow", l: "line", t: "text", s: "spot", x: "laser" };
addEventListener("keydown", (e) => {
  shift = e.shiftKey;
  // The zoom shortcut from the keyboard (typing a label too: it sizes the words).
  if ((OS === "mac" ? e.metaKey : e.ctrlKey) && ["=", "+", "-", "_"].includes(e.key) && canDraw()) {
    e.preventDefault();
    return zoomBy(e.key === "-" || e.key === "_" ? 1 / 1.15 : 1.15, pointer);
  }
  if (document.activeElement === textBox) {
    if (e.key === "Escape") {
      textBox.value = "";
      finishText();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      finishText();
    }
    return;
  }
  if (phase === "countdown" || phase === "recording") return;
  if (phase === "done") {
    if (e.key === "Escape") leave();
    return;
  }
  const mod = OS === "mac" ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  if (e.key === "Escape") {
    // One step back at a time: the picked item, drawing on the area, the chosen area, then leaving.
    if (pickedItem()) return pick(null);
    if (mode === "shot" && annotate) {
      annotate = false;
      return layout();
    }
    if (sel && mode !== "draw") {
      sel = null;
      phase = "select";
      return layout();
    }
    return leave();
  }
  if (e.key === "Enter" && sel && mode !== "draw") {
    e.preventDefault();
    return void (mode === "shot" ? capture() : startRecording());
  }
  if (!canDraw()) return;
  // Tab and Shift+Tab go through the placed items (the toolbar's own buttons keep Tab).
  if (e.key === "Tab" && items.length && !bar.contains(document.activeElement) && !textBar.contains(document.activeElement)) {
    e.preventDefault();
    const n = items.length;
    const cur = pickedItem() ? picked! : e.shiftKey ? 0 : -1;
    return pick((cur + (e.shiftKey ? -1 : 1) + n) % n);
  }
  if (mod && k === "z") {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (mod && k === "y") {
    e.preventDefault();
    return redo();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === "Delete" || e.key === "Backspace") && pickedItem()) {
    // Just the picked item.
    const i = picked!;
    pick(null);
    commit(items.filter((_, j) => j !== i));
    return sfx.delete();
  }
  if (e.key === "Delete") return clear();
  if (e.key === "Enter" && pickedItem()?.kind === "text") {
    e.preventDefault();
    return editText(picked!);
  }
  if (KEYS[k] && !(mode === "shot" && (KEYS[k] === "spot" || KEYS[k] === "laser"))) return setTool(KEYS[k]);
  if (["1", "2", "3"].includes(e.key)) setSize(Number(e.key) - 1);
});
addEventListener("keyup", (e) => (shift = e.shiftKey));

// ---- toast, leaving ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(text: string, ms = 2400) {
  toastEl.textContent = text;
  const r = (!bar.hidden ? bar : !recbar.hidden ? recbar : card).getBoundingClientRect();
  toastEl.style.left = `${Math.max(6, r.left)}px`;
  toastEl.style.top = r.bottom + 54 < innerHeight ? `${r.bottom + 10}px` : `${Math.max(6, r.top - 44)}px`;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("on"), ms);
}

function leave() {
  if (phase === "recording") return void stopRecording();
  void invoke("draw_close");
}

// ---- start ------------------------------------------------------------------------------------

addEventListener("resize", () => {
  fit();
  placeBar(parseFloat(bar.style.left) || 0, parseFloat(bar.style.top) || 0);
  layout();
});
// The web view's own menu has no place here.
addEventListener("contextmenu", (e) => e.preventDefault());
// A new accent from Settings repaints the swatch and the frame.
new MutationObserver(() => {
  refreshButtons();
  renderVeil();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-mode"] });

async function start() {
  info = (await invoke<Info>("draw_info").catch(() => null)) ?? info;
  mode = info.geometry?.mode ?? "draw";
  fit();
  buildBar();
  if (mode === "shot") {
    frozenFresh = await loadFrozen();
    if (!frozenFresh) mode = "draw";
  }
  document.body.classList.toggle("frozen", mode === "shot");
  loadWindows();
  // Where the toolbar was last time (on the same screens), else the top middle of the screen the
  // pointer is on.
  let saved: { x: number; y: number; w: number; h: number } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(BAR_KEY) ?? "null");
  } catch {}
  if (saved && saved.w === innerWidth && saved.h === innerHeight) placeBar(saved.x, saved.y);
  else {
    const s = startScreen();
    placeBar(s.x + (s.w - bar.offsetWidth) / 2, s.y + 18);
  }
  layout();
  await Promise.race([document.fonts.ready, sleep(400)]);
  // Shown once painted (a hidden page gets its frames late: a short timeout stands in).
  await new Promise<void>((painted) => {
    requestAnimationFrame(() => requestAnimationFrame(() => painted()));
    setTimeout(painted, 150);
  });
  await invoke("draw_ready");
  sfx.open();
  if (mode === "draw") toast("Draw anywhere. Esc leaves", 2600);
}
void start();

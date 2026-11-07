// Draw on screen (`draw.rs`): a see-through window over every screen with a floating toolbar.
// Pen, highlighter and eraser; rectangles, ellipses, lines, arrows and text; a spotlight and a
// laser pointer for presenting; undo, redo, clear; a screenshot of the screen with the drawing on
// it; and click-through, to keep the drawing up while using the apps underneath. The drawing is
// a list of items (in CSS px) painted onto a canvas, so undo, the eraser and the screenshot are
// simple. Leaving (Esc, ✕, the shortcut) destroys the window, and the drawing with it.
import { invoke } from "@tauri-apps/api/core";
import { followTheme } from "./lib/theme-colors";
import { sfx } from "./lib/sfx";
import { OS } from "./lib/platform";

followTheme();

type Tool = "pen" | "hl" | "eraser" | "rect" | "ellipse" | "line" | "arrow" | "text" | "spot" | "laser";
type Pt = [number, number];
type Item =
  | { kind: "pen" | "hl"; color: string; size: number; pts: Pt[] }
  | { kind: "rect" | "ellipse" | "line" | "arrow"; color: string; size: number; a: Pt; b: Pt }
  | { kind: "text"; color: string; size: number; at: Pt; text: string; w: number; h: number };

/** Each tool's three sizes (stroke width; the eraser's radius; text height; the spotlight's radius). */
const SIZES: Record<Tool, [number, number, number]> = {
  pen: [3, 6, 12], hl: [14, 24, 38], eraser: [10, 22, 42], rect: [3, 5, 9], ellipse: [3, 5, 9], line: [3, 5, 9], arrow: [3, 5, 9],
  text: [20, 32, 52], spot: [100, 160, 240], laser: [4, 6, 9],
};
/** The colours: Quicky's accent first, then a few that show up on anything. */
const COLORS = ["accent", "#ff4757", "#ffc531", "#22c55e", "#3b82f6", "#2b2540", "#ffffff"];
const COLOR_NAMES = ["Quicky's colour", "Red", "Yellow", "Green", "Blue", "Ink", "White"];
const LASER = "#ff2d55";
const MOD = OS === "mac" ? "⌘" : "Ctrl+";

const ink = document.getElementById("ink") as HTMLCanvasElement;
const live = document.getElementById("live") as HTMLCanvasElement;
const spot = document.getElementById("spot")!;
const textBox = document.getElementById("text") as HTMLTextAreaElement;
const bar = document.getElementById("bar")!;
const toastEl = document.getElementById("toast")!;
const inkCtx = ink.getContext("2d")!;
const liveCtx = live.getContext("2d")!;

let tool: Tool = "pen";
let colorIndex = 0;
let sizeIndex = 1;
let items: Item[] = [];
const undoStack: Item[][] = [];
const redoStack: Item[][] = [];
let through = false;
let canCapture = false;

const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#6d4cff";
const color = () => (COLORS[colorIndex] === "accent" ? accent() : COLORS[colorIndex]);
const size = (t: Tool = tool) => SIZES[t][sizeIndex];

// ---- painting ---------------------------------------------------------------------------------

/** The canvases match the window's real pixels; items are kept in CSS px. */
function fit() {
  const dpr = devicePixelRatio || 1;
  for (const c of [ink, live]) {
    c.width = Math.round(innerWidth * dpr);
    c.height = Math.round(innerHeight * dpr);
  }
  for (const c of [inkCtx, liveCtx]) c.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

/** Light colours get a dark halo and dark ones a light halo, so text reads on any background. */
function halo(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#2b2540" : "#ffffff";
}

const font = (px: number) => `600 ${px}px Fredoka, Nunito, system-ui, sans-serif`;

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
    if (p.length === 1) {
      c.beginPath();
      c.arc(p[0][0], p[0][1], it.size / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      c.beginPath();
      c.moveTo(p[0][0], p[0][1]);
      // Smooth: curves through the middles of the points, each point a control.
      for (let i = 1; i < p.length - 1; i++) c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      c.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      c.stroke();
    }
  } else if (it.kind === "rect") {
    const [x, y, w, h] = box(it.a, it.b);
    c.beginPath();
    c.roundRect(x, y, w, h, Math.min(6, w / 2, h / 2));
    c.stroke();
  } else if (it.kind === "ellipse") {
    const [x, y, w, h] = box(it.a, it.b);
    c.beginPath();
    c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
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
    c.font = font(it.size);
    c.textBaseline = "top";
    c.lineWidth = Math.max(3, it.size / 6);
    c.strokeStyle = halo(it.color);
    it.text.split("\n").forEach((line, i) => {
      const y = it.at[1] + i * it.size * 1.2;
      c.strokeText(line, it.at[0], y);
      c.fillText(line, it.at[0], y);
    });
  }
  c.restore();
}

const box = (a: Pt, b: Pt): [number, number, number, number] => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];

function render() {
  inkCtx.save();
  inkCtx.setTransform(1, 0, 0, 1, 0, 0);
  inkCtx.clearRect(0, 0, ink.width, ink.height);
  inkCtx.restore();
  for (const it of items) paint(inkCtx, it);
  refreshButtons();
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
  redoStack.push(items);
  items = prev;
  sfx.undo();
  render();
}
function redo() {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(items);
  items = next;
  sfx.tap();
  render();
}
function clear() {
  if (!items.length) return;
  commit([]);
  sfx.delete();
}

// ---- the eraser: takes away whole items it touches ---------------------------------------------

function segDist([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt) {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function outline(it: Item): Pt[] {
  if (it.kind === "pen" || it.kind === "hl") return it.pts;
  if (it.kind === "line" || it.kind === "arrow") return [it.a, it.b];
  if (it.kind === "rect") {
    const [x, y, w, h] = box(it.a, it.b);
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  }
  if (it.kind === "ellipse") {
    const [x, y, w, h] = box(it.a, it.b);
    return Array.from({ length: 49 }, (_, i) => [x + w / 2 + (w / 2) * Math.cos((i / 48) * Math.PI * 2), y + h / 2 + (h / 2) * Math.sin((i / 48) * Math.PI * 2)] as Pt);
  }
  return [];
}
function hits(it: Item, p: Pt, r: number) {
  if (it.kind === "text") return p[0] >= it.at[0] - r && p[0] <= it.at[0] + it.w + r && p[1] >= it.at[1] - r && p[1] <= it.at[1] + it.h + r;
  const o = outline(it);
  const reach = r + it.size / 2;
  if (o.length === 1) return Math.hypot(p[0] - o[0][0], p[1] - o[0][1]) <= reach;
  for (let i = 1; i < o.length; i++) if (segDist(p, o[i - 1], o[i]) <= reach) return true;
  return false;
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

const at = (e: PointerEvent): Pt => [e.clientX, e.clientY];

function liveFrame() {
  frame = 0;
  liveCtx.save();
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveCtx.clearRect(0, 0, live.width, live.height);
  liveCtx.restore();
  if (drawing) paint(liveCtx, drawing);
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
  if (tool !== "spot" || !pointer) return;
  const r = size("spot");
  spot.style.background = `radial-gradient(circle ${r}px at ${pointer[0]}px ${pointer[1]}px, transparent 97%, rgba(16, 12, 30, 0.66) 100%)`;
}

const onBar = (e: Event) => bar.contains(e.target as Node) || e.target === textBox;

addEventListener("pointerdown", (e) => {
  if (onBar(e) || e.button !== 0 || through) return;
  pointer = at(e);
  if (tool === "text") {
    e.preventDefault();
    if (textBox.classList.contains("on")) return finishText();
    return startText(pointer);
  }
  if (tool === "spot" || tool === "laser") return;
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

function eraseAt(p: Pt) {
  const r = size("eraser");
  const left = items.filter((it) => !hits(it, p, r));
  if (left.length !== items.length) {
    items = left;
    render();
  }
}

addEventListener("pointermove", (e) => {
  if (through) return;
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
    if (tool === "laser") trail.push({ p, t: performance.now() });
  }
  moveSpot();
  schedule();
});

addEventListener("pointerup", () => {
  if (drawing) {
    const d = drawing;
    drawing = null;
    // A click with a shape tool draws nothing.
    if (!("a" in d) || Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) > 3) commit([...items, d]);
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

// ---- text -------------------------------------------------------------------------------------

let textAt: Pt = [0, 0];
function startText(p: Pt) {
  textAt = p;
  const px = size("text");
  const c = color();
  Object.assign(textBox.style, { left: `${p[0]}px`, top: `${p[1]}px`, fontSize: `${px}px`, color: c, textShadow: `0 0 3px ${halo(c)}` });
  textBox.value = "";
  textBox.classList.add("on");
  growText();
  setTimeout(() => textBox.focus(), 0);
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
  if (!text.trim()) return;
  const px = size("text");
  inkCtx.save();
  inkCtx.font = font(px);
  const lines = text.split("\n");
  const w = Math.max(...lines.map((l) => inkCtx.measureText(l).width));
  inkCtx.restore();
  commit([...items, { kind: "text", color: color(), size: px, at: textAt, text, w, h: lines.length * px * 1.2 }]);
}
textBox.addEventListener("blur", () => finishText());

// ---- toolbar ----------------------------------------------------------------------------------

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
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const TOOLS: [Tool, string, string][] = [
  ["pen", "Pen", "P"], ["hl", "Highlighter", "H"], ["eraser", "Eraser", "E"],
  ["rect", "Rectangle", "R"], ["ellipse", "Ellipse", "O"], ["line", "Line", "L"], ["arrow", "Arrow", "A"], ["text", "Text", "T"],
  ["spot", "Spotlight", "S"], ["laser", "Laser pointer", "X"],
];
const toolButtons = new Map<Tool, HTMLButtonElement>();
const colorButtons: HTMLButtonElement[] = [];
const sizeButtons: HTMLButtonElement[] = [];
let undoBtn: HTMLButtonElement, redoBtn: HTMLButtonElement, clearBtn: HTMLButtonElement, throughBtn: HTMLButtonElement, shotBtn: HTMLButtonElement;

function button(icon: string, title: string, run: () => void, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = title;
  b.setAttribute("aria-label", title.replace(/ \(.*\)$/, ""));
  b.innerHTML = icon;
  b.addEventListener("click", () => {
    run();
    // Keys go back to the drawing, not the button.
    b.blur();
  });
  bar.append(b);
  return b;
}
const sep = () => bar.append(Object.assign(document.createElement("span"), { className: "sep" }));

function buildBar() {
  const grip = button(svg("grip"), "Drag to move the toolbar", () => {}, "grip");
  grip.addEventListener("pointerdown", startBarDrag);
  for (const [i, [t, name, key]] of TOOLS.entries()) {
    if (i === 3 || i === 8) sep();
    toolButtons.set(t, button(svg(t), `${name} (${key})`, () => setTool(t)));
  }
  sep();
  COLORS.forEach((_, i) => {
    const b = button("", COLOR_NAMES[i], () => setColor(i), "swatch");
    colorButtons.push(b);
  });
  sep();
  [0, 1, 2].forEach((i) => {
    const b = button("", `${["Small", "Medium", "Large"][i]} (${i + 1})`, () => setSize(i), "size");
    // Sized through the style object: the page's CSP drops style attributes in markup.
    const dot = document.createElement("i");
    dot.style.width = dot.style.height = `${5 + i * 4}px`;
    b.append(dot);
    sizeButtons.push(b);
  });
  sep();
  undoBtn = button(svg("undo"), `Undo (${MOD}Z)`, undo);
  redoBtn = button(svg("redo"), `Redo (${MOD}Y)`, redo);
  clearBtn = button(svg("clear"), "Clear everything (Delete)", clear);
  sep();
  throughBtn = button(svg("through"), "Click-through: keep the drawing and use the apps underneath", () => setThrough(!through));
  shotBtn = button(svg("shot"), "Screenshot: copy and save the screen with the drawing", () => void screenshot());
  shotBtn.hidden = !canCapture;
  button(svg("close"), "Leave (Esc)", leave, "close");
  refreshButtons();
}

function refreshButtons() {
  if (!undoBtn) return;
  for (const [t, b] of toolButtons) {
    b.classList.toggle("on", t === tool);
    b.setAttribute("aria-pressed", String(t === tool));
  }
  colorButtons.forEach((b, i) => {
    const c = COLORS[i] === "accent" ? accent() : COLORS[i];
    b.style.setProperty("--c", c);
    b.style.background = c;
    b.classList.toggle("on", i === colorIndex);
    b.setAttribute("aria-pressed", String(i === colorIndex));
    // The laser has its own red, and the spotlight no colour.
    b.disabled = tool === "spot" || tool === "laser" || tool === "eraser";
  });
  sizeButtons.forEach((b, i) => {
    b.classList.toggle("on", i === sizeIndex);
    b.setAttribute("aria-pressed", String(i === sizeIndex));
  });
  undoBtn.disabled = !undoStack.length;
  redoBtn.disabled = !redoStack.length;
  clearBtn.disabled = !items.length;
  throughBtn.classList.toggle("on", through);
  throughBtn.setAttribute("aria-pressed", String(through));
}

function setTool(t: Tool) {
  finishText();
  if (through && (t === "spot" || t === "laser")) setThrough(false);
  tool = t;
  document.body.classList.toggle("spot", t === "spot");
  document.body.classList.toggle("laser", t === "laser");
  document.body.classList.toggle("eraser", t === "eraser");
  document.body.classList.toggle("text", t === "text");
  trail.length = 0;
  moveSpot();
  schedule();
  sfx.tap();
  refreshButtons();
}
function setColor(i: number) {
  colorIndex = i;
  if (textBox.classList.contains("on")) textBox.style.color = color();
  refreshButtons();
}
function setSize(i: number) {
  sizeIndex = i;
  if (textBox.classList.contains("on")) {
    textBox.style.fontSize = `${size("text")}px`;
    growText();
  }
  moveSpot();
  schedule();
  refreshButtons();
}

/** Click-through: the drawing stays, the pointer reaches the apps underneath except over the
 *  toolbar (Rust watches it, since this page doesn't hear the pointer then). */
function setThrough(on: boolean) {
  finishText();
  through = on;
  if (on && (tool === "spot" || tool === "laser")) setTool("pen");
  document.body.classList.toggle("through", on);
  drawing = null;
  pointer = null;
  schedule();
  reportBar();
  void invoke("draw_passthrough", { on });
  toast(on ? "Click-through on: use your apps, the drawing stays" : "Drawing again");
  refreshButtons();
}

// ---- moving the toolbar -----------------------------------------------------------------------

const BAR_KEY = "quicky-draw-bar";
function placeBar(x: number, y: number) {
  // Its own size, not its box on screen (smaller while it pops in).
  x = Math.max(4, Math.min(innerWidth - bar.offsetWidth - 8, x));
  y = Math.max(4, Math.min(innerHeight - bar.offsetHeight - 8, y));
  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
  reportBar();
}
function reportBar() {
  const r = bar.getBoundingClientRect();
  const d = devicePixelRatio || 1;
  void invoke("draw_toolbar", { rect: [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * d)) }).catch(() => {});
}
function startBarDrag(e: PointerEvent) {
  const grip = e.currentTarget as HTMLElement;
  grip.setPointerCapture(e.pointerId);
  const r = bar.getBoundingClientRect();
  const off = [e.clientX - r.left, e.clientY - r.top];
  const move = (ev: PointerEvent) => placeBar(ev.clientX - off[0], ev.clientY - off[1]);
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
  const mod = OS === "mac" ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  if (e.key === "Escape") return leave();
  if (mod && k === "z") {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (mod && k === "y") {
    e.preventDefault();
    return redo();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Delete") return clear();
  if (KEYS[k]) return setTool(KEYS[k]);
  if (["1", "2", "3"].includes(e.key)) setSize(Number(e.key) - 1);
});
addEventListener("keyup", (e) => (shift = e.shiftKey));

// ---- screenshot, toast, leaving ---------------------------------------------------------------

let toastTimer = 0;
function toast(text: string, ms = 2400) {
  toastEl.textContent = text;
  const r = bar.getBoundingClientRect();
  toastEl.style.left = `${r.left}px`;
  toastEl.style.top = r.bottom + 54 < innerHeight ? `${r.bottom + 10}px` : `${r.top - 44}px`;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("on"), ms);
}

const two = (n: number) => String(n).padStart(2, "0");
async function screenshot() {
  if (shotBtn.disabled) return;
  finishText();
  shotBtn.disabled = true;
  toastEl.classList.remove("on");
  try {
    const blob = await new Promise<Blob | null>((res) => ink.toBlob(res, "image/png"));
    if (!blob) throw new Error("Couldn't read the drawing");
    const d = new Date();
    const name = `Drawing ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} at ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
    const r = await invoke<{ path: string; copied: boolean }>("draw_capture", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-name": name } });
    sfx.pop();
    document.body.append(Object.assign(document.createElement("div"), { className: "flash", onanimationend: (ev: Event) => (ev.target as HTMLElement).remove() }));
    toast(r.copied ? "Copied, and saved to Pictures › Quicky" : "Saved to Pictures › Quicky", 3200);
  } catch (err) {
    toast(String(err instanceof Error ? err.message : err), 3600);
  } finally {
    shotBtn.disabled = false;
  }
}

function leave() {
  void invoke("draw_close");
}

// ---- start ------------------------------------------------------------------------------------

addEventListener("resize", () => {
  fit();
  const r = bar.getBoundingClientRect();
  placeBar(r.left, r.top);
});
// The web view's own menu has no place here.
addEventListener("contextmenu", (e) => e.preventDefault());
// A new accent from Settings repaints the swatch.
new MutationObserver(refreshButtons).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-mode"] });

async function start() {
  const info = await invoke<{ geometry: { screen: [number, number, number, number] } | null; canCapture: boolean }>("draw_info").catch(() => null);
  canCapture = !!info?.canCapture;
  fit();
  buildBar();
  // Where the toolbar was last time (on the same screens), else the top middle of the screen the
  // pointer is on.
  let spotSaved: { x: number; y: number; w: number; h: number } | null = null;
  try {
    spotSaved = JSON.parse(localStorage.getItem(BAR_KEY) ?? "null");
  } catch {}
  const d = devicePixelRatio || 1;
  const width = bar.offsetWidth;
  bar.addEventListener("animationend", reportBar);
  if (spotSaved && spotSaved.w === innerWidth && spotSaved.h === innerHeight) placeBar(spotSaved.x, spotSaved.y);
  else if (info?.geometry) {
    const [sx, sy, sw] = info.geometry.screen.map((v) => v / d);
    placeBar(sx + (sw - width) / 2, sy + 18);
  } else placeBar((innerWidth - width) / 2, 18);
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 400))]);
  // Shown once painted (a hidden page gets its frames late: a short timeout stands in).
  await new Promise<void>((painted) => {
    requestAnimationFrame(() => requestAnimationFrame(() => painted()));
    setTimeout(painted, 150);
  });
  await invoke("draw_ready");
  sfx.open();
  toast("Draw anywhere. Esc leaves", 2600);
}
void start();

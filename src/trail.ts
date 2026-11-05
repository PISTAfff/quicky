// The sticky trail: while the bubble (or an app's mini) is dragged, snot stretches from where it
// started (a sticky puddle left behind) to it: a lumpy main strand, a thinner string sagging
// below, drips hanging off them, splats around the puddle, all squelching as it moves.
// - merge: a left drag (or a mini's drag) let go: the puddle slurps along the strand into it.
// - back: a right drag let go anywhere but an app: the bubble slides home along the strand.
// - split: a right drag dropped on an app: Quicky divides there; the new mini stays, and the twin
//   (drawn by the fx overlay, which tells this page where it is) travels home along the strand.
// Rust (`trail.rs`) streams where the bubble is; this click-through window only draws. Plain TS.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { storedAccent } from "./lib/theme-colors";
import { sfx } from "./lib/sfx";

interface Pt { x: number; y: number }
interface Start { run: number; from: Pt; small?: boolean }

const SVGNS = "http://www.w3.org/2000/svg";
const goo = document.getElementById("drops") as unknown as SVGGElement;
const shine = document.getElementById("shine") as unknown as SVGGElement;
const still = matchMedia("(prefers-reduced-motion: reduce)");

/** The dragged blob's end of the strand, tucked under its own body (a mini's is smaller). */
const END_R = 26;
const MINI_K = 0.62;
/** The puddle left behind. */
const PUDDLE_R = 19;
/** Drops along a strand, one every this many px (close enough that the goo reads as one smooth
 *  string), within these counts. */
const DROP_GAP = 3.5;
const MIN_DROPS = 10;
const MAX_DROPS = 260;
/** The goo filter wipes out anything much thinner than this (px radius), so nothing goes below it. */
const THIN = 4.4;

let run = 0;
let from: Pt | null = null;
let to: Pt | null = null;
let k = 1;
type Mode = "drag" | "merge" | "back" | "split" | "gone";
let mode: Mode = "gone";
let since = 0;
let frame = 0;
/** Split: the new mini's spot (from the fx overlay), and when the twin landed home. */
let mini: Pt | null = null;
let landedAt = 0;
let lastTwin = 0;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => 1 - (1 - t) ** 3;

function circle(cx: number, cy: number, r: number, fill: string) {
  const c = document.createElementNS(SVGNS, "circle");
  c.setAttribute("cx", cx.toFixed(1));
  c.setAttribute("cy", cy.toFixed(1));
  c.setAttribute("r", Math.max(0, r).toFixed(1));
  c.setAttribute("fill", fill);
  return c;
}

/** What makes each drag's goo its own mess: lumps that ooze along the strand, drips hanging off
 *  it and splats around the puddle (new ones every drag). */
interface Mess {
  lumps: { s: number; size: number; speed: number; phase: number }[];
  drips: { s: number; len: number; bulb: number; phase: number }[];
  splats: { dx: number; dy: number; r: number }[];
}
let mess: Mess = newMess();

function newMess(): Mess {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  return {
    lumps: Array.from({ length: 3 + Math.floor(Math.random() * 3) }, () => ({ s: rnd(0.15, 0.85), size: rnd(3.5, 8), speed: rnd(0.02, 0.07), phase: rnd(0, 6) })),
    drips: Array.from({ length: 2 + Math.floor(Math.random() * 2) }, () => ({ s: rnd(0.25, 0.75), len: rnd(22, 52), bulb: rnd(6, 9), phase: rnd(0, 6) })),
    splats: Array.from({ length: 3 + Math.floor(Math.random() * 3) }, () => {
      const ang = rnd(0, Math.PI * 2), dist = rnd(16, 28);
      return { dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist * 0.6 + 6, r: rnd(5, 9) };
    }),
  };
}

const bez = (a: Pt, m: Pt, b: Pt, s: number): Pt => ({
  x: (1 - s) ** 2 * a.x + 2 * (1 - s) * s * m.x + s ** 2 * b.x,
  y: (1 - s) ** 2 * a.y + 2 * (1 - s) * s * m.y + s ** 2 * b.y,
});

/** The goo between `a` (radius `puddle`) and `b` (radius `end`): a main strand with lumps oozing
 *  along it, a thinner string sagging lower, drips hanging off. `thin` (0..1) wrings it out
 *  (being slurped up); `messy` false leaves out the extras (a strand that's snapping). */
function strand(out: SVGCircleElement[], a: Pt, b: Pt, puddle: number, end: number, thin: number, t: number, messy = true) {
  const color = storedAccent();
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const keep = 1 - thin;
  if (d <= 4) return;
  const flat = 1 - 0.6 * Math.abs(dy / (d || 1));
  // Snot sags under its own weight, more the longer it is, and quivers.
  const sag = Math.min(90, d * 0.16) * flat + Math.sin(t * 5.2) * Math.min(6, d * 0.02);
  const mid = { x: (a.x + b.x) / 2 + Math.sin(t * 3.1) * 4, y: (a.y + b.y) / 2 + sag };
  // Thinner the further it's pulled; never quite snaps.
  const neck = Math.max(THIN, (12 - d * 0.012) * keep * k) * (1 + 0.1 * Math.sin(t * 9));
  const count = Math.max(MIN_DROPS, Math.min(MAX_DROPS, Math.round(d / DROP_GAP)));
  const lumps = messy ? mess.lumps.map((l) => ({ at: l.s + Math.sin(t * (1 + l.speed * 10) + l.phase) * 0.05, size: l.size * keep * k })) : [];
  for (let i = 1; i < count; i++) {
    const s = i / count;
    const p = bez(a, mid, b, s);
    const edge = Math.min(s, 1 - s) * 2;
    let r = lerp(lerp(puddle, end, s) * 0.85, neck, Math.min(1, edge * 1.6) ** 0.7);
    for (const l of lumps) r += l.size * Math.exp(-(((s - l.at) / 0.045) ** 2));
    out.push(circle(p.x, p.y, Math.max(THIN, r), color));
  }
  if (!messy) return;
  // A second, thinner string that hangs lower.
  if (d > 70 && keep > 0.3) {
    const low = { x: mid.x - Math.sin(t * 2.3) * 6, y: (a.y + b.y) / 2 + sag * 1.7 + 14 };
    for (let i = 2; i < count - 1; i++) {
      const s = i / count;
      const p = bez(a, low, b, s);
      out.push(circle(p.x, p.y, THIN * (1 + 0.5 * Math.exp(-(((s - 0.5) / 0.08) ** 2))), color));
    }
  }
  // Drips hanging off the strand, swinging a little.
  if (d > 50) {
    for (const dr of mess.drips) {
      const top = bez(a, mid, b, dr.s);
      const len = Math.min(dr.len, d * 0.2) * keep * k * (1 + 0.12 * Math.sin(t * 4 + dr.phase));
      if (len < 6) continue;
      const swing = Math.sin(t * 2.6 + dr.phase) * 4;
      const steps = Math.max(3, Math.round(len / 3));
      for (let j = 1; j <= steps; j++) {
        const f = j / steps;
        out.push(circle(top.x + swing * f, top.y + len * f, THIN, color));
      }
      out.push(circle(top.x + swing, top.y + len + dr.bulb * 0.6, Math.max(THIN, dr.bulb * keep * k), color));
    }
  }
}

/** Draws the puddle at `a` (with its splats and shine) and whatever `extra` adds. */
function paint(a: Pt, puddle: number, keep: number, extra: (out: SVGCircleElement[]) => void) {
  const color = storedAccent();
  const out: SVGCircleElement[] = [circle(a.x, a.y, puddle, color)];
  for (const p of mess.splats) if (p.r * keep * k > THIN * 0.9) out.push(circle(a.x + p.dx * k, a.y + p.dy * k, p.r * keep * k, color));
  extra(out);
  goo.replaceChildren(...out);
  shine.replaceChildren();
  if (puddle > 8) shine.append(circle(a.x - puddle * 0.35, a.y - puddle * 0.4, puddle * 0.22, "rgba(255,255,255,0.55)"));
}

function tick(now: number) {
  frame = 0;
  if (!from || !to || mode === "gone") return;
  const a = from, b = to;
  const t = now / 1000;
  const age = (now - since) / 1000;
  const puddle = PUDDLE_R * k;
  const end = END_R * k;
  const color = storedAccent();
  if (mode === "drag") {
    // The puddle wobbles as it's left behind.
    const p = puddle * (1 + 0.06 * Math.sin(t * 7));
    paint(a, p, 1, (out) => {
      strand(out, a, b, p, end, 0, t);
      out.push(circle(b.x, b.y, end, color));
    });
  } else if (mode === "merge") {
    // The puddle slurps along the strand into the blob.
    const q = Math.min(1, age / 0.38);
    const e = ease(q);
    const at = { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e) };
    paint(at, puddle * (1 - 0.6 * e), 1 - e, (out) => {
      strand(out, at, b, puddle * (1 - 0.6 * e), end * (1 - 0.3 * e), e, t);
      out.push(circle(b.x, b.y, end * (1 - 0.3 * e), color));
    });
    if (q >= 1) return done();
  } else if (mode === "back") {
    // The bubble slides home along the strand (Rust streams where it is); the strand shortens.
    const w = Math.min(1, age * 2);
    paint(a, puddle * (1 + 0.15 * w), 1 - w * 0.5, (out) => {
      strand(out, a, b, puddle, end, w * 0.6, t);
      out.push(circle(b.x, b.y, end, color));
    });
    if (age > 1.4) return done();
  } else if (mode === "split") {
    // The twin heads home along the strand; the strand to the new mini stretches and snaps.
    const snap = Math.min(1, age / 0.45);
    const home = landedAt ? Math.min(1, (now - landedAt) / 300) : 0;
    paint(a, puddle * (1 - 0.5 * home), 1 - home, (out) => {
      strand(out, a, b, puddle * (1 - 0.5 * home), end, Math.max(home, 0.2), t);
      if (mini && snap < 1) strand(out, b, mini, end, END_R * MINI_K * (1 - snap), snap, t, false);
      out.push(circle(b.x, b.y, end, color));
    });
    // Done once the twin is home (or the overlay stopped talking).
    if (home >= 1 || (lastTwin && now - lastTwin > 600) || age > 3) return done();
  }
  frame = requestAnimationFrame(tick);
}

function kick() {
  if (!frame) frame = requestAnimationFrame(tick);
}

function done() {
  mode = "gone";
  goo.replaceChildren();
  shine.replaceChildren();
  void invoke("trail_done", { run }).catch(() => {});
}

function start(s: Start) {
  run = s.run;
  mess = newMess();
  k = s.small ? MINI_K : 1;
  from = s.from;
  to = s.from;
  mini = null;
  landedAt = lastTwin = 0;
  mode = "drag";
  since = performance.now();
  if (still.matches) return done();
  sfx.stick();
  kick();
}

void listen<Start>("trail-start", ({ payload }) => start(payload));
void listen<{ run: number; at: Pt }>("trail-move", ({ payload: p }) => {
  if (p.run !== run || mode === "gone") return;
  // Squelches as it moves, more the faster it goes.
  if (to && mode === "drag") sfx.goo(Math.min(1, Math.hypot(p.at.x - to.x, p.at.y - to.y) / 30));
  to = p.at;
  kick();
});
void listen<{ run: number; mode: "merge" | "back" | "split"; at: Pt }>("trail-end", ({ payload: p }) => {
  if (p.run !== run || mode === "gone") return;
  to = p.at;
  mode = p.mode;
  since = performance.now();
  sfx.slurp();
  kick();
});
// The bubble is home: the last of the strand goes into the puddle.
void listen<{ run: number }>("trail-home", ({ payload: p }) => {
  if (p.run === run && mode === "back") done();
});
// Split: where the fx overlay's twin is (screen px) on its way home, and the new mini.
void listen<{ twin: Pt; mini: Pt; landed: boolean }>("fx-twin", ({ payload: p }) => {
  if (mode !== "split") return;
  const here = (q: Pt) => ({ x: q.x - window.screenX, y: q.y - window.screenY });
  to = here(p.twin);
  mini = here(p.mini);
  lastTwin = performance.now();
  if (p.landed && !landedAt) landedAt = lastTwin;
  kick();
});
// A drag that started before this page was listening.
void invoke<Start | null>("trail_state").then((s) => s && mode === "gone" && start(s));
addEventListener("contextmenu", (e) => e.preventDefault());

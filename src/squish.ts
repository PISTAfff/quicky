// The overlay a window's open and close animations play in (`src-tauri/src/anim.rs`), in the
// bubble's goo: closing, a picture of the window gathers itself into a Quicky blob, which bursts
// into droplets that fly into the bubble (it gulps them) or, with no bubble to go to, scatter and
// pop. Opening is the other way round: droplets fly out of the bubble, melt into a blob, and the
// blob swells into the window. Nothing fades: the window is solid until it's a blob.
// The overlay is never really hidden (Rust parks it as one see-through pixel), so its frames come
// on time. Rust hides the real window once the picture covers it (`squish_covered`) and shows it
// again under the last frame of an opening (`squish_landed`). Plain TS, like the bubble.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { onAccent, storedAccent } from "./lib/theme-colors";

interface Pt {
  x: number;
  y: number;
}
interface Play {
  run: number;
  phase: "open" | "close";
  /** The picture's size, physical px. */
  w: number;
  h: number;
  /** Where the window is, in this page's px. */
  rect: { x: number; y: number; w: number; h: number };
  /** The bubble (or mini) the droplets fly into or out of, and its window's label (to gulp). */
  to: Pt | null;
  gulp: string | null;
}

const SVGNS = "http://www.w3.org/2000/svg";
// The bubble's shape (bubble.html: a 40 x 36 view box).
const BLOB = "M20 1C31 1 39 9 39 20c0 9-6 15-19 15S1 29 1 20C1 9 9 1 20 1z";
const INK = "#2b2540";
/** The blob a window becomes, px wide (the bubble's own is 58). */
const SIZE = 70;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeInOutCubic = (t: number) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
/** 0 → 1 with a bouncy overshoot, settled by about x = 1. */
const springTo = (x: number) => (x <= 0 ? 0 : 1 - Math.exp(-5 * x) * Math.cos(10 * x));

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
};

const svg = document.getElementById("stage") as unknown as SVGSVGElement;
const goo = el("g", { filter: "url(#goo)" }, svg);
const crisp = el("g", {}, svg);
const faces = el("g", {}, svg);
const bits = el("g", {}, svg);
const pic = document.getElementById("pic")!;
const shot = document.getElementById("shot") as HTMLCanvasElement;
const tint = document.getElementById("tint")!;
let ACCENT = storedAccent();
let FACE = onAccent(ACCENT);

// ---- the blob a window becomes -------------------------------------------------------------
const blobPath = el("path", { d: BLOB }, goo);
const blobFace = el("g", {}, faces);
const blob = { shown: false, x: 0, y: 0, size: SIZE, sx: 1, sy: 1, squeeze: false };

function drawBlob() {
  const show = blob.shown && blob.size > 1;
  for (const n of [blobPath, blobFace]) n.style.display = show ? "" : "none";
  if (!show) return;
  const k = blob.size / 40;
  const t = `translate(${blob.x.toFixed(1)} ${blob.y.toFixed(1)}) scale(${(k * blob.sx).toFixed(3)} ${(k * blob.sy).toFixed(3)}) translate(-20 -18)`;
  blobPath.setAttribute("transform", t);
  blobPath.setAttribute("fill", ACCENT);
  blobFace.setAttribute("transform", t);
  blobFace.innerHTML = blob.squeeze
    ? `<path d="M11 18q3-3 6 0M23 18q3-3 6 0" fill="none" stroke="${FACE}" stroke-width="2.6" stroke-linecap="round"/>`
    : `<g fill="${FACE}"><rect x="12" y="13" width="4" height="7" rx="2"/><rect x="24" y="13" width="4" height="7" rx="2"/></g><path d="M17.2 25.2q2.8 2.4 5.6 0" fill="none" stroke="${FACE}" stroke-width="1.7" stroke-linecap="round"/>`;
}

// ---- the picture of the window --------------------------------------------------------------
/** Puts the picture centred on `c`, `w` x `h` px, rounder by `round` (0 → 1), tinted by `tinted`. */
function picture(p: Play, c: Pt, w: number, h: number, round: number, tinted: number) {
  const r = p.rect;
  const sx = w / r.w;
  const sy = h / r.h;
  pic.style.display = "block";
  pic.style.transform = `translate(${(c.x - (r.x + r.w / 2)).toFixed(1)}px, ${(c.y - (r.y + r.h / 2)).toFixed(1)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  // The corners stay as round on screen however it's scaled.
  const rx = lerp(8, w / 2, clamp(round, 0, 1)) / sx;
  const ry = lerp(8, h / 2, clamp(round, 0, 1)) / sy;
  pic.style.borderRadius = `${rx.toFixed(1)}px / ${ry.toFixed(1)}px`;
  tint.style.opacity = clamp(tinted, 0, 1).toFixed(3);
}

// ---- droplets and sparkles (like fx.ts) -----------------------------------------------------
interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** When it heads for its goal (ms), and that trip: start, velocity, duration. */
  turn: number;
  p0?: Pt;
  v0?: Pt;
  dur: number;
  done: boolean;
  g: SVGGElement;
  dot: SVGCircleElement;
  shade: SVGCircleElement | null;
}

function drop(layer: SVGGElement, at: Pt, v: Pt, r: number, turn: number, dur: number, outlined: boolean): Drop {
  const g = el("g", {}, layer);
  const shade = outlined ? el("circle", { r, fill: INK }, g) : null;
  const dot = el("circle", outlined ? { r, fill: ACCENT, stroke: INK, "stroke-width": 1.5 } : { r, fill: ACCENT }, g);
  return { x: at.x, y: at.y, vx: v.x, vy: v.y, r, turn, dur, done: false, g, dot, shade };
}

/** Moves a droplet: flung (gravity and drag) until its turn, then a smooth curve into `goal`
 *  that keeps its momentum at first. Returns how far along that curve it is (0 → 1). */
function fly(d: Drop, t: number, dt: number, goal: Pt | null): number {
  if (t < d.turn || !goal) {
    d.vy += 1100 * (dt / 1000);
    d.vx *= Math.pow(0.985, dt / 16);
    d.vy *= Math.pow(0.985, dt / 16);
    d.x += (d.vx * dt) / 1000;
    d.y += (d.vy * dt) / 1000;
    return 0;
  }
  if (!d.p0) {
    d.p0 = { x: d.x, y: d.y };
    d.v0 = { x: d.vx / 1000, y: d.vy / 1000 };
  }
  const s = clamp((t - d.turn) / d.dur, 0, 1);
  const h10 = s * s * s - 2 * s * s + s;
  const h01 = -2 * s * s * s + 3 * s * s;
  d.x = (1 - h01) * d.p0.x + h10 * d.dur * d.v0!.x + h01 * goal.x;
  d.y = (1 - h01) * d.p0.y + h10 * d.dur * d.v0!.y + h01 * goal.y;
  return s;
}

function place(d: Drop, r: number) {
  for (const [c, off] of [[d.dot, 0], [d.shade, 1.6]] as const) {
    if (!c) continue;
    c.setAttribute("cx", (d.x + off).toFixed(1));
    c.setAttribute("cy", (d.y + off).toFixed(1));
    c.setAttribute("r", Math.max(0, r).toFixed(2));
  }
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  age: number;
  node: SVGCircleElement;
}
const sparks: Spark[] = [];

function sparkle(at: Pt, count: number, speed: number) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.7;
    const v = speed * rand(0.7, 1.2);
    const node = el("circle", { r: rand(2.4, 3.6), fill: ACCENT, stroke: INK, "stroke-width": 1.4 }, bits);
    sparks.push({ x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(320, 480), age: 0, node });
  }
}

function stepSparks(dt: number) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.age += dt;
    s.vx *= 0.93;
    s.vy = s.vy * 0.93 + 0.25 * (dt / 16);
    s.x += (s.vx * dt) / 1000;
    s.y += (s.vy * dt) / 1000;
    const k = 1 - s.age / s.life;
    if (k <= 0) {
      s.node.remove();
      sparks.splice(i, 1);
      continue;
    }
    s.node.setAttribute("cx", s.x.toFixed(1));
    s.node.setAttribute("cy", s.y.toFixed(1));
    s.node.setAttribute("r", (3 * (0.3 + 0.7 * k)).toFixed(2));
  }
}

/** A quick ink shock ring where the blob bursts. */
function ring(at: Pt, size: number) {
  const c = el("circle", { cx: at.x, cy: at.y, r: 8, fill: "none", stroke: INK, "stroke-width": 3.2 }, bits);
  c.animate(
    [
      { r: "8px", strokeWidth: "3.2px", opacity: 1 },
      { r: `${size}px`, strokeWidth: "0.5px", opacity: 0 },
    ],
    { duration: 320, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" },
  ).finished.then(() => c.remove());
}

// ---- the two animations ---------------------------------------------------------------------
type Step = (t: number, dt: number) => { landed: boolean; done: boolean };
/** Closing, the real window hides this long into the animation (the picture only bulges until
 *  then, covering it): by now the picture is surely on screen, so there's never a gap. */
const COVER = 55;

/** Closing: gather into a blob (0 → GATHER ms), shrug, burst, and the droplets fly home. */
function closing(p: Play): Step {
  const r = p.rect;
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const GATHER = 240;
  const BURST = GATHER + 110;
  const N = 9;
  const home = p.to;
  const dist = home ? Math.hypot(home.x - c.x, home.y - c.y) : 0;
  const trip = clamp(240 + dist * 0.12, 260, 460);
  const drops: Drop[] = [];
  let burst = false;
  let gulped = false;

  return (t, dt) => {
    if (t < GATHER) {
      // A jelly wobble first (never smaller than the real window, which hides under it
      // meanwhile), then it gathers itself into a round, accent blob.
      const q = clamp(t / COVER, 0, 1);
      const bulge = { x: 1 + 0.04 * Math.sin(Math.PI * q), y: 1 + 0.025 * Math.sin(Math.PI * Math.min(1, q * 1.6)) };
      const e = easeInOutCubic((t - COVER) / (GATHER - COVER));
      const w = lerp(r.w * bulge.x, SIZE, e);
      const h = lerp(r.h * bulge.y, SIZE * 0.9, e);
      picture(p, c, w, h, e, 0.12 * q + (e - 0.3) / 0.5);
      // The goo blob takes over under it at the very end.
      Object.assign(blob, { shown: e > 0.85, x: c.x, y: c.y, size: SIZE, sx: w / SIZE, sy: h / (SIZE * 0.9), squeeze: false });
    } else if (t < BURST) {
      pic.style.display = "none";
      // A little shrug, eyes squeezed shut, then poof.
      const e = Math.sin((Math.PI * (t - GATHER)) / (BURST - GATHER));
      Object.assign(blob, { shown: true, sx: 1 + 0.16 * e, sy: 1 - 0.14 * e, squeeze: t - GATHER > 30 });
    } else if (!burst) {
      burst = true;
      blob.shown = false;
      ring(c, 54);
      sparkle(c, 6, 170);
      for (let i = 0; i < N; i++) {
        // Into the bubble: a puff all round, then home. No bubble: a wider spray that pops.
        const a = (i / N) * Math.PI * 2 + rand(-0.3, 0.3);
        const v = home ? rand(170, 300) : rand(260, 420);
        drops.push(drop(crisp, c, { x: Math.cos(a) * v, y: Math.sin(a) * v - (home ? 0 : 120) }, rand(4, 7), BURST + 150 + i * 16, trip * rand(0.9, 1.1), true));
      }
    }
    drawBlob();

    for (const d of drops) {
      if (d.done) continue;
      if (home) {
        const s = fly(d, t, dt, home);
        // Shrinking as it dives into the bubble.
        place(d, d.r * clamp(Math.hypot(d.x - home.x, d.y - home.y) / 36, 0.3, 1));
        if (s >= 1) d.done = true;
      } else {
        fly(d, t, dt, null);
        const k = 1 - (t - BURST) / 420;
        place(d, d.r * k);
        if (k <= 0) d.done = true;
      }
      if (d.done) d.g.remove();
    }
    const allIn = burst && drops.every((d) => d.done);
    if (allIn && !gulped && p.gulp) {
      gulped = true;
      void emitTo(p.gulp, "bubble-gulp").catch(() => {});
    }
    return { landed: allIn, done: allIn };
  };
}

/** Opening: droplets fly out of the bubble (or in from all round) and melt into a blob, which
 *  swells into the window and settles with a bounce. */
function opening(p: Play): Step {
  const r = p.rect;
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const N = 8;
  const from = p.to;
  const dist = from ? Math.hypot(from.x - c.x, from.y - c.y) : 160;
  const trip = clamp(180 + dist * 0.1, 200, 360);
  const drops: Drop[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rand(-0.3, 0.3);
    // Out of the bubble with a little spray; with no bubble, from a ring around the window's middle.
    const start = from ?? { x: c.x + Math.cos(a) * 170, y: c.y + Math.sin(a) * 170 };
    const v = from ? rand(200, 340) : rand(40, 90);
    drops.push(drop(goo, start, { x: Math.cos(a) * v, y: Math.sin(a) * v }, rand(5, 8), i * 14, trip * rand(0.9, 1.1), false));
  }
  const MELT = Math.max(...drops.map((d) => d.turn + d.dur));
  const SWELL = 300;

  return (t, dt) => {
    let arrived = 0;
    for (const d of drops) {
      if (d.done) {
        arrived++;
        continue;
      }
      const s = fly(d, t, dt, c);
      place(d, d.r * lerp(0.7, 1, s));
      if (s >= 1) {
        d.done = true;
        d.g.remove();
        arrived++;
      }
    }
    if (t < MELT) {
      // Each droplet that arrives makes the blob a little bigger.
      Object.assign(blob, { shown: arrived > 0, x: c.x, y: c.y, size: SIZE * lerp(0.45, 1, arrived / N), sx: 1, sy: 1, squeeze: true });
    } else {
      // Then it swells into the window, bouncing a little as it settles.
      const q = (t - MELT) / SWELL;
      const e = springTo(q);
      const w = lerp(SIZE, r.w, e);
      const h = lerp(SIZE * 0.9, r.h, e);
      Object.assign(blob, { shown: q < 0.12, size: SIZE, sx: w / SIZE, sy: h / (SIZE * 0.9), squeeze: false });
      picture(p, c, w, h, 1 - clamp(e, 0, 1), 1 - clamp(q / 0.55, 0, 1));
    }
    drawBlob();
    const landed = t > MELT + SWELL;
    return { landed, done: landed };
  };
}

// ---- run ------------------------------------------------------------------------------------
let playing = 0;
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const frames = (n = 2) =>
  new Promise<void>((done) => {
    const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : done());
    step(n);
    setTimeout(done, 120); // never wait on frames that come late
  });

/** The animation playing now, so a fresher picture can be swapped in mid-flight. */
let shown: Play | null = null;

async function paint(w: number, h: number) {
  const buf = await invoke<ArrayBuffer>("squish_frame");
  if (buf.byteLength !== w * h * 4) return false;
  shot.width = w;
  shot.height = h;
  shot.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
  return true;
}

function clear() {
  pic.style.display = "none";
  blob.shown = false;
  drawBlob();
  for (const layer of [crisp, bits]) layer.replaceChildren();
  goo.replaceChildren(blobPath);
  for (const s of sparks) s.node.remove();
  sparks.length = 0;
}

// Opening started with the window's last picture: here's how it looks now.
void listen<number>("squish-refresh", ({ payload: run }) => {
  if (shown?.run === run) void paint(shown.w, shown.h);
});

void listen<Play>("squish-play", async ({ payload: p }) => {
  playing = p.run;
  clear();
  ACCENT = storedAccent();
  FACE = onAccent(ACCENT);
  tint.style.background = ACCENT;
  const r = p.rect;
  Object.assign(pic.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  const ok = await paint(p.w, p.h);
  if (playing !== p.run) return;
  if (!ok) return void invoke("squish_done", { run: p.run });
  shown = p;
  const step = p.phase === "close" ? closing(p) : opening(p);
  step(0, 0);
  // The overlay is unseen until its first frames with the picture are on screen (it would show
  // the last thing it drew otherwise).
  await frames(2);
  if (playing !== p.run) return;
  await invoke("squish_visible", { run: p.run });
  let landed = false;
  let covered = p.phase !== "close";
  let drawn = 0;
  let last = performance.now();
  const t0 = last;
  for (;;) {
    const now = await frame();
    if (playing !== p.run) return; // a newer one took over
    const dt = Math.min(40, now - last);
    last = now;
    const s = step(now - t0, dt);
    stepSparks(dt);
    if (!covered && ++drawn >= 3 && now - t0 >= COVER) {
      covered = true;
      void invoke("squish_covered", { run: p.run });
    }
    if (s.landed && !landed) {
      landed = true;
      await invoke("squish_landed", { run: p.run });
      // Give the real window a frame on screen before the picture goes.
      if (p.phase === "open") await frames();
    }
    if (s.done && sparks.length === 0) break;
  }
  clear();
  await frames();
  if (playing === p.run) void invoke("squish_done", { run: p.run });
});

addEventListener("contextmenu", (e) => e.preventDefault());

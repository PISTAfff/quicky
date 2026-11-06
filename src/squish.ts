// The overlay a window's open and close animations play in (`src-tauri/src/anim.rs`), in the
// sticky trail's snot (`trail.ts`): closing, a picture of the window wobbles like jelly, sags and
// melts into a dripping blob, which a lumpy, sagging strand pulls into the bubble (or the app's
// mini); the goo left behind slurps in after it and the bubble gulps. With no bubble on screen it
// plops into a puddle that splats and shrinks away. Opening runs it back: the bubble shoots out
// along a strand, swells into a dripping blob, and the window bulges out of it like jelly.
// Nothing fades: the window is solid until it's goo.
// The overlay is never really hidden (Rust parks it as one see-through pixel), so its frames come
// on time. Rust hides the real window once the picture covers it (`squish_covered`), and shows
// the bubble (closing) or the real window (opening) when the goo lands (`squish_landed`). Plain
// TS, like the bubble.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { onAccent, storedAccent } from "./lib/theme-colors";
import { sfx } from "./lib/sfx";

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
/** The blob a window becomes, px wide (the bubble's own is 58). */
const SIZE = 70;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
};

const svg = document.getElementById("stage") as unknown as SVGSVGElement;
const goo = el("g", { filter: "url(#goo)" }, svg);
const faces = el("g", {}, svg);
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

// ---- snot (the sticky trail's goo, see trail.ts) ---------------------------------------------
/** Per-frame goo circles, under the blob: the goo filter melts them into one body. */
const snot = el("g", {});
goo.insertBefore(snot, blobPath);
/** The goo filter wipes out anything much thinner than this (px radius). */
const THIN = 4.4;
/** One drop every this many px along a strand. */
const GAP = 3.5;

function dot(out: SVGCircleElement[], x: number, y: number, r: number) {
  if (r < THIN * 0.9) return;
  out.push(el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(1), fill: ACCENT }));
}

/** What makes each animation's goo its own mess: lumps oozing along the strand, drips hanging
 *  off it (and off the melting window), splats around a puddle. */
interface Mess {
  lumps: { s: number; size: number; speed: number; phase: number }[];
  drips: { s: number; len: number; bulb: number; phase: number }[];
  splats: { ang: number; dist: number; r: number }[];
}

function newMess(): Mess {
  return {
    lumps: Array.from({ length: 3 + Math.floor(Math.random() * 3) }, () => ({ s: rand(0.15, 0.85), size: rand(3.5, 8), speed: rand(0.02, 0.07), phase: rand(0, 6) })),
    drips: Array.from({ length: 3 }, (_, i) => ({ s: rand(0.15, 0.3) + i * 0.28, len: rand(26, 54), bulb: rand(6, 9), phase: rand(0, 6) })),
    splats: Array.from({ length: 5 + Math.floor(Math.random() * 3) }, () => ({ ang: rand(0, Math.PI * 2), dist: rand(26, 46), r: rand(5, 9) })),
  };
}

const bez = (a: Pt, m: Pt, b: Pt, s: number): Pt => ({
  x: (1 - s) ** 2 * a.x + 2 * (1 - s) * s * m.x + s ** 2 * b.x,
  y: (1 - s) ** 2 * a.y + 2 * (1 - s) * s * m.y + s ** 2 * b.y,
});

/** Where the strand between `a` and `b` sags to (its curve's middle control point). */
function sagOf(a: Pt, b: Pt, t: number): Pt {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const flat = 1 - 0.6 * Math.abs((b.y - a.y) / (d || 1));
  const sag = Math.min(90, d * 0.16) * flat + Math.sin(t * 5.2) * Math.min(6, d * 0.02);
  return { x: (a.x + b.x) / 2 + Math.sin(t * 3.1) * 4, y: (a.y + b.y) / 2 + sag };
}

/** One drip hanging from `top`: a thin string with a bulb at the end. */
function drip(out: SVGCircleElement[], top: Pt, len: number, bulb: number, swing: number) {
  if (len < 6) return;
  const steps = Math.max(3, Math.round(len / 3));
  for (let j = 0; j <= steps; j++) dot(out, top.x + swing * (j / steps), top.y + len * (j / steps), THIN);
  dot(out, top.x + swing, top.y + len + bulb * 0.6, Math.max(THIN, bulb));
}

/** A lumpy, sagging snot strand from `a` (radius `ra`) to `b` (radius `rb`), with a thinner
 *  string hanging lower and drips off it. `thin` (0..1) wrings it out (being slurped up). */
function strand(out: SVGCircleElement[], a: Pt, b: Pt, ra: number, rb: number, thin: number, t: number, m: Mess) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  if (d <= 4) return;
  const keep = 1 - thin;
  const mid = sagOf(a, b, t);
  const neck = Math.max(THIN, (12 - d * 0.012) * keep) * (1 + 0.1 * Math.sin(t * 9));
  const count = clamp(Math.round(d / GAP), 10, 260);
  const lumps = m.lumps.map((l) => ({ at: l.s + Math.sin(t * (1 + l.speed * 10) + l.phase) * 0.05, size: l.size * keep }));
  for (let i = 1; i < count; i++) {
    const s = i / count;
    const q = bez(a, mid, b, s);
    const edge = Math.min(s, 1 - s) * 2;
    let r = lerp(lerp(ra, rb, s) * 0.85, neck, Math.min(1, edge * 1.6) ** 0.7);
    for (const l of lumps) r += l.size * Math.exp(-(((s - l.at) / 0.045) ** 2));
    dot(out, q.x, q.y, Math.max(THIN, r));
  }
  if (d > 70 && keep > 0.3) {
    const low = { x: mid.x - Math.sin(t * 2.3) * 6, y: mid.y + (mid.y - (a.y + b.y) / 2) * 0.7 + 14 };
    for (let i = 2; i < count - 1; i++) {
      const s = i / count;
      const q = bez(a, low, b, s);
      dot(out, q.x, q.y, THIN * (1 + 0.5 * Math.exp(-(((s - 0.5) / 0.08) ** 2))));
    }
  }
  if (d > 50) {
    for (const dr of m.drips) {
      const top = bez(a, mid, b, dr.s);
      drip(out, top, Math.min(dr.len, d * 0.2) * keep * (1 + 0.12 * Math.sin(t * 4 + dr.phase)), dr.bulb * keep, Math.sin(t * 2.6 + dr.phase) * 4);
    }
  }
}

/** A puddle at `at`, `r` wide, flattened, with splats around it (`spread` 0..1 flings them out). */
function puddle(out: SVGCircleElement[], at: Pt, r: number, spread: number, keep: number, m: Mess) {
  if (r < THIN) return;
  for (const f of [-0.55, 0, 0.55]) dot(out, at.x + f * r, at.y + Math.abs(f) * r * 0.15, r * (1 - Math.abs(f) * 0.45));
  for (const sp of m.splats) {
    const dd = sp.dist * spread;
    dot(out, at.x + Math.cos(sp.ang) * dd * 1.4, at.y + Math.sin(sp.ang) * dd * 0.45, sp.r * keep);
  }
}

// ---- the two animations ---------------------------------------------------------------------
type Step = (t: number, dt: number) => { landed: boolean; done: boolean };
/** Closing, the real window hides this long into the animation (the picture only bulges until
 *  then, covering it): by now the picture is surely on screen, so there's never a gap. */
const COVER = 55;
const easeIn = (t: number) => clamp(t, 0, 1) ** 2;
const easeOut = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;

/** The bubble's blob (or a mini's), px wide: the goo arrives as, or leaves from, one this size. */
const blobFor = (p: Play) => (p.gulp === "mini" ? 38 : 58);

/** Closing: the window wobbles like jelly, sags and melts into a dripping blob, which is pulled
 *  through a lumpy snot strand into the bubble; the goo left behind slurps in after it and the
 *  bubble gulps. No bubble: the blob plops into a puddle that splats and shrinks away. */
function closing(p: Play): Step {
  const r = p.rect;
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const home = p.to;
  const m = newMess();
  const end = blobFor(p);
  const MELT = 220;
  // Where the melted blob ends up: sagged below the window's middle.
  const B = { x: c.x, y: c.y + Math.min(46, r.h * 0.12) };
  const dist = home ? Math.hypot(home.x - B.x, home.y - B.y) : 0;
  const TRAVEL = clamp(130 + dist * 0.08, 150, 230);
  const SLURP = 150;
  const PLOP = 280;
  const heard = { melt: false, pull: false, slurp: false, end: false };
  let gulped = false;

  return (t) => {
    const out: SVGCircleElement[] = [];
    let landed = false;
    if (t < COVER) {
      // Jelly: it wobbles (never smaller than the real window, which hides under it meanwhile).
      const q = t / COVER;
      picture(p, c, r.w * (1 + 0.035 * Math.sin(Math.PI * q)), r.h * (1 + 0.02 * Math.sin(2 * Math.PI * Math.min(1, q))), 0, 0.1 * q);
    } else if (t < MELT) {
      // Sagging and melting into a blob, dripping off its bottom edge as it goes.
      if (!heard.melt) {
        heard.melt = true;
        sfx.goo(0.9);
      }
      const q = (t - COVER) / (MELT - COVER);
      const e = easeIn(q);
      const wob = Math.sin(t * 0.05) * 0.07 * (1 - e);
      const w = lerp(r.w * (1 + wob), SIZE * 1.05, e);
      const h = lerp(r.h * (1 - wob * 0.7), SIZE * 0.88, e);
      const at = { x: lerp(c.x, B.x, e), y: lerp(c.y, B.y, e) };
      picture(p, at, w, h, e, 0.15 + (e - 0.2) / 0.55);
      // Oozing from its bottom edge: a bead of goo on the edge, a string and a bulb below.
      const bottom = at.y + h / 2;
      const ooze = Math.sin(Math.PI * Math.min(1, q * 1.15));
      for (const dr of m.drips) {
        const top = { x: at.x + (dr.s - 0.5) * w * 0.8, y: bottom - 3 };
        dot(out, top.x, top.y, 7 * ooze + THIN * (1 - ooze));
        drip(out, top, dr.len * 1.3 * ooze, dr.bulb, 0);
      }
      Object.assign(blob, { shown: e > 0.82, x: B.x, y: B.y, size: SIZE, sx: w / SIZE, sy: h / (SIZE * 0.88), squeeze: true });
    } else if (home) {
      pic.style.display = "none";
      // Pulled into the bubble: the blob travels along the strand, the goo left behind slurps in.
      if (!heard.pull) {
        heard.pull = true;
        sfx.stick();
      }
      const q = clamp((t - MELT) / TRAVEL, 0, 1);
      const e = easeIn(q) * 0.6 + easeOut(q) * 0.4;
      const s = clamp((t - MELT - TRAVEL * 0.55) / SLURP, 0, 1);
      if (s > 0 && !heard.slurp) {
        heard.slurp = true;
        sfx.slurp();
      }
      const se = easeIn(s);
      const pos = bez(B, sagOf(B, home, 0.4), home, e);
      const left = { x: lerp(B.x, pos.x, se), y: lerp(B.y, pos.y, se) };
      const stretch = Math.sin(Math.PI * q);
      const size = lerp(SIZE, end, e);
      // Still drawn on the last frame, while the real bubble comes back under it.
      Object.assign(blob, { shown: true, x: pos.x, y: pos.y, size, sx: 1 + 0.22 * stretch, sy: 1 - 0.16 * stretch, squeeze: true });
      if (s < 1) {
        const pr = 20 * (1 - 0.8 * se);
        puddle(out, left, pr, 0.4 * (1 - se), 1 - se, m);
        strand(out, left, pos, pr, size * 0.32, se, t / 1000, m);
      }
      landed = s >= 1;
      if (landed && !gulped) {
        gulped = true;
        sfx.gulp();
        if (p.gulp) void emitTo(p.gulp, "bubble-gulp").catch(() => {});
      }
    } else {
      pic.style.display = "none";
      // No bubble to go to: it plops down into a puddle that splats and shrinks away.
      const q = clamp((t - MELT) / PLOP, 0, 1);
      const fall = easeIn(q / 0.3);
      const P = { x: B.x, y: B.y + 34 };
      if (q >= 0.3 && !heard.end) {
        heard.end = true;
        sfx.goo(1);
      }
      Object.assign(blob, { shown: q < 0.3, x: B.x, y: lerp(B.y, P.y, fall), size: SIZE, sx: 1 + 0.5 * fall, sy: 1 - 0.45 * fall, squeeze: true });
      if (q >= 0.25) {
        const k = (q - 0.25) / 0.75;
        puddle(out, P, 30 * (1 - easeIn(k)), easeOut(k * 2.5), 1 - easeIn(k), m);
      }
      landed = q >= 1;
    }
    snot.replaceChildren(...out);
    drawBlob();
    return { landed, done: landed };
  };
}

/** Opening: the bubble shoots out along a snot strand, swells into a dripping blob, and the
 *  window bulges out of it with a jelly overshoot while the strand slurps back. No bubble: splats
 *  run together into a puddle that rises into the blob. */
function opening(p: Play): Step {
  const r = p.rect;
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const home = p.to;
  const m = newMess();
  const start = blobFor(p);
  const B = { x: c.x, y: c.y + Math.min(30, r.h * 0.08) };
  const dist = home ? Math.hypot(home.x - B.x, home.y - B.y) : 0;
  const LEAP = home ? clamp(130 + dist * 0.08, 150, 230) : 200;
  const BULGE = LEAP + 30;
  const GROW = 330;
  const P = { x: B.x, y: B.y + 40 };
  const heard = { go: false, slurp: false, bulge: false };

  return (t) => {
    const out: SVGCircleElement[] = [];
    if (!heard.go) {
      heard.go = true;
      sfx.stick();
    }
    if (home) {
      // The bubble (a stand-in: the real one is hidden now) squashes, then shoots along the
      // strand; the goo it leaves at home slurps after it.
      const wind = clamp(t / 50, 0, 1);
      const q = clamp((t - 50) / (LEAP - 50), 0, 1);
      const e = easeIn(q) * 0.4 + easeOut(q) * 0.6;
      const pos = bez(home, sagOf(home, B, 0.4), B, e);
      const s = clamp((t - LEAP * 0.7) / 170, 0, 1);
      if (s > 0 && !heard.slurp) {
        heard.slurp = true;
        sfx.slurp();
      }
      const se = easeIn(s);
      const left = { x: lerp(home.x, pos.x, se), y: lerp(home.y, pos.y, se) };
      const stretch = Math.sin(Math.PI * q);
      const squash = Math.sin(Math.PI * wind) * (1 - q);
      const size = lerp(start, SIZE * 1.08, easeOut(q));
      if (t < BULGE + 60) Object.assign(blob, { shown: true, x: pos.x, y: pos.y, size, sx: (1 + 0.12 * squash) * (1 + 0.2 * stretch), sy: (1 - 0.14 * squash) * (1 - 0.14 * stretch), squeeze: q < 1 });
      if (s < 1 && q > 0) {
        const pr = 16 * (1 - 0.8 * se);
        puddle(out, left, pr, 0.3 * (1 - se), 1 - se, m);
        strand(out, left, pos, pr, size * 0.32, se, t / 1000, m);
      }
    } else {
      // Splats run together into a puddle, which rises into the blob.
      const q = clamp(t / 120, 0, 1);
      const rise = clamp((t - 110) / (LEAP - 110), 0, 1);
      if (rise < 1) puddle(out, P, lerp(10, 26, easeOut(q)) * (1 - 0.7 * easeIn(rise)), 1 - easeOut(q), 1, m);
      if (rise > 0) {
        const e = easeOut(rise);
        const top = { x: B.x, y: lerp(P.y, B.y, e) };
        if (t < BULGE + 60) Object.assign(blob, { shown: true, x: top.x, y: top.y, size: lerp(SIZE * 0.5, SIZE * 1.08, e), sx: 1 - 0.15 * Math.sin(Math.PI * rise), sy: 1 + 0.2 * Math.sin(Math.PI * rise), squeeze: true });
        if (rise < 1) strand(out, P, top, 12, SIZE * 0.3, easeIn(rise), t / 1000, m);
      }
    }
    // Drips hang off the swelling blob until the window bulges out.
    const span = BULGE + 120 - LEAP * 0.6;
    if (t > LEAP * 0.6 && t < BULGE + 120) {
      const k = Math.sin(Math.PI * clamp((t - LEAP * 0.6) / span, 0, 1));
      for (const dr of m.drips.slice(0, 2)) drip(out, { x: B.x + (dr.s - 0.5) * SIZE * 0.6, y: B.y + SIZE * 0.36 }, dr.len * 0.7 * k, dr.bulb * k, Math.sin(t / 160 + dr.phase) * 3);
    }
    if (t >= BULGE) {
      // The window bulges out of the blob, overshooting like jelly, and settles.
      if (!heard.bulge) {
        heard.bulge = true;
        sfx.goo(1);
      }
      const q = (t - BULGE) / GROW;
      // A firmer spring than the bubble's: the window overshoots a few percent, not a fifth.
      const e = q <= 0 ? 0 : 1 - Math.exp(-7.5 * q) * Math.cos(10.5 * q);
      const w = lerp(SIZE * 1.08, r.w, e);
      const h = lerp(SIZE * 0.95, r.h, e);
      const at = { x: lerp(B.x, c.x, clamp(e, 0, 1)), y: lerp(B.y, c.y, clamp(e, 0, 1)) };
      // A wobble on top of the overshoot: wider, then taller.
      const wob = Math.sin(q * 14) * 0.03 * Math.max(0, 1 - q);
      picture(p, at, w * (1 + wob), h * (1 - wob), 1 - clamp(e * 1.15, 0, 1), 1 - clamp(q / 0.5, 0, 1));
      if (q > 0.08) blob.shown = false;
    }
    snot.replaceChildren(...out);
    drawBlob();
    const landed = t > BULGE + GROW;
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
  snot.replaceChildren();
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
    if (!covered && ++drawn >= 3 && now - t0 >= COVER) {
      covered = true;
      void invoke("squish_covered", { run: p.run });
    }
    if (s.landed && !landed) {
      landed = true;
      await invoke("squish_landed", { run: p.run });
      // Give the real window (or the bubble) a frame on screen before the picture goes.
      await frames();
    }
    if (s.done) break;
  }
  clear();
  await frames();
  if (playing === p.run) void invoke("squish_done", { run: p.run });
});

addEventListener("contextmenu", (e) => e.preventDefault());

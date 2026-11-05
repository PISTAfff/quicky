// Quicky's big moments, played in a short-lived, click-through window that covers the bubble and
// its home spot, so they have room to move instead of being clipped to the little bubble window:
// - split: dropped on a new app, Quicky divides; one half shrinks into the app's mini, the other
//   hops home and stays there as the bubble;
// - pop / hide: a mini pushed out of its app (or hidden from its menu) bursts into droplets that
//   fly home and dive into the bubble, which gulps them down.
// Rust keeps the real blobs this draws invisible meanwhile and swaps them back in at the end
// (fx_handoff), so the last frame here is drawn exactly where they reappear. Plain TS, like the
// bubble.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { onAccent, storedAccent } from "./lib/theme-colors";
import { sfx } from "./lib/sfx";

type Kind = "split" | "pop" | "hide";
interface Pt {
  x: number;
  y: number;
}
interface Payload {
  kind: Kind;
  /** Centres of the bubble window where the moment starts, of the new mini's window (split; for
   *  pop / hide the same as `from`), and of the bubble's home spot. */
  from: Pt;
  mini: Pt;
  to: Pt;
  /** The mini's task space (split: the new one; pop / hide: the one going away). */
  space: string | null;
  /** Pop: which way it was being pushed (into the wall), unit length. */
  push?: Pt;
}
interface Counts {
  open: number;
  spaces?: Record<string, number>;
}
type Face = "happy" | "clear" | "angry" | "squeeze" | "surprised";

const SVGNS = "http://www.w3.org/2000/svg";
// Shapes and sizes copied from bubble.html (40 x 36 view box drawn 58 px wide; minis at 0.66).
const BLOB = "M20 1C31 1 39 9 39 20c0 9-6 15-19 15S1 29 1 20C1 9 9 1 20 1z";
const NORMAL = 1.45;
const MINI = NORMAL * 0.66;
// The blob's centre sits a hair below its window's centre (the button's offsets in bubble.html).
const NORMAL_DY = 1;
const MINI_DY = 1.34;
const INK = "#2b2540";
const RED = "#ff3b3b";

/** The face reads on the accent: white, or ink on light accents (like `--on-accent`). The window
 *  is kept between moments, so these are read again at the start of each one. */
let FACE = onAccent(storedAccent());
const faceSet = (): Record<Face, string> => ({
  happy: `<g fill="${FACE}"><rect x="12" y="13" width="4" height="7" rx="2"/><rect x="24" y="13" width="4" height="7" rx="2"/></g><path d="M17.2 25.2q2.8 2.4 5.6 0" fill="none" stroke="${FACE}" stroke-width="1.7" stroke-linecap="round"/>`,
  clear: `<path d="M11 18q3-3 6 0M23 18q3-3 6 0" fill="none" stroke="${FACE}" stroke-width="2.6" stroke-linecap="round"/>`,
  angry:
    `<g fill="${FACE}" transform="translate(0 16.5) scale(1 0.55) translate(0 -16.5)"><rect x="12" y="13" width="4" height="7" rx="2"/><rect x="24" y="13" width="4" height="7" rx="2"/></g>` +
    `<path d="M17.2 26.8q2.8-2.2 5.6 0" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>` +
    `<path d="M10.5 10.5l6 2.4M29.5 10.5l-6 2.4" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`,
  squeeze: `<path d="M11 18q3-3 6 0M23 18q3-3 6 0" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`,
  surprised: `<g fill="${FACE}"><rect x="11.5" y="11.5" width="5" height="9" rx="2.5"/><rect x="23.5" y="11.5" width="5" height="9" rx="2.5"/></g><circle cx="20" cy="26.5" r="1.8" fill="${FACE}"/>`,
});
let FACES = faceSet();

// ---- helpers ------------------------------------------------------------------------------
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeOutCubic = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;
const easeInOutCubic = (t: number) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
/** 0 → 1 with a bouncy overshoot, settled by about x = 1. */
const springTo = (x: number) => (x <= 0 ? 0 : 1 - Math.exp(-5 * x) * Math.cos(10 * x));
/** A decaying wobble: 1 at τ = 0 (ms), dying away. */
const wobble = (ms: number, hz: number, decay: number) => Math.exp((-decay * ms) / 1000) * Math.cos((2 * Math.PI * hz * ms) / 1000);

/** Blends two "#rrggbb" colours; returns "#rrggbb" too, so results can be mixed again. */
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(lerp(v, y[i], clamp(t, 0, 1))).toString(16).padStart(2, "0")).join("");
}


const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
};

// ---- stage --------------------------------------------------------------------------------
// Layers, bottom to top: crisp blobs, goo (shapes that merge while they touch, outlined and
// shadowed by the filter), faces, and bits (rings, sparks).
const svg = document.getElementById("stage") as unknown as SVGSVGElement;
const crisp = el("g", {}, svg);
const goo = el("g", { filter: "url(#goo)" }, svg);
const faces = el("g", {}, svg);
const bits = el("g", {}, svg);
let ACCENT = storedAccent();

/** One blob: drawn crisp (exactly like the bubble) or inside the goo layer while it merges. */
class Body {
  x = 0;
  y = 0;
  k = NORMAL;
  /** Squash along `rot` (radians): sx along it, sy across it. */
  sx = 1;
  sy = 1;
  rot = 0;
  color = ACCENT;
  face: Face = "happy";
  gooey = false;
  shown = true;
  private crispG = el("g", {}, crisp);
  private body: SVGPathElement;
  private gooPath = el("path", { d: BLOB }, goo);
  private faceG = el("g", {}, faces);
  private drawnFace: Face | null = null;

  constructor() {
    // The bubble's hard shadow, then its outlined body on top.
    el("path", { d: BLOB, fill: INK, transform: "translate(2 2)" }, this.crispG);
    this.body = el("path", { d: BLOB, stroke: INK, "stroke-width": 1.6, "stroke-linejoin": "round" }, this.crispG);
  }

  at(p: Pt) {
    this.x = p.x;
    this.y = p.y;
  }

  draw() {
    const t = `translate(${this.x.toFixed(2)} ${this.y.toFixed(2)}) rotate(${((this.rot * 180) / Math.PI).toFixed(2)}) scale(${this.sx.toFixed(3)} ${this.sy.toFixed(3)}) rotate(${((-this.rot * 180) / Math.PI).toFixed(2)}) scale(${this.k.toFixed(3)}) translate(-20 -18)`;
    const show = this.shown && this.k > 0.01;
    this.crispG.style.display = show && !this.gooey ? "" : "none";
    this.gooPath.style.display = show && this.gooey ? "" : "none";
    this.faceG.style.display = show ? "" : "none";
    for (const n of [this.crispG, this.gooPath, this.faceG]) n.setAttribute("transform", t);
    this.body.setAttribute("fill", this.color);
    this.gooPath.setAttribute("fill", this.color);
    if (this.face !== this.drawnFace) {
      this.faceG.innerHTML = FACES[this.face];
      this.drawnFace = this.face;
    }
  }
}

/** A droplet from a burst: a small outlined dot that flies home into the bubble. */
interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** When it turns for home (ms), and that trip: start point and velocity, duration. */
  turn: number;
  p0?: Pt;
  v0?: Pt;
  dur?: number;
  home: boolean;
  crisp: SVGGElement;
  dot: SVGCircleElement;
  shade: SVGCircleElement;
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

function sparkle(at: Pt, count: number, speed = 160) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.7;
    const v = speed * rand(0.7, 1.2);
    const node = el("circle", { r: rand(2.4, 3.6), fill: ACCENT, stroke: INK, "stroke-width": 1.4 }, bits);
    sparks.push({ x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(380, 560), age: 0, node });
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
    s.node.setAttribute("opacity", k.toFixed(2));
    s.node.setAttribute("transform", `translate(${s.x.toFixed(1)} ${s.y.toFixed(1)}) scale(${(0.3 + 0.7 * k).toFixed(2)}) translate(${(-s.x).toFixed(1)} ${(-s.y).toFixed(1)})`);
  }
}

/** A quick ink shock ring where something bursts. */
function ring(at: Pt, size: number) {
  const c = el("circle", { cx: at.x, cy: at.y, r: 8, fill: "none", stroke: INK, "stroke-width": 3.2 }, bits);
  c.animate(
    [
      { r: "8px", strokeWidth: "3.2px", opacity: 1 },
      { r: `${size}px`, strokeWidth: "0.5px", opacity: 0 },
    ],
    { duration: 340, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" },
  ).finished.then(() => c.remove());
}

// ---- the moments ----------------------------------------------------------------------------
// Each returns a step function of time (ms since the start) that draws one frame and reports
// when the real bubble can come back ("handoff") and when this window can go ("done").
type Step = (t: number, dt: number) => { handoff: boolean; done: boolean };

function split(p: Payload, stayClear: boolean, homeClear: boolean): Step {
  const from = { x: p.from.x, y: p.from.y + NORMAL_DY };
  const mini = { x: p.mini.x, y: p.mini.y + MINI_DY };
  const home = { x: p.to.x, y: p.to.y + NORMAL_DY };
  // The halves pull apart along the line from the mini's spot to home: the twin towards home.
  const ax = home.x - mini.x;
  const ay = home.y - mini.y;
  const alen = Math.hypot(ax, ay);
  const u = alen > 0.5 ? { x: ax / alen, y: ay / alen } : { x: -1, y: 0 };
  const ang = Math.atan2(u.y, u.x);
  // The twin's hop home: an arc bowed towards the top of the screen.
  let n = { x: -u.y, y: u.x };
  if (n.y > 0) n = { x: -n.x, y: -n.y };
  const dist = Math.hypot(home.x - from.x, home.y - from.y);
  const lift = Math.min(170, dist * 0.32);
  const flight = clamp(380 + dist * 0.18, 420, 720);
  const PULL = 30;
  const start = { x: from.x + u.x * PULL, y: from.y + u.y * PULL };
  const ctrl = { x: (start.x + home.x) / 2 + n.x * lift, y: (start.y + home.y) / 2 + n.y * lift };
  const bez = (q: number): Pt => ({
    x: (1 - q) ** 2 * start.x + 2 * (1 - q) * q * ctrl.x + q * q * home.x,
    y: (1 - q) ** 2 * start.y + 2 * (1 - q) * q * ctrl.y + q * q * home.y,
  });
  // Both halves at rest in their spots (ms after the snap): the real bubble and mini take over.
  const rest = Math.max(560, flight + 320);

  const stay = new Body();
  stay.at(from);
  const twin = new Body();
  twin.shown = false;
  /** Where the twin is (blob centre), for the sticky trail it travels home along. */
  let tw: Pt = from;
  let snapped = false;
  let landed = false;

  return (t) => {
    if (t < 170) {
      // Gather: squash against the pull, eyes squeezed shut.
      const e = easeOutCubic(t / 170);
      stay.gooey = true;
      stay.rot = ang;
      stay.sx = 1 - 0.12 * e;
      stay.sy = 1 + 0.1 * e;
      if (t > 60) stay.face = "squeeze";
    } else if (t < 440) {
      // Pull apart into a peanut: the goo keeps them one body joined by a thinning neck.
      const e = easeInOutCubic((t - 170) / 270);
      const s = PULL * e;
      twin.shown = true;
      for (const b of [stay, twin]) {
        b.gooey = true;
        b.rot = ang;
        b.k = NORMAL * (1 - 0.15 * e);
        b.sx = lerp(0.88, 1.12, e);
        b.sy = lerp(1.1, 0.92, e);
        b.face = "squeeze";
      }
      stay.at({ x: from.x - u.x * s * 0.55, y: from.y - u.y * s * 0.55 });
      tw = { x: from.x + u.x * s, y: from.y + u.y * s };
      twin.at(tw);
    } else {
      const tau = t - 440;
      if (!snapped) {
        // Snap! The neck breaks.
        snapped = true;
        sfx.split();
        sparkle({ x: from.x + u.x * PULL * 0.25, y: from.y + u.y * PULL * 0.25 }, 7, 190);
        stay.face = twin.face = "surprised";
      }
      // The half that stays recoils, then settles into the app's mini with a bouncy shrink.
      const back = PULL * 0.55 * wobble(tau, 3.2, 6);
      const m = easeOutCubic(tau / 320);
      const base = { x: lerp(from.x, mini.x, m), y: lerp(from.y, mini.y, m) };
      stay.at({ x: base.x - u.x * back, y: base.y - u.y * back });
      stay.k = lerp(NORMAL * 0.85, MINI, springTo(tau / 420));
      const w = wobble(tau, 4.2, 7);
      stay.sx = 1 + 0.14 * w;
      stay.sy = 1 - 0.1 * w;
      stay.gooey = tau < 110;
      if (tau > 160) stay.face = stayClear ? "clear" : "happy";
      if (tau > 520) {
        Object.assign(stay, { sx: 1, sy: 1, k: MINI });
        stay.at(mini);
      }

      // The twin hops home along the arc, stretching with its speed, lands and stays: it's the
      // bubble again.
      const q = tau / flight;
      twin.gooey = tau < 110;
      if (q < 1) {
        const e = easeInOutCubic(q);
        const pos = bez(e);
        const ahead = bez(Math.min(1, e + 0.02));
        tw = pos;
        twin.at(pos);
        twin.rot = Math.atan2(ahead.y - pos.y, ahead.x - pos.x);
        const stretch = 1 + 0.3 * Math.sin(Math.PI * q);
        twin.sx = stretch;
        twin.sy = 1 / Math.sqrt(stretch);
        twin.k = lerp(NORMAL * 0.85, NORMAL, e);
        if (tau > 140) twin.face = "happy";
      } else {
        const land = tau - flight;
        if (!landed) {
          landed = true;
          sfx.tap();
          sparkle(home, 4, 120);
        }
        tw = home;
        twin.at(home);
        twin.k = NORMAL;
        twin.face = homeClear ? "clear" : "happy";
        if (land < 300) {
          const w2 = wobble(land, 5, 12);
          twin.rot = Math.PI / 2;
          twin.sx = 1 - 0.16 * w2;
          twin.sy = 1 + 0.12 * w2;
        } else Object.assign(twin, { rot: 0, sx: 1, sy: 1 });
      }
      // The real ones are showing again on top by now; stop drawing copies under their bob.
      if (tau > rest + 100) stay.shown = twin.shown = false;
      stay.draw();
      twin.draw();
      tellTrail({ x: tw.x, y: tw.y - NORMAL_DY }, p.mini, tau > flight);
      return { handoff: tau > rest, done: tau > rest + 140 };
    }
    stay.draw();
    twin.draw();
    return { handoff: false, done: false };
  };
}

/** The sticky trail's window draws the strand the twin travels home along: it hears where the
 *  twin and the new mini are (window centres, in screen px so it can place them in its own window). */
function tellTrail(twin: Pt, mini: Pt, landed: boolean) {
  const s = (q: Pt) => ({ x: q.x + window.screenX, y: q.y + window.screenY });
  void emitTo("trail", "fx-twin", { twin: s(twin), mini: s(mini), landed }).catch(() => {});
}

function burst(p: Payload, hard: boolean): Step {
  const from = { x: p.from.x, y: p.from.y + MINI_DY };
  const home = { x: p.to.x, y: p.to.y + NORMAL_DY };
  const dist = Math.hypot(home.x - from.x, home.y - from.y);
  const push = p.push && Math.hypot(p.push.x, p.push.y) > 0.1 ? p.push : null;
  const pang = push ? Math.atan2(push.y, push.x) : 0;
  // Droplets spray back off the wall it was pushed into; a hidden mini puffs out all round.
  const away = push ? pang + Math.PI : -Math.PI / 2;
  const angry = mix(ACCENT, RED, hard ? 0.65 : 0);
  const BURST = hard ? 160 : 150;
  const N = hard ? 11 : 8;
  const trip = clamp(260 + dist * 0.1, 300, 480);

  const blob = new Body();
  blob.at(from);
  blob.k = MINI;
  blob.rot = pang;
  blob.color = angry;
  blob.face = hard ? "angry" : "happy";
  if (hard) {
    // The pose the bubble was holding: squashed flat against the wall.
    blob.sx = 0.62;
    blob.sy = 1.28;
  }

  const drops: Drop[] = [];
  let burstDone = false;
  let arrived = 0;
  let allIn = -1;

  const spawn = () => {
    for (let i = 0; i < N; i++) {
      const a = away + (hard ? rand(-1.9, 1.9) : (i / N) * Math.PI * 2 + rand(-0.3, 0.3));
      const v = hard ? rand(380, 640) : rand(170, 290);
      const r = rand(3.6, 6.6);
      const g = el("g", {}, crisp);
      const shade = el("circle", { r, fill: INK }, g);
      const dot = el("circle", { r, fill: angry, stroke: INK, "stroke-width": 1.5 }, g);
      drops.push({ x: from.x, y: from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r, turn: BURST + 170 + i * 18, home: false, crisp: g, dot, shade });
    }
  };

  return (t, dt) => {
    if (t < BURST) {
      if (hard) {
        // Squeezed even flatter, then it swells up round and red.
        const shake = 1.2 * Math.sin(t * 1.3);
        if (t < 80) {
          const e = easeOutCubic(t / 80);
          blob.sx = lerp(0.62, 0.5, e);
          blob.sy = lerp(1.28, 1.38, e);
          blob.at({ x: from.x + shake, y: from.y - shake * 0.5 });
        } else {
          const e = easeOutCubic((t - 80) / 80);
          blob.sx = lerp(0.5, 1.32, e);
          blob.sy = lerp(1.38, 1.32, e);
          blob.at(from);
        }
      } else {
        // A little shrug, eyes squeezed, then poof.
        const e = Math.sin((Math.PI * t) / BURST);
        blob.sx = 1 + 0.16 * e;
        blob.sy = 1 - 0.14 * e;
        blob.face = t > 40 ? "squeeze" : "happy";
      }
    } else if (!burstDone) {
      burstDone = true;
      blob.shown = false;
      ring(from, hard ? 74 : 46);
      sparkle(from, hard ? 8 : 5, hard ? 260 : 150);
      sfx.pop();
      spawn();
    }

    for (const d of drops) {
      if (d.home) continue;
      if (t < d.turn) {
        // Flung out: gravity and air drag.
        d.vy += 1100 * (dt / 1000);
        d.vx *= Math.pow(0.985, dt / 16);
        d.vy *= Math.pow(0.985, dt / 16);
        d.x += (d.vx * dt) / 1000;
        d.y += (d.vy * dt) / 1000;
      } else {
        // Then pulled home: a smooth curve from wherever it is, keeping its momentum at first.
        if (!d.p0) {
          d.p0 = { x: d.x, y: d.y };
          d.v0 = { x: d.vx / 1000, y: d.vy / 1000 };
          d.dur = trip * rand(0.9, 1.1);
        }
        const s = clamp((t - d.turn) / d.dur!, 0, 1);
        const h10 = s * s * s - 2 * s * s + s;
        const h01 = -2 * s * s * s + 3 * s * s;
        const h00 = 1 - h01;
        d.x = h00 * d.p0.x + h10 * d.dur! * d.v0!.x + h01 * home.x;
        d.y = h00 * d.p0.y + h10 * d.dur! * d.v0!.y + h01 * home.y;
        if (s >= 1) {
          d.home = true;
          arrived++;
          d.crisp.remove();
          continue;
        }
      }
      // Cooling down on the way home, and shrinking as it dives into the bubble.
      const r = d.r * clamp(Math.hypot(d.x - home.x, d.y - home.y) / 36, 0.3, 1);
      d.dot.setAttribute("fill", mix(hard ? angry : ACCENT, ACCENT, (t - BURST) / 500));
      for (const [c, off] of [[d.dot, 0], [d.shade, 1.6]] as const) {
        c.setAttribute("cx", (d.x + off).toFixed(1));
        c.setAttribute("cy", (d.y + off).toFixed(1));
        c.setAttribute("r", r.toFixed(2));
      }
    }

    // All home: the bubble (which stayed on screen) gulps them down.
    if (arrived === N && allIn < 0) {
      allIn = t;
      sfx.tap();
      void emitTo("bubble", "bubble-gulp");
    }
    blob.draw();
    // The mini is gone as soon as it bursts, so it's handed back (hidden) right away.
    return { handoff: burstDone, done: allIn >= 0 && t - allIn > 60 };
  };
}

// ---- run ----------------------------------------------------------------------------------
function counts(timeout: number): Promise<Counts | null> {
  return new Promise((resolve) => {
    let stop: (() => void) | null = null;
    let over = false;
    const end = (c: Counts | null) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      stop?.();
      resolve(c);
    };
    const timer = setTimeout(() => end(null), timeout);
    // The window is kept between moments, so each one stops listening when it has its answer.
    void listen<Counts>("counts", ({ payload }) => end(payload)).then((u) => {
      stop = u;
      if (over) u();
      else void emitTo("main", "bubble-ready");
    });
  });
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
/** A frame, or a moment: while this window is still hidden its frames come late or not at all. */
const frameOrSoon = () => Promise.race([frame(), new Promise<number>((r) => setTimeout(() => r(performance.now()), 34))]);

/** The moment playing (or last played), so the same one never plays twice. */
let current = 0;

/** Plays one moment. The window is made once and kept (hidden) between moments: making a new
 *  web view for each one made them stutter while it started up. */
async function play(p: Payload & { run: number }) {
  if (p.run <= current) return;
  current = p.run;
  // Colours may have changed since the last one.
  ACCENT = storedAccent();
  FACE = onAccent(ACCENT);
  FACES = faceSet();
  for (const layer of [crisp, goo, faces, bits]) layer.replaceChildren();
  sparks.length = 0;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    await invoke("fx_handoff").catch(() => {});
    return void invoke("fx_done");
  }
  const c = await counts(150);
  const openIn = (space: string | null) => (c ? (space ? c.spaces?.[space] ?? 0 : c.open) : 1);
  const step = p.kind === "split" ? split(p, openIn(p.space) === 0, openIn(null) === 0) : burst(p, p.kind === "pop");

  // Draw the first frame (identical to the bubble) before this window shows; Rust then shows it
  // and hides the real bubble's blob.
  step(0, 0);
  await frameOrSoon();
  await frameOrSoon();
  await invoke("fx_ready").catch(() => {});

  let handed = false;
  let last = await frame();
  const t0 = last;
  for (;;) {
    const now = await frame();
    const dt = Math.min(40, now - last);
    last = now;
    const { handoff, done } = step(now - t0, dt);
    stepSparks(dt);
    if (handoff && !handed) {
      handed = true;
      void invoke("fx_handoff");
    }
    if (done && sparks.length === 0) break;
    if (p.run !== current) return; // a newer moment took over
  }
  if (!handed) await invoke("fx_handoff").catch(() => {});
  // Nothing left drawn for the next time the window shows.
  for (const layer of [crisp, goo, faces, bits]) layer.replaceChildren();
  void invoke("fx_done");
}

void listen<Payload & { run: number }>("fx-play", ({ payload }) => void play(payload));
// A moment asked for before this page was listening (the first one, while it was being made).
void invoke<(Payload & { run: number }) | null>("fx_payload").then((p) => p && play(p)).catch(() => {});

// The always-on-screen bubble. Plain TS, no framework, so it costs almost nothing to keep open.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { THEME_KEY, resolveAccent } from "./lib/theme-colors";
import { sfx } from "./lib/sfx";

const win = getCurrentWindow();
const button = document.getElementById("b") as HTMLButtonElement;
const badge = document.getElementById("n") as HTMLSpanElement;

// ---- click vs drag -------------------------------------------------------------
// A press that moves more than a few pixels drags the bubble (unless it's locked); a press that
// doesn't is a click that opens Quicky next to it. The normal bubble and each app's mini have
// their own lock; this is the one for whatever the bubble is showing as right now.
let locked = false;
invoke<boolean>("get_bubble_locked").then((v) => (locked = v)).catch(() => {});

let press: { x: number; y: number } | null = null;

// ---- jelly (locked in place) -------------------------------------------------------
// Tugging a locked bubble doesn't move it: its outline is re-drawn as a soft body. The side you
// pull bulges after the pointer, the far side stays anchored, the waist thins to keep its volume,
// and a spring with momentum makes it lag, overshoot and wobble back when you let go. It gets
// angrier the harder you pull.
const bodyPath = document.getElementById("body") as unknown as SVGPathElement;
const shadowPath = document.getElementById("shadow") as unknown as SVGPathElement;
const face = document.getElementById("face") as unknown as SVGGElement;

const CX = 20, CY = 19, RX = 19, R_TOP = 18, R_BOTTOM = 16; // resting blob, in view-box units
const POINTS = 32;
const MAX_PULL = 13; // how far (view-box units, ~1.45 px each) the jelly can be drawn out
const STIFF = 0.14; // spring towards where the pointer wants it
const DAMP = 0.16; // lower = wobblier

/** Smooth closed outline of the blob deformed by a pull of (px, py). */
function outline(px: number, py: number): string {
  const len = Math.hypot(px, py);
  const ux = len ? px / len : 0;
  const uy = len ? py / len : 0;
  const amount = len / MAX_PULL;
  const pts: [number, number][] = [];
  for (let i = 0; i < POINTS; i++) {
    const a = (i / POINTS) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ox = RX * c;
    const oy = (s < 0 ? R_TOP : R_BOTTOM) * s;
    const facing = c * ux + s * uy; // 1 = side being pulled, -1 = far side
    const follow = 0.06 + 0.94 * ((facing + 1) / 2) ** 4; // far side stays put, front stretches into a drop
    const perp = ox * -uy + oy * ux; // distance from the pull axis
    const waist = 0.3 * amount * (1 - facing * facing); // sides draw in to keep the volume
    pts.push([
      CX + ox + px * follow - -uy * perp * waist,
      CY + oy + py * follow - ux * perp * waist,
    ]);
  }
  // Catmull-Rom through the points, as cubic Béziers.
  const p = (i: number) => pts[(i + POINTS) % POINTS];
  let d = `M${p(0)[0].toFixed(2)} ${p(0)[1].toFixed(2)}`;
  for (let i = 0; i < POINTS; i++) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d + "Z";
}

const jelly = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, running: false, last: 0 };
let tugging = false;

function draw() {
  const d = outline(jelly.x, jelly.y);
  bodyPath.setAttribute("d", d);
  shadowPath.setAttribute("d", d);
  // The face rides along a bit and leans with the wobble.
  face.setAttribute("transform", `translate(${(jelly.x * 0.45).toFixed(2)} ${(jelly.y * 0.45).toFixed(2)})`);
}

function frame(t: number) {
  const dt = Math.min(2.5, jelly.last ? (t - jelly.last) / 16.67 : 1);
  jelly.last = t;
  jelly.vx += ((jelly.tx - jelly.x) * STIFF - jelly.vx * DAMP) * dt;
  jelly.vy += ((jelly.ty - jelly.y) * STIFF - jelly.vy * DAMP) * dt;
  jelly.x += jelly.vx * dt;
  jelly.y += jelly.vy * dt;
  draw();
  const still = Math.hypot(jelly.x - jelly.tx, jelly.y - jelly.ty) < 0.02 && Math.hypot(jelly.vx, jelly.vy) < 0.02;
  if (!tugging && still) {
    Object.assign(jelly, { x: 0, y: 0, vx: 0, vy: 0, running: false, last: 0 });
    draw();
    return;
  }
  requestAnimationFrame(frame);
}

function wake() {
  if (jelly.running) return;
  jelly.running = true;
  jelly.last = 0;
  requestAnimationFrame(frame);
}

/** Pointer offset (screen px) → where the jelly wants to be, with rubber-band resistance. */
function pull(dx: number, dy: number) {
  const dist = Math.hypot(dx, dy);
  const reach = MAX_PULL * (1 - Math.exp(-dist / 90));
  jelly.tx = dist ? (dx / dist) * reach : 0;
  jelly.ty = dist ? (dy / dist) * reach : 0;
  button.style.setProperty("--anger", String(Math.min(1, dist / 150)));
  button.classList.toggle("furious", dist > 120);
  wake();
}

function letGo() {
  if (!tugging) return;
  tugging = false;
  button.classList.remove("tugging", "furious");
  button.style.setProperty("--anger", "0");
  // A flick of extra speed back through the middle makes the snap feel like it has weight.
  jelly.vx -= jelly.x * 0.35;
  jelly.vy -= jelly.y * 0.35;
  jelly.tx = jelly.ty = 0;
  wake();
}
draw();

// ---- minis: walls, pushing, popping, dividing ---------------------------------------------
// A mini can only be dragged around inside its app's window (Rust clamps it to the window and
// reports how hard it's being pushed past a wall). Pushed against a wall it squashes flat like a
// rubber ball, gets angrier, and if pushed hard enough it pops out: that app's mini is gone.
// The big moments themselves (dividing into a new mini, popping, hiding one) play in a separate
// overlay window with room to move (src/fx.ts); this page just hands over to it and back.
const squish = document.querySelector(".squish") as HTMLElement;
const POP_AT = 90; // logical px of push past a wall that pops it out
let isMini = false;
let walled = false;
let popping = false;
let veiled = false;

/** Squash flat against the wall being pushed into; angrier the closer it gets to popping. */
function squash(px: number, py: number) {
  const push = Math.hypot(px, py);
  const a = Math.min(1, push / POP_AT);
  if (push < 0.5) {
    squish.style.transform = "";
  } else {
    const ang = Math.atan2(py, px);
    squish.style.transform = `rotate(${ang}rad) translateX(${a * 4}px) scale(${1 - a * 0.38}, ${1 + a * 0.28}) rotate(${-ang}rad)`;
  }
  button.style.setProperty("--anger", String(a));
  button.classList.toggle("furious", a > 0.7);
  if (a > 0.05 && a < 1) sfx.squish(a);
}

// Rust follows the real cursor during a walled drag (it keeps working after the pointer leaves
// this little window) and reports the push against the wall, and when it's enough to pop.
listen<{ x: number; y: number }>("wall-push", ({ payload }) => walled && squash(payload.x, payload.y));
listen("bubble-pop", () => walled && pop());

// Same for tugging a locked bubble: Rust streams the cursor while the button is held.
listen<{ x: number; y: number }>("pointer-at", ({ payload }) => {
  if (!press || !locked) return;
  const dx = payload.x - press.x;
  const dy = payload.y - press.y;
  if (!tugging && Math.hypot(dx, dy) <= 4) return;
  if (!tugging) {
    tugging = true;
    button.classList.remove("pressed");
    button.classList.add("tugging");
  }
  pull(dx, dy);
});
listen("pointer-up", () => {
  if (!tugging) return;
  press = null;
  if (Math.hypot(jelly.x, jelly.y) > 3) sfx.boing();
  letGo();
});

function calm() {
  button.style.setProperty("--anger", "0");
  button.classList.remove("furious");
}

/** Pushed too hard: the app no longer has a mini until Quicky is dropped on it again. Hold the
 *  squashed pose; the overlay takes over from exactly this pose and plays the burst. */
function pop() {
  if (popping) return;
  popping = true;
  walled = false;
  press = null;
  void invoke("mini_pop").catch(() => (popping = false));
}

function endWall() {
  if (!walled) return;
  walled = false;
  void invoke("mini_drag_end");
  // Spring back off the wall.
  const t = squish.style.transform;
  squish.style.transform = "";
  calm();
  if (t) squish.animate([{ transform: t }, { transform: "scale(1.07, 0.94)", offset: 0.5 }, { transform: "none" }], { duration: 320, easing: "ease-out" });
}

// While the overlay draws Quicky, this blob is invisible (the window itself stays up, so nothing
// replays its entrance). Rust moves and resizes it unseen, then it shows again in its new form.
listen<{ on: boolean }>("bubble-veil", ({ payload: { on } }) => {
  if (on) {
    veiled = true;
    button.style.visibility = "hidden";
    button.classList.remove("prep");
    return;
  }
  squish.getAnimations().forEach((a) => a.cancel());
  squish.style.transform = "";
  button.classList.remove("prep");
  calm();
  popping = false;
  // Two frames: let the new size and form render before showing it.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      veiled = false;
      button.style.visibility = "";
    }),
  );
});
// A little wind-up while the overlay loads.
listen("bubble-prep", () => !veiled && button.classList.add("prep"));

// Normal bubble vs. an app's mini Quicky (Rust resizes the window around the same centre).
let mySpace: string | null = null;
listen<{ mini: boolean; space: string | null; locked?: boolean }>("bubble-mini", ({ payload: { mini, space, locked: l } }) => {
  isMini = mini;
  mySpace = space;
  locked = !!l;
  showCount();
  if (veiled) {
    // Changing form unseen (after a big moment): no shrink/grow transition when it reappears.
    button.style.transition = "none";
    button.classList.toggle("mini", mini);
    void button.offsetWidth;
    button.style.transition = "";
    return;
  }
  button.classList.toggle("mini", mini);
});

// ---- pointer --------------------------------------------------------------------------------
button.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || popping) return;
  press = { x: e.screenX, y: e.screenY };
  button.classList.add("pressed");
  if (locked) void invoke("pointer_track_start");
  // Keep getting moves outside the little window (tugging, pushing against walls).
  button.setPointerCapture(e.pointerId);
});
button.addEventListener("pointermove", (e) => {
  if (!press) return;
  const dx = e.screenX - press.x;
  const dy = e.screenY - press.y;
  if (locked) {
    if (tugging || Math.hypot(dx, dy) > 4) {
      if (!tugging) {
        tugging = true;
        button.classList.remove("pressed");
        button.classList.add("tugging");
      }
      pull(dx, dy);
    }
    return;
  }
  if (walled) return; // Rust is driving it from the real cursor
  if (Math.hypot(dx, dy) <= 4) return;
  button.classList.remove("pressed");
  if (isMini) {
    // A mini moves inside its app only.
    walled = true;
    void invoke<boolean>("mini_drag_start").then((ok) => {
      if (ok) return;
      walled = false;
      press = null;
      void invoke("bubble_drag_start").then(() => win.startDragging());
    });
    return;
  }
  press = null;
  // Tell Rust first: it pauses repositioning and saves the spot when the button comes up.
  void invoke("bubble_drag_start").then(() => win.startDragging());
});
button.addEventListener("pointerup", () => {
  button.classList.remove("pressed");
  if (!press) return;
  press = null;
  if (tugging) {
    if (Math.hypot(jelly.x, jelly.y) > 3) sfx.boing();
    return letGo();
  }
  if (walled) return endWall();
  sfx.tap();
  void invoke("open_from_bubble");
});
button.addEventListener("pointercancel", () => {
  press = null;
  letGo();
  endWall();
});
// If the page loses the pointer mid-gesture (or Rust ends a drag on its own), settle down:
// never leave the face stuck in its angry pose.
// The page loses the pointer as soon as it leaves this little window, but walled drags and tugs
// are driven by Rust from the real cursor and end on the real button release (bubble-calm /
// pointer-up), so only tidy up here when neither is going on.
button.addEventListener("lostpointercapture", () => {
  if (tugging || walled) return;
  press = null;
  calm();
});
listen("bubble-calm", () => {
  if (popping) return;
  const was = walled;
  walled = false;
  press = null;
  // Spring back off the wall.
  const t = squish.style.transform;
  squish.style.transform = "";
  calm();
  if (was && t) squish.animate([{ transform: t }, { transform: "scale(1.07, 0.94)", offset: 0.5 }, { transform: "none" }], { duration: 320, easing: "ease-out" });
});
addEventListener("blur", () => {
  if (!tugging && !walled) calm();
});
button.addEventListener("pointerleave", () => !tugging && !walled && button.classList.remove("pressed"));
button.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") void invoke("open_from_bubble");
});

// ---- right-click menu ------------------------------------------------------------
button.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  press = null;
  const ctx = await invoke<{ exe: string; name: string; stuck: boolean } | null>("bubble_context").catch(() => null);
  const open = await MenuItem.new({ text: "Open Quicky", action: () => void invoke("open_from_bubble") });
  const forSpace = isMini && ctx?.stuck ? mySpace : null;
  const lock = await CheckMenuItem.new({
    text: forSpace ? "Lock this mini in place" : "Lock in place",
    checked: locked,
    action: async () => {
      locked = !locked;
      await invoke("set_bubble_locked", { locked, space: forSpace });
    },
  });
  const sep = () => PredefinedMenuItem.new({ item: "Separator" });
  // A mini's own menu: hiding it removes just this app's mini (drop Quicky on the app to get it back).
  const items =
    isMini && ctx?.stuck
      ? [
          open,
          await sep(),
          lock,
          await sep(),
          await MenuItem.new({
            text: `Hide this mini Quicky (${ctx.name})`,
            action: () => void invoke("unstick_bubble", { exe: ctx.exe }),
          }),
        ]
      : [
          open,
          await sep(),
          ctx && !ctx.stuck
            ? await MenuItem.new({ text: `Make a mini Quicky here on ${ctx.name}`, action: () => void invoke("stick_bubble").catch(() => {}) })
            : await MenuItem.new({ text: "Drop me on an app to give it a mini Quicky", enabled: false }),
          lock,
          await MenuItem.new({ text: "Move back to corner", action: () => void invoke("reset_bubble") }),
          await sep(),
          await MenuItem.new({ text: "Hide bubble", action: () => void invoke("set_show_bubble", { show: false }) }),
        ];
  await (await Menu.new({ items })).popup();
});
// ---- badge -----------------------------------------------------------------------
// The normal bubble counts the general list; an app's mini counts that app's list.
let lastOpen = -1;
let counts: { open: number; spaces: Record<string, number> } = { open: 0, spaces: {} };
listen<{ open: number; spaces?: Record<string, number> }>("counts", ({ payload }) => {
  counts = { open: payload.open, spaces: payload.spaces ?? {} };
  showCount();
});
function showCount() {
  const open = mySpace ? counts.spaces[mySpace] ?? 0 : counts.open;
  badge.hidden = open === 0;
  badge.textContent = open > 99 ? "99+" : String(open);
  button.classList.toggle("clear", open === 0);
  if (lastOpen !== -1 && open !== lastOpen) replay(badge, "pop");
  lastOpen = open;
  const label = open ? `${open} task${open === 1 ? "" : "s"} left · click to open, drag to move` : "All clear! Click to open Quicky";
  button.title = label;
  button.setAttribute("aria-label", label);
}

// ---- animations ------------------------------------------------------------------
const replay = (el: Element, cls: string) => {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth; // restart the CSS animation
  el.classList.add(cls);
  // Drop the class once it has played, so nothing (like pausing animations while tugging) can
  // accidentally start it again: the entrance one begins fully transparent.
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
};
// Hop in whenever the bubble comes back on screen.
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && replay(button, "appear"));
replay(button, "appear");
// Blink now and then.
const blink = () => {
  replay(button, "blink");
  setTimeout(blink, 3500 + Math.random() * 4000);
};
setTimeout(blink, 2500);

// ---- theme -----------------------------------------------------------------------
// Follows the accent colour picked in Settings (shared localStorage; `storage` fires on change).
const applyAccent = () => {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(THEME_KEY) ?? "{}") ?? {};
  } catch {}
  document.documentElement.style.setProperty("--accent", resolveAccent(stored));
};
applyAccent();
addEventListener("storage", (e) => e.key === THEME_KEY && applyAccent());

// Ask the main window for the current count (it may have loaded first).
void emitTo("main", "bubble-ready");

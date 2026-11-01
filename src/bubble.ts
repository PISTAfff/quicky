// The always-on-screen bubble. Plain TS, no framework, so it costs almost nothing to keep open.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { THEME_KEY, resolveAccent } from "./lib/theme-colors";

const win = getCurrentWindow();
const button = document.getElementById("b") as HTMLButtonElement;
const badge = document.getElementById("n") as HTMLSpanElement;

// ---- click vs drag -------------------------------------------------------------
// A press that moves more than a few pixels drags the bubble (unless it's locked); a press that
// doesn't is a click that opens Quicky next to it.
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

button.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY };
  button.classList.add("pressed");
  if (locked) button.setPointerCapture(e.pointerId); // keep tugging even outside the little window
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
  if (Math.hypot(dx, dy) > 4) {
    press = null;
    button.classList.remove("pressed");
    // Tell Rust first: it pauses repositioning and saves the spot when the button comes up.
    void invoke("bubble_drag_start").then(() => win.startDragging());
  }
});
button.addEventListener("pointerup", () => {
  button.classList.remove("pressed");
  if (!press) return;
  press = null;
  if (tugging) return letGo();
  void invoke("open_from_bubble");
});
button.addEventListener("pointercancel", () => {
  press = null;
  letGo();
});
button.addEventListener("pointerleave", () => !tugging && button.classList.remove("pressed"));
button.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") void invoke("open_from_bubble");
});

// ---- right-click menu ------------------------------------------------------------
button.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  press = null;
  // Offer to stick the bubble to the app window it's sitting on (or unstick it).
  const ctx = await invoke<{ exe: string; name: string; stuck: boolean } | null>("bubble_context").catch(() => null);
  const stickItems = ctx
    ? [
        await MenuItem.new({
          text: ctx.stuck ? `Remove mini Quicky from ${ctx.name}` : `Make a mini Quicky here on ${ctx.name}`,
          action: () =>
            void (ctx.stuck ? invoke("unstick_bubble", { exe: ctx.exe }) : invoke("stick_bubble")).catch(() => {}),
        }),
      ]
    : [await MenuItem.new({ text: "Drag me onto an app to give it a mini Quicky", enabled: false })];
  const menu = await Menu.new({
    items: [
      await MenuItem.new({ text: "Open Quicky", action: () => void invoke("open_from_bubble") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      ...stickItems,
      await CheckMenuItem.new({
        text: "Lock in place",
        checked: locked,
        action: async () => {
          locked = !locked;
          await invoke("set_bubble_locked", { locked });
        },
      }),
      await MenuItem.new({ text: "Move back to corner", action: () => void invoke("reset_bubble") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Hide bubble", action: () => void invoke("set_show_bubble", { show: false }) }),
    ],
  });
  await menu.popup();
});

// Normal bubble vs. an app's mini Quicky (Rust also shrinks the window).
listen<boolean>("bubble-mini", ({ payload }) => {
  button.classList.toggle("mini", payload);
  replay(button, "appear");
});

// ---- badge -----------------------------------------------------------------------
let lastOpen = -1;
listen<{ open: number }>("counts", ({ payload }) => {
  const { open } = payload;
  badge.hidden = open === 0;
  badge.textContent = open > 99 ? "99+" : String(open);
  button.classList.toggle("clear", open === 0);
  if (lastOpen !== -1 && open !== lastOpen) replay(badge, "pop");
  lastOpen = open;
  const label = open ? `${open} task${open === 1 ? "" : "s"} left · click to open, drag to move` : "All clear! Click to open Quicky";
  button.title = label;
  button.setAttribute("aria-label", label);
});

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

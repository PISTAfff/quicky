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

// Locked in place: tugging doesn't move it, it squishes towards your pointer, gets angrier the
// further you pull, and springs back with a recoil when you let go.
const squish = document.querySelector(".squish") as HTMLElement;
let tug: { x: number; y: number; transform: string } | null = null;

function stretch(dx: number, dy: number) {
  const dist = Math.hypot(dx, dy);
  const k = Math.min(dist, 160) / 160; // how hard it's being pulled, 0..1
  const ang = Math.atan2(dy, dx);
  const tx = Math.cos(ang) * k * 7;
  const ty = Math.sin(ang) * k * 7;
  const transform = `translate(${tx}px, ${ty}px) rotate(${ang}rad) scale(${1 + k * 0.2}, ${1 - k * 0.18}) rotate(${-ang}rad)`;
  squish.style.transform = transform;
  button.style.setProperty("--anger", String(Math.min(1, dist / 140)));
  button.classList.toggle("furious", dist > 110);
  tug = { x: tx, y: ty, transform };
}

function recoil() {
  if (!tug) return;
  const { x, y, transform } = tug;
  tug = null;
  squish.style.transform = "";
  button.classList.remove("furious");
  button.style.setProperty("--anger", "0");
  // Snap back past the middle, wobble, settle.
  squish.animate(
    [
      { transform },
      { transform: `translate(${-x * 0.7}px, ${-y * 0.7}px) scale(0.84, 1.16)`, offset: 0.3 },
      { transform: `translate(${x * 0.3}px, ${y * 0.3}px) scale(1.08, 0.93)`, offset: 0.55 },
      { transform: `translate(${-x * 0.1}px, ${-y * 0.1}px) scale(0.97, 1.03)`, offset: 0.8 },
      { transform: "none" },
    ],
    { duration: 650, easing: "ease-out" },
  );
}

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
    if (tug || Math.hypot(dx, dy) > 4) {
      button.classList.remove("pressed");
      stretch(dx, dy);
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
  if (tug) return recoil();
  void invoke("open_from_bubble");
});
button.addEventListener("pointercancel", () => {
  press = null;
  recoil();
});
button.addEventListener("pointerleave", () => !tug && button.classList.remove("pressed"));
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
          text: ctx.stuck ? `Unstick from ${ctx.name}` : `Stick here on ${ctx.name}`,
          action: () =>
            void (ctx.stuck ? invoke("unstick_bubble", { exe: ctx.exe }) : invoke("stick_bubble")).catch(() => {}),
        }),
      ]
    : [await MenuItem.new({ text: "Drag me onto an app to stick here", enabled: false })];
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

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
button.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY };
  button.classList.add("pressed");
});
button.addEventListener("pointermove", (e) => {
  if (!press || locked) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press = null;
    button.classList.remove("pressed");
    void win.startDragging();
  }
});
button.addEventListener("pointerup", () => {
  button.classList.remove("pressed");
  if (!press) return;
  press = null;
  void invoke("open_from_bubble");
});
button.addEventListener("pointerleave", () => button.classList.remove("pressed"));
button.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") void invoke("open_from_bubble");
});

// ---- right-click menu ------------------------------------------------------------
button.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  press = null;
  const menu = await Menu.new({
    items: [
      await MenuItem.new({ text: "Open Quicky", action: () => void invoke("open_from_bubble") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
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

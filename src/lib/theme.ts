// Accent colour + light/dark mode. Stored per PC in the WebView's localStorage, which the
// bubble window shares (same origin) and hears about through the `storage` event.
import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { ACCENTS, DEFAULT_CUSTOM, THEME_KEY, isHex, paintTheme } from "./theme-colors";

export { ACCENTS, THEME_KEY };

export type AccentId = (typeof ACCENTS)[number]["id"] | "custom";
export type Mode = "light" | "dark" | "auto";
export interface Theme { accent: AccentId; custom: string; mode: Mode }

const DEFAULT: Theme = { accent: "grape", custom: DEFAULT_CUSTOM, mode: "light" };

export function readTheme(): Theme {
  try {
    const t = JSON.parse(localStorage.getItem(THEME_KEY) ?? "null");
    const accentOk = t && (t.accent === "custom" || ACCENTS.some((a) => a.id === t.accent));
    if (accentOk && ["light", "dark", "auto"].includes(t.mode)) {
      return { ...DEFAULT, ...t, custom: isHex(t.custom) ? t.custom : DEFAULT_CUSTOM };
    }
  } catch {}
  return DEFAULT;
}

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

// The taskbar and tray icons are Quicky's blob in the accent colour too (Rust redraws them).
// Waits a moment so dragging the custom colour picker doesn't redraw them on every step.
let iconColor = "";
let iconTimer = 0;
function tintIcons(color: string) {
  if (color === iconColor) return;
  iconColor = color;
  clearTimeout(iconTimer);
  iconTimer = window.setTimeout(() => void invoke("set_icon_color", { color }).catch(() => {}), 150);
}

function apply(t: Theme) {
  tintIcons(paintTheme(t));
}

const [theme, setThemeSignal] = createSignal<Theme>(readTheme());
export { theme };

export function setTheme(patch: Partial<Theme>) {
  const next = { ...theme(), ...patch };
  setThemeSignal(next);
  apply(next);
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(next));
  } catch {}
}

export function initTheme() {
  apply(theme());
  darkQuery.addEventListener("change", () => theme().mode === "auto" && apply(theme()));
}

// Accent colour + light/dark mode. Stored per PC in the WebView's localStorage, which the
// bubble window shares (same origin) and hears about through the `storage` event.
import { createSignal } from "solid-js";
import { ACCENTS, THEME_KEY } from "./theme-colors";

export { ACCENTS, THEME_KEY };

export type AccentId = (typeof ACCENTS)[number]["id"];
export type Mode = "light" | "dark" | "auto";
export interface Theme { accent: AccentId; mode: Mode }

const DEFAULT: Theme = { accent: "grape", mode: "light" };

export function readTheme(): Theme {
  try {
    const t = JSON.parse(localStorage.getItem(THEME_KEY) ?? "null");
    if (t && ACCENTS.some((a) => a.id === t.accent) && ["light", "dark", "auto"].includes(t.mode)) return t;
  } catch {}
  return DEFAULT;
}

export const accentColor = (id: AccentId) => ACCENTS.find((a) => a.id === id)!.color;

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function apply(t: Theme) {
  const root = document.documentElement;
  root.style.setProperty("--accent", accentColor(t.accent));
  root.dataset.mode = t.mode === "auto" ? (darkQuery.matches ? "dark" : "light") : t.mode;
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

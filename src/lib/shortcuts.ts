// The shortcuts as they are now, for labels and the main window's own keys. Global ones live in
// Rust's config (per PC; `shortcuts.rs` registers them) and arrive through `shortcuts_get` and
// the `shortcuts-changed` event; in-app ones are per PC in localStorage (never synced).
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IS_MOBILE, OS } from "./platform";
import { label, normalize } from "./keys";

export type GlobalId = "quick" | "bubble" | "screen" | "draw" | "record";
/** `taken`: keys another app owns; `available`: false for the screen tools without their extension. */
export interface GlobalShortcut { id: GlobalId; keys: string[]; defaults: string[]; taken: string[]; available: boolean }

const [globals, setGlobals] = createSignal<GlobalShortcut[]>([]);
export { globals };

export const refreshGlobals = () =>
  invoke<GlobalShortcut[]>("shortcuts_get").then(setGlobals).catch(() => {});

if (!IS_MOBILE) {
  void refreshGlobals();
  void listen("shortcuts-changed", () => void refreshGlobals());
  // Keys another app had may be free again: try them whenever Quicky comes back.
  addEventListener("focus", () => {
    if (globals().some((g) => g.taken.length)) void invoke("shortcuts_retry").catch(() => {});
  });
}

/** A global shortcut's keys as shown in tips: the first that works ("" when none does). */
export function globalLabel(id: GlobalId): string {
  const s = globals().find((g) => g.id === id);
  if (!s) return "";
  const k = s.keys.find((k) => !s.taken.includes(k));
  return k ? label(k, OS) : "";
}

// ---- in-app shortcuts ---------------------------------------------------------------------------

export type LocalId = "add" | "search";
const LOCAL_KEY = "quicky-keys";
const mod = OS === "mac" ? "Super" : "Ctrl";
export const LOCAL_DEFAULTS: Record<LocalId, string> = { add: `${mod}+N`, search: `${mod}+F` };

function readLocal(): Record<LocalId, string> {
  const out = { ...LOCAL_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}") as Record<string, unknown>;
    for (const id of Object.keys(out) as LocalId[]) {
      const v = saved[id];
      if (typeof v === "string" && normalize(v) !== null) out[id] = normalize(v)!;
    }
  } catch {}
  return out;
}

const [locals, setLocals] = createSignal(readLocal());
export { locals };

/** New keys for an in-app shortcut (`null`: its default; "": none). */
export function setLocal(id: LocalId, keys: string | null) {
  const next = { ...locals(), [id]: keys ?? LOCAL_DEFAULTS[id] };
  setLocals(next);
  try {
    const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== LOCAL_DEFAULTS[k as LocalId]));
    localStorage.setItem(LOCAL_KEY, JSON.stringify(changed));
  } catch {}
}

export const localLabel = (id: LocalId) => (locals()[id] ? label(locals()[id], OS) : "");

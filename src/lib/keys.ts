// Shortcut keys written one way everywhere: "Ctrl+Alt+Shift+Super+<key>" (modifiers in that
// order, letters and digits bare, everything else by its key code name, like "Space", "F5" or
// "ArrowUp"). That's the shortcut plugin's format, and `canonical` in `src-tauri/src/shortcuts.rs`
// writes them the same way. Pure (no Tauri, no `navigator`), so `tests/` can run it.

export type Os = "windows" | "mac" | "linux";

const MODS = ["Ctrl", "Alt", "Shift", "Super"] as const;
type Mod = (typeof MODS)[number];
const MOD_NAMES: Record<string, Mod> = {
  ctrl: "Ctrl", control: "Ctrl",
  alt: "Alt", option: "Alt",
  shift: "Shift",
  super: "Super", cmd: "Super", command: "Super", meta: "Super", win: "Super",
};

const NAMED = [
  "Space", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Escape",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backquote", "Backslash", "BracketLeft", "BracketRight",
  "Comma", "Period", "Slash", "Semicolon", "Quote", "Minus", "Equal", "PrintScreen", "ScrollLock", "Pause",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter",
];

/** A key code (`KeyboardEvent.code`, or a name typed in an accelerator) as written in one. */
export function keyName(code: string): string | null {
  const m = /^(?:Key)?([A-Za-z])$/.exec(code) ?? /^(?:Digit)?([0-9])$/.exec(code);
  if (m) return m[1].toUpperCase();
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(code)) return code.toUpperCase();
  if (/^Numpad[0-9]$/i.test(code)) return "Numpad" + code.slice(-1);
  return NAMED.find((n) => n.toLowerCase() === code.toLowerCase()) ?? null;
}

/** The canonical form of keys written any way ("shift+control+KeyD" → "Ctrl+Shift+D"); null
 *  when it isn't one key with modifiers. "" stays "" (no shortcut). */
export function normalize(accel: string): string | null {
  if (accel === "") return "";
  const parts = accel.split("+").map((p) => p.trim());
  const mods = new Set<Mod>();
  let key: string | null = null;
  for (const [i, p] of parts.entries()) {
    const mod = MOD_NAMES[p.toLowerCase()];
    if (mod && i < parts.length - 1) mods.add(mod);
    else if (i === parts.length - 1) key = keyName(p);
    else return null;
  }
  if (!key) return null;
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

type KeyEventLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** The keys a key press makes (null while only modifiers are down, or for a key Quicky doesn't
 *  name). Uses the key's place (`code`), so ⌥ letters on a Mac and other layouts still work. */
export function fromEvent(e: KeyEventLike): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const mods: Mod[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return [...mods, key].join("+");
}

/** The press is these keys. */
export const matches = (e: KeyEventLike, accel: string) => accel !== "" && fromEvent(e) === normalize(accel);

const MAC_SYMBOL: Record<Mod, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘" };
const KEY_LABEL: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Backquote: "`", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Minus: "-", Equal: "=", Escape: "Esc", Delete: "Del", PageUp: "Page Up",
  PageDown: "Page Down", PrintScreen: "Print Screen", NumpadAdd: "Num +", NumpadSubtract: "Num -", NumpadMultiply: "Num *",
  NumpadDivide: "Num /", NumpadDecimal: "Num .", NumpadEnter: "Num Enter",
};

/** How keys are shown: "Ctrl+Shift+D" on Windows and Linux, "⌥⇧ D" on macOS (like its menus). */
export function label(accel: string, os: Os): string {
  const n = normalize(accel);
  if (!n) return "None";
  const parts = n.split("+");
  const key = parts.pop()!;
  const k = KEY_LABEL[key] ?? key.replace(/^Numpad(\d)$/, "Num $1");
  if (os === "mac") return parts.length ? `${parts.map((p) => MAC_SYMBOL[p as Mod]).join("")} ${k}` : k;
  const name = (m: string) => (m === "Super" ? (os === "windows" ? "Win" : "Super") : m);
  return [...parts.map(name), k].join("+");
}

/** Why these keys can't be a shortcut (null: they can). Global ones and in-app ones both need
 *  Ctrl, Alt or the system key, so typing never sets one off; Esc and Backspace cancel and clear
 *  while recording. */
export function problem(accel: string, os: Os): string | null {
  const n = normalize(accel);
  if (n === null) return "Quicky doesn't know that key";
  if (n === "") return null;
  const parts = n.split("+");
  const key = parts.pop()!;
  if (!parts.some((p) => p !== "Shift")) {
    return os === "mac" ? "Hold ⌘, ⌥ or ⌃ with it" : `Hold Ctrl, Alt or ${os === "windows" ? "Win" : "Super"} with it`;
  }
  if (key === "Escape" || key === "Backspace") return "Esc and Backspace can't be shortcuts";
  return null;
}

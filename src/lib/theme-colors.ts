// Plain data shared by the app and the bubble (kept free of Solid so the bubble stays tiny).
export const ACCENTS = [
  { id: "grape", name: "Grape", color: "#6d4cff" },
  { id: "bubblegum", name: "Bubblegum", color: "#d6336c" },
  { id: "mint", name: "Mint", color: "#1f8f6a" },
  { id: "tangerine", name: "Tangerine", color: "#c2561a" },
  { id: "ocean", name: "Ocean", color: "#2f6fdb" },
] as const;

export const THEME_KEY = "quicky-theme";
export const DEFAULT_CUSTOM = "#ff7eb6";
const HEX = /^#[0-9a-f]{6}$/i;

/** The accent hex for a stored theme: a preset, or the user's own colour when accent is "custom". */
export function resolveAccent(t: { accent?: string; custom?: string }): string {
  if (t.accent === "custom" && t.custom && HEX.test(t.custom)) return t.custom;
  return ACCENTS.find((a) => a.id === t.accent)?.color ?? ACCENTS[0].color;
}

/** Text colour that stays readable on top of the accent (white on dark accents, ink on light ones). */
export function onAccent(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Pick whichever of white / #2b2540 (relative luminance ≈ 0.022) contrasts more.
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.072 ? "#ffffff" : "#2b2540";
}

export const isHex = (s: unknown): s is string => typeof s === "string" && HEX.test(s);

// Plain data shared by the app and the bubble (kept free of Solid so the bubble stays tiny).
export const ACCENTS = [
  { id: "grape", name: "Grape", color: "#6d4cff" },
  { id: "bubblegum", name: "Bubblegum", color: "#d6336c" },
  { id: "mint", name: "Mint", color: "#1f8f6a" },
  { id: "tangerine", name: "Tangerine", color: "#c2561a" },
  { id: "ocean", name: "Ocean", color: "#2f6fdb" },
] as const;

export const THEME_KEY = "quicky-theme";

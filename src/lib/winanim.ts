// Where Quicky can't take a picture of a window (macOS, Linux; `src-tauri/src/anim.rs`), the
// window squishes its own content before it hides, and springs it back when it opens (`win-anim`).
// Pure CSS, so late frames don't matter; with reduced motion it does nothing. The main page also
// reports reduced motion to Rust here, which every window's animation follows.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Anim { phase: "open" | "close"; origin: { x: number; y: number } | null; ms: number }

const CSS = `
html.wa-close, html.wa-open { background: var(--bg); }
html.wa-close body { transform: scale(0.93, 0.9); transform-origin: var(--wa-origin); transition: transform var(--wa-ms) cubic-bezier(0.5, 0, 0.75, 0); }
html.wa-open body { transform-origin: var(--wa-origin); animation: wa-open calc(var(--wa-ms) + 80ms) ease-out both; }
@keyframes wa-open { 0% { transform: scale(0.93, 0.9); } 60% { transform: scale(1.008, 1.016); } 100% { transform: none; } }
`;

const reduce = matchMedia("(prefers-reduced-motion: reduce)");

/** Plays this window's part of its open and close animations. `report`: this page tells Rust
 *  whether the system asks for less motion (the main page does, for every window). */
export function followWindowAnim(report = false) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const root = document.documentElement;
  void getCurrentWindow().listen<Anim>("win-anim", ({ payload }) => {
    root.classList.remove("wa-open", "wa-close");
    if (reduce.matches || !payload.ms) return;
    const o = payload.origin;
    root.style.setProperty("--wa-origin", o ? `${o.x}px ${o.y}px` : "50% 50%");
    root.style.setProperty("--wa-ms", `${payload.ms}ms`);
    void root.offsetWidth; // start from where it is now
    root.classList.add(payload.phase === "open" ? "wa-open" : "wa-close");
  });
  // Shown some other way than through Rust's animation: never stay squished.
  addEventListener("focus", () => setTimeout(() => root.classList.contains("wa-open") || root.classList.remove("wa-close"), 400));
  if (report) {
    const tell = () => void invoke("set_reduced_motion", { reduce: reduce.matches }).catch(() => {});
    tell();
    reduce.addEventListener("change", tell);
  }
}

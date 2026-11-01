// The always-on-screen bubble. Plain TS, no framework, so it costs almost nothing to keep open.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";

const button = document.getElementById("b") as HTMLButtonElement;
const badge = document.getElementById("n") as HTMLSpanElement;

button.addEventListener("click", () => invoke("toggle_main"));
button.addEventListener("contextmenu", (e) => e.preventDefault());

listen<{ open: number }>("counts", ({ payload }) => {
  const { open } = payload;
  badge.hidden = open === 0;
  badge.textContent = open > 99 ? "99+" : String(open);
  button.classList.toggle("clear", open === 0);
  const label = open ? `${open} task${open === 1 ? "" : "s"} left · click to open Quicky` : "All clear! Click to open Quicky";
  button.title = label;
  button.setAttribute("aria-label", label);
});

// Ask the main window for the current count (it may have loaded first).
void emitTo("main", "bubble-ready");

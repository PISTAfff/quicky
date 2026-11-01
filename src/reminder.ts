// Full-screen reminder: grows out of the bubble, stays until the user answers.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { THEME_KEY, onAccent, resolveAccent } from "./lib/theme-colors";
import "./reminder.css";
import { sfx } from "./lib/sfx";

interface Rect { x: number; y: number; w: number; h: number }
interface Payload { id: string; title: string; note: string; time: string; origin: { x: number; y: number }; focus?: Rect }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flood = $("flood");
let current: Payload | null = null;
let closing = false;
// Ignore keys for a moment so a keystroke meant for another app doesn't answer the reminder.
let armedAt = Infinity;

function theme() {
  let stored: { accent?: string; custom?: string; mode?: string } = {};
  try {
    stored = JSON.parse(localStorage.getItem(THEME_KEY) ?? "{}") ?? {};
  } catch {}
  const accent = resolveAccent(stored);
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  root.setProperty("--on-accent", onAccent(accent));
}

function render(p: Payload) {
  current = p;
  $("title").textContent = p.title;
  $("note").textContent = p.note;
  $("note").hidden = !p.note;
  $("time").textContent = p.time === "Snoozed reminder" ? "Back again!" : `It's ${p.time} — remember this?`;
  flood.style.setProperty("--ox", `${p.origin.x}px`);
  flood.style.setProperty("--oy", `${p.origin.y}px`);
  if (p.focus) {
    Object.assign($("area").style, {
      inset: "auto", left: `${p.focus.x}px`, top: `${p.focus.y}px`, width: `${p.focus.w}px`, height: `${p.focus.h}px`,
    });
  }
}

function answer(action: "doing" | "done" | "snooze" | "open", minutes?: number) {
  if (!current || closing) return;
  closing = true;
  ({ doing: sfx.doing, done: sfx.done, snooze: sfx.snooze, open: sfx.open })[action]();
  const msg = { id: current.id, action, minutes };
  flood.classList.remove("in");
  flood.classList.add("out");
  setTimeout(() => void invoke("close_reminder", { action: msg }), 320);
}

$("doing").addEventListener("click", () => answer("doing"));
$("done").addEventListener("click", () => answer("done"));
$("open").addEventListener("click", () => answer("open", 10));
document.querySelectorAll<HTMLButtonElement>(".snooze button").forEach((b) =>
  b.addEventListener("click", () => answer("snooze", Number(b.dataset.min))),
);

addEventListener("keydown", (e) => {
  if (performance.now() < armedAt) return;
  const k = e.key.toLowerCase();
  const actions: Record<string, () => void> = {
    d: () => answer("doing"),
    enter: () => answer("done"),
    o: () => answer("open", 10),
    s: () => answer("snooze", 10),
    escape: () => answer("snooze", 10),
    "1": () => answer("snooze", 5),
    "2": () => answer("snooze", 10),
    "3": () => answer("snooze", 30),
    "4": () => answer("snooze", 60),
  };
  if (actions[k]) {
    e.preventDefault();
    actions[k]();
  }
});

// Another reminder can arrive while this one is still up (e.g. a preview): just swap the content.
void listen<Payload>("reminder", ({ payload }) => render(payload));

async function start() {
  theme();
  const p = await invoke<Payload | null>("reminder_payload");
  if (!p) return void invoke("close_reminder", { action: { id: "", action: "snooze" } });
  render(p);
  // Paint once (fully transparent), then show the window and grow.
  requestAnimationFrame(() =>
    requestAnimationFrame(async () => {
      await invoke("reminder_ready");
      flood.classList.add("in");
      sfx.remind();
      armedAt = performance.now() + 700;
      ($("doing") as HTMLButtonElement).focus({ preventScroll: true });
    }),
  );
}
void start();

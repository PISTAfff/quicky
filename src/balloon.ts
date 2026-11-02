// The speech balloon over the bubble: the task pinned to it, or a peek at the top of the bubble's
// list while the pointer rests on it. Rust shows, hides and places the window; the main page sends
// the words. Plain TS, like the bubble.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { THEME_KEY, resolveAccent } from "./lib/theme-colors";

interface Peek { name: string; items: { title: string; status: string; due?: string }[]; more: number }
interface Data { focus: { title: string; since: number } | null; peek: Record<string, Peek> }
interface Mode { peek: boolean; space: string | null }

const card = document.getElementById("card") as HTMLDivElement;
let data: Data = { focus: null, peek: {} };
let mode: Mode = { peek: false, space: null };
let shown = "";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "just now", "12 min", "1 h 5 min". */
function since(ms: number) {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

function render() {
  let html = "";
  if (mode.peek) {
    const p = data.peek[mode.space ?? ""];
    const items = p?.items ?? [];
    html = `<div class="kicker">${esc(p?.name ?? (mode.space ? "This app" : "General"))}</div>`;
    html += items.length
      ? `<ul>${items.map((t) => `<li><i class="${t.status}"></i><span>${esc(t.title)}</span>${t.due ? `<small>${esc(t.due)}</small>` : ""}</li>`).join("")}</ul>`
      : `<div class="empty">All clear! Nothing left here.</div>`;
    if (p && p.more > 0) html += `<div class="more">+${p.more} more</div>`;
  } else if (data.focus) {
    html = `<div class="kicker">Doing now<time>${since(data.focus.since)}</time></div><div class="title">${esc(data.focus.title)}</div>`;
  }
  card.hidden = !html;
  card.innerHTML = html;
  // A little pop whenever it starts saying something new (not on every refresh).
  const key = mode.peek ? `peek ${mode.space}` : data.focus ? `focus ${data.focus.title}` : "";
  if (key && key !== shown) {
    card.classList.remove("in");
    void card.offsetWidth;
    card.classList.add("in");
  }
  shown = key;
}

function geometry(g: { below: boolean; tail: number }) {
  document.body.classList.toggle("below", g.below);
  card.style.setProperty("--tail", `${Math.max(18, Math.min(innerWidth - 34, g.tail - 8))}px`);
}

void listen<Data>("balloon-data", ({ payload }) => {
  data = payload;
  render();
});
void listen<Mode>("balloon-mode", ({ payload }) => {
  mode = payload;
  render();
});
void listen<{ below: boolean; tail: number }>("balloon-geom", ({ payload }) => geometry(payload));
setInterval(() => !mode.peek && data.focus && render(), 30_000);

const applyAccent = () => {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(THEME_KEY) ?? "{}") ?? {};
  } catch {}
  document.documentElement.style.setProperty("--accent", resolveAccent(stored));
};
applyAccent();
addEventListener("storage", (e) => e.key === THEME_KEY && applyAccent());

void invoke<{ mode: Mode; below: boolean; tail: number }>("balloon_state").then((s) => {
  mode = s.mode;
  geometry(s);
  render();
});
// Ask the main window for the words.
void emitTo("main", "balloon-ready");

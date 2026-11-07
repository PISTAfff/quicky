// The window an installed extension runs in. The extension is a sandboxed frame (no access to
// Quicky's commands, files, storage or sign-in); it talks to this page with postMessage through
// `lib/ext-host.ts`, which makes the project API calls for it with the user's session and passes
// live updates on.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readAccount, readInstalled } from "./lib/cloud";
import { followTheme } from "./lib/theme-colors";
import { DRAW_ALLOWED, hostExtension, TASKS_ALLOWED, type TaskAnswer } from "./lib/ext-host";
import { label } from "./lib/keys";
import { OS } from "./lib/platform";
import { followWindowAnim } from "./lib/winanim";
import { sendExtensionIcon } from "./lib/ext-icon";

followTheme();
followWindowAnim();
const win = getCurrentWindow();
document.getElementById("wb-min")!.onclick = () => void win.minimize();
document.getElementById("wb-max")!.onclick = () => void win.toggleMaximize();
document.getElementById("wb-close")!.onclick = () => void win.close();
// Double-clicking the bar maximizes, like a system title bar.
document.querySelector(".titlebar")!.addEventListener("dblclick", (e) => {
  if (!(e.target as HTMLElement).closest("button")) void win.toggleMaximize();
});
// The window is labelled `ext-<id>` (see `extensions.rs`).
const id = win.label.replace(/^ext-/, "");
const installed = readInstalled().find((i) => i.id === id);
if (installed) document.title = document.getElementById("ext-name")!.textContent = installed.name;
// Its own taskbar and window icon: the blob with this extension's badge.
void sendExtensionIcon(installed ?? { id, name: id });
// The window starts hidden: once this page has painted it springs open (a hidden page gets its
// frames late, so a short timeout stands in for them).
void new Promise<void>((painted) => {
  requestAnimationFrame(() => requestAnimationFrame(() => painted()));
  setTimeout(painted, 150);
}).then(() => invoke("extension_ready"));

let taskReq = 0;
const taskReplies = new Map<number, (r: TaskAnswer) => void>();

const stage = document.getElementById("stage")!;

function note(title: string, text: string) {
  stage.replaceChildren();
  const box = document.createElement("div");
  box.className = "note";
  const h = document.createElement("h1");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  box.append(h, p);
  stage.append(box);
}

// Account changes in another window (signing in or out from Settings) reload this one.
addEventListener("storage", (e) => {
  if (e.key === "quicky-account" || e.key === "quicky-extensions") location.reload();
});

async function start() {
  const account = readAccount();
  if (!account) return note("Sign in to use this", "Open Quicky's Settings, choose Sign in, and this window will open your projects.");
  const path = installed ? await invoke<string | null>("extension_file", { id }).catch(() => null) : null;
  if (!path) return note("Not installed", "Install this extension again from Settings → Extensions.");

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.title = installed!.name;
  frame.src = convertFileSrc(path);
  stage.replaceChildren(frame);

  const { post } = hostExtension(frame, {
    id,
    // Quicky's own tasks (the calendar): the main window answers.
    tasks: (op, args) => {
      const reqId = ++taskReq;
      const answer = new Promise<TaskAnswer>((resolve) => {
        taskReplies.set(reqId, resolve);
        setTimeout(() => taskReplies.delete(reqId) && resolve({ ok: false, error: "Quicky didn't answer" }), 8000);
      });
      void emitTo("main", "ext-tasks", { from: win.label, reqId, op, args });
      return answer;
    },
    // The board's eyedropper: Quicky reads the colour under the pointer anywhere on screen.
    pickColor: async (send) => {
      const stop = await win.listen<string>("picker-color", (ev) => send({ type: "picker-color", hex: ev.payload }));
      const hex = await invoke<string | null>("pick_screen_color").catch(() => null);
      stop();
      return hex;
    },
    // A calendar event changed: Quicky's reminders read them again.
    onEventsChanged: () => void emitTo("main", "calendar-changed").catch(() => {}),
    // Draw on screen: its window starts the overlay and shows its shortcut as Settings has it.
    ...(id === DRAW_ALLOWED ? { draw: () => invoke<void>("draw_open"), keys: drawKeys } : {}),
  });
  if (id === DRAW_ALLOWED) void listen("shortcuts-changed", async () => post({ type: "keys", keys: await drawKeys() }));

  // Answers about Quicky's tasks, and word that they changed.
  if (TASKS_ALLOWED.includes(id)) {
    void win.listen<{ reqId: number } & TaskAnswer>("ext-tasks-reply", ({ payload }) => {
      const resolve = taskReplies.get(payload.reqId);
      taskReplies.delete(payload.reqId);
      resolve?.(payload);
    });
    void win.listen("tasks-changed", () => post({ type: "tasks-changed" }));
  }
}

/** Draw on screen's shortcut as shown ("" when it has none, or another app has it). */
async function drawKeys(): Promise<Record<string, string>> {
  const all = await invoke<{ id: string; keys: string[]; taken: string[] }[]>("shortcuts_get").catch(() => []);
  const d = all.find((s) => s.id === "draw");
  const k = d?.keys.find((k) => !d.taken.includes(k));
  return { draw: k ? label(k, OS) : "" };
}

void start();

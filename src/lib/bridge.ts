// The Calendar extension's way to Quicky's tasks (main window only). Its window (extension.ts)
// forwards the frame's requests here as `ext-tasks` events; this page owns the data, so every
// change goes through the store's own actions (saved, merged and synced like any other).
import { createEffect, createRoot, on } from "solid-js";
import { emitTo, listen } from "@tauri-apps/api/event";
import { addTaskTo, data, removeTask, setDue, setReminder, setStatus, spaceName, updateTask } from "./store";
import { type Reminder, type Status } from "./model";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: Status[] = ["todo", "doing", "done"];

interface Request { from: string; reqId: number; op: string; args: Record<string, unknown> }

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

/** A task as the calendar sees it. */
const view = () =>
  data.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    due: t.due ?? null,
    note: t.note ?? "",
    list: spaceName(t.space ?? null),
    /** A one-time reminder's moment (ms), shown as the task's time. */
    at: t.reminder?.on && t.reminder.mode === "once" ? (t.reminder.at ?? null) : null,
  }));

/** A one-time reminder on `day` at `time` ("HH:MM"), or none. */
function onceAt(day: string, time: string | null): Reminder | undefined {
  if (!time) return undefined;
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return { on: true, mode: "once", times: [], days: [], at: new Date(y, m - 1, d, h, min).getTime() };
}

function run(op: string, a: Record<string, unknown>): unknown {
  if (op === "list") return view();
  const due = a.due === null ? null : typeof a.due === "string" && DAY.test(a.due) ? a.due : undefined;
  const time = a.time === null ? null : typeof a.time === "string" && TIME.test(a.time) ? a.time : undefined;
  if (op === "add") {
    const title = str(a.title, 500);
    if (!title) throw new Error("A task needs a title");
    const id = addTaskTo(null, title, [], str(a.note, 5000) || undefined);
    if (!id) throw new Error("Couldn't add that task");
    if (due) setDue(id, due);
    if (due && time) setReminder(id, onceAt(due, time));
    return { id };
  }
  const id = str(a.id, 64);
  const task = data.tasks.find((t) => t.id === id);
  if (!id || !task) throw new Error("That task isn't in Quicky any more");
  if (op === "update") {
    const title = str(a.title, 500);
    const note = str(a.note, 5000);
    if (title || note !== undefined) updateTask(id, { ...(title ? { title } : {}), ...(note !== undefined ? { note } : {}) });
    if (due !== undefined) setDue(id, due ?? undefined);
    if (time !== undefined) {
      const day = due ?? task.due;
      setReminder(id, day && time ? onceAt(day, time) : undefined);
    }
    if (STATUSES.includes(a.status as Status) && a.status !== task.status) setStatus(id, a.status as Status);
    return { id };
  }
  if (op === "remove") {
    removeTask(id);
    return { id };
  }
  throw new Error("Unknown request");
}

export async function startBridge() {
  await listen<Request>("ext-tasks", ({ payload: r }) => {
    if (!r || typeof r.from !== "string" || !r.from.startsWith("ext-")) return;
    let reply: object;
    try {
      reply = { reqId: r.reqId, ok: true, data: run(String(r.op), r.args ?? {}) };
    } catch (e) {
      reply = { reqId: r.reqId, ok: false, error: (e as Error).message };
    }
    void emitTo(r.from, "ext-tasks-reply", reply);
  });
  // Changes from anywhere (this window, a reminder, another PC) show in an open calendar.
  let timer: number | undefined;
  createRoot(() =>
    createEffect(
      on(
        () => JSON.stringify(view()),
        () => {
          clearTimeout(timer);
          timer = window.setTimeout(() => void emitTo("ext-calendar", "tasks-changed").catch(() => {}), 300);
        },
        { defer: true },
      ),
    ),
  );
}

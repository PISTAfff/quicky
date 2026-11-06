// The phone's background jobs: keeping the widgets and the scheduled reminders up to date with
// the tasks, and taking in what was done from them (a tick, start, pause or delete on a widget, Done or Snooze on a
// notification, the widget's add box) through the store's own actions, so it's saved and synced
// like anything done in the app.
import { createEffect, createRoot, on } from "solid-js";
import { addTaskTo, data, removeTask, setStatus, snoozeTask, today } from "../lib/store";
import {
  byUrgency, dueLabel, eventStarts, inQuietHours, isLater, parseDay, plusDays, stepsDone, time12, upcoming, type Task,
} from "../lib/model";
import { calendarEvents, CALENDAR_ID, snoozeAlarm, startEvents, upcomingAlarms } from "../lib/events";
import { readQuiet } from "../lib/reminders";
import { readInstalled } from "../lib/cloud";
import { theme } from "../lib/theme";
import { setSheet, WEEK_LONG } from "../ui/state";
import { pushWidgets, scheduleAlarms, takeActions, type Alarm, type Row, type Snapshot } from "./native";

/** Opens an installed extension full screen (set by the app). */
let openExt: (id: string) => void = () => {};
export const onOpenExtension = (fn: (id: string) => void) => void (openExt = fn);

// ---- widgets --------------------------------------------------------------------------

const row = (t: Task, day: string): Row => {
  const due = t.due ? dueLabel(t.due, day) : null;
  const st = stepsDone(t);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    ...(due ? { due: due.text, late: due.tone === "late" } : {}),
    ...(st ? { steps: `${st.done}/${st.total} steps` } : {}),
  };
};

/** The calendar's events on one day, by time ("All day" first). */
const eventRows = (day: string): Row[] =>
  calendarEvents()
    .filter((e) => eventStarts(e, day, day).length)
    .map((e) => ({ e, at: e.allDay || !e.time ? "" : e.time }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ e, at }): Row => ({ title: e.title, time: at ? time12(at) : "All day", kind: "event" }));

/** The week widget: today (with what's late) and the next six days, only days with something on. */
function week(open: Task[], day: string): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < 7 && out.length < 60; i++) {
    const d = plusDays(i, parseDay(day));
    const tasks = open
      .filter((t) => t.due && (i === 0 ? t.due <= d : t.due === d))
      .map((t): Row => ({ ...row(t, day), time: t.due! < day ? "Overdue" : "", kind: "task" }));
    const rows = [...eventRows(d), ...tasks];
    if (!rows.length) continue;
    const date = parseDay(d);
    const name = i === 0 ? "Today" : i === 1 ? "Tomorrow" : WEEK_LONG[date.getDay()];
    out.push({ title: `${name} ${date.getDate()}`, kind: "day" }, ...rows);
  }
  return out.slice(0, 60);
}

function snapshot(): Snapshot {
  const day = today();
  const tasks = data.tasks;
  const open = tasks.filter((t) => t.status !== "done" && !isLater(t, day) && !t.space).sort(byUrgency);
  const focus = data.focus && tasks.find((t) => t.id === data.focus!.id && t.status !== "done");
  const nextTask = focus || open[0];
  // Today: the calendar's events (by time), then the tasks due today or late.
  const dueToday = open
    .filter((t) => t.due && t.due <= day)
    .map((t): Row => ({ ...row(t, day), time: t.due! < day ? "Overdue" : "Due today", kind: "task" }));
  const css = getComputedStyle(document.documentElement);
  const d = parseDay(day);
  return {
    accent: css.getPropertyValue("--accent").trim(),
    onAccent: css.getPropertyValue("--on-accent").trim(),
    dark: document.documentElement.dataset.mode === "dark",
    mode: theme().mode,
    date: `${WEEK_LONG[d.getDay()]} ${d.getDate()}`,
    tasks: open.slice(0, 40).map((t) => row(t, day)),
    next: nextTask ? { ...row(nextTask, day), pinned: !!focus } : null,
    today: [...eventRows(day), ...dueToday],
    week: week(open, day),
    counts: { open: open.length, done: tasks.filter((t) => t.status === "done" && t.doneDay === day && !t.space).length },
  };
}

// ---- reminders --------------------------------------------------------------------------

/** How far ahead reminders are handed to Android: a week (as far as `upcoming` looks), done again
 *  on every change and each time Quicky opens, so they keep coming while it's closed. Android
 *  allows about 500 alarms per app. */
const AHEAD_MS = 7 * 86_400_000;
const PER_TASK = 40;
const MAX_ALARMS = 300;

/** During quiet hours a reminder waits until they end (like the desktop's "waited for you"). */
function afterQuiet(at: number): number {
  const q = readQuiet();
  if (!q.on || !inQuietHours(new Date(at), q.from, q.to)) return at;
  const [h, m] = q.to.split(":").map(Number);
  const end = new Date(at);
  end.setHours(h, m, 0, 0);
  if (end.getTime() <= at) end.setDate(end.getDate() + 1);
  return end.getTime();
}

export function comingAlarms(): Alarm[] {
  const now = new Date();
  const until = now.getTime() + AHEAD_MS;
  const out: Alarm[] = [];
  for (const t of data.tasks) {
    for (const at of upcoming(t, now, PER_TASK)) {
      if (at > until) break;
      out.push({ key: `t:${t.id}@${at}`, at: afterQuiet(at), title: t.title, body: t.note?.trim() || `Reminder · ${time12(new Date(at))}`, task: t.id });
    }
  }
  for (const a of upcomingAlarms(now)) {
    if (a.at > until) continue;
    const when = a.event.allDay || !a.event.time ? "All day" : time12(a.event.time);
    out.push({ key: `e:${a.key}`, at: afterQuiet(a.at), title: a.title, body: [when, a.note].filter(Boolean).join(" · "), event: a.key });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, MAX_ALARMS);
}

// ---- actions from widgets and notifications ------------------------------------------------

/** Applies what was queued on the Android side. Safe to run twice: each action is idempotent. */
export async function applyActions() {
  const list = await takeActions().catch(() => []);
  for (const a of list) {
    const task = "id" in a && a.id ? data.tasks.find((t) => t.id === a.id) : undefined;
    if (a.type === "status" && task && task.status !== a.status) setStatus(task.id, a.status);
    else if (a.type === "delete" && task) removeTask(task.id);
    else if (a.type === "add" && !data.tasks.some((t) => t.id === a.id)) addTaskTo(null, a.title, [], undefined, { id: a.id, at: a.at });
    else if (a.type === "snooze") {
      if (task && task.status === "todo") snoozeTask(task.id, a.minutes);
      else if (a.event) snoozeAlarm(a.event, a.minutes);
    } else if (a.type === "open") {
      if (task) setSheet({ kind: "task", id: task.id });
      else if (a.calendar && readInstalled().some((i) => i.id === CALENDAR_ID)) openExt(CALENDAR_ID);
    }
  }
}

// ---- keeping them fresh ------------------------------------------------------------------

let widgetTimer: number | undefined;
let alarmTimer: number | undefined;
const refreshWidgets = () => {
  clearTimeout(widgetTimer);
  // What was done on a widget meanwhile goes in first, so the new picture has it.
  widgetTimer = window.setTimeout(() => void applyActions().then(() => pushWidgets(snapshot())).catch(() => {}), 400);
};
export const refreshAlarms = () => {
  clearTimeout(alarmTimer);
  alarmTimer = window.setTimeout(() => void scheduleAlarms(comingAlarms()).catch(() => {}), 600);
};

/** Starts after the tasks have loaded. */
export function startPhone() {
  startEvents(() => {
    refreshWidgets();
    refreshAlarms();
  });
  createRoot(() => {
    // Any change to the tasks, the day, the calendar or the look redraws the widgets.
    createEffect(on(() => [JSON.stringify(data), today(), calendarEvents(), theme()], refreshWidgets));
    createEffect(on(() => [JSON.stringify(data.tasks), calendarEvents()], refreshAlarms));
  });
  new MutationObserver(refreshWidgets).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-mode"] });
  addEventListener("storage", (e) => e.key === "quicky-quiet" && refreshAlarms());
  // Reminders are handed over a few days ahead: top them up now and then.
  setInterval(refreshAlarms, 30 * 60_000);
}

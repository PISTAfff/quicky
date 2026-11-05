// Decides when to show a reminder and applies what the user picked on it.
// Checks are driven by a tick from Rust (reliable even while this window is hidden, when its own
// timers only run about once a minute): every 15 s, and right when the next reminder is due.
import { createEffect, createRoot } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { dayKey, dueReminder, inQuietHours, nextReminderAt, parseDay, time12 } from "./model";
import { CALENDAR_ID, dueAlarm, markShown, nextAlarmAt, snoozeAlarm, startEvents, type Alarm } from "./events";
import { openExtension, readInstalled } from "./cloud";
import { checkDisk, data, markReminderShown, setStatus, snoozeTask } from "./store";
import { setSheet } from "../ui/state";

const PREVIEW = "__preview";
/** The "these waited for you" screen after quiet hours. */
const HELD = "__held";
let showing: string | null = null;

// Shown on the reminder: "3:30 PM" (keys keep 24-hour time; once/snooze keys carry a timestamp).
const label = (key: string) =>
  key.startsWith("snooze") ? "Snoozed reminder" : key.startsWith("once") ? time12(new Date(Number(key.slice(5)))) : time12(key.slice(-5));

// ---- quiet hours ------------------------------------------------------------------------
// A per-machine preference (main window only), next to the other ones in localStorage.

const QUIET_KEY = "quicky-quiet";
const HELD_KEY = "quicky-held";

export interface Quiet {
  on: boolean;
  from: string; // "HH:MM"
  to: string;
  /** Also wait while a full-screen app (game, video, presentation) is in front. */
  busy: boolean;
}

export function readQuiet(): Quiet {
  try {
    const q = JSON.parse(localStorage.getItem(QUIET_KEY) ?? "null");
    if (q && typeof q.on === "boolean") return { on: q.on, from: q.from ?? "22:00", to: q.to ?? "08:00", busy: q.busy ?? true };
  } catch {}
  return { on: false, from: "22:00", to: "08:00", busy: true };
}

export function writeQuiet(q: Quiet) {
  try {
    localStorage.setItem(QUIET_KEY, JSON.stringify(q));
  } catch {}
}

interface Held { id: string; title: string; time: string }

function readHeld(): Held[] {
  try {
    const h = JSON.parse(localStorage.getItem(HELD_KEY) ?? "[]");
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

function writeHeld(h: Held[]) {
  try {
    localStorage.setItem(HELD_KEY, JSON.stringify(h));
  } catch {}
}

async function quietNow(now: Date): Promise<boolean> {
  const q = readQuiet();
  if (q.on && inQuietHours(now, q.from, q.to)) return true;
  if (!q.busy) return false;
  return invoke<boolean>("system_busy").catch(() => false);
}

// ---- showing them -----------------------------------------------------------------------

/** Calendar events remind with ids of their own (their alarm key after this). */
const EVENT = "event:";

/** "3:30 PM", "All day", or with the day when it isn't today: "Thu 12, 3:30 PM". */
function eventTime(a: Alarm): string {
  const day = a.key.slice(a.key.lastIndexOf("@") + 1);
  const when = a.event.allDay || !a.event.time ? "All day" : time12(a.event.time);
  if (day === dayKey()) return when;
  const d = parseDay(day);
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}, ${when}`;
}

/** Tells Rust when the next reminder is due, so its tick wakes the check right then. */
function wakeForNext() {
  const now = new Date();
  const times = [nextReminderAt(data.tasks, now), nextAlarmAt(now)].filter((t): t is number => t !== null);
  void invoke("reminder_wake_at", { at: times.length ? Math.min(...times) : null }).catch(() => {});
}

/** Shows the first reminder that's due (one at a time; the rest follow after an answer). */
export async function checkReminders() {
  wakeForNext();
  if (showing) return;
  const now = new Date();
  const quiet = await quietNow(now);
  if (showing) return;
  if (quiet) {
    // Each one that comes due now waits; they show together once it's no longer quiet.
    for (const t of data.tasks) {
      const key = dueReminder(t, now);
      if (!key) continue;
      markReminderShown(t.id, key);
      writeHeld([...readHeld().filter((h) => h.id !== t.id), { id: t.id, title: t.title, time: label(key) }]);
    }
    for (let a = dueAlarm(now); a; a = dueAlarm(now)) {
      markShown(a.key);
      writeHeld([...readHeld(), { id: EVENT + a.key, title: a.title, time: eventTime(a) }]);
    }
    return;
  }
  const held = readHeld().filter((h) => h.id.startsWith(EVENT) || data.tasks.some((t) => t.id === h.id && t.status === "todo"));
  writeHeld([]);
  if (held.length) {
    showing = HELD;
    const n = held.length;
    const payload = {
      id: HELD,
      title: n === 1 ? "1 reminder waited for you" : `${n} reminders waited for you`,
      note: held.map((h) => `${h.time}  ·  ${h.title}`).join("\n"),
      time: "",
    };
    invoke("show_reminder", { payload }).catch(() => (showing = null));
    return;
  }
  for (const t of data.tasks) {
    const key = dueReminder(t, now);
    if (!key) continue;
    showing = t.id;
    markReminderShown(t.id, key);
    try {
      await invoke("show_reminder", { payload: { id: t.id, title: t.title, note: t.note ?? "", time: label(key) } });
    } catch {
      showing = null;
    }
    return;
  }
  const alarm = dueAlarm(now);
  if (alarm) {
    showing = EVENT + alarm.key;
    markShown(alarm.key);
    invoke("show_reminder", { payload: { id: EVENT + alarm.key, title: alarm.title, note: alarm.note, time: eventTime(alarm) } }).catch(() => (showing = null));
  }
}

/** Settings → "Preview a reminder": the real overlay with a sample task; answers do nothing. */
export function previewReminder() {
  if (showing) return;
  showing = PREVIEW;
  const now = new Date();
  const time = time12(now);
  invoke("show_reminder", {
    payload: { id: PREVIEW, title: "Water the plants", note: "This is what a reminder looks like.", time },
  }).catch(() => (showing = null));
}

interface Answer { id: string; action: "doing" | "done" | "snooze" | "open"; minutes?: number }

export async function startReminders() {
  await listen<Answer>("reminder-action", ({ payload: a }) => {
    showing = null;
    if (a.id === HELD) {
      if (a.action === "open") setSheet({ kind: "reminders" });
    } else if (a.id.startsWith(EVENT)) {
      // An event: snooze shows it again later; open shows the calendar.
      const key = a.id.slice(EVENT.length);
      if (a.action === "snooze") snoozeAlarm(key, a.minutes ?? 10);
      const cal = readInstalled().find((i) => i.id === CALENDAR_ID);
      if (a.action === "open" && cal) void openExtension(cal).catch(() => {});
    } else if (a.id !== PREVIEW) {
      if (a.action === "doing") setStatus(a.id, "doing");
      else if (a.action === "done") setStatus(a.id, "done");
      else if (a.action === "snooze") snoozeTask(a.id, a.minutes ?? 10);
      else if (a.action === "open") {
        snoozeTask(a.id, a.minutes ?? 10);
        setSheet({ kind: "task", id: a.id });
      }
    }
    setTimeout(checkReminders, 800);
  });
  // Also the moment to take in another PC's changes to a synced quicky.json (works while hidden).
  await listen("reminder-tick", () => {
    void checkDisk();
    void checkReminders();
  });
  await listen("preview-reminder", previewReminder);
  // Calendar events: read every few minutes, on focus, and when the calendar window changes one.
  startEvents(() => {
    wakeForNext();
    void checkReminders();
  });
  setInterval(checkReminders, 30_000);
  // Any change to the tasks can move the next reminder (a new time, a snooze, ticked off). Its own
  // root: this runs after awaits, outside any component, and lives as long as the app.
  createRoot(() =>
    createEffect(() => {
      JSON.stringify(data.tasks);
      wakeForNext();
    }),
  );
  void checkReminders();
}

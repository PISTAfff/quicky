// Pure data model + daily rollover. No Tauri imports here so it can be tested in Node.

export type Status = "todo" | "doing" | "done";
export type Kind = "image" | "video" | "audio" | "file";

export interface Attachment {
  id: string;
  path: string; // relative to the data folder, e.g. media/2026-11/123-photo.png
  name: string;
  kind: Kind;
}

/** One item of a task's checklist. */
export interface Step {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  id: string;
  title: string;
  status: Status;
  day: string; // the day it is listed under (always today once open tasks roll over)
  since: string; // the day it was first listed; differs from `day` when carried over
  doneDay?: string;
  repeatId?: string;
  note?: string;
  attachments: Attachment[];
  created: number;
  /** When to be reminded (see Reminder). */
  reminder?: Reminder;
  /** Older form: "HH:MM" times every day. Read via reminderOf; replaced on the next edit. */
  remind?: string[];
  /** Snoozed: remind again at this time (ms) instead. */
  snoozeUntil?: number;
  /** The last reminder already shown, so each one shows once. */
  lastFired?: string;
  /** Which app's task space it belongs to (the app's .exe key); none = the general list. */
  space?: string;
  /** The day it's due (YYYY-MM-DD). */
  due?: string;
  /** "Not today": hidden from the lists (and its reminders held) until this day. */
  later?: string;
  /** A small checklist inside the task. */
  steps?: Step[];
}

export interface Repeat {
  id: string;
  title: string;
  days: number[]; // 0 = Sunday … 6 = Saturday
  lastSpawned?: string;
  paused?: boolean;
  /** Reminder copied onto each new copy of the task. */
  reminder?: Reminder;
  remind?: string[];
  space?: string;
  /** Checklist copied (unticked) onto each new copy of the task. */
  steps?: string[];
}

export interface Data {
  version: 1;
  tasks: Task[];
  repeats: Repeat[];
  /** Display names of app task spaces, by key (e.g. "c:\\...\\chrome.exe" → "Chrome"). */
  spaces?: Record<string, string>;
  /** The task pinned to the bubble, and since when (ms). */
  focus?: { id: string; since: number };
}

export const emptyData = (): Data => ({ version: 1, tasks: [], repeats: [] });

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day as YYYY-MM-DD (never toISOString, which is UTC). */
export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export const parseDay = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** The day key `n` calendar days after `from` (by the calendar, so a clock change can't skip a day). */
export const plusDays = (n: number, from = new Date()) => {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + n);
  return dayKey(d);
};

export const weekday = (key: string) => parseDay(key).getDay();

export const daysBetween = (a: string, b: string) =>
  Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/**
 * Brings data up to `today`:
 * - every unfinished task from an earlier day moves to today (keeping `since`)
 * - each active repeat spawns one task for today if today is one of its days,
 *   unless an unfinished copy was just carried over or one was already spawned today.
 * Returns the same object when nothing changed.
 */
export function rollover(data: Data, today: string): Data {
  let changed = false;
  const tasks = data.tasks.map((t) => {
    let next = t;
    if (t.status !== "done" && t.day < today) next = { ...next, day: today };
    // Back from "not today": listed again, as a fresh task of its day.
    if (t.later && t.later <= today) {
      next = { ...next, since: t.later > t.since ? t.later : t.since };
      delete next.later;
    }
    if (next !== t) changed = true;
    return next;
  });

  const repeats = data.repeats.map((r) => {
    if (r.paused || r.lastSpawned === today || !r.days.includes(weekday(today))) return r;
    changed = true;
    const hasOpen = tasks.some((t) => t.repeatId === r.id && t.status !== "done");
    if (!hasOpen) {
      tasks.push({
        id: uid(),
        title: r.title,
        status: "todo",
        day: today,
        since: today,
        repeatId: r.id,
        attachments: [],
        created: Date.now(),
        ...(r.reminder ? { reminder: structuredClone(r.reminder) } : r.remind?.length ? { remind: [...r.remind] } : {}),
        ...(r.space ? { space: r.space } : {}),
        ...(r.steps?.length ? { steps: r.steps.map((title) => ({ id: uid(), title, done: false })) } : {}),
      });
    }
    return { ...r, lastSpawned: today };
  });

  return changed ? { ...data, tasks, repeats } : data;
}

/** A missed reminder still shows if the app was closed, but not if it's more than this late. */
export const CATCH_UP_MS = 6 * 60 * 60 * 1000;

export type RemindMode = "once" | "daily" | "days" | "every";

/** When a task reminds you. Kept even while switched off, so turning it back on restores it. */
export interface Reminder {
  on: boolean;
  mode: RemindMode;
  /** "HH:MM" times, for daily / days. */
  times: string[];
  /** Weekdays (0 = Sunday) for "days". */
  days: number[];
  /** "once": the exact moment (ms). */
  at?: number;
  /** "every": minutes between reminders, from..to ("HH:MM") each day. */
  every?: number;
  from?: string;
  to?: string;
  /** A day (YYYY-MM-DD) to skip: "not today". */
  skip?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** How times are shown: 12-hour with AM/PM ("9:00 AM"). Storage stays 24-hour "HH:MM". */
export function time12(x: Date | string): string {
  const [h, m] = typeof x === "string" ? x.split(":").map(Number) : [x.getHours(), x.getMinutes()];
  return `${h % 12 || 12}:${pad2(m)} ${h < 12 ? "AM" : "PM"}`;
}

const atTime = (day: Date, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

/** The task's reminder, reading the older "list of daily times" form too. */
export function reminderOf(t: { reminder?: Reminder; remind?: string[] }): Reminder | undefined {
  if (t.reminder) return t.reminder;
  if (t.remind?.length) return { on: true, mode: "daily", times: [...t.remind], days: [] };
  return undefined;
}

/** All reminder moments (ms) on a given calendar day, in order. */
export function slotsOn(r: Reminder, day: Date): number[] {
  if (!r.on || r.skip === dayKey(day)) return [];
  switch (r.mode) {
    case "once":
      return r.at && dayKey(new Date(r.at)) === dayKey(day) ? [r.at] : [];
    case "days":
    case "daily":
      if (r.mode === "days" && !r.days.includes(day.getDay())) return [];
      return [...new Set(r.times)].map((hm) => atTime(day, hm)).sort((a, b) => a - b);
    case "every": {
      const every = Math.max(5, r.every ?? 60);
      const start = atTime(day, r.from ?? "09:00");
      const end = atTime(day, r.to ?? "18:00");
      const out: number[] = [];
      for (let t = start; t <= end && out.length < 300; t += every * 60_000) out.push(t);
      return out;
    }
  }
}

/**
 * The reminder a task is due to show right now, as a key to record in `lastFired`, or null.
 * Only tasks still "to do" remind (picking Doing or Done answers it). A snooze replaces the
 * schedule until it goes off; otherwise the latest moment already passed shows once (if it
 * isn't hours late).
 */
export function dueReminder(t: Task, now: Date): string | null {
  if (t.status !== "todo" || isLater(t, dayKey(now))) return null;
  if (t.snoozeUntil) return now.getTime() >= t.snoozeUntil ? `snooze ${t.snoozeUntil}` : null;
  const r = reminderOf(t);
  if (!r) return null;
  const n = now.getTime();
  const passed = slotsOn(r, now).filter((at) => at <= n && n - at < CATCH_UP_MS);
  const latest = passed[passed.length - 1];
  if (latest === undefined) return null;
  const key = r.mode === "once" ? `once ${latest}` : `${dayKey(now)} ${hhmm(new Date(latest))}`;
  return key !== t.lastFired ? key : null;
}

/** The next reminder moments (ms) within the coming week, soonest first. */
export function upcoming(t: Task, now: Date, count = 3): number[] {
  if (t.status !== "todo") return [];
  const n = now.getTime();
  const out: number[] = [];
  // A snooze replaces the schedule until it goes off.
  const snoozed = t.snoozeUntil && t.snoozeUntil > n ? t.snoozeUntil : 0;
  if (snoozed) out.push(snoozed);
  const after = Math.max(n, snoozed);
  const r = reminderOf(t);
  for (let i = 0; r && i < 8 && out.length < count + 1; i++) {
    const day = new Date(now);
    day.setDate(day.getDate() + i);
    if (isLater(t, dayKey(day))) continue;
    for (const at of slotsOn(r, day)) if (at > after) out.push(at);
  }
  return [...new Set(out)].sort((a, b) => a - b).slice(0, count);
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "3:30 PM" today, "Tue 9:00 AM" this week, "12 Nov 9:00 AM" later. */
export function whenLabel(at: number, now: Date): string {
  const d = new Date(at);
  if (dayKey(d) === dayKey(now)) return time12(d);
  const days = daysBetween(dayKey(now), dayKey(d));
  if (days === 1) return `Tomorrow ${time12(d)}`;
  if (days > 0 && days < 7) return `${DAY_NAMES[d.getDay()]} ${time12(d)}`;
  return `${d.getDate()} ${d.toLocaleString("en", { month: "short" })} ${time12(d)}`;
}

/** The next reminder, as a short label (for the little bell on cards). */
export function nextReminder(t: Task, now: Date): string | null {
  const next = upcoming(t, now, 1)[0];
  return next === undefined ? null : whenLabel(next, now);
}

/** Plain-words summary: "Every day at 9:00 AM, 3:30 PM", "Every 30 min, 9:00 AM–6:00 PM", … */
export function describeReminder(r: Reminder | undefined, now: Date): string {
  if (!r) return "No reminder";
  if (!r.on) return "Off";
  const times = [...new Set(r.times)].sort().map(time12).join(", ") || "no times yet";
  let s: string;
  switch (r.mode) {
    case "once":
      s = r.at ? `Once, ${whenLabel(r.at, now)}` : "Once: pick a time";
      break;
    case "daily":
      s = `Every day at ${times}`;
      break;
    case "days": {
      const days = [...r.days].sort().map((d) => DAY_NAMES[d]);
      s = `${days.length ? days.join(", ") : "No days picked"} at ${times}`;
      break;
    }
    case "every": {
      const e = r.every ?? 60;
      s = `Every ${e % 60 === 0 ? `${e / 60} h` : `${e} min`}, ${time12(r.from ?? "09:00")}–${time12(r.to ?? "18:00")}`;
      break;
    }
  }
  return r.skip === dayKey(now) ? `${s} (not today)` : s;
}
// ---- due dates, "not today", steps, search -------------------------------------------------

/** Put off with "not today" and not back yet. */
export const isLater = (t: Pick<Task, "later">, today: string) => !!t.later && t.later > today;

/** "Overdue · Mon 3", "Due today", "Due tomorrow", "Due Fri", "Due 12 Nov". */
export function dueLabel(due: string, today: string): { text: string; tone: "late" | "today" | "soon" } {
  const days = daysBetween(today, due);
  const d = parseDay(due);
  const short = days > 1 && days < 7 ? DAY_NAMES[d.getDay()] : `${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`;
  if (days < 0) return { text: days === -1 ? "Overdue · yesterday" : `Overdue · ${DAY_NAMES[d.getDay()]} ${d.getDate()}`, tone: "late" };
  if (days === 0) return { text: "Due today", tone: "today" };
  if (days === 1) return { text: "Due tomorrow", tone: "soon" };
  return { text: `Due ${short}`, tone: "soon" };
}

/** The same, short, where the date is shown next to it or room is tight: "Overdue", "Today",
 *  "Tomorrow", "Fri", "12 Nov". */
export function shortDueLabel(due: string, today: string): string {
  const { text, tone } = dueLabel(due, today);
  if (tone === "late") return "Overdue";
  const s = text.replace(/^Due /, "");
  return s[0].toUpperCase() + s.slice(1);
}

/** Lists order: Doing first, then by how soon it's due (overdue first), then the rest as added. */
export function byUrgency(a: Task, b: Task): number {
  const doing = (t: Task) => (t.status === "doing" ? 0 : 1);
  if (doing(a) !== doing(b)) return doing(a) - doing(b);
  const due = (t: Task) => t.due ?? "9999";
  return due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : 0;
}

/** "2/3" for a task's checklist, or null without one. */
export function stepsDone(t: Pick<Task, "steps">): { done: number; total: number } | null {
  if (!t.steps?.length) return null;
  return { done: t.steps.filter((s) => s.done).length, total: t.steps.length };
}

/** Lower-case, without accents, so "cafe" finds "Café". */
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Tasks matching every word of the query, in the title, note, steps or attachment names. Open tasks
 * come first (Doing, then To do), then finished ones, most recent first.
 */
export function searchTasks(tasks: Task[], query: string): Task[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = tasks.filter((t) => {
    const hay = fold([t.title, t.note ?? "", ...(t.steps ?? []).map((s) => s.title), ...t.attachments.map((a) => a.name)].join("\n"));
    return words.every((w) => hay.includes(w));
  });
  const rank = (t: Task) => (t.status === "doing" ? 0 : t.status === "todo" ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? (b.doneDay ?? "").localeCompare(a.doneDay ?? "") : a.created - b.created));
}

/** Whether a moment falls in quiet hours from..to ("HH:MM"), which may run past midnight. */
export function inQuietHours(now: Date, from: string, to: string): boolean {
  const m = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  const a = fh * 60 + fm;
  const b = th * 60 + tm;
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

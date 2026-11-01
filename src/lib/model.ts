// Pure data model + daily rollover. No Tauri imports here so it can be tested in Node.

export type Status = "todo" | "doing" | "done";
export type Kind = "image" | "video" | "audio" | "file";

export interface Attachment {
  id: string;
  path: string; // relative to the data folder, e.g. media/2026-11/123-photo.png
  name: string;
  kind: Kind;
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
  /** "HH:MM" times to be reminded at, every day, until the task is done. */
  remind?: string[];
  /** Snoozed: remind again at this time (ms) instead. */
  snoozeUntil?: number;
  /** The last reminder already shown, so each one shows once. */
  lastFired?: string;
  /** Which app's task space it belongs to (the app's .exe key); none = the general list. */
  space?: string;
}

export interface Repeat {
  id: string;
  title: string;
  days: number[]; // 0 = Sunday … 6 = Saturday
  lastSpawned?: string;
  paused?: boolean;
  /** Reminder times copied onto each new copy of the task. */
  remind?: string[];
  space?: string;
}

export interface Data {
  version: 1;
  tasks: Task[];
  repeats: Repeat[];
  /** Display names of app task spaces, by key (e.g. "c:\\...\\chrome.exe" → "Chrome"). */
  spaces?: Record<string, string>;
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
    if (t.status !== "done" && t.day < today) {
      changed = true;
      return { ...t, day: today };
    }
    return t;
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
        ...(r.remind?.length ? { remind: [...r.remind] } : {}),
        ...(r.space ? { space: r.space } : {}),
      });
    }
    return { ...r, lastSpawned: today };
  });

  return changed ? { ...data, tasks, repeats } : data;
}

/** A missed reminder still shows if the app was closed, but not if it's more than this late. */
export const CATCH_UP_MS = 6 * 60 * 60 * 1000;

const atTime = (now: Date, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

/**
 * The reminder a task is due to show right now, as a key to record in `lastFired`, or null.
 * Only tasks still "to do" remind (picking Doing or Done answers it). A snooze replaces the
 * day's times until it goes off; otherwise the latest time already passed today shows once.
 */
export function dueReminder(t: Task, now: Date): string | null {
  if (t.status !== "todo") return null;
  if (t.snoozeUntil) return now.getTime() >= t.snoozeUntil ? `snooze ${t.snoozeUntil}` : null;
  let best = -1;
  let key: string | null = null;
  for (const hm of t.remind ?? []) {
    const at = atTime(now, hm);
    if (at <= now.getTime() && now.getTime() - at < CATCH_UP_MS && at > best) {
      best = at;
      key = `${dayKey(now)} ${hm}`;
    }
  }
  return key && key !== t.lastFired ? key : null;
}

/** The next reminder time still to come today (for the little bell on cards). */
export function nextReminder(t: Task, now: Date): string | null {
  if (t.status !== "todo") return null;
  if (t.snoozeUntil && t.snoozeUntil > now.getTime()) {
    const d = new Date(t.snoozeUntil);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const upcoming = (t.remind ?? []).filter((hm) => atTime(now, hm) > now.getTime()).sort();
  return upcoming[0] ?? null;
}
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
}

export interface Repeat {
  id: string;
  title: string;
  days: number[]; // 0 = Sunday … 6 = Saturday
  lastSpawned?: string;
  paused?: boolean;
}

export interface Data {
  version: 1;
  tasks: Task[];
  repeats: Repeat[];
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
      });
    }
    return { ...r, lastSpawned: today };
  });

  return changed ? { ...data, tasks, repeats } : data;
}

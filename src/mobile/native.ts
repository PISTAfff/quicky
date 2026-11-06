// The Android side (`src-tauri/android-plugin`, Kotlin): widgets, reminder notifications and
// what was done from them while this page wasn't looking. Every call goes through here.
import { invoke } from "@tauri-apps/api/core";

const call = <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(`plugin:quicky-android|${cmd}`, args);

/** One row of the task list widget (or the today widget, which adds `time` and `kind`). */
export interface Row {
  id?: string;
  title: string;
  status?: string;
  /** "Today", "Overdue", "Fri": the due label, as on the cards. */
  due?: string;
  late?: boolean;
  /** "2/5" steps done. */
  steps?: string;
  /** Today widget: "9:00 AM", "All day", "Due today". */
  time?: string;
  kind?: "event" | "task";
}

/** What the widgets draw (kept by Android until the next one). */
export interface Snapshot {
  accent: string;
  onAccent: string;
  dark: boolean;
  /** "Fri 6" */
  date: string;
  tasks: Row[];
  next: (Row & { pinned: boolean }) | null;
  today: Row[];
  counts: { open: number; done: number };
}

/** A reminder for Android to show at `at` (ms), even with Quicky closed. */
export interface Alarm {
  key: string;
  at: number;
  title: string;
  body: string;
  /** The task it's for (Done on the notification ticks it off). */
  task?: string;
  /** A calendar event's alarm key (Snooze snoozes that). */
  event?: string;
}

/** Done from a widget or a notification, applied here through the store's own actions. */
export type Action =
  | { type: "status"; id: string; status: "todo" | "doing" | "done"; at: number }
  | { type: "add"; id: string; title: string; at: number }
  | { type: "snooze"; id?: string; event?: string; minutes: number; at: number }
  | { type: "open"; id?: string; calendar?: boolean };

export const pushWidgets = (s: Snapshot) => call("widgets", { snapshot: JSON.stringify(s) });
export const scheduleAlarms = (list: Alarm[]) => call("schedule", { alarms: JSON.stringify(list) });
export const takeActions = () => call<{ actions: Action[] }>("actions").then((r) => r.actions ?? []);
/** Whether notifications (and exact alarm times) are allowed; `ask` shows Android's prompt, `exact`
 *  opens the exact-alarm switch in Android's settings when it's off. */
export const notifyPermission = (ask = false, exact = false) =>
  call<{ notifications: boolean; exact: boolean }>("permission", { ask, exact });

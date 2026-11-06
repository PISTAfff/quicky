// The Android side (`src-tauri/android-plugin`, Kotlin): widgets, reminder notifications and
// what was done from them while this page wasn't looking. Every call goes through here.
import { invoke } from "@tauri-apps/api/core";

const call = <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(`plugin:quicky-android|${cmd}`, args);

/** One row of the task list widget (the today and week widgets add `time` and `kind`; the week
 *  widget's `kind: "day"` rows are the day headings). */
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
  kind?: "event" | "task" | "day";
}

/** What the widgets draw (kept by Android until the next one). */
export interface Snapshot {
  accent: string;
  onAccent: string;
  dark: boolean;
  /** The app's theme setting: "auto" lets the widgets follow the phone's dark mode by themselves. */
  mode: "light" | "dark" | "auto";
  /** "Fri 6" */
  date: string;
  tasks: Row[];
  next: (Row & { pinned: boolean }) | null;
  today: Row[];
  /** The week widget: the next 7 days' events and due tasks, under a heading per day. */
  week: Row[];
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
/** Back with nothing open: Quicky goes to the background (as Android's own back does). */
export const leaveApp = () => call("leave");

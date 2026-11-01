// Decides when to show a reminder and applies what the user picked on it.
// Checks are driven by a tick from Rust (reliable even while this window is hidden) plus a timer.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { dueReminder } from "./model";
import { data, markReminderShown, setStatus, snoozeTask } from "./store";
import { setSheet } from "../ui/state";

const PREVIEW = "__preview";
let showing: string | null = null;

const label = (key: string) => (key.startsWith("snooze") ? "Snoozed reminder" : key.slice(-5));

/** Shows the first reminder that's due (one at a time; the rest follow after an answer). */
export async function checkReminders() {
  if (showing) return;
  const now = new Date();
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
}

/** Settings → "Preview a reminder": the real overlay with a sample task; answers do nothing. */
export function previewReminder() {
  if (showing) return;
  showing = PREVIEW;
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  invoke("show_reminder", {
    payload: { id: PREVIEW, title: "Water the plants", note: "This is what a reminder looks like.", time },
  }).catch(() => (showing = null));
}

interface Answer { id: string; action: "doing" | "done" | "snooze" | "open"; minutes?: number }

export async function startReminders() {
  await listen<Answer>("reminder-action", ({ payload: a }) => {
    showing = null;
    if (a.id !== PREVIEW) {
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
  await listen("reminder-tick", () => void checkReminders());
  await listen("preview-reminder", previewReminder);
  setInterval(checkReminders, 30_000);
  void checkReminders();
}

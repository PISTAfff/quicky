import { createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { sfx } from "./sfx";
import {
  rollover, emptyData, dayKey, plusDays, uid, weekday,
  type Data, type Task, type Status, type Attachment, type Repeat, type Reminder, type Step,
} from "./model";

export const [data, setData] = createStore<Data>(emptyData());
export const [today, setToday] = createSignal(dayKey());
export const [dataDir, setDataDir] = createSignal<string | null>(null);
export const [ready, setReady] = createSignal(false);
export const [loadError, setLoadError] = createSignal<string | null>(null);

// ---- persistence -------------------------------------------------------------

let loaded = false;
let dirty = false;
let timer: number | undefined;

function scheduleSave() {
  if (!loaded) return;
  dirty = true;
  clearTimeout(timer);
  timer = window.setTimeout(flush, 250);
}

export async function flush() {
  clearTimeout(timer);
  if (!loaded || !dirty) return;
  dirty = false;
  try {
    await invoke("save_data", { json: JSON.stringify(unwrap(data)) });
  } catch (e) {
    dirty = true;
    showToast(`Couldn't save: ${e}`);
  }
}

function mutate(fn: (d: Data) => void) {
  setData(produce(fn));
  scheduleSave();
}

/** Re-checks the date; rolls unfinished tasks and repeats onto the new day. */
/** Minute-ish clock for "next reminder" labels. */
export const [clock, setClock] = createSignal(Date.now());

export function tick() {
  setClock(Date.now());
  if (!loaded) return;
  const t = dayKey();
  if (t !== today()) setToday(t);
  const current = unwrap(data);
  const next = rollover(current, t);
  if (next !== current) {
    setData(reconcile(next));
    scheduleSave();
  }
}

async function load() {
  loaded = false;
  setLoadError(null);
  try {
    const raw = await invoke<string>("load_data");
    const parsed: Data = raw ? JSON.parse(raw) : emptyData();
    if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.repeats)) throw new Error("unexpected format");
    setData(reconcile(parsed));
    loaded = true;
    tick();
  } catch (e) {
    // Never overwrite a file we couldn't read.
    setLoadError(`Couldn't read quicky.json (${e}). Fix or move the file, then restart Quicky.`);
  }
}

export async function init() {
  const dir = await invoke<string | null>("get_data_dir");
  setDataDir(dir);
  if (dir) await load();
  setReady(true);
}

export async function chooseDataDir(path: string) {
  await flush();
  const dir = await invoke<string>("set_data_dir", { path });
  setDataDir(dir);
  await load();
}

export const mediaUrl = (rel: string) => {
  const dir = dataDir();
  if (!dir) return "";
  // Windows paths use backslashes; macOS and Linux keep the forward slashes.
  return dir.includes("\\") ? convertFileSrc(`${dir}\\${rel.replace(/\//g, "\\")}`) : convertFileSrc(`${dir}/${rel}`);
};

// ---- task spaces ----------------------------------------------------------------
// Each app with a mini Quicky has its own list; `null` is the general list.

export const [space, setSpace] = createSignal<string | null>(null);
export const inSpace = (key?: string) => (key ?? null) === space();
export const spaceTasks = () => data.tasks.filter((t) => inSpace(t.space));
export const spaceRepeats = () => data.repeats.filter((r) => inSpace(r.space));
export const spaceName = (key: string | null) => (key ? data.spaces?.[key] ?? "App" : "General");

export function nameSpace(key: string, name: string) {
  if (data.spaces?.[key] === name) return;
  mutate((d) => {
    d.spaces = { ...(d.spaces ?? {}), [key]: name };
  });
}

// ---- toast -------------------------------------------------------------------

export interface Toast { text: string; action?: { label: string; run: () => void } }
export const [toast, setToast] = createSignal<Toast | null>(null);
let toastTimer: number | undefined;
export function showToast(text: string, action?: Toast["action"], ms = 4500) {
  clearTimeout(toastTimer);
  setToast({ text, action });
  toastTimer = window.setTimeout(() => setToast(null), ms);
}

// ---- task actions ------------------------------------------------------------

export function addTask(title: string, attachments: Attachment[], repeatDays?: number[]) {
  title = title.trim();
  if (!title && !attachments.length) return;
  if (!title) title = attachments[0].name;
  const t = today();
  let repeatId: string | undefined;
  if (repeatDays?.length) {
    repeatId = uid();
    const repeat: Repeat = { id: repeatId, title, days: repeatDays, lastSpawned: t, ...(space() ? { space: space()! } : {}) };
    mutate((d) => void d.repeats.push(repeat));
    if (!repeatDays.includes(weekday(t))) {
      showToast(`“${title}” will show up on its next repeat day`);
      return;
    }
  }
  const task: Task = {
    id: uid(), title, status: "todo", day: t, since: t, repeatId, attachments, created: Date.now(),
    ...(space() ? { space: space()! } : {}),
  };
  mutate((d) => void d.tasks.push(task));
  sfx.add();
}

/** A task made somewhere else (something dropped on the bubble or a mini), into a given list. */
export function addTaskTo(key: string | null, title: string, attachments: Attachment[], note?: string) {
  title = title.trim() || attachments[0]?.name || "";
  if (!title) return;
  const t = today();
  const task: Task = {
    id: uid(), title, status: "todo", day: t, since: t, attachments, created: Date.now(),
    ...(note ? { note } : {}),
    ...(key ? { space: key } : {}),
  };
  mutate((d) => void d.tasks.push(task));
}

const find = (d: Data, id: string) => d.tasks.find((t) => t.id === id);

export function setStatus(id: string, status: Status) {
  const prev = find(unwrap(data), id)?.status;
  mutate((d) => {
    const t = find(d, id);
    if (!t) return;
    t.status = status;
    if (status === "done") t.doneDay = today();
    else {
      delete t.doneDay;
      t.day = today();
    }
  });
  if (prev !== status) (status === "done" ? sfx.done : status === "doing" ? sfx.doing : sfx.undo)();
  if (status === "done" && prev && prev !== "done") {
    const title = find(unwrap(data), id)?.title ?? "";
    showToast(`“${title}” done`, { label: "Undo", run: () => setStatus(id, prev) });
    // Finishing the task pinned to the bubble: it celebrates, and the pin comes off.
    if (data.focus?.id === id) {
      mutate((d) => void delete d.focus);
      void emitTo("bubble", "bubble-cheer", { title });
    }
  }
}

// ---- focus pin, due dates, "not today" ------------------------------------------------

/** Pins a task to the bubble (it's started, if it wasn't), or with null takes the pin off. */
export function setFocus(id: string | null) {
  if (!id) return mutate((d) => void delete d.focus);
  const t = find(unwrap(data), id);
  if (!t) return;
  if (t.status !== "doing") setStatus(id, "doing");
  mutate((d) => void (d.focus = { id, since: Date.now() }));
}

export function setDue(id: string, due: string | undefined) {
  mutate((d) => {
    const t = find(d, id);
    if (!t) return;
    if (due) t.due = due;
    else delete t.due;
  });
}

/** "Not today": hides the task (and holds its reminders) until `day`. */
export function putOff(id: string, day: string) {
  const title = find(unwrap(data), id)?.title ?? "";
  mutate((d) => {
    const t = find(d, id);
    if (!t) return;
    t.later = day;
    if (t.status === "doing") t.status = "todo";
    if (d.focus?.id === id) delete d.focus;
  });
  sfx.snooze();
  showToast(`“${title}” is back ${day === plusDays(1) ? "tomorrow" : "on its day"}`, {
    label: "Undo",
    run: () => bringBack(id),
  });
}

export function bringBack(id: string) {
  mutate((d) => {
    const t = find(d, id);
    if (t) delete t.later;
  });
}

// ---- steps (a task's checklist) -------------------------------------------------------------

/** Changes a task's steps, and its repeat's so future copies get the same checklist. */
function editSteps(id: string, change: (steps: Step[]) => Step[]) {
  mutate((d) => {
    const t = find(d, id);
    if (!t) return;
    const steps = change(t.steps ?? []);
    if (steps.length) t.steps = steps;
    else delete t.steps;
    const r = t.repeatId ? d.repeats.find((r) => r.id === t.repeatId) : undefined;
    if (r) {
      if (steps.length) r.steps = steps.map((s) => s.title);
      else delete r.steps;
    }
  });
}

export function addStep(id: string, title: string) {
  title = title.trim();
  if (title) editSteps(id, (steps) => [...steps, { id: uid(), title, done: false }]);
}

export function renameStep(id: string, stepId: string, title: string) {
  title = title.trim();
  editSteps(id, (steps) => (title ? steps.map((s) => (s.id === stepId ? { ...s, title } : s)) : steps.filter((s) => s.id !== stepId)));
}

export function removeStep(id: string, stepId: string) {
  editSteps(id, (steps) => steps.filter((s) => s.id !== stepId));
}

export function toggleStep(id: string, stepId: string) {
  mutate((d) => {
    const s = find(d, id)?.steps?.find((s) => s.id === stepId);
    if (s) s.done = !s.done;
  });
  const t = find(unwrap(data), id);
  const steps = t?.steps ?? [];
  if (!t || !steps.find((s) => s.id === stepId)?.done) return;
  sfx.step();
  // The last step ticked: offer to finish the whole task.
  if (steps.every((s) => s.done) && t.status !== "done") {
    showToast("All steps done", { label: "Finish task", run: () => setStatus(id, "done") });
  }
}

export const nextStatus = (s: Status): Status => (s === "todo" ? "doing" : s === "doing" ? "done" : "todo");
export const prevStatus = (s: Status): Status => (s === "done" ? "doing" : s === "doing" ? "todo" : "todo");

export function updateTask(id: string, patch: Partial<Pick<Task, "title" | "note">>) {
  mutate((d) => {
    const t = find(d, id);
    if (t) Object.assign(t, patch);
  });
}

export function addAttachments(id: string, atts: Attachment[]) {
  if (!atts.length) return;
  mutate((d) => void find(d, id)?.attachments.push(...atts));
}

export function removeAttachment(id: string, attId: string) {
  const att = find(unwrap(data), id)?.attachments.find((a) => a.id === attId);
  mutate((d) => {
    const t = find(d, id);
    if (t) t.attachments = t.attachments.filter((a) => a.id !== attId);
  });
  if (att) invoke("remove_media", { rel: att.path }).catch(() => {});
}

export function removeTask(id: string) {
  const current = unwrap(data);
  const index = current.tasks.findIndex((t) => t.id === id);
  if (index < 0) return;
  const task = structuredClone(current.tasks[index]);
  mutate((d) => void d.tasks.splice(index, 1));
  sfx.delete();
  // Media is deleted only once the undo window has passed.
  const purge = window.setTimeout(() => {
    for (const a of task.attachments) invoke("remove_media", { rel: a.path }).catch(() => {});
  }, 6000);
  showToast(`Deleted “${task.title}”`, {
    label: "Undo",
    run: () => {
      clearTimeout(purge);
      sfx.undo();
      mutate((d) => void d.tasks.splice(Math.min(index, d.tasks.length), 0, task));
    },
  }, 5500);
}

// ---- repeats -----------------------------------------------------------------

export function makeRepeat(taskId: string, days: number[]) {
  const id = uid();
  mutate((d) => {
    const t = find(d, taskId);
    if (!t) return;
    d.repeats.push({ id, title: t.title, days, lastSpawned: today(), ...(t.space ? { space: t.space } : {}) });
    t.repeatId = id;
  });
}

export function setRepeatDays(id: string, days: number[]) {
  mutate((d) => {
    const r = d.repeats.find((r) => r.id === id);
    if (r) r.days = days;
  });
}

export function toggleRepeatPaused(id: string) {
  mutate((d) => {
    const r = d.repeats.find((r) => r.id === id);
    if (r) r.paused = !r.paused;
  });
}

export function renameRepeat(id: string, title: string) {
  mutate((d) => {
    const r = d.repeats.find((r) => r.id === id);
    if (r) r.title = title;
  });
}

export function deleteRepeat(id: string) {
  mutate((d) => {
    d.repeats = d.repeats.filter((r) => r.id !== id);
    for (const t of d.tasks) if (t.repeatId === id) delete t.repeatId;
  });
}

// ---- reminders -----------------------------------------------------------------

/** Sets (or with undefined, stops) a task's reminder, and its repeat's so future copies match. */
export function setReminder(id: string, reminder: Reminder | undefined) {
  const clean = reminder && { ...reminder, times: [...new Set(reminder.times)].sort(), days: [...new Set(reminder.days)].sort() };
  mutate((d) => {
    const t = find(d, id);
    if (!t) return;
    delete t.remind;
    if (clean) t.reminder = clean;
    else {
      delete t.reminder;
      delete t.snoozeUntil;
    }
    const r = t.repeatId ? d.repeats.find((r) => r.id === t.repeatId) : undefined;
    if (r) {
      delete r.remind;
      if (clean) r.reminder = structuredClone({ ...clean, skip: undefined });
      else delete r.reminder;
    }
  });
}

export function clearSnooze(id: string) {
  mutate((d) => void delete find(d, id)?.snoozeUntil);
}

export function markReminderShown(id: string, key: string) {
  mutate((d) => {
    const t = find(d, id);
    if (!t) return;
    t.lastFired = key;
    if (key.startsWith("snooze")) delete t.snoozeUntil;
  });
}

export function snoozeTask(id: string, minutes: number) {
  mutate((d) => {
    const t = find(d, id);
    if (t) t.snoozeUntil = Date.now() + minutes * 60_000;
  });
}
import { createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import {
  rollover, emptyData, dayKey, uid, weekday,
  type Data, type Task, type Status, type Attachment, type Repeat,
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
  return dir ? convertFileSrc(`${dir}\\${rel.replace(/\//g, "\\")}`) : "";
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
  if (status === "done" && prev && prev !== "done") {
    const title = find(unwrap(data), id)?.title ?? "";
    showToast(`“${title}” done`, { label: "Undo", run: () => setStatus(id, prev) });
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
  // Media is deleted only once the undo window has passed.
  const purge = window.setTimeout(() => {
    for (const a of task.attachments) invoke("remove_media", { rel: a.path }).catch(() => {});
  }, 6000);
  showToast(`Deleted “${task.title}”`, {
    label: "Undo",
    run: () => {
      clearTimeout(purge);
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

/** Sets a task's reminder times (and its repeat's, so future copies remind too). */
export function setRemind(id: string, times: string[]) {
  const sorted = [...new Set(times)].sort();
  mutate((d) => {
    const t = find(d, id);
    if (!t) return;
    if (sorted.length) t.remind = sorted;
    else delete t.remind;
    delete t.snoozeUntil;
    const r = t.repeatId ? d.repeats.find((r) => r.id === t.repeatId) : undefined;
    if (r) {
      if (sorted.length) r.remind = [...sorted];
      else delete r.remind;
    }
  });
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
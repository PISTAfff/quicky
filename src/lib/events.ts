// Reminders for the Calendar extension's events (main window only). The events live on Quicky's
// server; this reads them every few minutes while signed in with the extension installed, so an
// event reminds through Quicky's own reminder screen even with the calendar window closed.
import { createSignal } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { ACCOUNT_EVENT, api, readAccount, readInstalled } from "./cloud";
import { eventAlarms, CATCH_UP_MS, type CalEvent } from "./model";

export const CALENDAR_ID = "calendar";
const FIRED_KEY = "quicky-event-fired";
const SNOOZE_KEY = "quicky-event-snooze";

export interface Alarm { key: string; at: number; title: string; note: string; event: CalEvent }

const [events, setEvents] = createSignal<CalEvent[]>([]);
/** The calendar's events as last read (the phone's widgets and notifications use them). */
export const calendarEvents = events;

const read = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
};

/** Reminders already shown (key → when), kept a few days. */
const fired = () => read<Record<string, number>>(FIRED_KEY, {});
/** Snoozed event reminders (key → when to show again). */
const snoozed = () => read<Record<string, number>>(SNOOZE_KEY, {});

export function markShown(key: string) {
  const f = fired();
  const now = Date.now();
  f[key] = now;
  for (const [k, at] of Object.entries(f)) if (now - at > 4 * 86_400_000) delete f[k];
  write(FIRED_KEY, f);
  const s = snoozed();
  if (key in s) {
    delete s[key];
    write(SNOOZE_KEY, s);
  }
}

export function snoozeAlarm(key: string, minutes: number) {
  write(SNOOZE_KEY, { ...snoozed(), [key]: Date.now() + minutes * 60_000 });
}

function alarms(now: Date): Alarm[] {
  const out: Alarm[] = [];
  const snooze = snoozed();
  for (const e of events()) {
    for (const a of eventAlarms(e, now)) out.push({ key: a.key, at: snooze[a.key] ?? a.at, title: e.title, note: e.note, event: e });
  }
  for (const [key, at] of Object.entries(snooze)) {
    if (out.some((a) => a.key === key)) continue;
    const e = events().find((x) => key.startsWith(x.id + "@"));
    if (e) out.push({ key, at, title: e.title, note: e.note, event: e });
  }
  return out;
}

/** The event reminder to show now, if any (the oldest one due, not shown yet). */
export function dueAlarm(now: Date): Alarm | null {
  const f = fired();
  const t = now.getTime();
  const due = alarms(now).filter((a) => a.at <= t && t - a.at < CATCH_UP_MS && !(a.key in f && f[a.key] >= a.at));
  return due.sort((a, b) => a.at - b.at)[0] ?? null;
}

/** Event reminders still to come and not shown yet (the phone schedules them as notifications). */
export function upcomingAlarms(now: Date): Alarm[] {
  const f = fired();
  const t = now.getTime();
  return alarms(now).filter((a) => a.at > t && !(a.key in f && f[a.key] >= a.at));
}

/** When the next event reminder is due (ms), for Rust's wake-up tick. */
export function nextAlarmAt(now: Date): number | null {
  const f = fired();
  const t = now.getTime();
  const next = alarms(now).filter((a) => a.at > t && !(a.key in f && f[a.key] >= a.at)).map((a) => a.at);
  return next.length ? Math.min(...next) : null;
}

export const calendarInstalled = () => readInstalled().some((i) => i.id === CALENDAR_ID);

/** Reads the events again (signed in, email confirmed, the Calendar extension installed). */
export async function refreshEvents() {
  const a = readAccount();
  if (!a?.user.verified || !calendarInstalled()) return setEvents([]);
  try {
    const r = await api<{ events: CalEvent[] }>("GET", "/api/projects/calendar-events");
    setEvents(r.events);
  } catch {
    // Offline: keep the ones read last.
  }
}

export function startEvents(onChange: () => void) {
  const again = () => void refreshEvents().then(onChange);
  addEventListener(ACCOUNT_EVENT, again);
  addEventListener("storage", (e) => (e.key === "quicky-account" || e.key === "quicky-extensions") && again());
  addEventListener("focus", again);
  void listen("calendar-changed", again);
  setInterval(again, 5 * 60_000);
  again();
}

import { createMemo, For, Show } from "solid-js";
import { clearSnooze, clock, setReminder, snoozeTask } from "../lib/store";
import { dayKey, describeReminder, hhmm, reminderOf, time12, upcoming, whenLabel, type RemindMode, type Reminder, type Task } from "../lib/model";
import { IBell, IClose, IPlus } from "./icons";
import { WeekPicker } from "./WeekPicker";
import { TimeField } from "./TimeField";

const MODES: [RemindMode, string][] = [
  ["once", "Once"],
  ["daily", "Daily"],
  ["days", "Some days"],
  ["every", "Repeat"],
];
const PRESETS: [string, string][] = [
  ["Morning", "09:00"],
  ["Noon", "12:00"],
  ["Afternoon", "15:00"],
  ["Evening", "20:00"],
];
const EVERY: [number, string][] = [
  [15, "15 min"],
  [30, "30 min"],
  [45, "45 min"],
  [60, "1 hour"],
  [90, "1½ hours"],
  [120, "2 hours"],
  [180, "3 hours"],
];

const nextHour = () => {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
};
const fromNow = (min: number) => Date.now() + min * 60_000;
const dateInput = (ms: number) => dayKey(new Date(ms));
const atDay = (ms: number, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(ms);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

/**
 * "Remind me" for one task: a switch, a plain-words summary, four ways to schedule it (once,
 * daily, some weekdays, every N minutes in a window), skip today, stop, and the next few times.
 */
export function RemindBox(p: { task: Task }) {
  const r = createMemo(() => reminderOf(p.task));
  const now = () => new Date(clock());
  const save = (patch: Partial<Reminder>) => {
    const base: Reminder = r() ?? { on: true, mode: "daily", times: [hhmm(nextHour())], days: [1, 2, 3, 4, 5] };
    setReminder(p.task.id, { ...base, ...patch });
  };
  const toggle = () => (r() ? save({ on: !r()!.on }) : save({ on: true }));
  const pickMode = (mode: RemindMode) => {
    const cur = r();
    const patch: Partial<Reminder> = { mode, on: true };
    if (mode === "once" && !cur?.at) patch.at = nextHour().getTime();
    if ((mode === "daily" || mode === "days") && !cur?.times.length) patch.times = [hhmm(nextHour())];
    if (mode === "days" && !cur?.days.length) patch.days = [1, 2, 3, 4, 5];
    if (mode === "every") Object.assign(patch, { every: cur?.every ?? 60, from: cur?.from ?? "09:00", to: cur?.to ?? "18:00" });
    save(patch);
  };
  const times = () => r()?.times ?? [];
  const setTimes = (list: string[]) => save({ times: list.filter(Boolean) });
  const next = createMemo(() => upcoming(p.task, now(), 4));
  const snoozed = () => (p.task.snoozeUntil && p.task.snoozeUntil > clock() ? p.task.snoozeUntil : 0);
  const skipping = () => r()?.skip === dayKey(now());

  return (
    <div class="box remind" classList={{ off: !r()?.on }}>
      <div class="box-row">
        <span class="box-label">
          <IBell size={14} /> Remind me
        </span>
        <label class="switch-row tiny">
          <span class="sr">Reminders {r()?.on ? "on" : "off"}</span>
          <input type="checkbox" role="switch" checked={!!r()?.on} onChange={toggle} />
        </label>
      </div>

      <p class="remind-summary">
        {r() ? describeReminder(r(), now()) : "Off. Turn it on, or pick a quick one below."}
        <Show when={next()[0]}>{(n) => <> · <b>next {whenLabel(n(), now())}</b></>}</Show>
      </p>

      <Show when={snoozed()}>
        {(ms) => (
          <span class="time-chip snooze-chip">
            Snoozed until {whenLabel(ms(), now())}
            <button aria-label="Cancel snooze" onClick={() => clearSnooze(p.task.id)}>
              <IClose size={10} />
            </button>
          </span>
        )}
      </Show>

      <div class="quick-remind">
        <span class="muted-small">Nudge me once in</span>
        <For each={[[15, "15m"], [30, "30m"], [60, "1h"], [120, "2h"]] as const}>
          {([min, label]) => (
            <button class="chip-btn" onClick={() => snoozeTask(p.task.id, min)} title={`Remind me once at ${time12(new Date(fromNow(min)))}`}>
              {label}
            </button>
          )}
        </For>
      </div>

      <Show when={r()?.on}>
        <div class="segment remind-modes" role="group" aria-label="How often">
          <For each={MODES}>
            {([mode, label]) => (
              <button classList={{ on: r()?.mode === mode }} aria-pressed={r()?.mode === mode} onClick={() => pickMode(mode)}>
                {label}
              </button>
            )}
          </For>
        </div>

        {/* Once: a specific date and time. */}
        <Show when={r()?.mode === "once"}>
          <div class="time-row">
            <label class="sr" for="once-date">Date</label>
            <input id="once-date" type="date" value={dateInput(r()!.at ?? Date.now())} onChange={(e) => e.currentTarget.value && save({ at: atDay(new Date(`${e.currentTarget.value}T00:00`).getTime(), hhmm(new Date(r()!.at ?? Date.now()))) })} />
            <TimeField id="once-time" label="Time" value={hhmm(new Date(r()!.at ?? Date.now()))} onChange={(hm) => save({ at: atDay(r()!.at ?? Date.now(), hm) })} />
          </div>
          <div class="quick-remind">
            <button class="chip-btn" onClick={() => save({ at: fromNow(30) })}>In 30 min</button>
            <button class="chip-btn" onClick={() => save({ at: fromNow(60) })}>In 1 hour</button>
            <button class="chip-btn" onClick={() => save({ at: atDay(Date.now(), "20:00") })}>Tonight 8 PM</button>
            <button class="chip-btn" onClick={() => save({ at: atDay(Date.now() + 86_400_000, "09:00") })}>Tomorrow 9 AM</button>
          </div>
        </Show>

        {/* Daily / some days: a list of times, each editable. */}
        <Show when={r()?.mode === "days"}>
          <WeekPicker days={r()!.days} onChange={(days) => save({ days })} />
        </Show>
        <Show when={r()?.mode === "daily" || r()?.mode === "days"}>
          <div class="times">
            <For each={times()}>
              {(hm, i) => (
                <span class="time-edit">
                  <TimeField
                    id={`t-${i()}`}
                    label={`Reminder time ${i() + 1}`}
                    value={hm}
                    onChange={(v) => setTimes(times().map((x, j) => (j === i() ? v : x)))}
                  />
                  <button aria-label={`Remove ${time12(hm)}`} disabled={times().length < 2} onClick={() => setTimes(times().filter((_, j) => j !== i()))}>
                    <IClose size={10} />
                  </button>
                </span>
              )}
            </For>
            <button class="chip-btn add" onClick={() => setTimes([...times(), hhmm(nextHour())])}>
              <IPlus size={11} /> Time
            </button>
          </div>
          <div class="quick-remind">
            <For each={PRESETS}>
              {([label, hm]) => (
                <button
                  class="chip-btn"
                  classList={{ on: times().includes(hm) }}
                  aria-pressed={times().includes(hm)}
                  onClick={() => setTimes(times().includes(hm) ? (times().length > 1 ? times().filter((x) => x !== hm) : times()) : [...times(), hm])}
                >
                  {label} {time12(hm)}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* Repeat: every N minutes inside a daily window. */}
        <Show when={r()?.mode === "every"}>
          <div class="time-row every-row">
            <span>Every</span>
            <label class="sr" for="every-n">How often</label>
            <select id="every-n" value={r()!.every ?? 60} onChange={(e) => save({ every: Number(e.currentTarget.value) })}>
              <For each={EVERY}>{([n, label]) => <option value={n}>{label}</option>}</For>
            </select>
            <span>from</span>
            <TimeField id="every-from" label="From" value={r()!.from ?? "09:00"} onChange={(hm) => save({ from: hm })} />
            <span>to</span>
            <TimeField id="every-to" label="To" value={r()!.to ?? "18:00"} onChange={(hm) => save({ to: hm })} />
          </div>
        </Show>

        <Show when={next().length}>
          <div class="upcoming">
            <span class="muted-small">Coming up</span>
            <For each={next()}>{(ms) => <span class="up-chip">{whenLabel(ms, now())}</span>}</For>
          </div>
        </Show>

        <div class="remind-actions">
          <Show when={r()?.mode !== "once"}>
            <button class="link" onClick={() => save({ skip: skipping() ? undefined : dayKey(now()) })}>
              {skipping() ? "Remind me today after all" : "Not today"}
            </button>
          </Show>
          <button class="link danger-link" onClick={() => setReminder(p.task.id, undefined)}>
            Stop reminders
          </button>
        </div>
      </Show>
    </div>
  );
}

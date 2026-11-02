import { createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import { autoCheck, checkForUpdate, installUpdate, setAutoCheck, updateState } from "../lib/updates";
import { ACCENTS, setTheme, theme } from "../lib/theme";
import { onAccent } from "../lib/theme-colors";
import {
  addAttachments, addStep, bringBack, chooseDataDir, clock, data, dataDir, deleteRepeat, makeRepeat, putOff, removeAttachment, removeStep,
  removeTask, renameRepeat, renameStep, setDue, setFocus, setReminder, setSpace, spaceName, spaceRepeats, spaceTasks, setRepeatDays,
  setStatus, showToast, toggleRepeatPaused, toggleStep, today, updateTask,
} from "../lib/store";
import {
  EVERY_DAY, dayKey, describeReminder, dueLabel, isLater, parseDay, reminderOf, searchTasks, upcoming, whenLabel, type Status, type Task,
} from "../lib/model";
import { OS, SYSTEM_NAME } from "../lib/platform";
import { readQuiet, writeQuiet } from "../lib/reminders";
import { showTour } from "./Tour";
import { pickFiles, startRecording, type Recording } from "../lib/media";
import { previewReminder } from "../lib/reminders";
import { readSfx, sfx, writeSfx } from "../lib/sfx";
import { Blob, IBell, ICalendar, IChecks, IClip, IClose, IMic, IMoon, IPin2, IRepeat, IRestore, ISearch, ITarget, ITrash, IFolder, IStop } from "./icons";
import { MediaView } from "./Media";
import { RecStrip } from "./LiveWave";
import { WeekPicker } from "./WeekPicker";
import { RemindBox } from "./RemindBox";
import { setSheet, sheet, WEEK_LONG } from "./state";

function Panel(p: { title: string; children: JSX.Element; class?: string }) {
  sfx.open();
  onCleanup(() => sfx.close());
  return (
    <div class="sheet-backdrop" onClick={() => setSheet(null)}>
      <section class={`sheet ${p.class ?? ""}`} role="dialog" aria-label={p.title} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <h2>{p.title}</h2>
          <button class="ib soft" aria-label="Close" onClick={() => setSheet(null)}>
            <IClose size={14} />
          </button>
        </div>
        <div class="sheet-body">{p.children}</div>
      </section>
    </div>
  );
}

/** Every task with a reminder, across all lists: see when, pause/resume, or stop each. */
function RemindersSheet() {
  const now = () => new Date(clock());
  const items = createMemo(() =>
    data.tasks
      .filter((t) => t.status !== "done" && (reminderOf(t) || (t.snoozeUntil && t.snoozeUntil > clock())))
      .map((t) => ({ t, r: reminderOf(t), next: upcoming(t, now(), 1)[0] }))
      .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity)),
  );
  const openTask = (t: Task) => {
    setSpace(t.space ?? null);
    setSheet({ kind: "task", id: t.id });
  };
  return (
    <Panel title="Reminders" class="reminders-sheet">
      <Show
        when={items().length}
        fallback={<div class="empty"><Blob size={44} /><p>No reminders yet. Open a task and switch on “Remind me”.</p></div>}
      >
        <For each={items()}>
          {({ t, r, next }) => (
            <div class="reminder-row" classList={{ off: !!r && !r.on }}>
              <button class="reminder-main" onClick={() => openTask(t)}>
                <span class="reminder-title">{t.title}</span>
                <span class="reminder-sub">
                  <Show when={t.space}>{(s) => <b>{spaceName(s())} · </b>}</Show>
                  {r ? describeReminder(r, now()) : "Once"}
                  <Show when={next}>{(n) => <> · next {whenLabel(n(), now())}</>}</Show>
                </span>
              </button>
              <Show when={r}>
                {(rem) => (
                  <label class="switch-row tiny" title={rem().on ? "Pause" : "Resume"}>
                    <span class="sr">{rem().on ? "Pause" : "Resume"} reminder for {t.title}</span>
                    <input type="checkbox" role="switch" checked={rem().on} onChange={() => setReminder(t.id, { ...rem(), on: !rem().on })} />
                  </label>
                )}
              </Show>
              <button class="ib soft" aria-label={`Stop reminders for ${t.title}`} title="Stop reminders" onClick={() => setReminder(t.id, undefined)}>
                <ITrash size={14} />
              </button>
            </div>
          )}
        </For>
      </Show>
    </Panel>
  );
}
function TaskSheet(p: { id: string }) {
  const task = createMemo(() => data.tasks.find((t) => t.id === p.id));
  const repeat = createMemo(() => data.repeats.find((r) => r.id === task()?.repeatId));
  const [rec, setRec] = createSignal<Recording | null>(null);
  onCleanup(() => rec()?.cancel());

  const record = async () => {
    const r = rec();
    if (r) {
      setRec(null);
      const att = await r.stop();
      if (att) addAttachments(p.id, [att]);
      return;
    }
    try {
      setRec(await startRecording());
    } catch {
      showToast("Microphone isn't available");
    }
  };

  return (
    <Show when={task()}>
      {(t) => (
        <Panel title="Task" class="task-sheet">
          <label class="sr" for="task-title">Title</label>
          <textarea
            id="task-title"
            class="title-input"
            rows="1"
            value={t().title}
            onChange={(e) => updateTask(p.id, { title: e.currentTarget.value.trim() || t().title })}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
          />
          <div class="segment" role="group" aria-label="Status">
            <For each={["todo", "doing", "done"] as Status[]}>
              {(s) => (
                <button
                  class={s}
                  classList={{ on: t().status === s }}
                  aria-pressed={t().status === s}
                  onClick={() => setStatus(p.id, s)}
                >
                  {{ todo: "To do", doing: "Doing", done: "Done" }[s]}
                </button>
              )}
            </For>
          </div>

          <Show when={t().status !== "done"}>
            <button
              class="focus-btn"
              classList={{ on: data.focus?.id === p.id }}
              aria-pressed={data.focus?.id === p.id}
              onClick={() => setFocus(data.focus?.id === p.id ? null : p.id)}
            >
              <ITarget size={15} />
              <Show when={data.focus?.id === p.id} fallback={<span>Pin to the bubble<small>Keeps it in front of you while you work on it</small></span>}>
                <span>Pinned to the bubble<small>Finish it to make Quicky cheer. Click to unpin</small></span>
              </Show>
            </button>
          </Show>

          <DueBox task={t()} />

          <StepsBox task={t()} />

          <div class="box">
            <div class="box-row">
              <span class="box-label"><IRepeat size={14} /> Repeat</span>
              <Show
                when={repeat()}
                fallback={<button class="link" onClick={() => makeRepeat(p.id, EVERY_DAY)}>Make it repeat</button>}
              >
                <button class="link" onClick={() => deleteRepeat(repeat()!.id)}>Stop repeating</button>
              </Show>
            </div>
            <Show when={repeat()}>
              {(r) => <WeekPicker days={r().days} onChange={(d) => setRepeatDays(r().id, d)} />}
            </Show>
          </div>

          <RemindBox task={t()} />

          <label class="sr" for="task-note">Note</label>
          <textarea
            id="task-note"
            class="note"
            placeholder="Add a note…"
            value={t().note ?? ""}
            onChange={(e) => updateTask(p.id, { note: e.currentTarget.value })}
          />

          <Show when={t().attachments.length}>
            <div class="box-label">Attachments · {t().attachments.length}</div>
            <div class="media-grid">
              <For each={t().attachments}>
                {(a) => (
                  <div class="media-cell" classList={{ wide: a.kind === "audio" || a.kind === "file" }}>
                    <MediaView att={a} />
                    <button class="x" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(p.id, a.id)}>
                      <IClose size={10} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={rec()}>
            {(r) => (
              <div class="rec-box">
                <RecStrip
                  analyser={r().analyser}
                  onCancel={() => {
                    r().cancel();
                    setRec(null);
                  }}
                />
              </div>
            )}
          </Show>

          <div class="sheet-actions">
            <button class="btn ghost" onClick={async () => addAttachments(p.id, await pickFiles())}>
              <IClip size={15} /> Attach
            </button>
            <button class="btn ghost" classList={{ recording: !!rec() }} onClick={record}>
              <Show when={rec()} fallback={<><IMic size={15} /> Record</>}>
                <IStop size={13} /> Stop &amp; save
              </Show>
            </button>
            <button
              class="btn danger"
              aria-label="Delete task"
              onClick={() => {
                setSheet(null);
                removeTask(p.id);
              }}
            >
              <ITrash size={15} />
            </button>
          </div>
        </Panel>
      )}
    </Show>
  );
}

const plusDays = (n: number) => dayKey(new Date(Date.now() + n * 86_400_000));

const laterDay = (k: string) => {
  if (k === plusDays(1)) return "tomorrow";
  const d = parseDay(k);
  return `${WEEK_LONG[d.getDay()]} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`;
};

/** When it's due, and "not today": hide it until tomorrow or a picked day. */
function DueBox(p: { task: Task }) {
  const label = () => (p.task.due ? dueLabel(p.task.due, today()) : null);
  return (
    <div class="box">
      <div class="box-row">
        <span class="box-label"><ICalendar size={14} /> Due</span>
        <Show
          when={label()}
          fallback={
            <span class="row-gap">
              <button class="link" onClick={() => setDue(p.task.id, today())}>Today</button>
              <button class="link" onClick={() => setDue(p.task.id, plusDays(1))}>Tomorrow</button>
            </span>
          }
        >
          {(l) => <span class={`chip due ${l().tone}`}>{l().text}</span>}
        </Show>
        <input
          type="date"
          class="date-input"
          aria-label="Due date"
          value={p.task.due ?? ""}
          onChange={(e) => setDue(p.task.id, e.currentTarget.value || undefined)}
        />
        <Show when={p.task.due}>
          <button class="ib soft" aria-label="No due date" title="No due date" onClick={() => setDue(p.task.id, undefined)}>
            <IClose size={12} />
          </button>
        </Show>
      </div>
      <Show when={p.task.status !== "done"}>
        <div class="box-row later-row">
          <Show
            when={isLater(p.task, today())}
            fallback={
              <>
                <button
                  class="btn small"
                  onClick={() => {
                    setSheet(null);
                    putOff(p.task.id, plusDays(1));
                  }}
                >
                  <IMoon size={13} /> Not today
                </button>
                <label class="link later-pick">
                  Later…
                  <input
                    type="date"
                    aria-label="Hide it until"
                    min={plusDays(1)}
                    onChange={(e) => {
                      const day = e.currentTarget.value;
                      if (!day) return;
                      setSheet(null);
                      putOff(p.task.id, day);
                    }}
                  />
                </label>
              </>
            }
          >
            <span class="muted">Hidden until {laterDay(p.task.later!)}</span>
            <button class="link" onClick={() => bringBack(p.task.id)}>Back to today</button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** A small checklist inside the task. */
function StepsBox(p: { task: Task }) {
  const [draft, setDraft] = createSignal("");
  const add = () => {
    addStep(p.task.id, draft());
    setDraft("");
  };
  const steps = () => p.task.steps ?? [];
  return (
    <div class="box steps-box">
      <div class="box-row">
        <span class="box-label"><IChecks size={14} /> Steps</span>
        <Show when={steps().length}>
          <span class="muted">{steps().filter((x) => x.done).length} of {steps().length}</span>
        </Show>
      </div>
      <For each={steps()}>
        {(st) => (
          <div class="step" classList={{ done: st.done }}>
            <input type="checkbox" aria-label={`Done: ${st.title}`} checked={st.done} onChange={() => toggleStep(p.task.id, st.id)} />
            <input
              class="step-title"
              aria-label="Step"
              value={st.title}
              onChange={(e) => renameStep(p.task.id, st.id, e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <button class="ib soft" aria-label={`Remove step ${st.title}`} onClick={() => removeStep(p.task.id, st.id)}>
              <IClose size={11} />
            </button>
          </div>
        )}
      </For>
      <input
        class="step-add"
        placeholder={steps().length ? "Add another step…" : "Break it into steps…"}
        aria-label="Add a step"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        onBlur={add}
      />
    </div>
  );
}

/** Every task in every list (done ones too): titles, notes, steps and file names. */
function SearchSheet() {
  const [q, setQ] = createSignal("");
  const hits = createMemo(() => searchTasks([...data.tasks], q()).slice(0, 60));
  let input: HTMLInputElement | undefined;
  queueMicrotask(() => input?.focus());
  const openTask = (t: Task) => {
    setSpace(t.space ?? null);
    setSheet({ kind: "task", id: t.id });
  };
  const status = (t: Task) => (isLater(t, today()) ? "Later" : ({ todo: "To do", doing: "Doing", done: "Done" } as const)[t.status]);
  return (
    <Panel title="Search" class="search-sheet">
      <label class="search-field">
        <ISearch size={15} />
        <input
          ref={input}
          type="search"
          placeholder="Search every list…"
          aria-label="Search tasks"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits()[0]) openTask(hits()[0]);
          }}
        />
      </label>
      <Show when={q().trim()} fallback={<p class="muted center">Titles, notes, steps and file names, in every list. Done tasks too.</p>}>
        <Show when={hits().length} fallback={<div class="empty"><Blob size={40} /><p>Nothing matches “{q().trim()}”.</p></div>}>
          <For each={hits()}>
            {(t) => (
              <button class="search-hit" classList={{ done: t.status === "done" }} onClick={() => openTask(t)}>
                <span class={`dot ${t.status} small`} aria-hidden="true" />
                <span class="search-main">
                  <span class="search-title">{t.title}</span>
                  <span class="search-sub">
                    {status(t)} · {spaceName(t.space ?? null)}
                    <Show when={t.note}> · {t.note!.slice(0, 80)}</Show>
                  </span>
                </span>
              </button>
            )}
          </For>
        </Show>
      </Show>
    </Panel>
  );
}

/** Tasks put off with "not today", until their day comes. */
function LaterSheet() {
  const items = createMemo(() =>
    spaceTasks()
      .filter((t) => t.status !== "done" && isLater(t, today()))
      .sort((a, b) => (a.later! < b.later! ? -1 : 1)),
  );
  return (
    <Panel title="Later" class="later-sheet">
      <Show when={items().length} fallback={<div class="empty"><Blob size={44} /><p>Nothing put off. “Not today” on a task hides it here until its day.</p></div>}>
        <For each={items()}>
          {(t) => (
            <div class="done-row">
              <IMoon size={14} />
              <button class="done-title" onClick={() => setSheet({ kind: "task", id: t.id })}>{t.title}</button>
              <span class="muted">{laterDay(t.later!)}</span>
              <button class="ib soft" aria-label={`Bring ${t.title} back to today`} title="Back to today" onClick={() => bringBack(t.id)}>
                <IRestore size={15} />
              </button>
            </div>
          )}
        </For>
      </Show>
    </Panel>
  );
}

function DoneDrawer() {
  const groups = createMemo(() => {
    const map = new Map<string, typeof data.tasks>();
    for (const t of spaceTasks()) {
      if (t.status !== "done") continue;
      const k = t.doneDay ?? t.day;
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  });
  const label = (k: string) => {
    if (k === today()) return "Today";
    const d = parseDay(k);
    return `${WEEK_LONG[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
  };
  return (
    <Panel title="Done drawer" class="done-sheet">
      <Show
        when={groups().length}
        fallback={
          <div class="empty">
            <Blob size={44} />
            <p>Nothing finished yet. Done tasks hide here and can be brought back.</p>
          </div>
        }
      >
        <For each={groups()}>
          {([day, tasks]) => (
            <>
              <div class="group-label">{label(day)}</div>
              <For each={tasks}>
                {(t) => (
                  <div class="done-row">
                    <span class="dot done small" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /></svg>
                    </span>
                    <button class="done-title" onClick={() => setSheet({ kind: "task", id: t.id })}>{t.title}</button>
                    <button class="ib soft" aria-label={`Restore ${t.title} to today`} title="Back to today" onClick={() => setStatus(t.id, "todo")}>
                      <IRestore size={15} />
                    </button>
                  </div>
                )}
              </For>
            </>
          )}
        </For>
      </Show>
    </Panel>
  );
}

function RepeatsSheet() {
  return (
    <Panel title="Repeating tasks" class="repeats-sheet">
      <Show
        when={spaceRepeats().length}
        fallback={<div class="empty"><Blob size={44} /><p>No repeating tasks. Tap the repeat button in the add box, or “Make it repeat” on any task.</p></div>}
      >
        <For each={spaceRepeats()}>
          {(r) => (
            <div class="repeat-row" classList={{ paused: r.paused }}>
              <div class="box-row">
                <input
                  class="repeat-title"
                  aria-label="Repeat title"
                  value={r.title}
                  onChange={(e) => e.currentTarget.value.trim() && renameRepeat(r.id, e.currentTarget.value.trim())}
                />
                <button class="link" onClick={() => toggleRepeatPaused(r.id)}>{r.paused ? "Resume" : "Pause"}</button>
                <button class="ib soft" aria-label={`Delete repeat ${r.title}`} onClick={() => deleteRepeat(r.id)}>
                  <ITrash size={14} />
                </button>
              </div>
              <WeekPicker days={r.days} onChange={(d) => setRepeatDays(r.id, d)} />
            </div>
          )}
        </For>
      </Show>
    </Panel>
  );
}

function SettingsSheet() {
  const change = async () => {
    const picked = await open({ directory: true, title: "Choose where Quicky keeps your stuff" });
    if (typeof picked === "string") {
      await chooseDataDir(picked);
      showToast("Now using the new folder");
    }
  };
  const [sounds, setSoundsSignal] = createSignal(readSfx());
  const setSounds = (p: ReturnType<typeof readSfx>) => {
    writeSfx(p);
    setSoundsSignal(p);
  };
  const [startup, setStartup] = createSignal(false);
  const [bubble, setBubble] = createSignal(true);
  isEnabled().then(setStartup).catch(() => {});
  invoke<boolean>("get_show_bubble").then(setBubble).catch(() => {});
  // The bubble can also be hidden from its own right-click menu or brought back from the tray.
  const stop = listen<boolean>("bubble-pref", (e) => setBubble(e.payload));
  onCleanup(() => void stop.then((u) => u()));
  const [stuck, setStuck] = createSignal<{ exe: string; name: string }[]>([]);
  const loadStuck = () => invoke<{ exe: string; name: string }[]>("stuck_apps").then(setStuck).catch(() => {});
  void loadStuck();
  const stopStuck = listen("stuck-apps", loadStuck);
  onCleanup(() => void stopStuck.then((u) => u()));
  const toggleStartup = async () => {
    const next = !startup();
    await (next ? enable() : disable());
    setStartup(next);
  };
  const toggleBubble = async () => {
    const next = !bubble();
    await invoke("set_show_bubble", { show: next });
    setBubble(next);
  };
  const [version, setVersion] = createSignal("");
  getVersion().then(setVersion).catch(() => {});
  const [auto, setAuto] = createSignal(autoCheck());
  const updateLine = () => {
    const u = updateState();
    if (u.kind === "checking") return "Checking…";
    if (u.kind === "latest") return "You have the latest version";
    if (u.kind === "ready") return `Version ${u.version} is ready to install`;
    if (u.kind === "installing") return `Updating… ${Math.round(u.progress * 100)}%`;
    if (u.kind === "failed") return "Couldn't check right now. Try again in a bit";
    return "";
  };
  return (
    <Panel title="Settings" class="settings-sheet">
      <div class="box">
        <span class="box-label">Colour</span>
        <div class="swatches" role="group" aria-label="Accent colour">
          <For each={ACCENTS}>
            {(a) => (
              <button
                class="swatch"
                classList={{ on: theme().accent === a.id }}
                style={{ background: a.color }}
                aria-label={a.name}
                aria-pressed={theme().accent === a.id}
                title={a.name}
                onClick={() => setTheme({ accent: a.id })}
              />
            )}
          </For>
          {/* Your own colour: the native picker sits invisibly on top of the swatch. */}
          <label
            class="swatch custom"
            classList={{ on: theme().accent === "custom" }}
            style={{
              background: theme().accent === "custom" ? theme().custom : "conic-gradient(#ff6b6b, #ffd166, #06d6a0, #4cc9f0, #7b61ff, #ff6bd6, #ff6b6b)",
              color: onAccent(theme().custom),
            }}
            title="Pick your own colour"
          >
            <input
              type="color"
              aria-label="Custom colour"
              value={theme().custom}
              onInput={(e) => setTheme({ accent: "custom", custom: e.currentTarget.value })}
              onClick={() => theme().accent !== "custom" && setTheme({ accent: "custom" })}
            />
            <Show when={theme().accent !== "custom"}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2b2540" stroke-width="3" stroke-linecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </Show>
          </label>
        </div>
        <div class="segment modes" role="group" aria-label="Light or dark">
          <For each={[["light", "Light"], ["dark", "Dark"], ["auto", `Match ${SYSTEM_NAME}`]] as const}>
            {([m, label]) => (
              <button classList={{ on: theme().mode === m }} aria-pressed={theme().mode === m} onClick={() => setTheme({ mode: m })}>
                {label}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="box">
        <label class="switch-row">
          <span>{OS === "windows" ? "Start with Windows" : "Open at login"}<small>Opens quietly in the {OS === "mac" ? "menu bar" : "tray"} when you sign in</small></span>
          <input type="checkbox" role="switch" checked={startup()} onChange={toggleStartup} />
        </label>
        <label class="switch-row">
          <span>Bubble on screen<small>Little Quicky that waits while the app is closed. Drag it anywhere; right-click for options</small></span>
          <input type="checkbox" role="switch" checked={bubble()} onChange={toggleBubble} />
        </label>
        <Show
          when={stuck().length}
          fallback={<small class="muted">Drag the bubble onto any app to give that app its own mini Quicky.</small>}
        >
          <div class="stuck-list">
            <span class="box-label"><IPin2 size={14} /> Mini Quicky in</span>
            <For each={stuck()}>
              {(s) => (
                <span class="time-chip" title={s.exe}>
                  {s.name}
                  <button aria-label={`Remove mini Quicky from ${s.name}`} onClick={() => invoke("unstick_bubble", { exe: s.exe })}>
                    <IClose size={10} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="box">
        <label class="switch-row">
          <span>Sounds<small>Little sound effects for adding, finishing, the bubble and reminders</small></span>
          <input type="checkbox" role="switch" checked={sounds().on} onChange={() => setSounds({ ...sounds(), on: !sounds().on })} />
        </label>
        <Show when={sounds().on}>
          <label class="volume-row">
            <span>Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={sounds().volume}
              onChange={(e) => {
                setSounds({ ...sounds(), volume: Number(e.currentTarget.value) });
                sfx.done();
              }}
            />
          </label>
        </Show>
      </div>
      <div class="box">
        <div class="box-row">
          <span class="box-label">Updates · Quicky {version()}</span>
          <Show
            when={updateState().kind === "ready"}
            fallback={
              <button class="btn small" disabled={updateState().kind === "checking" || updateState().kind === "installing"} onClick={() => void checkForUpdate()}>
                Check now
              </button>
            }
          >
            <button class="btn small primary" onClick={() => void installUpdate()}>Update and restart</button>
          </Show>
        </div>
        <Show when={updateLine()}>
          <small class="muted" role="status">{updateLine()}</small>
        </Show>
        <label class="switch-row">
          <span>Check for updates automatically<small>Looks for new versions on GitHub now and then; you choose when to install</small></span>
          <input
            type="checkbox"
            role="switch"
            checked={auto()}
            onChange={() => {
              setAutoCheck(!auto());
              setAuto(!auto());
            }}
          />
        </label>
      </div>
      <div class="box">
        <div class="box-row">
          <span class="box-label"><IBell size={14} /> Reminders</span>
          <span class="row-gap">
            <button class="btn small" onClick={() => setSheet({ kind: "reminders" })}>See all</button>
            <button class="btn small" onClick={previewReminder}>Preview one</button>
          </span>
        </div>
        <QuietHours />
      </div>
      <div class="box">
        <div class="box-row">
          <span class="box-label">Tips</span>
          <button
            class="btn small"
            onClick={() => {
              setSheet(null);
              showTour();
            }}
          >
            Show the tour again
          </button>
        </div>
      </div>
      <p class="muted">Tasks and media live in this folder on this computer:</p>
      <code class="path">{dataDir()}</code>
      <div class="sheet-actions">
        <button class="btn ghost" onClick={() => invoke("open_data_dir")}><IFolder size={15} /> Open folder</button>
        <button class="btn ghost" onClick={change}>Change…</button>
      </div>
    </Panel>
  );
}

/** Reminders wait during quiet hours (and while a full-screen app is up), then show together. */
function QuietHours() {
  const [q, setQ] = createSignal(readQuiet());
  const set = (patch: Partial<ReturnType<typeof readQuiet>>) => {
    const next = { ...q(), ...patch };
    writeQuiet(next);
    setQ(next);
  };
  return (
    <>
      <label class="switch-row">
        <span>Quiet hours<small>Reminders wait, then show together when quiet hours end</small></span>
        <input type="checkbox" role="switch" checked={q().on} onChange={() => set({ on: !q().on })} />
      </label>
      <Show when={q().on}>
        <div class="quiet-times">
          <label>From <input type="time" value={q().from} onChange={(e) => e.currentTarget.value && set({ from: e.currentTarget.value })} /></label>
          <label>to <input type="time" value={q().to} onChange={(e) => e.currentTarget.value && set({ to: e.currentTarget.value })} /></label>
        </div>
      </Show>
      <label class="switch-row">
        <span>Wait during full-screen apps<small>Games, videos and presentations aren't interrupted</small></span>
        <input type="checkbox" role="switch" checked={q().busy} onChange={() => set({ busy: !q().busy })} />
      </label>
    </>
  );
}

export function Sheets() {
  return (
    <Show when={sheet()} keyed>
      {(s) =>
        s.kind === "task" ? <TaskSheet id={s.id} />
        : s.kind === "done" ? <DoneDrawer />
        : s.kind === "later" ? <LaterSheet />
        : s.kind === "search" ? <SearchSheet />
        : s.kind === "repeats" ? <RepeatsSheet />
        : s.kind === "reminders" ? <RemindersSheet />
        : <SettingsSheet />
      }
    </Show>
  );
}

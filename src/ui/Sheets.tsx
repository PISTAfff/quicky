import { createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { ACCENTS, setTheme, theme } from "../lib/theme";
import { onAccent } from "../lib/theme-colors";
import {
  addAttachments, chooseDataDir, clock, data, dataDir, deleteRepeat, makeRepeat, removeAttachment, removeTask,
  renameRepeat, setReminder, setSpace, spaceName, spaceRepeats, spaceTasks, setRepeatDays, setStatus, showToast, toggleRepeatPaused, today, updateTask,
} from "../lib/store";
import { EVERY_DAY, describeReminder, parseDay, reminderOf, upcoming, whenLabel, type Status, type Task } from "../lib/model";
import { pickFiles, startRecording, type Recording } from "../lib/media";
import { previewReminder } from "../lib/reminders";
import { readSfx, sfx, writeSfx } from "../lib/sfx";
import { Blob, IBell, IClip, IClose, IMic, IPin2, IRepeat, IRestore, ITrash, IFolder, IStop } from "./icons";
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
          <For each={[["light", "Light"], ["dark", "Dark"], ["auto", "Match Windows"]] as const}>
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
          <span>Start with Windows<small>Opens quietly in the tray when you sign in</small></span>
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
          <span class="box-label"><IBell size={14} /> Reminders</span>
          <span class="row-gap">
            <button class="btn small" onClick={() => setSheet({ kind: "reminders" })}>See all</button>
            <button class="btn small" onClick={previewReminder}>Preview one</button>
          </span>
        </div>
      </div>
      <p class="muted">Tasks and media live in this folder on your PC:</p>
      <code class="path">{dataDir()}</code>
      <div class="sheet-actions">
        <button class="btn ghost" onClick={() => invoke("open_data_dir")}><IFolder size={15} /> Open folder</button>
        <button class="btn ghost" onClick={change}>Change…</button>
      </div>
    </Panel>
  );
}

export function Sheets() {
  return (
    <Show when={sheet()} keyed>
      {(s) =>
        s.kind === "task" ? <TaskSheet id={s.id} />
        : s.kind === "done" ? <DoneDrawer />
        : s.kind === "repeats" ? <RepeatsSheet />
        : s.kind === "reminders" ? <RemindersSheet />
        : <SettingsSheet />
      }
    </Show>
  );
}

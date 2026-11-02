import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  addAttachments, addStep, bringBack, data, deleteRepeat, makeRepeat, putOff, removeAttachment, removeStep, removeTask, renameStep,
  setDue, setFocus, setRepeatDays, setStatus, showToast, toggleStep, today, updateTask,
} from "../../lib/store";
import { EVERY_DAY, dueLabel, isLater, plusDays, shortDueLabel, type Status, type Task } from "../../lib/model";
import { pickFiles, startRecording, type Recording } from "../../lib/media";
import { ICalendar, IChecks, IClip, IClose, IMic, IMoon, IRepeat, ITarget, ITrash, IStop } from "../icons";
import { MediaView } from "../Media";
import { RecStrip } from "../LiveWave";
import { WeekPicker } from "../WeekPicker";
import { RemindBox } from "../RemindBox";
import { setSheet } from "../state";
import { Panel } from "./Panel";
import { laterDay } from "./dates";

export function TaskSheet(p: { id: string; edit?: boolean }) {
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
            title="Edit the title"
            ref={(el) => p.edit && queueMicrotask(() => (el.focus(), el.select()))}
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

/** When it's due, and "not today": hide it until tomorrow or a picked day. */
function DueBox(p: { task: Task }) {
  // Short: the date box right beside it shows the full date.
  const label = () => (p.task.due ? { text: shortDueLabel(p.task.due, today()), tone: dueLabel(p.task.due, today()).tone } : null);
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

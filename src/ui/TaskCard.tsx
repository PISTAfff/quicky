import { For, Show } from "solid-js";
import type { Task } from "../lib/model";
import { daysBetween, dueLabel, nextReminder, plusDays, stepsDone } from "../lib/model";
import { clock, data, nextStatus, prevStatus, putOff, removeTask, setFocus, setStatus, today } from "../lib/store";
import { openMenu, type MenuItem } from "./ContextMenu";
import { IBell, IChecks, ICalendar, IRepeat, ITarget } from "./icons";
import { Thumb } from "./Media";
import { ordinal, setSheet } from "./state";

export function StatusDot(p: { task: Task }) {
  const label = () => ({ todo: "To do", doing: "Doing", done: "Done" })[p.task.status];
  return (
    <button
      class={`dot ${p.task.status}`}
      aria-label={`Status: ${label()}. Click to advance, right-click to go back`}
      title={`${label()} · click: next · right-click: back`}
      onClick={(e) => {
        e.stopPropagation();
        setStatus(p.task.id, nextStatus(p.task.status));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setStatus(p.task.id, prevStatus(p.task.status));
      }}
    >
      <Show when={p.task.status === "done"}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </Show>
    </button>
  );
}

/** What right-clicking a task offers. */
function taskMenu(t: Task): MenuItem[] {
  const pinned = data.focus?.id === t.id;
  const items: MenuItem[] = [{ label: "Edit", run: () => setSheet({ kind: "task", id: t.id, edit: true }) }, "sep"];
  if (t.status === "todo") items.push({ label: "Start", run: () => setStatus(t.id, "doing") });
  if (t.status !== "done") {
    items.push({ label: "Finish", run: () => setStatus(t.id, "done") });
    if (t.status === "doing") items.push({ label: "Back to To do", run: () => setStatus(t.id, "todo") });
    items.push({ label: pinned ? "Unpin from the bubble" : "Pin to the bubble", run: () => setFocus(pinned ? null : t.id) });
    items.push({ label: "Not today", run: () => putOff(t.id, plusDays(1)) });
  } else items.push({ label: "Not done yet", run: () => setStatus(t.id, "todo") });
  items.push("sep", { label: "Delete", danger: true, run: () => removeTask(t.id) });
  return items;
}

export function TaskCard(p: { task: Task; onPointerDown?: (e: PointerEvent) => void; unseen?: boolean }) {
  const carriedDays = () => (p.task.status !== "done" ? daysBetween(p.task.since, today()) : 0);
  const due = () => (p.task.due && p.task.status !== "done" ? dueLabel(p.task.due, today()) : null);
  const steps = () => stepsDone(p.task);
  const pinned = () => data.focus?.id === p.task.id;
  const MAX_THUMBS = 3;
  return (
    <article
      class={`card ${p.task.status}`}
      classList={{ carried: carriedDays() > 0, overdue: due()?.tone === "late", focused: pinned(), unseen: !!p.unseen }}
      data-id={p.task.id}
      onPointerDown={p.onPointerDown}
      onContextMenu={(e) => openMenu(e, taskMenu(p.task))}
    >
      <StatusDot task={p.task} />
      {/* The whole body opens the task; the title is the keyboard-focusable control. */}
      <div class="card-body" onClick={() => setSheet({ kind: "task", id: p.task.id })}>
        <button class="card-title" onClick={(e) => { e.stopPropagation(); setSheet({ kind: "task", id: p.task.id }); }}>
          {p.task.title}
        </button>
        <Show when={carriedDays() > 0 || p.task.repeatId || p.task.attachments.length || nextReminder(p.task, new Date(clock())) || due() || steps() || pinned()}>
          <span class="card-meta">
            <Show when={pinned()}>
              <span class="chip focus" title="Pinned to the bubble"><ITarget size={11} />On the bubble</span>
            </Show>
            <Show when={due()}>
              {(d) => <span class={`chip due ${d().tone}`}><ICalendar size={11} />{d().text}</span>}
            </Show>
            <Show when={steps()}>
              {(st) => (
                <span class="chip steps" classList={{ all: st().done === st().total }} title="Steps done">
                  <IChecks size={11} />{st().done}/{st().total}
                </span>
              )}
            </Show>
            <Show when={carriedDays() > 0}>
              <span class="carried-label">Carried · {ordinal(carriedDays() + 1)} day</span>
            </Show>
            <Show when={p.task.repeatId}>
              <span class="chip repeat"><IRepeat size={11} />Repeats</span>
            </Show>
            <Show when={nextReminder(p.task, new Date(clock()))}>
              {(at) => <span class="chip bell" title="Next reminder"><IBell size={11} />{at()}</span>}
            </Show>
            <For each={p.task.attachments.slice(0, MAX_THUMBS)}>{(a) => <Thumb att={a} />}</For>
            <Show when={p.task.attachments.length > MAX_THUMBS}>
              <span class="more">+{p.task.attachments.length - MAX_THUMBS}</span>
            </Show>
          </span>
        </Show>
      </div>
      {/* One-tap status change without opening the task (always shown in small windows). */}
      <div class="quick-acts">
        <Show
          when={p.task.status === "doing"}
          fallback={
            <button class="qa doing" aria-label={`Start ${p.task.title}`} title="Doing" onClick={(e) => { e.stopPropagation(); setStatus(p.task.id, "doing"); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
            </button>
          }
        >
          <button class="qa todo" aria-label={`Back to to-do: ${p.task.title}`} title="Back to To do" onClick={(e) => { e.stopPropagation(); setStatus(p.task.id, "todo"); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
          </button>
        </Show>
        <button class="qa done" aria-label={`Finish ${p.task.title}`} title="Done" onClick={(e) => { e.stopPropagation(); setStatus(p.task.id, "done"); }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
        </button>
      </div>
    </article>
  );
}

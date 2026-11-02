import { createMemo, For, Show } from "solid-js";
import { clock, data, setReminder, setSpace, spaceName } from "../../lib/store";
import { describeReminder, reminderOf, upcoming, whenLabel, type Task } from "../../lib/model";
import { Blob, ITrash } from "../icons";
import { setSheet } from "../state";
import { Panel } from "./Panel";

/** Every task with a reminder, across all lists: see when, pause/resume, or stop each. */
export function RemindersSheet() {
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

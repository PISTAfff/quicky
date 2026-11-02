import { createMemo, For, Show } from "solid-js";
import { bringBack, spaceTasks, today } from "../../lib/store";
import { isLater } from "../../lib/model";
import { Blob, IMoon, IRestore } from "../icons";
import { setSheet } from "../state";
import { Panel } from "./Panel";
import { laterDay } from "./dates";

/** Tasks put off with "not today", until their day comes. */
export function LaterSheet() {
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

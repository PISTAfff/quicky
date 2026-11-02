import { createMemo, For, Show } from "solid-js";
import { data, spaceTasks, setStatus, today } from "../../lib/store";
import { parseDay } from "../../lib/model";
import { Blob, IRestore } from "../icons";
import { setSheet, WEEK_LONG } from "../state";
import { Panel } from "./Panel";

export function DoneDrawer() {
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

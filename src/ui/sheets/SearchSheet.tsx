import { createMemo, createSignal, For, Show } from "solid-js";
import { data, setSpace, spaceName, today } from "../../lib/store";
import { isLater, searchTasks, type Task } from "../../lib/model";
import { Blob, ISearch } from "../icons";
import { setSheet } from "../state";
import { Panel } from "./Panel";

/** Every task in every list (done ones too): titles, notes, steps and file names. */
export function SearchSheet() {
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

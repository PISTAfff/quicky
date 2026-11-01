import { createMemo, For, Show } from "solid-js";
import { data, today } from "../lib/store";
import { parseDay } from "../lib/model";
import { WEEK_LONG } from "./state";

export const useProgress = () =>
  createMemo(() => {
    const t = today();
    let done = 0;
    let total = 0;
    for (const task of data.tasks) {
      if (task.status !== "done") total++;
      else if (task.doneDay === t) {
        done++;
        total++;
      }
    }
    return { done, total };
  });

const MAX_SQUARES = 12;

export function Progress(p: { compact?: boolean }) {
  const prog = useProgress();
  const squares = createMemo(() => {
    const { done, total } = prog();
    // Past 12 tasks each square stands for a share, so the row never wraps.
    const n = Math.min(total, MAX_SQUARES);
    const filled = total ? Math.round((done / total) * n) : 0;
    return Array.from({ length: n }, (_, i) => i < filled);
  });
  return (
    <div class="progress" classList={{ compact: p.compact }}>
      <Show when={!p.compact}>
        <span class="progress-text">
          {prog().total ? `${prog().done} of ${prog().total} done` : "Nothing yet"}
        </span>
      </Show>
      <div class="squares" role="img" aria-label={`${prog().done} of ${prog().total} done`}>
        <For each={squares()}>{(on) => <i classList={{ on }} />}</For>
      </div>
    </div>
  );
}

export function DateTitle() {
  const d = () => parseDay(today());
  return <h1 class="date">{`${WEEK_LONG[d().getDay()]} ${d().getDate()}`}</h1>;
}

export function Header() {
  return (
    <div class="header">
      <DateTitle />
      <Progress />
    </div>
  );
}

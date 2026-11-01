import { createMemo, createSignal, For, Show } from "solid-js";
import { data, setStatus, today } from "../lib/store";
import type { Status, Task } from "../lib/model";
import { DateTitle, Header, Progress } from "./Header";
import { QuickAdd } from "./QuickAdd";
import { TaskCard } from "./TaskCard";
import { Blob, IArrow, IRepeat, IUp } from "./icons";
import { setSheet } from "./state";

const open = () => data.tasks.filter((t) => t.status !== "done");
const byStatus = (a: Task, b: Task) => (a.status === b.status ? 0 : a.status === "doing" ? -1 : 1);
const doneCount = () => data.tasks.filter((t) => t.status === "done").length;

function DrawerButton() {
  return (
    <button class="drawer-btn" onClick={() => setSheet({ kind: "done" })}>
      <Blob size={18} color="var(--mint)" mood="done" />
      Done drawer · {doneCount()} hidden
      <IUp size={14} />
    </button>
  );
}

function Empty() {
  return (
    <div class="empty">
      <Blob size={48} />
      <p>All clear! Add a mini task above.</p>
    </div>
  );
}

type Filter = "all" | "todo" | "doing";

export function ListView() {
  const [filter, setFilter] = createSignal<Filter>("all");
  const tasks = createMemo(() => {
    const f = filter();
    return open().filter((t) => f === "all" || t.status === f);
  });
  const carried = createMemo(() => tasks().filter((t) => t.since < today()).sort(byStatus));
  const fresh = createMemo(() => tasks().filter((t) => t.since >= today()).sort(byStatus));
  const count = (s: Status) => open().filter((t) => t.status === s).length;

  return (
    <div class="view list">
      <Header />
      <QuickAdd />
      <div class="pills" role="group" aria-label="Filter">
        <For each={[["all", "All", open().length], ["todo", "To do", count("todo")], ["doing", "Doing", count("doing")]] as const}>
          {([key, label]) => (
            <button classList={{ on: filter() === key }} aria-pressed={filter() === key} onClick={() => setFilter(key)}>
              {label} {key === "all" ? open().length : count(key)}
            </button>
          )}
        </For>
        <button class="pill-repeat" aria-label="Repeating tasks" title="Repeating tasks" onClick={() => setSheet({ kind: "repeats" })}>
          <IRepeat size={13} /> {data.repeats.length}
        </button>
      </div>
      <div class="scroll">
        <Show when={tasks().length} fallback={<Empty />}>
          <Show when={carried().length}>
            <div class="group-label warm"><IArrow size={13} /> Carried over</div>
            <For each={carried()}>{(t) => <TaskCard task={t} />}</For>
          </Show>
          <Show when={fresh().length}>
            <div class="group-label">Today</div>
            <For each={fresh()}>{(t) => <TaskCard task={t} />}</For>
          </Show>
        </Show>
      </div>
      <DrawerButton />
    </div>
  );
}

export function MiniView() {
  const next = createMemo(() => [...open()].sort(byStatus).slice(0, 2));
  const rest = () => Math.max(0, open().length - next().length);
  return (
    <div class="view mini">
      <QuickAdd compact />
      <div class="scroll">
        <For each={next()} fallback={<p class="muted center">All clear!</p>}>{(t) => <TaskCard task={t} />}</For>
      </div>
      <div class="mini-foot">
        <Progress compact />
        <Show when={rest()}><span>+{rest()} more</span></Show>
      </div>
    </div>
  );
}

/** Pointer-based drag (HTML5 DnD is taken over by the file-drop handler on Windows). */
function useCardDrag() {
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [overCol, setOverCol] = createSignal<Status | null>(null);

  const start = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".dot, .audio-play")) return;
    const card = e.currentTarget as HTMLElement;
    const id = card.dataset.id!;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;

    const colAt = (x: number, y: number) => {
      card.style.pointerEvents = "none";
      const col = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-col]");
      card.style.pointerEvents = "";
      return (col?.dataset.col as Status | undefined) ?? null;
    };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!dragging && Math.hypot(dx, dy) < 6) return;
      if (!dragging) {
        dragging = true;
        setDragId(id);
        card.setPointerCapture(ev.pointerId);
      }
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(2deg)`;
      setOverCol(colAt(ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!dragging) return;
      const col = colAt(ev.clientX, ev.clientY);
      card.style.transform = "";
      setDragId(null);
      setOverCol(null);
      // Swallow the click that follows a drag so the task sheet doesn't open.
      const swallow = (c: MouseEvent) => c.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      const task = data.tasks.find((t) => t.id === id);
      if (col && task && task.status !== col) setStatus(id, col);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { start, dragId, overCol };
}

export function BoardView() {
  const drag = useCardDrag();
  const col = (s: Status) => open().filter((t) => t.status === s);
  const COLS = [
    { key: "todo", label: "To do" },
    { key: "doing", label: "Doing" },
    { key: "done", label: "Done" },
  ] as const;

  return (
    <div class="view board">
      <aside class="rail">
        <DateTitle />
        <Progress />
        <div class="rail-links">
          <button onClick={() => setSheet({ kind: "repeats" })}><IRepeat size={14} /> Repeats · {data.repeats.length}</button>
          <button onClick={() => setSheet({ kind: "done" })}><Blob size={15} color="var(--mint)" mood="done" /> Done · {doneCount()}</button>
        </div>
      </aside>
      <div class="board-main">
        <QuickAdd />
        <div class="columns">
          <For each={COLS}>
            {(c) => (
              <section
                class={`col ${c.key}`}
                classList={{ over: drag.overCol() === c.key, dropzone: c.key === "done" }}
                data-col={c.key}
                aria-label={c.label}
              >
                <Show
                  when={c.key !== "done"}
                  fallback={
                    <div class="done-zone">
                      <Blob size={30} color="var(--mint)" mood="done" />
                      <span>Drop here to finish</span>
                    </div>
                  }
                >
                  <div class="col-head">{c.label} · {col(c.key).length}</div>
                  <div class="col-list">
                    <For each={col(c.key)}>
                      {(t) => (
                        <div classList={{ dragging: drag.dragId() === t.id }}>
                          <TaskCard task={t} onPointerDown={drag.start} />
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

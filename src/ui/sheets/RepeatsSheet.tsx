import { For, Show } from "solid-js";
import { deleteRepeat, renameRepeat, spaceRepeats, setRepeatDays, toggleRepeatPaused } from "../../lib/store";
import { Blob, ITrash } from "../icons";
import { WeekPicker } from "../WeekPicker";
import { Panel } from "./Panel";

export function RepeatsSheet() {
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

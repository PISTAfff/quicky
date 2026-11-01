import { createSignal, For, onCleanup, Show } from "solid-js";
import { IClip, IMic, IPlus, IRepeat, IClose } from "./icons";
import { registerQuickInput, setStaged, staged } from "./state";
import { addTask, showToast } from "../lib/store";
import { invoke } from "@tauri-apps/api/core";
import { EVERY_DAY, type Attachment } from "../lib/model";
import { fromClipboard, pickFiles, startRecording, type Recording } from "../lib/media";
import { Thumb } from "./Media";

const REPEATS = [
  { label: "", days: undefined },
  { label: "Daily", days: EVERY_DAY },
  { label: "Weekdays", days: [1, 2, 3, 4, 5] },
] as const;

export function QuickAdd(p: { compact?: boolean }) {
  const [text, setText] = createSignal("");
  const [repeat, setRepeat] = createSignal(0);
  const [rec, setRec] = createSignal<Recording | null>(null);
  const [secs, setSecs] = createSignal(0);
  let clock: number | undefined;

  const submit = () => {
    if (rec()) return;
    const r = REPEATS[repeat()];
    addTask(text(), staged(), r.days ? [...r.days] : undefined);
    if (text().trim() || staged().length) {
      setText("");
      setStaged([]);
      setRepeat(0);
    }
  };

  const stage = (list: Attachment[]) => setStaged([...staged(), ...list]);
  const unstage = (a: Attachment) => {
    setStaged(staged().filter((s) => s.id !== a.id));
    invoke("remove_media", { rel: a.path }).catch(() => {});
  };

  const attach = async () => {
    try {
      stage(await pickFiles());
    } catch (e) {
      showToast(`Couldn't attach: ${e}`);
    }
  };

  const toggleRecord = async () => {
    const current = rec();
    if (current) {
      clearInterval(clock);
      setRec(null);
      const att = await current.stop();
      if (att) stage([att]);
      return;
    }
    try {
      setRec(await startRecording());
      setSecs(0);
      clock = window.setInterval(() => setSecs(secs() + 1), 1000);
    } catch (e) {
      showToast("Microphone isn't available");
    }
  };
  onCleanup(() => {
    clearInterval(clock);
    rec()?.cancel();
  });

  const onPaste = async (e: ClipboardEvent) => {
    try {
      stage(await fromClipboard(e));
    } catch (err) {
      showToast(`Couldn't paste: ${err}`);
    }
  };

  const mmss = () => `${Math.floor(secs() / 60)}:${String(secs() % 60).padStart(2, "0")}`;

  return (
    <div class="quick" classList={{ compact: p.compact }}>
      <div class="quick-row">
        <div class="quick-box">
          <label for="quick-input" class="sr">Add a task</label>
          <input
            id="quick-input"
            ref={registerQuickInput}
            placeholder={rec() ? `Recording… ${mmss()}` : "Add a mini task…"}
            value={text()}
            autocomplete="off"
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            onPaste={onPaste}
          />
          <span class="kbd hide-narrow">Ctrl Space</span>
          <Show when={!p.compact}>
            <button
              class="ib"
              classList={{ on: repeat() > 0 }}
              aria-label={repeat() ? `Repeats ${REPEATS[repeat()].label}` : "Make recurring"}
              title="Repeat: off / daily / weekdays"
              onClick={() => setRepeat((repeat() + 1) % REPEATS.length)}
            >
              <IRepeat size={16} />
            </button>
            <button class="ib" aria-label="Attach file" title="Attach files" onClick={attach}>
              <IClip size={16} />
            </button>
          </Show>
          <button
            class="ib"
            classList={{ rec: !!rec() }}
            aria-label={rec() ? "Stop recording" : "Record voice note"}
            title={rec() ? "Stop" : "Voice note"}
            onClick={toggleRecord}
          >
            <Show when={rec()} fallback={<IMic size={16} />}>
              <i class="rec-dot" />
            </Show>
          </button>
        </div>
        <button class="add-btn" aria-label="Add task" onClick={submit}>
          <IPlus size={18} />
        </button>
      </div>
      <Show when={staged().length || repeat()}>
        <div class="staged">
          <Show when={repeat()}>
            <span class="chip repeat"><IRepeat size={11} />{REPEATS[repeat()].label}</span>
          </Show>
          <For each={staged()}>
            {(a) => (
              <span class="staged-item">
                <Thumb att={a} />
                <button
                  class="x"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => unstage(a)}
                >
                  <IClose size={10} />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

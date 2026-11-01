import { createSignal, For, onCleanup, Show } from "solid-js";
import { IClip, IMic, IPlus, IRepeat, IClose, IStop } from "./icons";
import { registerQuickInput, setStaged, staged } from "./state";
import { addTask, showToast } from "../lib/store";
import { invoke } from "@tauri-apps/api/core";
import { EVERY_DAY, type Attachment } from "../lib/model";
import { fromClipboard, pickFiles, startRecording, type Recording } from "../lib/media";
import { Thumb } from "./Media";
import { RecStrip } from "./LiveWave";
import { sfx } from "../lib/sfx";
import { WeekPicker, daysLabel } from "./WeekPicker";


export function QuickAdd(p: { compact?: boolean }) {
  const [text, setText] = createSignal("");
  // Days the new task repeats on (empty = doesn't repeat); picked in a small row under the box.
  const [days, setDays] = createSignal<number[]>([]);
  const [picking, setPicking] = createSignal(false);
  const [rec, setRec] = createSignal<Recording | null>(null);

  const submit = () => {
    if (rec()) return;
    addTask(text(), staged(), days().length ? days() : undefined);
    if (text().trim() || staged().length) {
      setText("");
      setStaged([]);
      setDays([]);
      setPicking(false);
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
      sfx.recStop();
      setRec(null);
      const att = await current.stop();
      if (att) stage([att]);
      return;
    }
    try {
      setRec(await startRecording());
      sfx.recStart();
    } catch {
      showToast("Microphone isn't available");
    }
  };
  const cancelRecord = () => {
    rec()?.cancel();
    setRec(null);
  };
  onCleanup(() => rec()?.cancel());

  const onPaste = async (e: ClipboardEvent) => {
    try {
      stage(await fromClipboard(e));
    } catch (err) {
      showToast(`Couldn't paste: ${err}`);
    }
  };


  return (
    <div class="quick" classList={{ compact: p.compact }}>
      <div class="quick-row">
        <div class="quick-box" classList={{ recording: !!rec() }}>
          <Show
            when={rec()}
            fallback={
              <>
                <label for="quick-input" class="sr">Add a task</label>
                <input
                  id="quick-input"
                  ref={registerQuickInput}
                  placeholder="Add a mini task…"
                  value={text()}
                  autocomplete="off"
                  onInput={(e) => setText(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  onPaste={onPaste}
                />
                <span class="kbd hide-narrow">Ctrl Space</span>
              </>
            }
          >
            {(r) => <RecStrip analyser={r().analyser} onCancel={cancelRecord} />}
          </Show>
          <Show when={!p.compact && !rec()}>
            <button
              class="ib"
              classList={{ on: days().length > 0 || picking() }}
              aria-label="Repeat on days"
              aria-expanded={picking()}
              title="Repeat on days you pick"
              onClick={() => {
                if (!picking() && !days().length) setDays([...EVERY_DAY]);
                setPicking(!picking());
              }}
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
              <IStop size={14} />
            </Show>
          </button>
        </div>
        <button class="add-btn" aria-label="Add task" onClick={submit}>
          <IPlus size={18} />
        </button>
      </div>
      <Show when={picking()}>
        <div class="repeat-pick">
          <WeekPicker days={days()} onChange={setDays} allowEmpty />
          <button class="link" onClick={() => setDays(days().length === 7 ? [] : [...EVERY_DAY])}>
            {days().length === 7 ? "Clear" : "Every day"}
          </button>
        </div>
      </Show>
      <Show when={staged().length || (days().length && !picking())}>
        <div class="staged">
          <Show when={days().length && !picking()}>
            <button class="chip repeat" onClick={() => setPicking(true)} title="Change days">
              <IRepeat size={11} />{daysLabel(days())}
            </button>
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

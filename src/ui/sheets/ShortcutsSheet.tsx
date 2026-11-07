import { createSignal, For, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { OS } from "../../lib/platform";
import { fromEvent, label, normalize, problem } from "../../lib/keys";
import { globals, LOCAL_DEFAULTS, locals, refreshGlobals, setLocal, type GlobalId, type LocalId } from "../../lib/shortcuts";
import { showToast } from "../../lib/store";
import { Panel } from "./Panel";

type Row = { kind: "global"; id: GlobalId; text: string; note?: string } | { kind: "local"; id: LocalId; text: string };

const ROWS: Row[] = [
  { kind: "global", id: "quick", text: "Open Quicky and add a task", note: "Press it again to close Quicky" },
  { kind: "global", id: "bubble", text: "Show or hide the bubble" },
  { kind: "global", id: "draw", text: "Draw on screen" },
  { kind: "local", id: "add", text: "Jump to the add box" },
  { kind: "local", id: "search", text: "Search all tasks" },
];

/** Settings → Shortcuts: every shortcut, its keys, and a way to change or reset them. Global ones
 *  are Rust's (registered system-wide); in-app ones only work while Quicky's window is in front. */
export function ShortcutsSheet() {
  void refreshGlobals();
  /** The row recording keys now, what's held so far, and why the last try didn't work. */
  const [recording, setRecording] = createSignal<string | null>(null);
  const [held, setHeld] = createSignal("");
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const key = (r: Row) => `${r.kind}:${r.id}`;
  const setError = (r: Row, msg: string) => setErrors({ ...errors(), [key(r)]: msg });

  const keysOf = (r: Row): string[] => (r.kind === "local" ? (locals()[r.id] ? [locals()[r.id]] : []) : (globals().find((g) => g.id === r.id)?.keys ?? []));
  const defaultsOf = (r: Row): string[] => (r.kind === "local" ? [LOCAL_DEFAULTS[r.id]] : (globals().find((g) => g.id === r.id)?.defaults ?? []));
  const isDefault = (r: Row) => keysOf(r).join() === defaultsOf(r).map((k) => normalize(k)).join();
  const taken = (r: Row) => (r.kind === "global" ? (globals().find((g) => g.id === r.id)?.taken ?? []) : []);
  const unavailable = (r: Row) => r.kind === "global" && globals().find((g) => g.id === r.id)?.available === false;

  /** Keys used by another row (in-app ones also can't take a global one: it would never arrive). */
  const usedBy = (r: Row, accel: string) =>
    ROWS.find((o) => key(o) !== key(r) && keysOf(o).some((k) => normalize(k) === accel));

  const save = async (r: Row, keys: string[] | null) => {
    setErrors({ ...errors(), [key(r)]: "" });
    if (r.kind === "local") return setLocal(r.id, keys === null ? null : (keys[0] ?? ""));
    try {
      await invoke("shortcut_set", { id: r.id, keys });
    } catch (e) {
      setError(r, String(e));
    }
  };

  const stop = () => {
    if (recording() === null) return;
    setRecording(null);
    setHeld("");
    removeEventListener("keydown", onKey, true);
    removeEventListener("keyup", onKeyUp, true);
    removeEventListener("blur", stop);
    void invoke("shortcuts_pause", { paused: false }).catch(() => {});
  };
  let current: Row | null = null;
  const onKeyUp = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHeld(modsOf(e));
  };
  const onKey = (e: KeyboardEvent) => {
    const r = current;
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return stop();
    if (e.code === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      stop();
      return void save(r, []);
    }
    const accel = fromEvent(e);
    if (!accel) return setHeld(modsOf(e));
    const why = problem(accel, OS);
    if (why) return setError(r, why);
    const other = usedBy(r, normalize(accel)!);
    if (other) return setError(r, `Already used for "${other.text}"`);
    stop();
    void save(r, [accel]);
  };
  const record = (r: Row) => {
    stop();
    current = r;
    setErrors({ ...errors(), [key(r)]: "" });
    setRecording(key(r));
    addEventListener("keydown", onKey, true);
    addEventListener("keyup", onKeyUp, true);
    addEventListener("blur", stop);
    // Registered keys never reach the page: let go of them while recording.
    void invoke("shortcuts_pause", { paused: true }).catch(() => {});
  };
  onCleanup(stop);

  const resetAll = async () => {
    stop();
    for (const id of Object.keys(LOCAL_DEFAULTS) as LocalId[]) setLocal(id, null);
    setErrors({});
    await invoke("shortcuts_reset").catch((e) => showToast(String(e)));
  };

  return (
    <Panel title="Shortcuts" class="shortcuts-sheet">
      <p class="muted">
        Choose <b>Change</b>, then press the new keys with {OS === "mac" ? "⌘, ⌥ or ⌃" : `Ctrl, Alt or ${OS === "windows" ? "Win" : "Super"}`}. Esc cancels; Backspace leaves it with no shortcut.
      </p>
      <For each={[["global", "Anywhere"], ["local", "In Quicky's window"]] as const}>
        {([kind, title]) => (
          <div class="box">
            <span class="box-label">{title}</span>
            <For each={ROWS.filter((r) => r.kind === kind)}>
              {(r) => (
                <div class="shortcut-row">
                  <div class="shortcut-what">
                    <span>{r.text}</span>
                    <Show when={r.kind === "global" && r.note}>
                      <small class="muted">{r.kind === "global" && r.note}</small>
                    </Show>
                    <Show when={unavailable(r)}>
                      <small class="muted">Works once the Draw on screen extension is installed (Settings → Extensions)</small>
                    </Show>
                    <Show when={errors()[key(r)]}>
                      <small class="shortcut-error" role="alert">{errors()[key(r)]}</small>
                    </Show>
                  </div>
                  <div class="shortcut-keys">
                    <Show
                      when={recording() !== key(r)}
                      fallback={<span class="kbd recording" aria-live="polite">{held() ? `${held()}…` : "Press keys…"}</span>}
                    >
                      <Show when={keysOf(r).length} fallback={<span class="kbd none">None</span>}>
                        <For each={keysOf(r)}>
                          {(k) => (
                            <span class="kbd" classList={{ taken: taken(r).includes(k) }} title={taken(r).includes(k) ? "Taken by another app" : undefined}>
                              {label(k, OS)}
                              <Show when={taken(r).includes(k)}> · taken by another app</Show>
                            </span>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                  <div class="shortcut-actions">
                    <Show
                      when={recording() !== key(r)}
                      fallback={<button class="btn small" onClick={stop}>Cancel</button>}
                    >
                      <button class="btn small" onClick={() => record(r)} aria-label={`Change the shortcut to ${r.text.toLowerCase()}`}>Change</button>
                    </Show>
                    <Show when={!isDefault(r)}>
                      <button class="btn small ghost-soft" onClick={() => void save(r, null)} title={`Back to ${defaultsOf(r).map((k) => label(k, OS)).join(" and ")}`}>
                        Reset
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
      <div class="sheet-actions">
        <button class="btn ghost" onClick={() => void resetAll()}>Reset all</button>
      </div>
    </Panel>
  );
}

/** The modifiers held, as shown while recording. */
function modsOf(e: KeyboardEvent): string {
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
  return mods.length ? label([...mods, "A"].join("+"), OS).replace(/\+?\s?A$/, "") : "";
}

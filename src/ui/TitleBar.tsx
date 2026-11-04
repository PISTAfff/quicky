import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { SpacePicker } from "./SpacePicker";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Blob, IClose, IGear, IMax, IPin, ISearch, IUnmax } from "./icons";
import { pinned, setPinned, setSheet } from "./state";
import { data, flush, space } from "../lib/store";
import { MOD_KEY, QUICK_KEY } from "../lib/platform";

const win = getCurrentWindow();

export function TitleBar() {
  const togglePin = async () => {
    const next = !pinned();
    await win.setAlwaysOnTop(next);
    // Pinned also keeps Quicky open when it loses focus (otherwise it tucks itself away).
    await invoke("set_pinned", { pinned: next });
    setPinned(next);
  };
  const spaces = () => Object.entries(data.spaces ?? {}).sort((a, b) => a[1].localeCompare(b[1]));
  // The maximize button turns into "restore" while maximized (also by Win+Up or a double-click on the bar).
  const [maxed, setMaxed] = createSignal(false);
  const readMaxed = () => void win.isMaximized().then(setMaxed);
  let unlisten: (() => void) | undefined;
  onMount(() => {
    readMaxed();
    void win.onResized(readMaxed).then((u) => (unlisten = u));
  });
  onCleanup(() => unlisten?.());
  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="brand" classList={{ "has-picker": !!(spaces().length || space()) }} data-tauri-drag-region>
        <Blob size={20} />
        <span data-tauri-drag-region>Quicky</span>
        {/* Which list this is: the general one, or an app's own (switchable). */}
        <Show when={spaces().length || space()}>
          <SpacePicker />
        </Show>
      </div>
      <div class="winbtns">
        <button class="wb" aria-label="Search all tasks" title={`Search all tasks (${MOD_KEY}F)`} onClick={() => setSheet({ kind: "search" })}>
          <ISearch size={14} />
        </button>
        <button class="wb" aria-label="Settings" title="Settings: colours, startup, data folder" onClick={() => setSheet({ kind: "settings" })}>
          <IGear size={14} />
        </button>
        <button
          class="wb"
          classList={{ on: pinned() }}
          aria-label={pinned() ? "Unpin" : "Pin open"}
          aria-pressed={pinned()}
          title={pinned() ? "Pinned: stays open and on top" : "Pin: keep open and on top (otherwise it tucks away when you click elsewhere)"}
          onClick={togglePin}
        >
          <IPin size={14} />
        </button>
        <button
          class="wb"
          aria-label={maxed() ? "Restore" : "Maximize"}
          title={maxed() ? "Restore" : space() ? "Maximize (fills the app it's in)" : "Maximize"}
          onClick={() => void win.toggleMaximize()}
        >
          <Show when={maxed()} fallback={<IMax size={11} />}>
            <IUnmax size={12} />
          </Show>
        </button>
        <button
          class="wb close"
          aria-label="Close to tray"
          title={`Close (keeps running in the tray, ${QUICK_KEY} to open)`}
          onClick={async () => {
            await flush();
            await invoke("hide_main");
          }}
        >
          <IClose size={12} />
        </button>
      </div>
    </header>
  );
}

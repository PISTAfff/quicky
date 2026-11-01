import { getCurrentWindow } from "@tauri-apps/api/window";
import { Blob, IClose, IMin, IPin, IFolder } from "./icons";
import { pinned, setPinned, setSheet } from "./state";
import { flush } from "../lib/store";

const win = getCurrentWindow();

export function TitleBar() {
  const togglePin = async () => {
    const next = !pinned();
    await win.setAlwaysOnTop(next);
    setPinned(next);
  };
  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>
        <Blob size={20} />
        <span data-tauri-drag-region>Quicky</span>
      </div>
      <div class="winbtns">
        <button class="wb" aria-label="Settings" title="Data folder" onClick={() => setSheet({ kind: "settings" })}>
          <IFolder size={14} />
        </button>
        <button
          class="wb"
          classList={{ on: pinned() }}
          aria-label={pinned() ? "Unpin from top" : "Pin on top"}
          aria-pressed={pinned()}
          title="Keep on top"
          onClick={togglePin}
        >
          <IPin size={14} />
        </button>
        <button class="wb" aria-label="Minimize" onClick={() => win.minimize()}>
          <IMin size={12} />
        </button>
        <button
          class="wb close"
          aria-label="Close to tray"
          title="Close (keeps running in the tray, Ctrl+Space to open)"
          onClick={async () => {
            await flush();
            await win.hide();
          }}
        >
          <IClose size={12} />
        </button>
      </div>
    </header>
  );
}

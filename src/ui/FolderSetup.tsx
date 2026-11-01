import { createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { chooseDataDir } from "../lib/store";
import { Blob } from "./icons";

export function FolderSetup() {
  const [error, setError] = createSignal("");
  const use = async (path: string | null) => {
    if (!path) return;
    try {
      await chooseDataDir(path);
    } catch (e) {
      setError(String(e));
    }
  };
  const pick = async () => {
    const picked = await open({ directory: true, title: "Choose where Quicky keeps your stuff" });
    await use(typeof picked === "string" ? picked : null);
  };
  const useDefault = async () => use(await invoke<string>("default_data_dir"));

  return (
    <div class="setup">
      <Blob size={56} />
      <h2>Where should Quicky keep your stuff?</h2>
      <p class="muted">Pick any place on this PC and Quicky makes its own “Quicky” folder there. Choose OneDrive or Dropbox if you want it synced.</p>
      <pre class="tree">{`Quicky/\n├ quicky.json\n└ media/\n  └ 2026-11/\n    ├ sketch.png\n    └ voice-0912.webm`}</pre>
      <button class="btn primary" onClick={pick}>Choose folder…</button>
      <button class="btn ghost" onClick={useDefault}>Use Documents\Quicky</button>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    </div>
  );
}

// An installed extension on the phone: full screen over the app (the desktop gives it a window),
// in the same sandboxed frame and through the same bridge (`lib/ext-host.ts`).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { createEffect, createSignal, getOwner, on, onCleanup, onMount, runWithOwner, Show } from "solid-js";
import { readAccount, readInstalled } from "../lib/cloud";
import { hostExtension, TASKS_ALLOWED } from "../lib/ext-host";
import { runTask, taskView } from "../lib/bridge";
import { refreshEvents } from "../lib/events";
import { IClose } from "../ui/icons";

export function ExtensionView(p: { id: string; onClose: () => void }) {
  const installed = readInstalled().find((i) => i.id === p.id);
  const [note, setNote] = createSignal<{ title: string; text: string } | null>(null);
  let stage!: HTMLDivElement;
  // Effects and cleanups made after the awaits below still belong to this view.
  const owner = getOwner();

  onMount(async () => {
    if (!readAccount()) return setNote({ title: "Sign in to use this", text: "Open Settings, choose Sign in, and come back here." });
    const path = installed ? await invoke<string | null>("extension_file", { id: p.id }).catch(() => null) : null;
    if (!path) return setNote({ title: "Not installed", text: "Install this extension again from Settings → Extensions." });

    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.title = installed!.name;
    frame.src = convertFileSrc(path);
    stage.replaceChildren(frame);

    runWithOwner(owner, () => start(frame));
  });

  const start = (frame: HTMLIFrameElement) => {
    const host = hostExtension(frame, {
      id: p.id,
      // This page owns the tasks: answered right here.
      tasks: async (op, args) => runTask(op, args),
      // No screen to pick a colour from on a phone.
      pickColor: async () => null,
      onEventsChanged: () => void refreshEvents(),
    });
    onCleanup(host.stop);

    if (TASKS_ALLOWED.includes(p.id)) {
      let timer: number | undefined;
      createEffect(
        on(
          () => JSON.stringify(taskView()),
          () => {
            clearTimeout(timer);
            timer = window.setTimeout(() => host.post({ type: "tasks-changed" }), 300);
          },
          { defer: true },
        ),
      );
      onCleanup(() => clearTimeout(timer));
    }
  };

  return (
    <section class="ext-view" role="dialog" aria-label={installed?.name ?? "Extension"}>
      <header class="ext-bar">
        <button class="ib soft" aria-label="Close" onClick={p.onClose}>
          <IClose size={14} />
        </button>
        <span class="ext-name">{installed?.name ?? "Extension"}</span>
      </header>
      <div class="ext-stage" ref={stage}>
        <Show when={note()}>
          {(n) => (
            <div class="ext-note">
              <h1>{n().title}</h1>
              <p>{n().text}</p>
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}

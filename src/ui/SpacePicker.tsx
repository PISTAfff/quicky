import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { data, setSpace, space, spaceName } from "../lib/store";
import { setSheet } from "./state";
import { Blob } from "./icons";

// Each app's real icon, fetched once from its .exe (null = it has none: show its initial).
const [icons, setIcons] = createStore<Record<string, string | null>>({});
function iconFor(key: string) {
  if (!(key in icons)) {
    setIcons(key, null);
    invoke<string | null>("app_icon", { exe: key }).then((url) => url && setIcons(key, url)).catch(() => {});
  }
  return icons[key];
}

function SpaceIcon(p: { key: string; name: string }) {
  return (
    <span class="space-icon" classList={{ img: !!(p.key && iconFor(p.key)) }} aria-hidden="true">
      <Show when={p.key} fallback={<Blob size={16} />}>
        <Show when={iconFor(p.key)} fallback={p.name.slice(0, 1).toUpperCase()}>
          {(url) => <img src={url()} alt="" width="20" height="20" />}
        </Show>
      </Show>
    </span>
  );
}

/** Title-bar pill showing which list this is (General or an app's), opening a themed menu. */
export function SpacePicker() {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;

  const spaces = createMemo(() => Object.entries(data.spaces ?? {}).sort((a, b) => a[1].localeCompare(b[1])));
  const openCount = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of data.tasks) if (t.status !== "done") counts[t.space ?? ""] = (counts[t.space ?? ""] ?? 0) + 1;
    return counts;
  });
  const options = () => [["", "General"] as [string, string], ...spaces()];

  const pick = (key: string) => {
    setOpen(false);
    if ((key || null) === space()) return;
    setSheet(null);
    setSpace(key || null);
  };

  const onDoc = (e: PointerEvent) => !root.contains(e.target as Node) && setOpen(false);
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && open() && (e.stopPropagation(), setOpen(false));
  document.addEventListener("pointerdown", onDoc);
  document.addEventListener("keydown", onKey, true);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDoc);
    document.removeEventListener("keydown", onKey, true);
  });

  return (
    <div class="space-picker" ref={root}>
      <button
        class="space-pill"
        classList={{ open: open() }}
        aria-haspopup="menu"
        aria-expanded={open()}
        title="Switch between the general list and your apps' lists"
        onClick={() => setOpen(!open())}
      >
        <Show when={space()}>{(key) => <SpaceIcon key={key()} name={spaceName(key())} />}</Show>
        <span>{spaceName(space())}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="space-menu" role="menu" aria-label="Task lists">
          <For each={options()}>
            {([key, name]) => {
              const current = () => (key || null) === space();
              return (
                <button role="menuitemradio" aria-checked={current()} class="space-item" classList={{ on: current() }} onClick={() => pick(key)}>
                  <SpaceIcon key={key} name={name} />
                  <span class="space-name">{name}</span>
                  <Show when={openCount()[key]}>{(n) => <span class="space-count">{n()}</span>}</Show>
                  <svg class="space-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7" />
                  </svg>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

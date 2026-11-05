// Quicky's own colour picker (the system one can't take the theme): a saturation/brightness square,
// a hue bar, a hex field, the preset accents, and an eyedropper that picks from anywhere on screen.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ACCENTS, isHex } from "../lib/theme-colors";
import { pinned } from "./state";

type HSV = { h: number; s: number; v: number };

export function hexToHsv(hex: string): HSV {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: HSV): string {
  const f = (k: number) => {
    const n = (k + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(n, 4 - n, 1))));
  };
  return "#" + [f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** "#abc", "abc", "#aabbcc" or "rgb(1, 2, 3)" as "#aabbcc"; anything else as null. */
export function normalizeHex(input: string): string | null {
  const t = input.trim().toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(t);
  if (rgb) return "#" + rgb.slice(1, 4).map((c) => Math.min(255, +c).toString(16).padStart(2, "0")).join("");
  const h = t.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(h)) return "#" + [...h].map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/.test(h) ? "#" + h : null;
}

export function ColorPicker(p: { value: string; onChange: (hex: string) => void; onClose: () => void }) {
  const [hsv, setHsv] = createSignal(hexToHsv(isHex(p.value) ? p.value : "#6d4cff"));
  const [text, setText] = createSignal(p.value);
  const [picking, setPicking] = createSignal(false);
  let root!: HTMLDivElement;

  const commit = (next: HSV) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setText(hex);
    p.onChange(hex);
  };
  const setHex = (hex: string) => {
    setHsv(hexToHsv(hex));
    setText(hex);
    p.onChange(hex);
  };

  /** Drags on the square or the hue bar: follows the pointer until it's let go. */
  const drag = (e: PointerEvent, apply: (fx: number, fy: number) => void) => {
    const el = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      apply(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    el.setPointerCapture(e.pointerId);
    move(e);
    el.onpointermove = move;
    el.onpointerup = () => (el.onpointermove = el.onpointerup = null);
  };

  // The eyedropper: the web view's own when it has one, else Quicky's, which reads any pixel on
  // screen. While it runs Quicky stays open (clicking another app would otherwise tuck it away).
  const eyedrop = async () => {
    if (picking()) return;
    setPicking(true);
    const wasPinned = pinned();
    try {
      const Dropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
      if (Dropper) {
        try {
          const r = await new Dropper().open();
          const hex = normalizeHex(r.sRGBHex);
          if (hex) setHex(hex);
          return;
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
        }
      }
      if (!wasPinned) await invoke("set_pinned", { pinned: true }).catch(() => {});
      const stop = await getCurrentWindow().listen<string>("picker-color", (ev) => setHex(ev.payload));
      const hex = await invoke<string | null>("pick_screen_color").catch(() => null);
      stop();
      if (hex) setHex(hex);
    } finally {
      if (!wasPinned) await invoke("set_pinned", { pinned: false }).catch(() => {});
      setPicking(false);
    }
  };

  onMount(() => {
    const away = (e: PointerEvent) => !picking() && !root.contains(e.target as Node) && p.onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !picking() && (e.stopPropagation(), p.onClose());
    setTimeout(() => addEventListener("pointerdown", away), 0);
    addEventListener("keydown", esc, true);
    onCleanup(() => {
      removeEventListener("pointerdown", away);
      removeEventListener("keydown", esc, true);
    });
  });

  return (
    <div class="cpick" ref={root} role="dialog" aria-label="Pick a colour">
      <div
        class="cpick-sv"
        style={{ "background-color": hsvToHex({ h: hsv().h, s: 1, v: 1 }) }}
        onPointerDown={(e) => drag(e, (x, y) => commit({ ...hsv(), s: x, v: 1 - y }))}
      >
        <i class="cpick-knob" style={{ left: `${hsv().s * 100}%`, top: `${(1 - hsv().v) * 100}%`, background: hsvToHex(hsv()) }} />
      </div>
      <div class="cpick-hue" onPointerDown={(e) => drag(e, (x) => commit({ ...hsv(), h: x * 359.9 }))}>
        <i class="cpick-knob" style={{ left: `${(hsv().h / 360) * 100}%`, background: hsvToHex({ h: hsv().h, s: 1, v: 1 }) }} />
      </div>
      <div class="cpick-row">
        <button
          class="cpick-drop"
          classList={{ on: picking() }}
          aria-label="Pick a colour from the screen"
          title="Pick a colour from anywhere on the screen (right-click cancels)"
          onClick={() => void eyedrop()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14.5 5.5l4 4M17 3l4 4-3 3-4-4z" />
            <path d="M14 7l-9 9-1 4 4-1 9-9" />
          </svg>
        </button>
        <span class="cpick-preview" style={{ background: hsvToHex(hsv()) }} />
        <input
          id="cpick-hex"
          class="cpick-hex"
          aria-label="Hex colour"
          spellcheck={false}
          maxLength={7}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            const hex = normalizeHex(e.currentTarget.value);
            if (hex && hex.length === 7) {
              setHsv(hexToHsv(hex));
              p.onChange(hex);
            }
          }}
          onBlur={() => setText(hsvToHex(hsv()))}
        />
      </div>
      <Show when={picking()}>
        <small class="muted">Click anywhere on the screen to pick. Right-click cancels.</small>
      </Show>
      <div class="cpick-presets">
        <For each={ACCENTS}>
          {(a) => <button class="cpick-preset" style={{ background: a.color }} aria-label={a.name} title={a.name} onClick={() => setHex(a.color)} />}
        </For>
      </div>
    </div>
  );
}

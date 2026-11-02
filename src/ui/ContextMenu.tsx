// Quicky's own right-click menu inside the main window, styled like the bubble's menu (the web
// view's browser menu is turned off in App.tsx). Open it with `openMenu(event, items)`.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { arrowFocus } from "../lib/menus";

export type MenuItem = { label: string; run: () => void; danger?: boolean } | "sep";

const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);

export function openMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  setMenu({ x: e.clientX, y: e.clientY, items });
}

const close = () => setMenu(null);

export function ContextMenu() {
  return (
    <Show when={menu()} keyed>
      {(m) => <MenuBox x={m.x} y={m.y} items={m.items} />}
    </Show>
  );
}

function MenuBox(p: { x: number; y: number; items: MenuItem[] }) {
  let box!: HTMLDivElement;
  const [at, setAt] = createSignal({ left: p.x, top: p.y, origin: "left top" });
  const buttons = () => [...box.querySelectorAll<HTMLButtonElement>("button")];

  const onDown = (e: PointerEvent) => !box.contains(e.target as Node) && close();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // Only the menu closes, not the panel behind it.
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (arrowFocus(e.key, buttons())) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  onMount(() => {
    // At the pointer, flipped to stay inside the window.
    const r = box.getBoundingClientRect();
    const left = p.x + r.width > innerWidth - 6 ? p.x - r.width : p.x;
    const top = p.y + r.height > innerHeight - 6 ? p.y - r.height : p.y;
    setAt({
      left: Math.max(6, left),
      top: Math.max(6, top),
      origin: `${left < p.x ? "right" : "left"} ${top < p.y ? "bottom" : "top"}`,
    });
    box.focus();
    addEventListener("pointerdown", onDown, true);
    addEventListener("keydown", onKey, true);
    addEventListener("blur", close);
    addEventListener("resize", close);
    addEventListener("scroll", close, true);
  });
  onCleanup(() => {
    removeEventListener("pointerdown", onDown, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("blur", close);
    removeEventListener("resize", close);
    removeEventListener("scroll", close, true);
  });

  return (
    <div
      ref={box}
      class="ctx-menu qmenu in"
      role="menu"
      tabindex="-1"
      style={{ left: `${at().left}px`, top: `${at().top}px`, "transform-origin": at().origin }}
      onPointerMove={(e) => {
        // Hover moves the focus too, so one highlight serves mouse and keys.
        const b = (e.target as HTMLElement).closest("button");
        if (b && document.activeElement !== b) b.focus();
      }}
      onPointerLeave={() => box.focus()}
    >
      <For each={p.items}>
        {(item) =>
          item === "sep" ? (
            <div class="qmenu-sep" role="separator" />
          ) : (
            <button
              type="button"
              role="menuitem"
              tabindex="-1"
              classList={{ danger: !!item.danger }}
              onClick={() => {
                close();
                item.run();
              }}
            >
              {item.label}
            </button>
          )
        }
      </For>
    </div>
  );
}

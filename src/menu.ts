// Quicky's own right-click menu for the bubble and its minis, in the app's colours. The bubble
// page sends the items and runs the one picked; Rust places, shows and hides this window. Plain
// TS, like the bubble.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { followTheme } from "./lib/theme-colors";

export type MenuEntry = { id: string; text: string; checked?: boolean; disabled?: boolean } | "sep";
interface Request { seq: number; items: MenuEntry[] }

const menu = document.getElementById("menu") as HTMLDivElement;
/** Room for the hard shadow (3 px) past the card. */
const SHADOW = 4;
let seq = 0;

followTheme();

function render(items: MenuEntry[]) {
  menu.classList.toggle("checks", items.some((i) => i !== "sep" && i.checked !== undefined));
  menu.replaceChildren(
    ...items.map((item) => {
      if (item === "sep") {
        const sep = document.createElement("div");
        sep.className = "sep";
        sep.setAttribute("role", "separator");
        return sep;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;
      b.textContent = item.text;
      b.dataset.id = item.id;
      b.disabled = !!item.disabled;
      if (item.checked === undefined) b.setAttribute("role", "menuitem");
      else {
        b.setAttribute("role", "menuitemcheckbox");
        b.setAttribute("aria-checked", String(item.checked));
      }
      return b;
    }),
  );
}

async function open(r: Request) {
  if (r.seq <= seq) return;
  seq = r.seq;
  render(r.items);
  menu.classList.remove("in");
  menu.style.visibility = "hidden";
  await document.fonts.ready;
  const box = menu.getBoundingClientRect();
  const way = await invoke<{ left: boolean; up: boolean } | null>("menu_show", {
    seq: r.seq,
    width: Math.ceil(box.width) + SHADOW,
    height: Math.ceil(box.height) + SHADOW,
  }).catch(() => null);
  if (r.seq !== seq) return; // a newer right-click took over
  if (!way) return close();
  // Pop out of the corner at the pointer.
  menu.style.transformOrigin = `${way.left ? "right" : "left"} ${way.up ? "bottom" : "top"}`;
  menu.style.visibility = "";
  menu.classList.add("in");
  menu.focus();
}

const close = () => void invoke("menu_hide");
const enabled = () => [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];

menu.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b || b.disabled) return;
  void emitTo("bubble", "bubble-menu-pick", b.dataset.id);
  close();
});
menu.addEventListener("pointermove", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b && !b.disabled && document.activeElement !== b) b.focus();
});
menu.addEventListener("pointerleave", () => menu.focus());
addEventListener("keydown", (e) => {
  if (e.key === "Escape") return close();
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const list = enabled();
  if (!list.length) return;
  const i = list.indexOf(document.activeElement as HTMLButtonElement);
  list[e.key === "ArrowDown" ? (i + 1) % list.length : i <= 0 ? list.length - 1 : i - 1].focus();
});
// Clicked anywhere else (Rust also watches for that, for systems where focus doesn't move).
addEventListener("blur", close);

void listen<Request>("menu-items", ({ payload }) => void open(payload));
// A right-click that came before this page was listening.
void invoke<Request | null>("menu_pending").then((r) => r && open(r));

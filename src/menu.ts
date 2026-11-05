// Quicky's own right-click menu for the bubble and its minis, in the app's colours. The bubble
// page sends the items and runs the one picked; Rust places, shows and hides this window. Plain
// TS, like the bubble. An item with `sub` opens a side menu on hover: the window is sized for the
// menu and its widest side menu together, the room beside the menu staying see-through.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { followTheme } from "./lib/theme-colors";
import { arrowFocus, type MenuEntry } from "./lib/menus";

/** `owner`: the bubble window that opened it ("bubble" or "mini"), which runs the pick. */
interface Request { seq: number; items: MenuEntry[]; owner: string }

const menu = document.getElementById("menu") as HTMLDivElement;
/** Room for the hard shadow (3 px) past the card. */
const SHADOW = 4;
/** How far a side menu tucks over the menu's edge. */
const OVERLAP = 4;
let seq = 0;
let owner = "bubble";
/** Side menus, by the item that opens them. */
let subs = new Map<HTMLButtonElement, HTMLDivElement>();
/** The side menu open now. */
let openSub: HTMLDivElement | null = null;

followTheme();

function list(el: HTMLDivElement, items: MenuEntry[]) {
  el.classList.toggle("checks", items.some((i) => i !== "sep" && i.checked !== undefined));
  el.replaceChildren(
    ...items.map((item) => {
      if (item === "sep") {
        const sep = document.createElement("div");
        sep.className = "qmenu-sep";
        sep.setAttribute("role", "separator");
        return sep;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;
      b.textContent = item.text;
      b.dataset.id = item.id;
      b.disabled = !!item.disabled;
      if (item.sub) {
        b.classList.add("has-sub");
        b.setAttribute("role", "menuitem");
        b.setAttribute("aria-haspopup", "menu");
        b.setAttribute("aria-expanded", "false");
        const s = document.createElement("div");
        s.className = "qmenu sub";
        s.setAttribute("role", "menu");
        s.setAttribute("aria-label", item.text);
        list(s, item.sub);
        subs.set(b, s);
      } else if (item.checked === undefined) b.setAttribute("role", "menuitem");
      else {
        b.setAttribute("role", "menuitemcheckbox");
        b.setAttribute("aria-checked", String(item.checked));
      }
      return b;
    }),
  );
}

function render(items: MenuEntry[]) {
  for (const s of subs.values()) s.remove();
  subs = new Map();
  openSub = null;
  list(menu, items);
  document.body.append(...subs.values());
}

async function open(r: Request) {
  if (r.seq <= seq) return;
  seq = r.seq;
  owner = r.owner;
  render(r.items);
  menu.classList.remove("in");
  menu.style.visibility = "hidden";
  menu.style.left = menu.style.top = "0px";
  await document.fonts.ready;
  const box = menu.getBoundingClientRect();
  const sizes = [...subs.values()].map((s) => s.getBoundingClientRect());
  const subW = Math.max(0, ...sizes.map((s) => s.width));
  const width = Math.ceil(box.width + (subW ? subW - OVERLAP : 0));
  const height = Math.ceil(Math.max(box.height, ...sizes.map((s) => s.height)));
  const way = await invoke<{ left: boolean; up: boolean } | null>("menu_show", {
    seq: r.seq,
    width: width + SHADOW,
    height: height + SHADOW,
  }).catch(() => null);
  if (r.seq !== seq) return; // a newer right-click took over
  if (!way) return close();
  // The menu sits in the window's corner at the pointer; its side menus open into the rest.
  menu.style.left = `${way.left ? width - box.width : 0}px`;
  menu.style.top = `${way.up ? height - box.height : 0}px`;
  const mx = way.left ? width - box.width : 0;
  const my = way.up ? height - box.height : 0;
  for (const [b, s] of subs) {
    const sb = s.getBoundingClientRect();
    s.style.left = `${way.left ? mx - sb.width + OVERLAP : mx + box.width - OVERLAP}px`;
    // Level with its item (the side menu's first item beside it), kept inside the window.
    s.style.top = `${Math.max(0, Math.min(height - sb.height, my + b.offsetTop - 5))}px`;
    s.style.transformOrigin = `${way.left ? "right" : "left"} top`;
  }
  // Pop out of the corner at the pointer.
  menu.style.transformOrigin = `${way.left ? "right" : "left"} ${way.up ? "bottom" : "top"}`;
  document.body.dataset.way = way.left ? "left" : "right";
  menu.style.visibility = "";
  menu.classList.add("in");
  menu.focus();
}

const close = () => void invoke("menu_hide");
const enabled = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)")];

function showSub(b: HTMLButtonElement | null) {
  const s = b ? subs.get(b) ?? null : null;
  if (s === openSub) return;
  for (const [ob, os] of subs) {
    const on = os === s;
    os.classList.toggle("open", on);
    ob.classList.toggle("open", on);
    ob.setAttribute("aria-expanded", String(on));
  }
  openSub = s;
}

function pick(b: HTMLButtonElement) {
  if (b.disabled) return;
  if (subs.has(b)) {
    showSub(b);
    enabled(subs.get(b)!)[0]?.focus();
    return;
  }
  void emitTo(owner, "bubble-menu-pick", b.dataset.id);
  close();
}

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b) pick(b);
  // A click on the see-through room beside the menu is a click elsewhere.
  else if (!(e.target as HTMLElement).closest(".qmenu")) close();
});
document.addEventListener("pointermove", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  // Over the menu: its side menu opens, any other closes. Over a side menu: it stays.
  if (b.parentElement === menu) showSub(b.classList.contains("has-sub") && !b.disabled ? b : null);
  if (!b.disabled && document.activeElement !== b) b.focus();
});
menu.addEventListener("pointerleave", () => !openSub && menu.focus());
addEventListener("keydown", (e) => {
  const inSub = !!openSub && openSub.contains(document.activeElement);
  const parent = openSub && [...subs].find(([, s]) => s === openSub)?.[0];
  const toward = document.body.dataset.way === "left" ? "ArrowLeft" : "ArrowRight";
  const back = toward === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
  if (e.key === "Escape" || (e.key === back && inSub)) {
    if (inSub && parent) {
      parent.focus();
      showSub(null);
      return;
    }
    if (e.key === "Escape") return close();
  }
  const at = document.activeElement as HTMLButtonElement | null;
  if (e.key === toward && at && subs.has(at)) return pick(at);
  if ((e.key === "Enter" || e.key === " ") && at?.tagName === "BUTTON") {
    e.preventDefault();
    return pick(at);
  }
  if (arrowFocus(e.key, enabled(inSub ? openSub! : menu))) {
    e.preventDefault();
    if (!inSub) showSub(null);
  }
});
// Clicked anywhere else (Rust also watches for that, for systems where focus doesn't move).
addEventListener("blur", close);

void listen<Request>("menu-items", ({ payload }) => void open(payload));
// A right-click that came before this page was listening.
void invoke<Request | null>("menu_pending").then((r) => r && open(r));
addEventListener("contextmenu", (e) => e.preventDefault()); // no browser menu (Back, Refresh, Print)

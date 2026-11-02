// Shared by Quicky's two menus: the bubble's (menu.html, its items sent between windows) and the
// main window's (ui/ContextMenu.tsx, its items run in place).

/** An item of the bubble's menu (greyed out without an action, ticked when `checked`) or a line. */
export type MenuEntry = { id: string; text: string; checked?: boolean; disabled?: boolean } | "sep";

/** Arrow keys move through `items`, wrapping round. Returns whether it was an arrow key. */
export function arrowFocus(key: string, items: HTMLElement[]): boolean {
  if (key !== "ArrowDown" && key !== "ArrowUp") return false;
  if (!items.length) return true;
  const i = items.indexOf(document.activeElement as HTMLElement);
  items[key === "ArrowDown" ? (i + 1) % items.length : i <= 0 ? items.length - 1 : i - 1].focus();
  return true;
}

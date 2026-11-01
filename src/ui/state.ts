import { createSignal } from "solid-js";
import type { Attachment } from "../lib/model";

export type Sheet = { kind: "task"; id: string } | { kind: "done" } | { kind: "repeats" } | { kind: "reminders" } | { kind: "settings" } | null;

export const [sheet, setSheet] = createSignal<Sheet>(null);
export const [staged, setStaged] = createSignal<Attachment[]>([]);
export const [dropping, setDropping] = createSignal(false);
export const [pinned, setPinned] = createSignal(false);

let quickInput: HTMLInputElement | undefined;
export const registerQuickInput = (el: HTMLInputElement) => (quickInput = el);
export const focusQuickAdd = () => {
  setSheet(null);
  queueMicrotask(() => quickInput?.focus());
};

export const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
};

export const WEEK = ["S", "M", "T", "W", "T", "F", "S"];
export const WEEK_LONG = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

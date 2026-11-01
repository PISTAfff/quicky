import { For } from "solid-js";
import { WEEK, WEEK_LONG } from "./state";

/** S M T W T F S toggles. `allowEmpty` lets the last day be switched off too (add box). */
export function WeekPicker(p: { days: number[]; onChange: (days: number[]) => void; allowEmpty?: boolean }) {
  const toggle = (d: number) => {
    const next = p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d].sort();
    if (next.length || p.allowEmpty) p.onChange(next);
  };
  return (
    <div class="week" role="group" aria-label="Repeat on">
      <For each={WEEK}>
        {(l, i) => (
          <button
            class="wd"
            classList={{ on: p.days.includes(i()) }}
            aria-pressed={p.days.includes(i())}
            aria-label={WEEK_LONG[i()]}
            title={WEEK_LONG[i()]}
            onClick={() => toggle(i())}
          >
            {l}
          </button>
        )}
      </For>
    </div>
  );
}

/** "Every day", "Weekends: Fri, Sat"-style short summary of chosen days. */
export function daysLabel(days: number[]) {
  if (days.length === 7) return "Every day";
  return [...days].sort().map((d) => WEEK_LONG[d]).join(", ");
}

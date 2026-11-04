// A time of day ("HH:MM", 24-hour, as it's stored), shown and picked as 12-hour with AM/PM on
// every system. The browser's own time box follows the OS setting (24-hour on many Macs), so
// Quicky draws its own: hour, minute, and an AM/PM switch.
import { For } from "solid-js";

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

export function TimeField(p: { value: string; onChange: (hm: string) => void; label: string; id?: string }) {
  const parts = () => {
    const [h, m] = (p.value || "09:00").split(":").map(Number);
    return { h12: h % 12 || 12, m, pm: h >= 12 };
  };
  const set = (h12: number, m: number, pm: boolean) =>
    p.onChange(`${String((h12 % 12) + (pm ? 12 : 0)).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  const half = () => (parts().pm ? "PM" : "AM");
  return (
    <span class="tf" role="group" aria-label={p.label}>
      <select id={p.id} aria-label={`${p.label}, hour`} value={parts().h12} onChange={(e) => set(Number(e.currentTarget.value), parts().m, parts().pm)}>
        <For each={HOURS}>{(h) => <option value={h}>{h}</option>}</For>
      </select>
      <span class="tf-colon" aria-hidden="true">:</span>
      <select aria-label={`${p.label}, minute`} value={parts().m} onChange={(e) => set(parts().h12, Number(e.currentTarget.value), parts().pm)}>
        <For each={MINUTES}>{(m) => <option value={m}>{String(m).padStart(2, "0")}</option>}</For>
      </select>
      <button
        type="button"
        class="tf-ampm"
        aria-label={`${p.label}, ${half()} (switch to ${parts().pm ? "AM" : "PM"})`}
        onClick={() => set(parts().h12, parts().m, !parts().pm)}
      >
        {half()}
      </button>
    </span>
  );
}

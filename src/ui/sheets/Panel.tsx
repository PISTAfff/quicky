import { onCleanup, type JSX } from "solid-js";
import { sfx } from "../../lib/sfx";
import { IClose } from "../icons";
import { setSheet } from "../state";

export function Panel(p: { title: string; children: JSX.Element; class?: string }) {
  sfx.open();
  onCleanup(() => sfx.close());
  return (
    <div class="sheet-backdrop" onClick={() => setSheet(null)}>
      <section class={`sheet ${p.class ?? ""}`} role="dialog" aria-label={p.title} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <h2>{p.title}</h2>
          <button class="ib soft" aria-label="Close" onClick={() => setSheet(null)}>
            <IClose size={14} />
          </button>
        </div>
        <div class="sheet-body">{p.children}</div>
      </section>
    </div>
  );
}

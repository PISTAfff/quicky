import { createSignal, For, Show } from "solid-js";
import { QUICK_KEY } from "../lib/platform";
import { sfx } from "../lib/sfx";
import { Blob } from "./icons";

// Three hints on first run (and from Settings → Tips): the bubble's tricks aren't discoverable.

const KEY = "quicky-tour";
const seen = () => {
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    return true;
  }
};

const [open, setOpen] = createSignal(!seen());
export const showTour = () => setOpen(true);

const STEPS = [
  {
    title: "Give any app its own Quicky",
    text: "Drag the bubble onto an app's window. It divides, and that app gets a mini Quicky with a list of its own.",
    art: "drag",
  },
  {
    title: "Right-click the bubble",
    text: "Lock it in place, hide a mini, or tuck the bubble away. Hover a mini to peek at its top tasks.",
    art: "menu",
  },
  {
    title: `${QUICK_KEY} from anywhere`,
    text: "Adds a task without leaving what you're doing: to the app's own list if it has a mini, otherwise to the general one.",
    art: "key",
  },
] as const;

export function Tour() {
  const [step, setStep] = createSignal(0);
  const close = () => {
    try {
      localStorage.setItem(KEY, "done");
    } catch {}
    setOpen(false);
    setStep(0);
  };
  const s = () => STEPS[step()];
  return (
    <Show when={open()}>
      <div class="tour-backdrop" onClick={close}>
        <section class="tour" role="dialog" aria-label="Quick tour" onClick={(e) => e.stopPropagation()}>
          <div class={`tour-art ${s().art}`} aria-hidden="true">
            <Show when={s().art === "drag"}>
              <div class="tour-window"><i /><i /><i /></div>
              <span class="tour-blob drag"><Blob size={34} /></span>
            </Show>
            <Show when={s().art === "menu"}>
              <span class="tour-blob"><Blob size={40} /></span>
              <div class="tour-menu"><i /><i /><i /></div>
            </Show>
            <Show when={s().art === "key"}>
              <kbd class="tour-key">{QUICK_KEY}</kbd>
              <span class="tour-blob small"><Blob size={26} /></span>
            </Show>
          </div>
          <h2>{s().title}</h2>
          <p>{s().text}</p>
          <div class="tour-dots" aria-hidden="true">
            <For each={STEPS}>{(_, i) => <i classList={{ on: i() === step() }} />}</For>
          </div>
          <div class="tour-actions">
            <button class="link" onClick={close}>Skip</button>
            <Show
              when={step() < STEPS.length - 1}
              fallback={
                <button
                  class="btn primary"
                  onClick={() => {
                    sfx.done();
                    close();
                  }}
                >
                  Got it
                </button>
              }
            >
              <button
                class="btn primary"
                onClick={() => {
                  sfx.tap();
                  setStep(step() + 1);
                }}
              >
                Next
              </button>
            </Show>
          </div>
        </section>
      </div>
    </Show>
  );
}

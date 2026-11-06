import { createSignal, For, Show } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { readAccount, sendFeedback } from "../../lib/cloud";
import { IS_MOBILE, OS } from "../../lib/platform";
import { showToast } from "../../lib/store";
import { setSheet } from "../state";
import { Panel } from "./Panel";

/** Settings → Bugs & requests: sends a report or an idea to Quicky's maker. */
export function FeedbackSheet() {
  const account = readAccount();
  const [kind, setKind] = createSignal<"bug" | "request">("bug");
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [version, setVersion] = createSignal("");
  getVersion().then(setVersion).catch(() => {});

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await sendFeedback({ kind: kind(), title: title().trim(), body: body().trim(), email: email().trim() || undefined, appVersion: version(), os: IS_MOBILE ? "android" : OS });
      showToast(kind() === "bug" ? "Thanks! Your bug report was sent" : "Thanks! Your idea was sent");
      setSheet({ kind: "settings" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Bugs & requests" class="feedback-sheet">
      <form class="box account-form" onSubmit={submit}>
        <div class="segment" role="group" aria-label="What are you sending?">
          <For each={[["bug", "Something's wrong"], ["request", "I have an idea"]] as const}>
            {([k, label]) => (
              <button type="button" classList={{ on: kind() === k }} aria-pressed={kind() === k} onClick={() => setKind(k)}>
                {label}
              </button>
            )}
          </For>
        </div>
        <label class="field">
          <span>{kind() === "bug" ? "What went wrong?" : "What would you like?"}</span>
          <input
            id="fb-title"
            maxLength={120}
            minLength={3}
            placeholder={kind() === "bug" ? (IS_MOBILE ? "The widget doesn't update" : "The bubble hides behind the taskbar") : "Let me colour tasks"}
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            required
          />
        </label>
        <label class="field">
          <span>Details <small class="muted">(optional)</small></span>
          <textarea
            id="fb-body"
            class="fb-body"
            maxLength={5000}
            rows={5}
            placeholder={kind() === "bug" ? "What were you doing, and what did you expect?" : "How would it help you?"}
            value={body()}
            onInput={(e) => setBody(e.currentTarget.value)}
          />
        </label>
        <Show
          when={!account}
          fallback={<small class="muted">Sent as {account!.user.name} ({account!.user.email}), so we can reply.</small>}
        >
          <label class="field">
            <span>Your email <small class="muted">(optional, if you'd like a reply)</small></span>
            <input id="fb-email" type="email" autocomplete="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
          </label>
        </Show>
        <small class="muted">Quicky {version()} on {IS_MOBILE ? "Android" : OS === "windows" ? "Windows" : OS === "mac" ? "macOS" : "Linux"} is added so we can reproduce it. Your tasks are never sent.</small>
        <Show when={error()}>
          <p class="error" role="alert">{error()}</p>
        </Show>
        <button class="btn primary" type="submit" disabled={busy()}>{busy() ? "Sending…" : "Send"}</button>
      </form>
    </Panel>
  );
}

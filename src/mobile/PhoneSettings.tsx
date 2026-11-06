// Settings → Reminders on the phone: whether Android lets Quicky notify (and at exact times),
// and a test notification.
import { createSignal, onCleanup, Show } from "solid-js";
import { notifyPermission, scheduleAlarms } from "./native";
import { comingAlarms, refreshAlarms } from "./phone";
import { showToast } from "../lib/store";

export function PhoneReminders() {
  const [state, setState] = createSignal<{ notifications: boolean; exact: boolean } | null>(null);
  const check = () => notifyPermission().then(setState).catch(() => {});
  void check();
  // Coming back from Android's settings: look again.
  const onVisible = () => document.visibilityState === "visible" && void check();
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisible));

  const ask = async () => {
    await notifyPermission(true).catch(() => {});
    setTimeout(check, 1500);
  };
  const exact = () => void notifyPermission(false, true).catch(() => {});
  const test = async () => {
    const at = Date.now() + 5000;
    await scheduleAlarms([...comingAlarms(), { key: `test@${at}`, at, title: "Water the plants", body: "This is what a reminder looks like." }]).catch(() => {});
    showToast("A test reminder shows in 5 seconds");
    // The test is a one-off: the real list again after it went off.
    setTimeout(refreshAlarms, 8000);
  };
  return (
    <>
      <small class="muted">
        <Show when={state()} fallback="Reminders show as notifications, even with Quicky closed.">
          {(s) => (s().notifications ? (s().exact ? "Reminders show as notifications, right on time." : "Reminders show as notifications; Android may move them by a few minutes.") : "Notifications are off for Quicky, so reminders can't show.")}
        </Show>
      </small>
      <span class="row-gap">
        <Show when={state() && !state()!.notifications}>
          <button class="btn small primary" onClick={() => void ask()}>Allow notifications</button>
        </Show>
        <Show when={state()?.notifications && !state()!.exact}>
          <button class="btn small" onClick={exact}>Exact times</button>
        </Show>
        <button class="btn small" onClick={() => void test()}>Test one</button>
      </span>
    </>
  );
}

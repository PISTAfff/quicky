// The Android app's one screen: the task list (the desktop's list view and panels), a top bar
// with sync, search, extensions and settings, and installed extensions full screen over it.
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { checkDisk, flush, init, loadError, ready, setToast, tick, toast } from "../lib/store";
import { startSync, syncNow, syncOn, syncStatus } from "../lib/sync";
import { ACCOUNT_EVENT, readAccount, setExtensionOpener } from "../lib/cloud";
import { ListView } from "../ui/Views";
import { Sheets } from "../ui/Sheets";
import { ContextMenu } from "../ui/ContextMenu";
import { closeSheet, setSheet, sheet } from "../ui/state";
import { Blob, IGear, ISearch } from "../ui/icons";
import { ExtensionView } from "./ExtensionView";
import { applyActions, onOpenExtension, refreshAlarms, startPhone } from "./phone";
import { leaveApp, notifyPermission } from "./native";

const WELCOMED = "quicky-phone-welcomed";

function IGrid(p: { size?: number }) {
  const s = p.size ?? 18;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" />
      <rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" />
    </svg>
  );
}

/** The little dot by the logo: synced, syncing, or couldn't. Tap to sync now. */
function SyncDot() {
  const [account, setAccount] = createSignal(readAccount());
  const update = () => setAccount(readAccount());
  addEventListener(ACCOUNT_EVENT, update);
  onCleanup(() => removeEventListener(ACCOUNT_EVENT, update));
  const label = () => {
    const s = syncStatus();
    if (!account() || !syncOn()) return "Not syncing";
    return s.state === "syncing" ? "Syncing" : s.state === "error" ? `Couldn't sync: ${s.error}` : s.state === "ok" ? "Synced" : "Waiting to sync";
  };
  return (
    <Show when={account()}>
      <button class={`sync-dot ${syncStatus().state}`} aria-label={label()} title={label()} onClick={() => void syncNow()} />
    </Show>
  );
}

export default function App() {
  const [ext, setExt] = createSignal<string | null>(null);
  const [welcome, setWelcome] = createSignal(false);
  setExtensionOpener((id) => {
    setSheet(null);
    setExt(id);
  });
  onOpenExtension((id) => setExt(id));

  // Android's back button comes here (a listener takes it over from the web view's history):
  // it closes the context menu, then the extension, then the open panel (Settings' own panels go
  // back to Settings), and with nothing open sends Quicky to the background like other apps.
  const stopBack = onBackButtonPress(() => {
    if (document.querySelector(".ctx-menu")) dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    else if (ext()) setExt(null);
    else if (sheet()) closeSheet();
    else void leaveApp().catch(() => {});
  }).catch(() => null);

  // Back in front (from the home screen, a widget, a notification): a new day maybe, other
  // devices' changes, and whatever was done from the widgets meanwhile.
  const resume = () => {
    if (document.visibilityState !== "visible") {
      void flush();
      return;
    }
    tick();
    void checkDisk();
    void applyActions();
    void syncNow();
    refreshAlarms();
  };
  document.addEventListener("visibilitychange", resume);
  // Settings may have changed quiet hours: hand the reminders over again when it closes.
  createEffect(on(sheet, (s, prev) => prev?.kind === "settings" && !s && refreshAlarms(), { defer: true }));

  onMount(async () => {
    const onMenu = (e: MouseEvent) => {
      const field = (e.target as HTMLElement).closest('textarea, [contenteditable="true"], input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color])');
      if (!field) e.preventDefault();
    };
    addEventListener("contextmenu", onMenu);
    const minute = setInterval(tick, 60_000);
    onCleanup(() => {
      removeEventListener("contextmenu", onMenu);
      void stopBack.then((l) => l?.unregister());
      document.removeEventListener("visibilitychange", resume);
      clearInterval(minute);
    });

    await init();
    // Widget ticks and notification buttons first, so they're part of the first sync.
    await applyActions();
    startSync();
    startPhone();
    try {
      if (!localStorage.getItem(WELCOMED) && !readAccount()) setWelcome(true);
    } catch {}
    // Reminders need Android's say-so (Android 13 and up ask once).
    void notifyPermission(true).catch(() => {});
  });

  const dismissWelcome = (signIn: boolean) => {
    try {
      localStorage.setItem(WELCOMED, "1");
    } catch {}
    setWelcome(false);
    if (signIn) setSheet({ kind: "account" });
  };

  return (
    <div class="app phone pop-in" data-mode="list">
      <header class="m-top">
        <span class="m-brand">
          <Blob size={26} />
          <span>Quicky</span>
          <SyncDot />
        </span>
        <span class="m-acts">
          <button class="ib" aria-label="Search" onClick={() => setSheet({ kind: "search" })}><ISearch size={18} /></button>
          <button class="ib" aria-label="Extensions" onClick={() => setSheet({ kind: "extensions" })}><IGrid /></button>
          <button class="ib" aria-label="Settings" onClick={() => setSheet({ kind: "settings" })}><IGear size={18} /></button>
        </span>
      </header>
      <main class="content">
        <Show when={ready()}>
          <Show when={!loadError()} fallback={<p class="error pad" role="alert">{loadError()}</p>}>
            <ListView />
            <Sheets />
          </Show>
        </Show>
      </main>
      <Show when={welcome()}>
        <div class="sheet-backdrop">
          <section class="sheet welcome" role="dialog" aria-label="Welcome to Quicky">
            <div class="sheet-body">
              <Blob size={56} />
              <h2>Hi, I'm Quicky</h2>
              <p class="muted">Sign in with your Quicky account to have the same tasks, reminders and extensions as on your PC. You can also just start here and sign in later.</p>
              <div class="sheet-actions">
                <button class="btn primary" onClick={() => dismissWelcome(true)}>Sign in</button>
                <button class="btn ghost" onClick={() => dismissWelcome(false)}>Not now</button>
              </div>
            </div>
          </section>
        </div>
      </Show>
      <Show when={ext()} keyed>
        {(id) => <ExtensionView id={id} onClose={() => setExt(null)} />}
      </Show>
      <Show when={toast()}>
        {(t) => (
          <div class="toast" role="status">
            <span>{t().text}</span>
            <Show when={t().action}>
              {(a) => (
                <button
                  onClick={() => {
                    setToast(null);
                    a().run();
                  }}
                >
                  {a().label}
                </button>
              )}
            </Show>
          </div>
        )}
      </Show>
      <ContextMenu />
    </div>
  );
}

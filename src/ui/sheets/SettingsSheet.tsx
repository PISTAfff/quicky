import { createSignal, For, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import { autoCheck, checkForUpdate, installUpdate, setAutoCheck, updateState } from "../../lib/updates";
import { ACCENTS, setTheme, theme } from "../../lib/theme";
import { onAccent } from "../../lib/theme-colors";
import { chooseDataDir, dataDir, showToast } from "../../lib/store";
import { IS_MOBILE, OS, SYSTEM_NAME } from "../../lib/platform";
import { PhoneQuickTile, PhoneReminders } from "../../mobile/PhoneSettings";
import { readQuiet, writeQuiet } from "../../lib/reminders";
import { showTour } from "../Tour";
import { previewReminder } from "../../lib/reminders";
import { readSfx, sfx, writeSfx } from "../../lib/sfx";
import { readAccount } from "../../lib/cloud";
import { setSyncOn, syncNow, syncOn, syncStatus } from "../../lib/sync";
import { IBell, IClose, IPin2, IFolder } from "../icons";
import { setSheet } from "../state";
import { Panel } from "./Panel";
import { TimeField } from "../TimeField";
import { ColorPicker } from "../ColorPicker";

export function SettingsSheet() {
  const change = async () => {
    const picked = await open({ directory: true, title: "Choose where Quicky keeps your stuff" });
    if (typeof picked === "string") {
      await chooseDataDir(picked);
      showToast("Now using the new folder");
    }
  };
  const [sounds, setSoundsSignal] = createSignal(readSfx());
  const setSounds = (p: ReturnType<typeof readSfx>) => {
    writeSfx(p);
    setSoundsSignal(p);
  };
  const [startup, setStartup] = createSignal(false);
  const [bubble, setBubble] = createSignal(true);
  // The phone has no start-up setting, bubble or minis.
  if (!IS_MOBILE) {
    isEnabled().then(setStartup).catch(() => {});
    invoke<boolean>("get_show_bubble").then(setBubble).catch(() => {});
  }
  // The bubble can also be hidden from its own right-click menu or brought back from the tray.
  const stop = listen<boolean>("bubble-pref", (e) => setBubble(e.payload));
  onCleanup(() => void stop.then((u) => u()));
  const [stuck, setStuck] = createSignal<{ exe: string; name: string }[]>([]);
  const loadStuck = () => invoke<{ exe: string; name: string }[]>("stuck_apps").then(setStuck).catch(() => {});
  if (!IS_MOBILE) void loadStuck();
  const stopStuck = listen("stuck-apps", loadStuck);
  onCleanup(() => void stopStuck.then((u) => u()));
  const toggleStartup = async () => {
    const next = !startup();
    await (next ? enable() : disable());
    setStartup(next);
  };
  const toggleBubble = async () => {
    const next = !bubble();
    await invoke("set_show_bubble", { show: next });
    setBubble(next);
  };
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [version, setVersion] = createSignal("");
  getVersion().then(setVersion).catch(() => {});
  const [auto, setAuto] = createSignal(autoCheck());
  const updateLine = () => {
    const u = updateState();
    if (u.kind === "checking") return "Checking…";
    if (u.kind === "latest") return "You have the latest version";
    if (u.kind === "ready") return `Version ${u.version} is ready to install`;
    if (u.kind === "installing") return `Updating… ${Math.round(u.progress * 100)}%`;
    if (u.kind === "failed") return "Couldn't check right now. Try again in a bit";
    return "";
  };
  return (
    <Panel title="Settings" class="settings-sheet">
      <div class="box">
        <span class="box-label">Colour</span>
        <div class="swatches" role="group" aria-label="Accent colour">
          <For each={ACCENTS}>
            {(a) => (
              <button
                class="swatch"
                classList={{ on: theme().accent === a.id }}
                style={{ background: a.color }}
                aria-label={a.name}
                aria-pressed={theme().accent === a.id}
                title={a.name}
                onClick={() => setTheme({ accent: a.id })}
              />
            )}
          </For>
          {/* Your own colour, in Quicky's own picker (with an eyedropper for anything on screen). */}
          <span class="swatch-wrap">
            <button
              class="swatch custom"
              classList={{ on: theme().accent === "custom" }}
              style={{
                background: theme().accent === "custom" ? theme().custom : "conic-gradient(#ff6b6b, #ffd166, #06d6a0, #4cc9f0, #7b61ff, #ff6bd6, #ff6b6b)",
                color: onAccent(theme().custom),
              }}
              title="Pick your own colour"
              aria-label="Custom colour"
              aria-expanded={pickerOpen()}
              onClick={() => {
                if (theme().accent !== "custom") setTheme({ accent: "custom" });
                setPickerOpen(!pickerOpen());
              }}
            >
              <Show when={theme().accent !== "custom"}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2b2540" stroke-width="3" stroke-linecap="round" aria-hidden="true">
                  <path d="M5 12h14M12 5v14" />
                </svg>
              </Show>
            </button>
            <Show when={pickerOpen()}>
              <ColorPicker value={theme().custom} onChange={(hex) => setTheme({ accent: "custom", custom: hex })} onClose={() => setPickerOpen(false)} />
            </Show>
          </span>
        </div>
        <div class="segment modes" role="group" aria-label="Light or dark">
          <For each={[["light", "Light"], ["dark", "Dark"], ["auto", `Match ${SYSTEM_NAME}`]] as const}>
            {([m, label]) => (
              <button classList={{ on: theme().mode === m }} aria-pressed={theme().mode === m} onClick={() => setTheme({ mode: m })}>
                {label}
              </button>
            )}
          </For>
        </div>
      </div>
      <Show when={!IS_MOBILE}>
      <div class="box">
        <label class="switch-row">
          <span>{OS === "windows" ? "Start with Windows" : "Open at login"}<small>Opens quietly in the {OS === "mac" ? "menu bar" : "tray"} when you sign in</small></span>
          <input type="checkbox" role="switch" checked={startup()} onChange={toggleStartup} />
        </label>
        <label class="switch-row">
          <span>Bubble on screen<small>Little Quicky that waits while the app is closed. Drag it anywhere; right-click for options</small></span>
          <input type="checkbox" role="switch" checked={bubble()} onChange={toggleBubble} />
        </label>
        <Show
          when={stuck().length}
          fallback={<small class="muted">Drag the bubble onto any app to give that app its own mini Quicky.</small>}
        >
          <div class="stuck-list">
            <span class="box-label"><IPin2 size={14} /> Mini Quicky in</span>
            <For each={stuck()}>
              {(s) => (
                <span class="time-chip" title={s.exe}>
                  {s.name}
                  <button aria-label={`Remove mini Quicky from ${s.name}`} onClick={() => invoke("unstick_bubble", { exe: s.exe })}>
                    <IClose size={10} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
      </Show>
      <div class="box">
        <label class="switch-row">
          <span>Sounds<small>{IS_MOBILE ? "Little sound effects for adding, finishing and recording" : "Little sound effects for adding, finishing, the bubble and reminders"}</small></span>
          <input type="checkbox" role="switch" checked={sounds().on} onChange={() => setSounds({ ...sounds(), on: !sounds().on })} />
        </label>
        <Show when={sounds().on}>
          <label class="volume-row">
            <span>Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={sounds().volume}
              onChange={(e) => {
                setSounds({ ...sounds(), volume: Number(e.currentTarget.value) });
                sfx.done();
              }}
            />
          </label>
        </Show>
      </div>
      {/* The phone app is updated by installing a new APK. */}
      <Show when={!IS_MOBILE}>
      <div class="box">
        <div class="box-row">
          <span class="box-label">Updates · Quicky {version()}</span>
          <Show
            when={updateState().kind === "ready"}
            fallback={
              <button class="btn small" disabled={updateState().kind === "checking" || updateState().kind === "installing"} onClick={() => void checkForUpdate()}>
                Check now
              </button>
            }
          >
            <button class="btn small primary" onClick={() => void installUpdate()}>Update and restart</button>
          </Show>
        </div>
        <Show when={updateLine()}>
          <small class="muted" role="status">{updateLine()}</small>
        </Show>
        <label class="switch-row">
          <span>Check for updates automatically<small>Looks for new versions on GitHub now and then; you choose when to install</small></span>
          <input
            type="checkbox"
            role="switch"
            checked={auto()}
            onChange={() => {
              setAutoCheck(!auto());
              setAuto(!auto());
            }}
          />
        </label>
      </div>
      </Show>
      <div class="box">
        <div class="box-row wrap">
          <span class="box-label">Online</span>
          <span class="row-gap">
            <button class="btn small" onClick={() => setSheet({ kind: "account" })}>{readAccount() ? "Account" : "Sign in"}</button>
            <button class="btn small" onClick={() => setSheet({ kind: "extensions" })}>Extensions</button>
          </span>
        </div>
        <small class="muted online-who">{readAccount() ? `Signed in as ${readAccount()!.user.email}` : "Not signed in"}</small>
        <Show
          when={readAccount()}
          fallback={<small class="muted">Sign in to keep your tasks and settings the same on every {IS_MOBILE ? "PC and phone" : "PC"}, and for online projects you share with others.</small>}
        >
          <SyncRow />
        </Show>
      </div>
      <div class="box">
        <div class="box-row">
          <span class="box-label"><IBell size={14} /> Reminders</span>
          <span class="row-gap">
            <button class="btn small" onClick={() => setSheet({ kind: "reminders" })}>See all</button>
            <Show when={!IS_MOBILE}>
              <button class="btn small" onClick={previewReminder}>Preview one</button>
            </Show>
          </span>
        </div>
        <Show when={IS_MOBILE}>
          <PhoneReminders />
        </Show>
        <QuietHours />
      </div>
      <Show when={IS_MOBILE}>
        <div class="box">
          <PhoneQuickTile />
        </div>
      </Show>
      <div class="box">
        <div class="box-row">
          <span class="box-label">Bugs &amp; requests</span>
          <button class="btn small" onClick={() => setSheet({ kind: "feedback" })}>Send one</button>
        </div>
        <small class="muted">Found something broken, or wish Quicky did something? Tell us.</small>
      </div>
      {/* The tour is about the bubble and minis: desktop only. */}
      <Show when={!IS_MOBILE}>
      <div class="box">
        <div class="box-row">
          <span class="box-label">Tips</span>
          <button
            class="btn small"
            onClick={() => {
              setSheet(null);
              showTour();
            }}
          >
            Show the tour again
          </button>
        </div>
      </div>
      </Show>
      <Show
        when={!IS_MOBILE}
        fallback={<p class="muted">Tasks and media live on this phone{readAccount() && syncOn() ? ", and in your account so every PC and phone signed in has them" : ""}.</p>}
      >
        <p class="muted">Tasks and media live in this folder on this computer:</p>
        <code class="path">{dataDir()}</code>
        <div class="sheet-actions">
          <button class="btn ghost" onClick={() => invoke("open_data_dir")}><IFolder size={15} /> Open folder</button>
          <button class="btn ghost" onClick={change}>Change…</button>
        </div>
      </Show>
    </Panel>
  );
}

/** Reminders wait during quiet hours (and while a full-screen app is up), then show together. */
function QuietHours() {
  const [q, setQ] = createSignal(readQuiet());
  const set = (patch: Partial<ReturnType<typeof readQuiet>>) => {
    const next = { ...q(), ...patch };
    writeQuiet(next);
    setQ(next);
  };
  return (
    <>
      <label class="switch-row">
        <span>Quiet hours<small>Reminders wait, then show together when quiet hours end</small></span>
        <input type="checkbox" role="switch" checked={q().on} onChange={() => set({ on: !q().on })} />
      </label>
      <Show when={q().on}>
        <div class="quiet-times">
          <span>From <TimeField label="Quiet hours from" value={q().from} onChange={(hm) => set({ from: hm })} /></span>
          <span>to <TimeField label="Quiet hours to" value={q().to} onChange={(hm) => set({ to: hm })} /></span>
        </div>
      </Show>
      <Show when={!IS_MOBILE}>
      <label class="switch-row">
        <span>Wait during full-screen apps<small>Games, videos and presentations aren't interrupted</small></span>
        <input type="checkbox" role="switch" checked={q().busy} onChange={() => set({ busy: !q().busy })} />
      </label>
      </Show>
    </>
  );
}

/** Settings → Online: task sync on or off, and how it went last. */
function SyncRow() {
  const [on, setOn] = createSignal(syncOn());
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 15_000);
  onCleanup(() => clearInterval(clock));
  const line = () => {
    const s = syncStatus();
    if (!on()) return "Off: your tasks stay on this PC only.";
    if (!readAccount()?.user.verified) return "Confirm your email (Account) to start syncing.";
    if (s.state === "syncing") return "Syncing…";
    if (s.state === "error") return `Couldn't sync: ${s.error}`;
    if (s.state === "ok" && s.at) {
      const mins = Math.floor((now() - s.at) / 60_000);
      return `Synced ${mins < 1 ? "just now" : mins === 1 ? "a minute ago" : mins < 60 ? `${mins} minutes ago` : "a while ago"}.`;
    }
    return "Waiting to sync.";
  };
  return (
    <>
      <label class="switch-row">
        <span>
          Sync my tasks and settings
          <small>Tasks, repeats, app lists, attachments (pictures shrunk to save space, up to 500 MB), your look and reminder settings: the same on every PC signed in to this account</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={on()}
          onChange={() => {
            setSyncOn(!on());
            setOn(!on());
          }}
        />
      </label>
      <small class="muted" role="status">
        {line()}
        <Show when={on() && syncStatus().state !== "syncing"}>
          {" "}
          <button class="link" onClick={() => void syncNow()}>Sync now</button>
        </Show>
      </small>
    </>
  );
}

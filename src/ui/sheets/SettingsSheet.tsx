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
import { OS, SYSTEM_NAME } from "../../lib/platform";
import { readQuiet, writeQuiet } from "../../lib/reminders";
import { showTour } from "../Tour";
import { previewReminder } from "../../lib/reminders";
import { readSfx, sfx, writeSfx } from "../../lib/sfx";
import { IBell, IClose, IPin2, IFolder } from "../icons";
import { setSheet } from "../state";
import { Panel } from "./Panel";

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
  isEnabled().then(setStartup).catch(() => {});
  invoke<boolean>("get_show_bubble").then(setBubble).catch(() => {});
  // The bubble can also be hidden from its own right-click menu or brought back from the tray.
  const stop = listen<boolean>("bubble-pref", (e) => setBubble(e.payload));
  onCleanup(() => void stop.then((u) => u()));
  const [stuck, setStuck] = createSignal<{ exe: string; name: string }[]>([]);
  const loadStuck = () => invoke<{ exe: string; name: string }[]>("stuck_apps").then(setStuck).catch(() => {});
  void loadStuck();
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
          {/* Your own colour: the native picker sits invisibly on top of the swatch. */}
          <label
            class="swatch custom"
            classList={{ on: theme().accent === "custom" }}
            style={{
              background: theme().accent === "custom" ? theme().custom : "conic-gradient(#ff6b6b, #ffd166, #06d6a0, #4cc9f0, #7b61ff, #ff6bd6, #ff6b6b)",
              color: onAccent(theme().custom),
            }}
            title="Pick your own colour"
          >
            <input
              type="color"
              aria-label="Custom colour"
              value={theme().custom}
              onInput={(e) => setTheme({ accent: "custom", custom: e.currentTarget.value })}
              onClick={() => theme().accent !== "custom" && setTheme({ accent: "custom" })}
            />
            <Show when={theme().accent !== "custom"}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2b2540" stroke-width="3" stroke-linecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </Show>
          </label>
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
      <div class="box">
        <label class="switch-row">
          <span>Sounds<small>Little sound effects for adding, finishing, the bubble and reminders</small></span>
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
      <div class="box">
        <div class="box-row">
          <span class="box-label"><IBell size={14} /> Reminders</span>
          <span class="row-gap">
            <button class="btn small" onClick={() => setSheet({ kind: "reminders" })}>See all</button>
            <button class="btn small" onClick={previewReminder}>Preview one</button>
          </span>
        </div>
        <QuietHours />
      </div>
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
      <p class="muted">Tasks and media live in this folder on this computer:</p>
      <code class="path">{dataDir()}</code>
      <div class="sheet-actions">
        <button class="btn ghost" onClick={() => invoke("open_data_dir")}><IFolder size={15} /> Open folder</button>
        <button class="btn ghost" onClick={change}>Change…</button>
      </div>
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
          <label>From <input type="time" value={q().from} onChange={(e) => e.currentTarget.value && set({ from: e.currentTarget.value })} /></label>
          <label>to <input type="time" value={q().to} onChange={(e) => e.currentTarget.value && set({ to: e.currentTarget.value })} /></label>
        </div>
      </Show>
      <label class="switch-row">
        <span>Wait during full-screen apps<small>Games, videos and presentations aren't interrupted</small></span>
        <input type="checkbox" role="switch" checked={q().busy} onChange={() => set({ busy: !q().busy })} />
      </label>
    </>
  );
}

// Updates come from GitHub Releases: each release carries a signed `latest.json` that the
// updater plugin reads (see `plugins.updater` in tauri.conf.json). Quicky checks quietly a while
// after it starts and twice a day, unless that's switched off in Settings; installing is always
// the user's click.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { createSignal } from "solid-js";

const KEY = "quicky-updates";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "ready"; version: string }
  | { kind: "installing"; progress: number }
  | { kind: "failed"; message: string };

const [updateState, setUpdateState] = createSignal<UpdateState>({ kind: "idle" });
export { updateState };

/** The user closed the "update ready" banner (it stays in Settings). */
const [bannerClosed, setBannerClosed] = createSignal(false);
export { bannerClosed, setBannerClosed };

let pending: Update | null = null;

export function autoCheck(): boolean {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}").auto !== false;
  } catch {
    return true;
  }
}

export function setAutoCheck(auto: boolean) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ auto }));
  } catch {}
}

/** Asks GitHub for a newer version. Quiet checks don't report failures (offline, rate limits). */
export async function checkForUpdate(quiet = false) {
  if (updateState().kind === "checking" || updateState().kind === "installing") return;
  setUpdateState({ kind: "checking" });
  try {
    pending = await check();
    setUpdateState(pending ? { kind: "ready", version: pending.version } : { kind: "latest" });
  } catch (e) {
    setUpdateState(quiet ? { kind: "idle" } : { kind: "failed", message: String(e) });
  }
}

/** Downloads and installs the waiting update, then Quicky restarts on the new version. */
export async function installUpdate() {
  if (!pending) return;
  let total = 0;
  let got = 0;
  setUpdateState({ kind: "installing", progress: 0 });
  try {
    await pending.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      if (e.event === "Progress") {
        got += e.data.chunkLength;
        setUpdateState({ kind: "installing", progress: total ? got / total : 0 });
      }
    });
    // On Windows the installer closes Quicky and opens the new one itself; elsewhere, restart.
    await relaunch();
  } catch (e) {
    setUpdateState({ kind: "failed", message: String(e) });
  }
}

export function startUpdateChecks() {
  const run = () => autoCheck() && updateState().kind !== "ready" && void checkForUpdate(true);
  setTimeout(run, 20_000);
  setInterval(run, 12 * 60 * 60 * 1000);
}

// Online sync (main window only): with an account, this PC's tasks, repeats and app lists, the
// shared settings (look, sounds, reminder settings) and the files attached to tasks are kept the
// same on every PC signed in to it. quicky.json stays the copy that works offline.
//
// The server keeps one copy per account with a revision number. Like two PCs sharing a synced
// folder, changes are merged three ways with `mergeData` (the copy this PC last agreed with the
// server, this PC's own, the server's) and put back with the revision they started from; when
// another PC got there first the server answers 409 with its newer copy, which is merged again.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ACCOUNT_EVENT, API, CloudError, api, readAccount, mediaDown, mediaList, mediaUp } from "./cloud";
import { dayKey, planSync, type Attachment, type Data, type SyncBase } from "./model";
import { applySynced, isLoaded, onLocalChange, snapshot, syncQueued, mediaExists, readMedia, writeMedia, showToast } from "./store";
import { THEME_KEY, setTheme, type Theme } from "./theme";
import { writeSfx, type SfxPrefs } from "./sfx";
import { writeQuiet, type Quiet } from "./reminders";

const ON_KEY = "quicky-sync";
/** Per account: the revision and copy this PC last agreed with the server. */
const stateKey = (userId: string) => `quicky-sync-state-${userId}`;
/** Per account: the settings this PC last sent or took, and when they were changed. */
const settingsKey = (userId: string) => `quicky-sync-settings-${userId}`;
/** Settings that follow the account (each one a localStorage key every window reads). The minis
 *  (which apps have one, and where) live in Rust's config; `MINIS_KEY` mirrors them here. */
const MINIS_KEY = "quicky-minis";
const SHARED = { theme: THEME_KEY, sfx: "quicky-sfx", quiet: "quicky-quiet", minis: MINIS_KEY } as const;
type Shared = Partial<Record<keyof typeof SHARED, unknown>>;

/** Pictures are shrunk before they go up: at most this many pixels on the long side. */
const MAX_SIDE = 2560;
/** Smaller pictures go up as they are. */
const SHRINK_FROM = 400 * 1024;
const FILE_MAX = 25 * 1024 * 1024;

export type SyncState = { state: "off" | "syncing" | "ok" | "error"; at?: number; error?: string };
export const [syncStatus, setSyncStatus] = createSignal<SyncState>({ state: "off" });

export function syncOn(): boolean {
  try {
    return JSON.parse(localStorage.getItem(ON_KEY) ?? "{}").on !== false;
  } catch {
    return true;
  }
}

export function setSyncOn(on: boolean) {
  try {
    localStorage.setItem(ON_KEY, JSON.stringify({ on }));
  } catch {}
  if (on) void syncNow();
  else {
    closeSocket();
    setSyncStatus({ state: "off" });
  }
}

const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
};

/** The signed-in, confirmed account sync works for, if it's on. */
function who(): string | null {
  const a = readAccount();
  return a?.user.verified && syncOn() ? a.user.id : null;
}

interface Remote { rev: number; data: Data | null; settings: Shared | null; settingsAt: number }

// ---- tasks ----------------------------------------------------------------------

let running: Promise<void> | null = null;
let again = false;

/** Syncs now (or right after the sync already running). */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncOnce().catch((e) => {
        const msg = e instanceof CloudError ? e.message : String(e);
        setSyncStatus({ state: "error", at: Date.now(), error: msg });
      });
    } while (again);
  })().finally(() => (running = null));
  return running;
}

async function syncOnce() {
  const userId = who();
  if (!userId || !isLoaded()) {
    if (!userId) setSyncStatus({ state: "off" });
    return;
  }
  setSyncStatus({ state: "syncing" });
  openSocket();
  let remote = await api<Remote>("GET", "/api/sync");
  await mirrorMinis();
  await syncSettings(userId, remote);
  let synced: Data | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const st = read<SyncBase>(stateKey(userId));
    // Merged in the same queue as quicky.json's own saves and merges.
    const plan = await syncQueued(async () => {
      const p = planSync(st, remote, snapshot(), dayKey());
      if (p.apply) applySynced(p.merged);
      return p;
    });
    if (remote.data) write(stateKey(userId), { rev: remote.rev, base: plan.theirs });
    synced = plan.merged;
    if (!plan.upload) break;
    try {
      const { rev } = await api<{ rev: number }>("PUT", "/api/sync", { baseRev: remote.data ? remote.rev : 0, data: plan.merged });
      write(stateKey(userId), { rev, base: plan.merged });
      break;
    } catch (e) {
      if (!(e instanceof CloudError) || e.status !== 409) throw e;
      // Another PC got there first: merge with its copy and try again.
      remote = await api<Remote>("GET", "/api/sync");
    }
  }
  setSyncStatus({ state: "ok", at: Date.now() });
  // Files after the tasks, one at a time: one that fails waits for the next sync.
  if (synced) {
    await downloadMedia(synced);
    await uploadMedia(synced);
  }
}

// ---- settings -------------------------------------------------------------------

function localShared(): Shared {
  const out: Shared = {};
  for (const [name, key] of Object.entries(SHARED)) {
    const v = read<unknown>(key);
    if (v !== null) out[name as keyof Shared] = v;
  }
  return out;
}

/** Copies this PC's minis from Rust's config into `MINIS_KEY`, so a change shows up as a settings change. */
async function mirrorMinis() {
  const list = await invoke<unknown[]>("minis_get").catch(() => null);
  if (list) write(MINIS_KEY, list);
}

function applyShared(s: Shared) {
  if (Array.isArray(s.minis)) {
    write(MINIS_KEY, s.minis);
    void invoke("minis_set", { list: s.minis }).catch(() => {});
  }
  if (s.theme && typeof s.theme === "object") setTheme(s.theme as Partial<Theme>);
  if (s.sfx && typeof s.sfx === "object") writeSfx(s.sfx as SfxPrefs);
  if (s.quiet && typeof s.quiet === "object") writeQuiet(s.quiet as Quiet);
}

/** Takes newer settings from the server, or sends this PC's when they changed here. */
async function syncSettings(userId: string, remote: Remote) {
  const mine = read<{ at: number; json: string }>(settingsKey(userId)) ?? { at: 0, json: "" };
  const now = localShared();
  const json = JSON.stringify(now);
  if (remote.settings && remote.settingsAt > mine.at) {
    // Another PC changed them since: theirs win.
    if (JSON.stringify(remote.settings) !== json) applyShared(remote.settings);
    write(settingsKey(userId), { at: remote.settingsAt, json: JSON.stringify(localShared()) });
  } else if (json !== mine.json || !remote.settings) {
    const at = Math.max(Date.now(), remote.settingsAt + 1);
    const r = await api<{ settings: Shared | null; settingsAt: number }>("PUT", "/api/sync/settings", { settings: now, at });
    if (r.settingsAt === at) write(settingsKey(userId), { at, json });
  }
}

/** Settings changed on this PC since they were last synced. */
function settingsChanged(): boolean {
  const userId = who();
  if (!userId) return false;
  return JSON.stringify(localShared()) !== (read<{ json: string }>(settingsKey(userId))?.json ?? "");
}

// ---- attached files ---------------------------------------------------------------

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4",
  ogg: "audio/ogg", wav: "audio/wav", pdf: "application/pdf",
};
const typeOf = (path: string) => TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Big pictures are scaled down and re-saved (same format) so they cost the server less. */
export async function shrink(blob: Blob, type: string): Promise<Blob> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(type)) return blob;
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return blob;
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && blob.size < SHRINK_FROM) return blob;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type, quality: 0.82 }).catch(() => null);
  return out && out.size < blob.size ? out : blob;
}

const attachmentsOf = (d: Data): Attachment[] => d.tasks.flatMap((t) => t.attachments ?? []);
/** Files already checked this session (on the server / on this PC), so each is looked at once. */
const uploaded = new Set<string>();
const present = new Set<string>();
const tooBig = new Set<string>();

async function uploadMedia(d: Data) {
  const atts = attachmentsOf(d).filter((a) => !uploaded.has(a.id) && !tooBig.has(a.id));
  if (!atts.length) return;
  const list = await mediaList().catch(() => null);
  if (!list) return;
  const onServer = new Set(list.media.map((m) => m.key));
  for (const a of atts) {
    if (onServer.has(a.id)) {
      uploaded.add(a.id);
      continue;
    }
    try {
      if (!(await mediaExists(a.path))) continue; // not on this PC either (another PC's, still coming)
      const type = typeOf(a.path);
      const blob = await shrink(new Blob([await readMedia(a.path)], { type }), type);
      if (blob.size > FILE_MAX) {
        tooBig.add(a.id);
        showToast(`"${a.name}" is over 25 MB, so it stays on this PC only`);
        continue;
      }
      await mediaUp(a.id, blob, type);
      uploaded.add(a.id);
    } catch (e) {
      if (e instanceof CloudError && e.status === 413) {
        tooBig.add(a.id);
        showToast(e.message);
      }
      // Anything else (offline, a file in use): tried again next time.
    }
  }
}

async function downloadMedia(d: Data) {
  const atts = attachmentsOf(d).filter((a) => !present.has(a.id));
  if (!atts.length) return;
  let onServer: Set<string> | null = null;
  for (const a of atts) {
    try {
      if (await mediaExists(a.path)) {
        present.add(a.id);
        continue;
      }
      onServer ??= new Set((await mediaList()).media.map((m) => m.key));
      if (!onServer.has(a.id)) continue;
      await writeMedia(a.path, await mediaDown(a.id));
      present.add(a.id);
      uploaded.add(a.id);
    } catch {
      // Tried again next time.
    }
  }
}

// ---- live updates -----------------------------------------------------------------

let ws: WebSocket | null = null;
let wsRetry = 2000;
let wsTimer: number | undefined;

function openSocket() {
  if (ws || !who()) return;
  const sock = new WebSocket(API.replace(/^http/, "ws") + "/api/live");
  ws = sock;
  sock.onopen = () => {
    wsRetry = 2000;
    sock.send(JSON.stringify({ type: "auth", token: readAccount()?.token ?? "" }));
  };
  sock.onmessage = (e) => {
    let m: { type?: string; rev?: number };
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    const userId = who();
    if (!userId) return;
    if (m.type === "sync" && m.rev !== read<{ rev: number }>(stateKey(userId))?.rev) void syncNow();
    else if (m.type === "sync-settings") void syncNow();
  };
  sock.onclose = (e) => {
    if (ws === sock) ws = null;
    if (e.code === 4001 || !who()) return;
    clearTimeout(wsTimer);
    wsTimer = window.setTimeout(openSocket, (wsRetry = Math.min(wsRetry * 2, 60_000)));
  };
}

function closeSocket() {
  clearTimeout(wsTimer);
  const s = ws;
  ws = null;
  s?.close();
}

// ---- when to sync -------------------------------------------------------------------

let pushTimer: number | undefined;

/** Starts syncing (after the tasks have loaded): on changes, on focus, live and every few minutes. */
export function startSync() {
  onLocalChange(() => {
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => void syncNow(), 1500);
  });
  addEventListener("focus", () => void syncNow());
  addEventListener("online", () => void syncNow());
  // Signing in or out (in this window, or another one).
  const accountChanged = () => {
    closeSocket();
    void syncNow();
  };
  addEventListener(ACCOUNT_EVENT, accountChanged);
  addEventListener("storage", (e) => e.key === "quicky-account" && accountChanged());
  setInterval(() => void syncNow(), 3 * 60_000);
  // Settings are changed through their own setters all over the app: look for changes here
  // (the minis in Rust's config, copied over first).
  setInterval(() => void mirrorMinis().then(() => settingsChanged() && void syncNow()), 4000);
  void syncNow();
}

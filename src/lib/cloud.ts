// Quicky's online side: the account, and extensions from Quicky's server. Tasks never go here;
// they stay in the user's own folder. Online projects live in the PROJECT extension.
// Plain TS (no Solid store) so the extension window's page can share it.
import { invoke } from "@tauri-apps/api/core";
import { ipcBytes } from "./platform";

export const API = "https://quicky-api.pistasspot.com";
const ACCOUNT_KEY = "quicky-account";
const INSTALLED_KEY = "quicky-extensions";

/** `verified`: the emailed code was entered (projects and extensions need that). */
export interface User { id: string; email: string; name: string; verified: boolean }
export interface Account { token: string; user: User }
/** `icon`: the catalogue's picture for it (a PNG or SVG data URL), when it has one: its windows'
 *  taskbar badge (`lib/ext-icon.ts`). */
export interface Extension { id: string; name: string; version: string; description: string; type: string; sha256: string; size: number; icon?: string }
export interface Installed { id: string; name: string; version: string; sha256: string; icon?: string }

/** A catalogue picture Quicky will draw: a small PNG or SVG data URL. */
const iconOf = (e: Extension) =>
  typeof e.icon === "string" && e.icon.length <= 64_000 && /^data:image\/(png|svg\+xml)[;,]/.test(e.icon) ? e.icon : undefined;

export class CloudError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---- account (per PC, in localStorage, which every Quicky window shares) ----------------------

export function readAccount(): Account | null {
  try {
    const a = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null");
    return a && typeof a.token === "string" && a.user ? a : null;
  } catch {
    return null;
  }
}

/** Fired in this window when the account changes here (other windows hear `storage`). */
export const ACCOUNT_EVENT = "quicky-account-changed";

function writeAccount(a: Account | null) {
  try {
    if (a) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {}
  dispatchEvent(new Event(ACCOUNT_EVENT));
}

/** Calls the API. Sends the session when signed in; a 401 means it ended, so this PC signs out. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const account = readAccount();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (account) headers.authorization = `Bearer ${account.token}`;
  let res: Response;
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new CloudError(0, "Can't reach Quicky's server. Check your internet connection");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && account && !path.startsWith("/api/auth/sign")) writeAccount(null);
    throw new CloudError(res.status, data.error ?? `The server answered ${res.status}`);
  }
  return data as T;
}

export async function signUp(email: string, password: string, name: string) {
  const a = await api<Account>("POST", "/api/auth/signup", { email, password, name });
  writeAccount(a);
  return a;
}

export async function signIn(email: string, password: string) {
  const a = await api<Account>("POST", "/api/auth/signin", { email, password });
  writeAccount(a);
  return a;
}

export async function signOut() {
  await api("POST", "/api/auth/signout").catch(() => {});
  writeAccount(null);
}

/** Deletes the account and everything the server keeps for it (the password confirms it), then
 *  signs this device out. Turning sync off is the caller's (sync.ts isn't loaded everywhere). */
export async function deleteAccount(password: string) {
  await api("DELETE", "/api/auth/me", { password });
  writeAccount(null);
}

/** The privacy policy (also how to delete an account from the web). */
export const PRIVACY_URL = "https://quicky.pistasspot.com/privacy";

export const forgotPassword =(email: string) => api("POST", "/api/auth/forgot", { email });

/** Confirms the email with the code sent at sign-up, and remembers the confirmed user. */
export async function verifyEmail(code: string) {
  const { user } = await api<{ user: User }>("POST", "/api/auth/verify", { code });
  const a = readAccount();
  if (a) writeAccount({ ...a, user });
  return user;
}

/** Re-reads the signed-in user (the email may have been confirmed on another PC). */
export async function refreshAccount() {
  const a = readAccount();
  if (!a) return null;
  try {
    const { user } = await api<{ user: User }>("GET", "/api/auth/me");
    writeAccount({ ...a, user });
  } catch {}
  return readAccount();
}

export const resendVerification = () => api("POST", "/api/auth/verify/resend");

// ---- bugs and requests -----------------------------------------------------------------------

/** What the maker did with a request. Requests sent before the states read as one of them. */
export type FeedbackState = "open" | "fixed" | "dismissed" | "added";
/** One of the signed-in user's own requests. `images` is how many pictures it has. */
export interface MyFeedback {
  id: string;
  kind: "bug" | "request";
  title: string;
  body: string;
  status: FeedbackState;
  reply: string | null;
  images: number;
  createdAt: string;
  updatedAt: string;
}
/** At most this many pictures, each at most this big once shrunk (the server checks both). */
export const FEEDBACK_IMAGES = 3;
export const FEEDBACK_IMAGE_MAX = 4 * 1024 * 1024;
/** Fired in this window when the admin changed one of this user's requests (from sync's socket). */
export const FEEDBACK_EVENT = "quicky-feedback-changed";

/** A bug report or feature request, with up to three pictures (base64). Signed in, the server adds who sent it. */
export const sendFeedback = (f: { kind: "bug" | "request"; title: string; body: string; email?: string; appVersion: string; os: string; images?: { data: string }[] }) =>
  api<{ feedback: MyFeedback }>("POST", "/api/feedback", f);

/** The signed-in user's own requests, newest first. */
export const myFeedback = async () => (await api<{ feedback: MyFeedback[] }>("GET", "/api/feedback/mine")).feedback;

/** Picture `n` of one of the user's requests, as a blob URL (it needs the session, so no plain <img src>). */
export async function feedbackPicture(id: string, n: number): Promise<string> {
  const token = readAccount()?.token ?? "";
  const res = await fetch(`${API}/api/feedback/mine/${id}/images/${n}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res?.ok) throw new CloudError(res?.status ?? 0, "Couldn't load the picture");
  return URL.createObjectURL(await res.blob());
}

export async function resetPassword(email: string, code: string, password: string) {
  const a = await api<Account>("POST", "/api/auth/reset", { email, code, password });
  writeAccount(a);
  return a;
}

// ---- synced attachments (lib/sync.ts) ------------------------------------------------------------

export const mediaList = () => api<{ media: { key: string; size: number }[]; used: number; max: number }>("GET", "/api/sync/media");

async function mediaFetch(key: string, init: RequestInit = {}) {
  const token = readAccount()?.token ?? "";
  let res: Response;
  try {
    res = await fetch(`${API}/api/sync/media/${encodeURIComponent(key)}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  } catch {
    throw new CloudError(0, "Can't reach Quicky's server. Check your internet connection");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CloudError(res.status, data.error ?? `The server answered ${res.status}`);
  }
  return res;
}

export const mediaUp = (key: string, blob: Blob, type: string) => mediaFetch(key, { method: "PUT", headers: { "content-type": type }, body: blob });
export const mediaDown = async (key: string) => (await mediaFetch(key)).arrayBuffer();

// ---- extensions ------------------------------------------------------------------------------

export function readInstalled(): Installed[] {
  try {
    const list = JSON.parse(localStorage.getItem(INSTALLED_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeInstalled(list: Installed[]) {
  try {
    localStorage.setItem(INSTALLED_KEY, JSON.stringify(list));
  } catch {}
}

export const listExtensions = () => api<{ extensions: Extension[] }>("GET", "/api/extensions").then((r) => r.extensions);

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Downloads, checks the sha256 against the catalogue, and saves it on this PC. */
export async function installExtension(ext: Extension) {
  const account = readAccount();
  if (!account) throw new CloudError(401, "Sign in first");
  const res = await fetch(`${API}/api/extensions/${ext.id}/bundle`, { headers: { authorization: `Bearer ${account.token}` } }).catch(() => null);
  if (!res?.ok) throw new CloudError(res?.status ?? 0, "Couldn't download the extension");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== ext.sha256) {
    throw new CloudError(0, "The download didn't match the catalogue, so it wasn't installed");
  }
  await invoke("extension_save", ipcBytes(bytes), { headers: { "x-id": ext.id } });
  writeInstalled([...readInstalled().filter((i) => i.id !== ext.id), { id: ext.id, name: ext.name, version: ext.version, sha256: ext.sha256, icon: iconOf(ext) }]);
}

export async function removeExtension(id: string) {
  await invoke("extension_remove", { id });
  writeInstalled(readInstalled().filter((i) => i.id !== id));
}

/** The phone opens extensions inside its one window instead (set by `mobile/App.tsx`). */
let opener: ((id: string) => void) | null = null;
export const setExtensionOpener = (fn: (id: string) => void) => void (opener = fn);

export const openExtension = async (i: Installed) => (opener ? opener(i.id) : invoke("open_extension", { id: i.id, title: i.name }));

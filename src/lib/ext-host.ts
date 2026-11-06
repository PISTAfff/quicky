// Hosts an installed extension's sandboxed frame: the postMessage bridge it talks to Quicky
// through. Shared by the desktop's extension window (`extension.ts`) and the phone's full-screen
// extension view (`mobile/ExtensionView.tsx`). The frame never gets the session: it asks with
// `{qx:1, type}` messages and this side makes the (allow-listed) calls for it.
import { API, api, readAccount } from "./cloud";
import fredokaUrl from "@fontsource-variable/fredoka/files/fredoka-latin-wght-normal.woff2?url";
import nunitoUrl from "@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2?url";

/** Extensions that may read and change Quicky's tasks (the Calendar). */
export const TASKS_ALLOWED = ["calendar"];

export type TaskAnswer = { ok: boolean; data?: unknown; error?: string };

export interface HostOptions {
  /** The extension's id (its window is `ext-<id>` on the desktop). */
  id: string;
  /** Answers a tasks request (`list`, `add`, `update`, `remove`), for TASKS_ALLOWED only. */
  tasks: (op: string, args: Record<string, unknown>) => Promise<TaskAnswer>;
  /** The board's eyedropper: a colour from anywhere on screen (null: not available here). */
  pickColor: (post: (msg: object) => void) => Promise<string | null>;
  /** A calendar event was changed through the frame. */
  onEventsChanged: () => void;
}

/** Only the project routes (and who is signed in) are open to extensions. */
const ALLOWED = /^\/api\/(projects(\/[A-Za-z0-9/_-]*)?|auth\/me)$/;
const METHODS = ["GET", "POST", "PATCH", "DELETE"];
const HEX24 = /^[0-9a-f]{24}$/i;

/** The theme's colours and fonts, so the extension can look like Quicky. */
export function themeForFrame() {
  const css = getComputedStyle(document.documentElement);
  const names = ["bg", "card", "ink", "muted", "line", "soft", "accent", "accent-ink", "on-accent", "accent-soft", "edge", "solid", "on-solid", "sub", "placeholder", "doing", "done", "danger", "danger-soft", "peach", "blue", "warm", "shadow", "r"];
  const vars: Record<string, string> = {};
  for (const n of names) vars[n] = css.getPropertyValue(`--${n}`).trim();
  return { mode: document.documentElement.dataset.mode ?? "light", vars };
}

/** Starts the bridge for `frame`. Returns `post` (to send it messages) and `stop`. */
export function hostExtension(frame: HTMLIFrameElement, opt: HostOptions) {
  const { id } = opt;
  const post = (msg: object) => frame.contentWindow?.postMessage({ qx: 1, ...msg }, "*");
  /** The voice note being recorded for the extension, if any. */
  let recorder: { rec: MediaRecorder; stream: MediaStream; chunks: Blob[]; started: number } | null = null;
  let stopped = false;

  // Live updates: one socket, opened when the extension first watches a project.
  let ws: WebSocket | null = null;
  const watching = new Set<string>();
  let retry = 1000;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(API.replace(/^http/, "ws") + "/api/live");
    ws.onopen = () => {
      retry = 1000;
      ws!.send(JSON.stringify({ type: "auth", token: readAccount()?.token ?? "" }));
    };
    ws.onmessage = (e) => {
      let m: { type?: string };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === "ready") for (const p of watching) ws!.send(JSON.stringify({ type: "subscribe", projectId: p }));
      else post({ type: "live", msg: m });
    };
    ws.onclose = (e) => {
      ws = null;
      if (e.code === 4001) return post({ type: "signed-out" });
      if (watching.size && !stopped) setTimeout(connect, (retry = Math.min(retry * 2, 30_000)));
    };
  };

  const onMessage = async (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || !e.data || e.data.qx !== 1) return;
    const m = e.data as { type: string; id?: number; method?: string; path?: string; body?: unknown; projectId?: string };
    if (m.type === "ready") {
      post({ type: "hello", user: readAccount()?.user ?? null, theme: themeForFrame() });
      // Quicky's own fonts: the frame can't fetch the app's files, so it gets their bytes.
      void Promise.all(
        [
          { family: "Fredoka", weight: "300 700", url: fredokaUrl },
          { family: "Nunito", weight: "200 1000", url: nunitoUrl },
        ].map(async (f) => ({ family: f.family, weight: f.weight, bytes: await (await fetch(f.url)).arrayBuffer() })),
      )
        .then((fonts) => frame.contentWindow?.postMessage({ qx: 1, type: "fonts", fonts }, "*", fonts.map((f) => f.bytes)))
        .catch(() => {});
    } else if (m.type === "api") {
      const method = String(m.method ?? "GET").toUpperCase();
      if (!METHODS.includes(method) || typeof m.path !== "string" || !ALLOWED.test(m.path)) {
        return post({ type: "reply", id: m.id, ok: false, status: 403, error: "Extensions can only use project routes" });
      }
      try {
        post({ type: "reply", id: m.id, ok: true, status: 200, data: await api(method, m.path, m.body) });
        // A calendar event changed: Quicky's reminders read them again.
        if (method !== "GET" && m.path.includes("/events")) opt.onEventsChanged();
      } catch (err) {
        const status = (err as { status?: number }).status ?? 0;
        post({ type: "reply", id: m.id, ok: false, status, error: (err as Error).message });
        if (status === 401) post({ type: "signed-out" });
      }
    } else if (m.type === "tasks") {
      if (!TASKS_ALLOWED.includes(id)) return post({ type: "reply", id: m.id, ok: false, status: 403, error: "This extension can't use your tasks" });
      const x = e.data as { op?: unknown; args?: unknown };
      const r = await opt.tasks(String(x.op ?? ""), x.args && typeof x.args === "object" ? (x.args as Record<string, unknown>) : {});
      post({ type: "reply", id: m.id, ok: r.ok, status: r.ok ? 200 : 400, data: r.data, error: r.error });
    } else if (m.type === "watch" && typeof m.projectId === "string") {
      watching.add(m.projectId);
      if (!ws) connect();
      else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "subscribe", projectId: m.projectId }));
    } else if (m.type === "unwatch" && typeof m.projectId === "string") {
      watching.delete(m.projectId);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "unsubscribe", projectId: m.projectId }));
    } else if (m.type === "upload" || m.type === "media") {
      // Images and voice notes: raw bytes both ways, sent with the session here (never to the frame).
      const x = e.data as { projectId?: unknown; mediaId?: unknown; mime?: unknown; bytes?: unknown };
      const ok = (v: unknown) => typeof v === "string" && HEX24.test(v);
      const fail = (status: number, error: string) => post({ type: "reply", id: m.id, ok: false, status, error });
      if (!ok(x.projectId) || (m.type === "media" && !ok(x.mediaId))) return fail(400, "Not a valid project or file");
      const auth = { authorization: `Bearer ${readAccount()?.token ?? ""}` };
      const url = `${API}/api/projects/${x.projectId}/media`;
      try {
        if (m.type === "upload") {
          if (!(x.bytes instanceof ArrayBuffer) || typeof x.mime !== "string") return fail(400, "Nothing to upload");
          const res = await fetch(url, { method: "POST", headers: { ...auth, "content-type": x.mime }, body: x.bytes });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) return fail(res.status, data.error ?? "Couldn't upload that file");
          post({ type: "reply", id: m.id, ok: true, status: 201, data });
        } else {
          const res = await fetch(`${url}/${x.mediaId}`, { headers: auth });
          if (!res.ok) return fail(res.status, "Couldn't load that file");
          const bytes = await res.arrayBuffer();
          frame.contentWindow?.postMessage({ qx: 1, type: "reply", id: m.id, ok: true, status: 200, data: { bytes, type: res.headers.get("content-type") ?? "" } }, "*", [bytes]);
        }
      } catch {
        fail(0, "Can't reach Quicky's server. Check your internet connection");
      }
    } else if (m.type === "pick-color") {
      const hex = await opt.pickColor(post).catch(() => null);
      post({ type: "reply", id: m.id, ok: true, status: 200, data: hex });
    } else if (m.type === "record") {
      // Voice notes are recorded here: the sandboxed frame can't ask for the microphone itself.
      const action = (e.data as { action?: string }).action;
      const reply = (data: unknown) => post({ type: "reply", id: m.id, ok: true, status: 200, data });
      const fail = (error: string) => post({ type: "reply", id: m.id, ok: false, status: 0, error });
      if (action === "start") {
        if (recorder) return fail("Already recording");
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
          const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
          const chunks: Blob[] = [];
          rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
          recorder = { rec, stream, chunks, started: performance.now() };
          rec.start(250);
          reply({ recording: true });
        } catch {
          fail("Quicky couldn't use the microphone. Check that it's allowed in your system's privacy settings");
        }
      } else if (action === "stop" || action === "cancel") {
        const r = recorder;
        recorder = null;
        if (!r) return fail("Not recording");
        const done = new Promise<void>((res) => (r.rec.onstop = () => res()));
        r.rec.stop();
        await done;
        r.stream.getTracks().forEach((t) => t.stop());
        if (action === "cancel") return reply({ cancelled: true });
        const blob = new Blob(r.chunks, { type: r.rec.mimeType || "audio/webm" });
        const bytes = await blob.arrayBuffer();
        const mime = (r.rec.mimeType || "audio/webm").split(";")[0];
        frame.contentWindow?.postMessage(
          { qx: 1, type: "reply", id: m.id, ok: true, status: 200, data: { bytes, mime, duration: Math.round((performance.now() - r.started) / 100) / 10 } },
          "*",
          [bytes],
        );
      }
    }
  };
  addEventListener("message", onMessage);

  // Theme changes in Settings repaint the extension too.
  const themeWatch = new MutationObserver(() => post({ type: "theme", theme: themeForFrame() }));
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-mode"] });

  const stop = () => {
    stopped = true;
    removeEventListener("message", onMessage);
    themeWatch.disconnect();
    watching.clear();
    ws?.close();
    if (recorder) {
      recorder.rec.stop();
      recorder.stream.getTracks().forEach((t) => t.stop());
      recorder = null;
    }
  };
  return { post, stop };
}

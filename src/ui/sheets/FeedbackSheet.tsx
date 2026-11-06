import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import {
  ACCOUNT_EVENT,
  FEEDBACK_EVENT,
  FEEDBACK_IMAGE_MAX,
  FEEDBACK_IMAGES,
  feedbackPicture,
  myFeedback,
  readAccount,
  sendFeedback,
  type FeedbackState,
  type MyFeedback,
} from "../../lib/cloud";
import { chooseFiles, importPaths } from "../../lib/media";
import { IS_MOBILE, OS } from "../../lib/platform";
import { readMedia, showToast } from "../../lib/store";
import { shrink } from "../../lib/sync";
import { IClose, IImage, IPlus } from "../icons";
import { setSheet } from "../state";
import { Panel } from "./Panel";

/** Pictures go up at most this many pixels on the long side (a screenshot stays readable). */
const PICTURE_SIDE = 1920;
const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Re-draws a picture as a JPEG (a type the server doesn't take, or a PNG still too big). */
async function asJpeg(blob: Blob, maxSide: number): Promise<Blob | null> {
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return null;
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff"; // transparent parts of a PNG
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 }).catch(() => null);
}

/** A picked, pasted or dropped file, ready to send: shrunk like sync's pictures, and under the cap. */
async function preparePicture(file: Blob): Promise<Blob> {
  let out: Blob | null = PICTURE_TYPES.includes(file.type) ? await shrink(file, file.type, PICTURE_SIDE) : await asJpeg(file, PICTURE_SIDE);
  if (!out) throw new Error("That isn't a picture Quicky can read");
  if (out.size > FEEDBACK_IMAGE_MAX && out.type !== "image/gif") out = (await asJpeg(out, PICTURE_SIDE)) ?? out;
  if (out.size > FEEDBACK_IMAGE_MAX) throw new Error(`A picture can be at most ${FEEDBACK_IMAGE_MAX / 1024 / 1024} MB`);
  return out;
}

const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };

/** Files dropped on the main window while this panel is open (Tauri hands over paths, not files). */
let onDrop: ((paths: string[]) => void) | null = null;
export const feedbackDrop = (paths: string[]) => onDrop?.(paths);

const STATE_LABEL: Record<FeedbackState, string> = { open: "Open", fixed: "Fixed", dismissed: "Dismissed", added: "Added" };
/** What each request looked like when this user last saw the list, so a change stands out once. */
const seenKey = (userId: string) => `quicky-feedback-seen-${userId}`;
const stamp = (f: MyFeedback) => `${f.status}\n${f.reply ?? ""}`;
function readSeen(userId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(seenKey(userId)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};

/** Settings → Bugs & requests: sends a report or an idea to Quicky's maker (with up to three
 *  pictures), and lists the signed-in user's earlier ones with what became of them. */
export function FeedbackSheet() {
  const [account, setAccount] = createSignal(readAccount());
  const [kind, setKind] = createSignal<"bug" | "request">("bug");
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [pics, setPics] = createSignal<{ blob: Blob; url: string }[]>([]);
  const [adding, setAdding] = createSignal(0);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [version, setVersion] = createSignal("");
  getVersion().then(setVersion).catch(() => {});

  const addPictures = async (files: Blob[]) => {
    setError("");
    const room = FEEDBACK_IMAGES - pics().length - adding();
    if (files.length > room) setError(`Up to ${FEEDBACK_IMAGES} pictures`);
    const take = files.slice(0, Math.max(0, room));
    if (!take.length) return;
    setAdding((n) => n + take.length);
    for (const f of take) {
      try {
        const blob = await preparePicture(f);
        setPics((p) => [...p, { blob, url: URL.createObjectURL(blob) }]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setAdding((n) => n - 1);
      }
    }
  };
  const removePicture = (i: number) => {
    URL.revokeObjectURL(pics()[i].url);
    setPics((p) => p.filter((_, k) => k !== i));
  };
  const pick = async () => addPictures(await chooseFiles("image/*"));
  const paste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void addPictures(files);
  };
  // The main window takes file drops itself (paths): copy each into the data folder, read it, remove it.
  onDrop = (paths) => {
    const images = paths.filter((p) => TYPES[p.split(".").pop()?.toLowerCase() ?? ""]);
    if (!images.length) return setError("Only pictures can go with a report");
    void (async () => {
      const blobs: Blob[] = [];
      for (const att of await importPaths(images.slice(0, FEEDBACK_IMAGES)).catch(() => [])) {
        try {
          blobs.push(new Blob([await readMedia(att.path)], { type: TYPES[att.path.split(".").pop()!.toLowerCase()] }));
        } catch {}
        invoke("remove_media", { rel: att.path }).catch(() => {});
      }
      await addPictures(blobs);
      if (images.length > FEEDBACK_IMAGES) setError(`Up to ${FEEDBACK_IMAGES} pictures`);
    })();
  };

  // ---- history ----
  const [history, setHistory] = createSignal<MyFeedback[] | null>(null);
  const [historyError, setHistoryError] = createSignal("");
  const [changed, setChanged] = createSignal<Set<string>>(new Set());
  const [zoom, setZoom] = createSignal<string | null>(null);
  /** The sent pictures, loaded once while the panel is open (the list reloads on every focus). */
  const shots = new Map<string, Promise<string>>();
  const shot = (id: string, n: number) => {
    const key = `${id}/${n}`;
    let p = shots.get(key);
    if (!p) {
      p = feedbackPicture(id, n);
      p.catch(() => shots.delete(key));
      shots.set(key, p);
    }
    return p;
  };
  /** What the list looked like before this panel opened: changes since then stay marked while it's open. */
  let seenAtOpen: Record<string, string> | null = null;
  const loadHistory = async () => {
    const a = account();
    if (!a) return setHistory(null);
    try {
      const list = await myFeedback();
      const seen = (seenAtOpen ??= readSeen(a.user.id));
      // Changed since last seen: the admin set a state or replied (new ones were seen when sent).
      setChanged(new Set(list.filter((f) => seen[f.id] !== undefined && seen[f.id] !== stamp(f)).map((f) => f.id)));
      try {
        localStorage.setItem(seenKey(a.user.id), JSON.stringify(Object.fromEntries(list.map((f) => [f.id, stamp(f)]))));
      } catch {}
      setHistory(list);
      setHistoryError("");
    } catch (e) {
      setHistoryError((e as Error).message);
    }
  };
  const accountChanged = () => {
    seenAtOpen = null;
    setAccount(readAccount());
    void loadHistory();
  };
  const reload = () => void loadHistory();
  const escZoom = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !zoom()) return;
    e.stopImmediatePropagation();
    setZoom(null);
  };
  onMount(() => {
    void loadHistory();
    addEventListener(FEEDBACK_EVENT, reload);
    addEventListener("focus", reload);
    addEventListener(ACCOUNT_EVENT, accountChanged);
    addEventListener("keydown", escZoom, true);
  });
  onCleanup(() => {
    onDrop = null;
    removeEventListener(FEEDBACK_EVENT, reload);
    removeEventListener("focus", reload);
    removeEventListener(ACCOUNT_EVENT, accountChanged);
    removeEventListener("keydown", escZoom, true);
    pics().forEach((p) => URL.revokeObjectURL(p.url));
    shots.forEach((p) => p.then((url) => URL.revokeObjectURL(url), () => {}));
  });

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy() || adding()) return;
    setBusy(true);
    setError("");
    try {
      const images = await Promise.all(pics().map(async (p) => ({ data: await base64(p.blob) })));
      const { feedback } = await sendFeedback({
        kind: kind(),
        title: title().trim(),
        body: body().trim(),
        email: email().trim() || undefined,
        appVersion: version(),
        os: IS_MOBILE ? "android" : OS,
        images: images.length ? images : undefined,
      });
      showToast(kind() === "bug" ? "Thanks! Your bug report was sent" : "Thanks! Your idea was sent");
      const a = account();
      if (!a) return setSheet({ kind: "settings" });
      // Signed in: stay, so the new one shows at the top of the list below.
      pics().forEach((p) => URL.revokeObjectURL(p.url));
      setPics([]);
      setTitle("");
      setBody("");
      if (feedback) setHistory((h) => [feedback, ...(h ?? [])]);
      void loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Bugs & requests" class="feedback-sheet">
      <form class="box account-form" onSubmit={submit} onPaste={paste}>
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
        <div class="field">
          <span>
            Pictures <small class="muted">(optional, up to {FEEDBACK_IMAGES}{IS_MOBILE ? "" : ": pick, paste or drop a screenshot"})</small>
          </span>
          <div class="fb-pics">
            <For each={pics()}>
              {(p, i) => (
                <div class="fb-pic">
                  <img src={p.url} alt={`Picture ${i() + 1}`} />
                  <button type="button" class="fb-pic-x" aria-label={`Remove picture ${i() + 1}`} title="Remove" onClick={() => removePicture(i())}>
                    <IClose size={11} />
                  </button>
                </div>
              )}
            </For>
            <For each={Array.from({ length: adding() })}>{() => <div class="fb-pic loading" aria-label="Adding a picture" />}</For>
            <Show when={pics().length + adding() < FEEDBACK_IMAGES}>
              <button type="button" class="fb-pic add" onClick={() => void pick()} aria-label="Add a picture">
                <IImage size={18} />
                <IPlus size={11} />
              </button>
            </Show>
          </div>
        </div>
        <Show
          when={!account()}
          fallback={<small class="muted">Sent as {account()!.user.name} ({account()!.user.email}), so we can reply.</small>}
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
        <button class="btn primary" type="submit" disabled={busy() || adding() > 0}>{busy() ? "Sending…" : "Send"}</button>
      </form>

      <Show
        when={account()}
        fallback={<p class="muted fb-hint">Signed in (Settings → Online), you can see what became of each one here.</p>}
      >
        <div class="box fb-history">
          <span class="box-label">Sent by you</span>
          <Show when={historyError() && !history()}>
            <p class="muted">{historyError()}</p>
          </Show>
          <Show when={history()} fallback={<Show when={!historyError()}><p class="muted">Loading…</p></Show>}>
            <Show when={history()!.length} fallback={<p class="muted">Nothing yet. What you send shows up here.</p>}>
              <ul class="fb-list">
                <For each={history()!}>
                  {(f) => (
                    <li class="fb-item" classList={{ changed: changed().has(f.id) }}>
                      <div class="fb-item-top">
                        <span class={`fb-kind ${f.kind}`}>{f.kind === "bug" ? "Bug" : "Idea"}</span>
                        <span class="fb-item-title">{f.title}</span>
                        <span class={`fb-state ${f.status}`}>{STATE_LABEL[f.status]}</span>
                      </div>
                      <Show when={f.body}>
                        <p class="fb-item-body">{f.body}</p>
                      </Show>
                      <Show when={f.images}>
                        <div class="fb-shots">
                          <For each={Array.from({ length: f.images }, (_, n) => n)}>{(n) => <Shot n={n} load={() => shot(f.id, n)} onOpen={setZoom} />}</For>
                        </div>
                      </Show>
                      <Show when={f.reply}>
                        <p class="fb-reply"><b>Reply:</b> {f.reply}</p>
                      </Show>
                      <small class="muted">
                        Sent {shortDate(f.createdAt)}
                        <Show when={f.status !== "open"}> · {STATE_LABEL[f.status].toLowerCase()} {shortDate(f.updatedAt)}</Show>
                        <Show when={changed().has(f.id)}> · <b class="fb-new">Updated</b></Show>
                      </small>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </Show>

      <Show when={zoom()}>
        <div class="fb-zoom" role="dialog" aria-label="Picture" onClick={() => setZoom(null)}>
          <img src={zoom()!} alt="" />
        </div>
      </Show>
    </Panel>
  );
}

/** One picture of a sent request (it needs the session, so it comes in as a blob; the panel keeps it). */
function Shot(p: { n: number; load: () => Promise<string>; onOpen: (url: string) => void }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  p.load().then(setUrl, () => setFailed(true));
  return (
    <button type="button" class="fb-shot" aria-label={`Picture ${p.n + 1}, show it bigger`} disabled={!url()} onClick={() => url() && p.onOpen(url()!)}>
      <Show when={url()} fallback={<Show when={failed()}><IImage size={14} /></Show>}>
        <img src={url()!} alt="" />
      </Show>
    </button>
  );
}

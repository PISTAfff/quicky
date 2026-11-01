import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { monthKey, uid, type Attachment } from "./model";

type Raw = Omit<Attachment, "id">;
const withIds = (list: Raw[]): Attachment[] => list.map((a) => ({ ...a, id: uid() }));

/** Copies files from anywhere on disk into the data folder's media/<month>/. */
export async function importPaths(paths: string[]): Promise<Attachment[]> {
  if (!paths.length) return [];
  return withIds(await invoke<Raw[]>("import_files", { paths, month: monthKey() }));
}

export async function pickFiles(): Promise<Attachment[]> {
  const picked = await open({ multiple: true, title: "Attach to task" });
  if (!picked) return [];
  return importPaths(Array.isArray(picked) ? picked : [picked]);
}

/** Sends raw bytes (pasted image, voice note) straight to disk without JSON-encoding them. */
export async function saveBlob(blob: Blob, name: string, kind?: Attachment["kind"]): Promise<Attachment> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const headers: Record<string, string> = { "x-name": name, "x-month": monthKey() };
  if (kind) headers["x-kind"] = kind;
  const raw = await invoke<Raw>("save_blob", bytes, { headers });
  return { ...raw, id: uid() };
}

const extFor = (type: string) =>
  ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" })[type] ?? "bin";

/** Pulls images/files out of a paste event. */
export async function fromClipboard(e: ClipboardEvent): Promise<Attachment[]> {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return [];
  e.preventDefault();
  return Promise.all(
    files.map((f) => saveBlob(f, f.name && f.name !== "image.png" ? f.name : `pasted.${extFor(f.type)}`)),
  );
}

export interface Recording {
  analyser: AnalyserNode;
  stop(): Promise<Attachment | null>;
  cancel(): void;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();

  // Tap the same stream for the live waveform.
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);

  const end = () => new Promise<void>((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      resolve();
    };
    rec.stop();
  });
  return {
    analyser,
    async stop() {
      await end();
      if (!chunks.length) return null;
      const stamp = new Date().toTimeString().slice(0, 5).replace(":", "");
      return saveBlob(new Blob(chunks, { type: "audio/webm" }), `voice-${stamp}.webm`, "audio");
    },
    cancel() {
      void end();
    },
  };
}

export const openMedia = (rel: string) => invoke("open_media", { rel });

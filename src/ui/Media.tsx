import { createSignal, Match, onCleanup, Switch } from "solid-js";
import type { Attachment } from "../lib/model";
import { mediaUrl } from "../lib/store";
import { openMedia } from "../lib/media";
import { IFile, IPause, IPlay } from "./icons";

const fmt = (s: number) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");

/** One shared player so only one voice note plays at a time. */
let current: HTMLAudioElement | null = null;

export function AudioChip(p: { att: Attachment; large?: boolean }) {
  const [playing, setPlaying] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [dur, setDur] = createSignal(NaN);
  const audio = new Audio();
  audio.preload = "none";
  audio.onplay = () => setPlaying(true);
  audio.onpause = () => setPlaying(false);
  audio.ontimeupdate = () => setTime(audio.currentTime);
  // Recorded webm often reports an infinite duration; learn it at the end instead.
  audio.ondurationchange = () => isFinite(audio.duration) && setDur(audio.duration);
  audio.onended = () => {
    setPlaying(false);
    if (!isFinite(dur())) setDur(audio.currentTime);
    setTime(0);
  };
  onCleanup(() => audio.pause());

  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    if (!audio.src) audio.src = mediaUrl(p.att.path);
    if (playing()) return audio.pause();
    if (current && current !== audio) current.pause();
    current = audio;
    void audio.play();
  };
  const pct = () => (dur() > 0 ? Math.min(100, (time() / dur()) * 100) : 0);

  return (
    <span class="audio" classList={{ large: p.large }}>
      <button class="audio-play" aria-label={playing() ? "Pause voice note" : "Play voice note"} onClick={toggle}>
        {playing() ? <IPause size={10} /> : <IPlay size={10} />}
      </button>
      {p.large && <span class="audio-track"><i style={{ width: `${pct()}%` }} /></span>}
      <span class="audio-time">{playing() || time() ? fmt(time()) : isFinite(dur()) ? fmt(dur()) : "Voice"}</span>
    </span>
  );
}

/** Small preview used on cards and in the quick-add tray. */
export function Thumb(p: { att: Attachment }) {
  return (
    <Switch fallback={<span class="thumb file" title={p.att.name}><IFile size={14} /></span>}>
      <Match when={p.att.kind === "image"}>
        <img class="thumb" src={mediaUrl(p.att.path)} alt={p.att.name} loading="lazy" decoding="async" />
      </Match>
      <Match when={p.att.kind === "video"}>
        <span class="thumb video" title={p.att.name}><IPlay size={12} /></span>
      </Match>
      <Match when={p.att.kind === "audio"}>
        <AudioChip att={p.att} />
      </Match>
    </Switch>
  );
}

/** Full-size view used in the task sheet. */
export function MediaView(p: { att: Attachment }) {
  const open = () => openMedia(p.att.path).catch(() => {});
  return (
    <Switch
      fallback={
        <button class="media-file" onClick={open} title="Open with the default app">
          <IFile size={16} />
          <span>{p.att.name}</span>
        </button>
      }
    >
      <Match when={p.att.kind === "image"}>
        <button class="media-img" onClick={open} title="Open full size">
          <img src={mediaUrl(p.att.path)} alt={p.att.name} loading="lazy" decoding="async" />
        </button>
      </Match>
      <Match when={p.att.kind === "video"}>
        <video class="media-video" src={mediaUrl(p.att.path)} preload="metadata" controls />
      </Match>
      <Match when={p.att.kind === "audio"}>
        <AudioChip att={p.att} large />
      </Match>
    </Switch>
  );
}

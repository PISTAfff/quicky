import { createSignal, onCleanup, onMount } from "solid-js";
import { IClose } from "./icons";

/** Timer + live wave + discard button shown while a voice note records. */
export function RecStrip(p: { analyser: AnalyserNode; onCancel: () => void }) {
  const [secs, setSecs] = createSignal(0);
  const clock = setInterval(() => setSecs(secs() + 1), 1000);
  onCleanup(() => clearInterval(clock));
  const mmss = () => `${Math.floor(secs() / 60)}:${String(secs() % 60).padStart(2, "0")}`;
  return (
    <div class="rec-strip" role="status" aria-label={`Recording, ${mmss()}`}>
      <i class="rec-dot" />
      <span class="rec-time">{mmss()}</span>
      <LiveWave analyser={p.analyser} />
      <button class="ib" aria-label="Discard recording" title="Discard" onClick={p.onCancel}>
        <IClose size={14} />
      </button>
    </div>
  );
}

/**
 * Scrolling level meter for a live recording: one rounded bar per 45 ms, newest on the right.
 * Drawn on a canvas so each tick is a single small paint.
 */
export function LiveWave(p: { analyser: AnalyserNode; class?: string }) {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const g = canvas.getContext("2d")!;
    const samples = new Float32Array(p.analyser.fftSize);
    const BAR = 3;
    const GAP = 2;
    let levels: number[] = [];

    const resize = () => {
      const dpr = devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const color = getComputedStyle(canvas).color;
    // A steady tick (not requestAnimationFrame) so the history has no gaps even if frames are throttled.
    const tick = () => {
      p.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      // RMS, boosted so normal speech fills most of the height.
      const peak = Math.min(1, Math.sqrt(sum / samples.length) * 4.5);

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const max = Math.max(1, Math.floor(w / (BAR + GAP)));
      levels.push(peak);
      if (levels.length > max) levels = levels.slice(-max);

      g.clearRect(0, 0, w, h);
      g.fillStyle = color;
      const x0 = w - levels.length * (BAR + GAP);
      levels.forEach((lv, i) => {
        const bh = Math.max(3, lv * h);
        g.globalAlpha = 0.35 + 0.65 * ((i + 1) / levels.length);
        g.beginPath();
        g.roundRect(x0 + i * (BAR + GAP), (h - bh) / 2, BAR, bh, 1.5);
        g.fill();
      });
      g.globalAlpha = 1;
    };
    const timer = setInterval(tick, 45);
    onCleanup(() => {
      clearInterval(timer);
      ro.disconnect();
    });
  });

  return <canvas ref={canvas} class={`livewave ${p.class ?? ""}`} aria-hidden="true" />;
}

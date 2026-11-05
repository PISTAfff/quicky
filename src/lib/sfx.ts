// Little synthesized sound effects (Web Audio): no audio files, nothing to load.
// Shared by the main window, the bubble and the reminder; on/off and volume live in
// localStorage so every window follows the same setting.

const KEY = "quicky-sfx";

export interface SfxPrefs {
  on: boolean;
  volume: number; // 0..1
}

export function readSfx(): SfxPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (p && typeof p.on === "boolean" && typeof p.volume === "number") return p;
  } catch {}
  return { on: true, volume: 0.6 };
}

export function writeSfx(p: SfxPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
}

interface Note {
  f: number; // start frequency (Hz)
  to?: number; // glide to this frequency
  d: number; // duration (s)
  t?: number; // start offset (s)
  type?: OscillatorType;
  g?: number; // loudness 0..1
}

let ctx: AudioContext | null = null;

function play(notes: Note[]) {
  const prefs = readSfx();
  if (!prefs.on || prefs.volume <= 0) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const master = ctx.createGain();
    master.gain.value = prefs.volume * 0.3;
    master.connect(ctx.destination);
    for (const n of notes) {
      const t0 = ctx.currentTime + (n.t ?? 0);
      const osc = ctx.createOscillator();
      osc.type = n.type ?? "sine";
      osc.frequency.setValueAtTime(n.f, t0);
      if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t0 + n.d);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(n.g ?? 0.6, t0 + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + n.d);
      osc.connect(env).connect(master);
      osc.start(t0);
      osc.stop(t0 + n.d + 0.03);
    }
  } catch {
    // No audio device: stay quiet.
  }
}

let lastSquish = 0;
let lastGoo = 0;

export const sfx = {
  /** New task: a bright little "plip". */
  add: () => play([{ f: 520, to: 780, d: 0.11, type: "triangle" }, { f: 1040, d: 0.1, t: 0.06, g: 0.35 }]),
  /** Finished: a happy three-note chime. */
  done: () =>
    play([
      { f: 659, d: 0.14, type: "triangle", g: 0.5 },
      { f: 880, d: 0.14, t: 0.08, type: "triangle", g: 0.5 },
      { f: 1319, d: 0.28, t: 0.16, g: 0.45 },
    ]),
  /** Started: a short rising blip. */
  doing: () => play([{ f: 440, to: 620, d: 0.1, type: "triangle", g: 0.5 }]),
  /** Back / undo: falling blip. */
  undo: () => play([{ f: 720, to: 420, d: 0.15, type: "triangle", g: 0.45 }]),
  /** Deleted: a soft low "whmp". */
  delete: () => play([{ f: 260, to: 110, d: 0.22, type: "triangle", g: 0.5 }]),
  /** A panel slides in / out. */
  open: () => play([{ f: 380, to: 640, d: 0.11, g: 0.3 }]),
  close: () => play([{ f: 600, to: 360, d: 0.09, g: 0.25 }]),
  /** Bubble tapped. */
  tap: () => play([{ f: 880, to: 620, d: 0.06, g: 0.35 }]),
  /** Squashing against a wall: pitch rises with the strain. Throttled. */
  squish: (strain: number) => {
    const now = performance.now();
    if (now - lastSquish < 90) return;
    lastSquish = now;
    play([{ f: 160 + strain * 260, to: 130 + strain * 320, d: 0.08, type: "triangle", g: 0.18 + strain * 0.2 }]);
  },
  /** The sticky trail stretching as the bubble moves: a wet squelch, faster and higher with
   *  speed (0..1). Throttled. */
  goo: (speed: number) => {
    const now = performance.now();
    if (speed < 0.08 || now - lastGoo < 140 - speed * 60) return;
    lastGoo = now;
    const f = 70 + Math.random() * 50 + speed * 90;
    play([
      { f, to: f * 0.55, d: 0.09, type: "triangle", g: 0.12 + speed * 0.16 },
      { f: f * 3.2, to: f * 2.1, d: 0.04, t: 0.03, g: 0.05 + speed * 0.06 },
    ]);
  },
  /** The bubble comes unstuck and the trail starts: a sticky pull. */
  stick: () => play([{ f: 90, to: 210, d: 0.16, type: "triangle", g: 0.3 }, { f: 420, to: 260, d: 0.07, t: 0.12, g: 0.12 }]),
  /** The trail slurped back in. */
  slurp: () =>
    play([
      { f: 160, to: 360, d: 0.1, type: "triangle", g: 0.3 },
      { f: 220, to: 480, d: 0.1, t: 0.08, type: "triangle", g: 0.26 },
      { f: 300, to: 160, d: 0.12, t: 0.17, type: "triangle", g: 0.22 },
    ]),
  /** Springing back after a tug. */
  boing: () => play([{ f: 200, to: 540, d: 0.22, g: 0.45 }, { f: 540, to: 380, d: 0.16, t: 0.18, g: 0.2 }]),
  /** Popped out of an app. */
  pop: () => play([{ f: 320, to: 1500, d: 0.07, g: 0.6 }, { f: 1700, to: 500, d: 0.16, t: 0.06, type: "triangle", g: 0.35 }]),
  /** Dividing into a new mini. */
  split: () =>
    play([
      { f: 480, to: 760, d: 0.12, g: 0.4 },
      { f: 480, to: 760, d: 0.12, t: 0.14, g: 0.4 },
      { f: 1150, d: 0.2, t: 0.3, type: "triangle", g: 0.35 },
    ]),
  /** Reminder appears: a little tune. */
  remind: () =>
    play([
      { f: 784, d: 0.18, type: "triangle", g: 0.55 },
      { f: 988, d: 0.18, t: 0.13, type: "triangle", g: 0.55 },
      { f: 1175, d: 0.18, t: 0.26, type: "triangle", g: 0.55 },
      { f: 1568, d: 0.4, t: 0.39, g: 0.5 },
    ]),
  /** Snoozed: a sleepy slide down. */
  snooze: () => play([{ f: 620, to: 260, d: 0.35, g: 0.4 }]),
  /** A checklist step ticked: a tiny tick. */
  step: () => play([{ f: 1200, to: 1500, d: 0.05, type: "triangle", g: 0.35 }]),
  /** Something dropped on the bubble: a gulp. */
  gulp: () => play([{ f: 300, to: 180, d: 0.09, type: "triangle", g: 0.45 }, { f: 700, to: 980, d: 0.1, t: 0.08, g: 0.3 }]),
  /** The pinned task is done: a little fanfare. */
  cheer: () =>
    play([
      { f: 523, d: 0.12, type: "triangle", g: 0.5 },
      { f: 659, d: 0.12, t: 0.09, type: "triangle", g: 0.5 },
      { f: 784, d: 0.12, t: 0.18, type: "triangle", g: 0.5 },
      { f: 1047, d: 0.38, t: 0.27, g: 0.5 },
      { f: 1568, d: 0.3, t: 0.35, g: 0.2 },
    ]),
  /** Voice note start / stop. */
  recStart: () => play([{ f: 660, d: 0.07, g: 0.4 }, { f: 990, d: 0.09, t: 0.07, g: 0.4 }]),
  recStop: () => play([{ f: 990, d: 0.07, g: 0.4 }, { f: 660, d: 0.09, t: 0.07, g: 0.4 }]),
};

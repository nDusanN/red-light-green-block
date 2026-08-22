/**
 * Synthesised sound for the stage view.
 *
 * In a room where every demo is a silent screen-share, the one that makes noise is the one people
 * talk about afterwards. This is the cheapest memorability available: no audio files, no assets,
 * no dependencies — just oscillators.
 *
 * STAGE VIEW ONLY, NEVER THE PHONES. Fifty handsets buzzing a third of a second out of sync would
 * be noise rather than drama, and would make the game feel broken. One speaker, driven by the
 * screen everyone is already looking at.
 *
 * Browsers refuse to start audio without a user gesture, so `unlock()` must be called from a real
 * click. Until then every play call is a no-op rather than an error — a muted stage view is a
 * minor disappointment, a crashed one is a dead demo.
 */

let ctx: AudioContext | undefined;
let muted = false;

/** Call from a click handler. Safe to call repeatedly. */
export function unlock(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx.state !== "suspended";
  } catch {
    return false;
  }
}

export function setMuted(value: boolean): void {
  muted = value;
}

export function isMuted(): boolean {
  return muted;
}

export function isReady(): boolean {
  return Boolean(ctx) && ctx?.state === "running";
}

type ToneOptions = {
  freq: number;
  /** Seconds. */
  duration: number;
  type?: OscillatorType;
  /** Peak gain, 0..1. Kept well below 1 so stacked tones cannot clip. */
  gain?: number;
  /** Seconds to wait before starting, for building chords and sweeps. */
  delay?: number;
  /** Slide to this frequency over the duration. */
  slideTo?: number;
};

function tone({ freq, duration, type = "sine", gain = 0.18, delay = 0, slideTo }: ToneOptions): void {
  if (!ctx || muted || ctx.state !== "running") return;

  try {
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), start + duration);

    // A short attack and an exponential release: an abrupt stop produces an audible click, which
    // on a PA system sounds like a fault rather than a sound effect.
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(amp).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  } catch {
    // Never let a sound failure take down the screen the whole room is watching.
  }
}

/** The light turned green. Bright, short, inviting — this is the "go" cue. */
export function playGreen(): void {
  tone({ freq: 660, duration: 0.1, type: "triangle", gain: 0.16 });
  tone({ freq: 990, duration: 0.14, type: "triangle", gain: 0.12, delay: 0.07 });
}

/** The light turned red. Harsh and lower — unmistakably a warning. */
export function playRed(): void {
  tone({ freq: 220, duration: 0.26, type: "square", gain: 0.14 });
  tone({ freq: 155, duration: 0.32, type: "sawtooth", gain: 0.1, delay: 0.04 });
}

/**
 * A player died. Deliberately the most distinctive sound in the set.
 *
 * A falling sawtooth reads as a failure across any speaker, and it must not be confusable with the
 * red light itself — the light turning red is routine, someone dying to it is the moment.
 */
export function playElimination(): void {
  tone({ freq: 380, duration: 0.42, type: "sawtooth", gain: 0.2, slideTo: 70 });
  tone({ freq: 190, duration: 0.5, type: "square", gain: 0.1, delay: 0.05, slideTo: 45 });
}

/** Several players died in the same block. Stacked and heavier, so a cull sounds like an event. */
export function playMassElimination(count: number): void {
  playElimination();
  const extra = Math.min(4, Math.max(1, Math.floor(count / 2)));
  for (let i = 0; i < extra; i++) {
    tone({ freq: 300 - i * 40, duration: 0.5, type: "sawtooth", gain: 0.12, delay: 0.07 * (i + 1), slideTo: 55 });
  }
}

/** Somebody won. A rising arpeggio — the only unambiguously happy sound here. */
export function playWin(): void {
  const notes = [523, 659, 784, 1047];
  notes.forEach((freq, i) => tone({ freq, duration: 0.3, type: "triangle", gain: 0.2, delay: i * 0.09 }));
}

/** A round began. Two soft ticks, enough to draw eyes back to the screen. */
export function playRoundStart(): void {
  tone({ freq: 440, duration: 0.09, type: "sine", gain: 0.12 });
  tone({ freq: 587, duration: 0.12, type: "sine", gain: 0.12, delay: 0.11 });
}

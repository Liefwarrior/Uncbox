// A short, soft three-note chime made with WebAudio, so there are no sound files to ship.

let ctx: AudioContext | null = null;

/** Browsers only let a page make sound after the person has touched it; call this from a click (Start). */
export function primeAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    // No audio on this device: the timer still works, just silently.
  }
}

/** Notes (Hz) and when each starts (seconds): a rising major arpeggio. */
const NOTES: [number, number][] = [
  [784, 0],
  [988, 0.16],
  [1175, 0.32],
];

export function playChime() {
  primeAudio();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + 0.02;
    for (const [freq, at] of NOTES) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 1.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 1.4);
    }
  } catch {
    // Same as above.
  }
}

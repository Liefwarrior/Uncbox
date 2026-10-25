import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { HudRegion, PresetData } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { offerUndo } from '../undo';
import { type DebounceState, freshDebounce, planFire, readingKey, stepDebounce } from './triggers';

// The Stats panel's screen reader. The game panel shares its capture here; every second, each box
// is cut out of the latest frame, enlarged (OCR reads small game fonts much better bigger), and
// read by Windows' own OCR through the server (server/ocr.mjs). A reading has to come back the
// same twice in a row before it counts, so one blurry frame never flashes a wrong number.

let gameStream: MediaStream | null = null;
const listeners = new Set<() => void>();

/** The game panel calls this with its capture (or null), so the Stats panel can read it. */
export function shareGameStream(stream: MediaStream | null) {
  if (stream === gameStream) return;
  gameStream = stream;
  listeners.forEach((l) => l());
}

export function useGameStream(): MediaStream | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => gameStream,
  );
}

const EVERY_MS = 1000;
/** Boxes are enlarged until their text is about this tall, in pixels. */
const TARGET_HEIGHT = 72;

/** "1,234" → "1234"; letters OCR mistakes for digits in game fonts are turned back. Exported for tests. */
export function cleanReading(text: string, numeric: boolean): string {
  const t = text.trim();
  if (!numeric) return t;
  return t
    .replace(/[oOD]/g, '0')
    .replace(/[lI|!]/g, '1')
    .replace(/[sS]/g, '5')
    .replace(/[^\d]/g, '');
}

/** A box on the game picture, in percent of it. */
export type Box = Pick<HudRegion, 'x' | 'y' | 'w' | 'h'>;
/** Wider than this is shrunk, so a big box (a whole death screen) stays a small upload. */
const MAX_WIDTH = 1280;

/** A box cut out of the frame and enlarged, as base64 PNG (no data: prefix). */
export function cutOut(source: CanvasImageSource, vw: number, vh: number, r: Box, canvas: HTMLCanvasElement): string {
  const sx = (r.x / 100) * vw;
  const sy = (r.y / 100) * vh;
  const sw = Math.max(1, (r.w / 100) * vw);
  const sh = Math.max(1, (r.h / 100) * vh);
  const scale = Math.min(6, MAX_WIDTH / sw, Math.max(1, TARGET_HEIGHT / sh));
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
}

/** The text Windows' OCR reads in each box of the latest frame; null if the server could not read them. */
export async function readBoxes(v: HTMLVideoElement, boxes: Box[], canvas: HTMLCanvasElement): Promise<string[] | null> {
  if (!v.videoWidth || !boxes.length) return null;
  const images = boxes.map((r) => cutOut(v, v.videoWidth, v.videoHeight, r, canvas));
  const res = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images }),
  });
  if (!res.ok) return null;
  return ((await res.json()) as { texts: string[] }).texts;
}

/** A video element playing the stream, for grabbing frames from. */
export function useVideo(stream: MediaStream | null, enabled = true) {
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!stream || !enabled) return;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    v.play().catch(() => {});
    video.current = v;
    return () => {
      v.srcObject = null;
      video.current = null;
    };
  }, [stream, enabled]);
  return video;
}

/** Reads every box once a second and saves readings that changed. */
export function useHudReader(stream: MediaStream | null, regions: HudRegion[], mutatePreset: MutatePreset) {
  const video = useVideo(stream);
  const latest = useRef(regions);
  useEffect(() => {
    latest.current = regions;
  });
  const on = Boolean(stream) && regions.length > 0;

  useEffect(() => {
    if (!on) return;
    const canvas = document.createElement('canvas');
    const pending = new Map<string, string>();
    let busy = false;
    const tick = async () => {
      const v = video.current;
      const boxes = latest.current;
      if (busy || !v || !v.videoWidth || !boxes.length) return;
      busy = true;
      try {
        const texts = await readBoxes(v, boxes, canvas);
        if (!texts) return;
        const changed: Record<string, string> = {};
        boxes.forEach((r, i) => {
          const reading = cleanReading(texts[i] ?? '', r.numeric);
          if (!reading) return;
          // Twice the same in a row, or it doesn't count.
          if (pending.get(r.id) !== reading) {
            pending.set(r.id, reading);
            return;
          }
          if (reading !== r.value) changed[r.id] = reading;
        });
        if (Object.keys(changed).length) {
          mutatePreset((d) => {
            for (const r of d.hud) {
              if (r.id in changed) {
                r.value = changed[r.id];
                r.at = Date.now();
              }
            }
          });
        }
      } catch {
        // Server busy or restarting; the next second tries again.
      } finally {
        busy = false;
      }
    };
    const t = setInterval(() => void tick(), EVERY_MS);
    return () => clearInterval(t);
  }, [on, video, mutatePreset]);
}

// ---------- screen triggers ----------

/** How many times each trigger has fired since Uncbox opened (not saved), for the Stats panel. */
const fired = new Map<string, number>();
const firedListeners = new Set<() => void>();
let firedSnapshot: ReadonlyMap<string, number> = new Map();

function countFired(id: string) {
  fired.set(id, (fired.get(id) ?? 0) + 1);
  firedSnapshot = new Map(fired);
  firedListeners.forEach((l) => l());
}

export function useFiredCounts(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    (l) => {
      firedListeners.add(l);
      return () => firedListeners.delete(l);
    },
    () => firedSnapshot,
  );
}

/**
 * Watches the boxes of the switched-on screen triggers, once a second and only while a game
 * picture is up. A phrase seen does its action once (see stepDebounce) and offers an Undo, since
 * OCR is sometimes wrong. Runs from the app root, so it works without the Stats panel on the board.
 */
export function useScreenTriggers(stream: MediaStream | null, data: PresetData, mutatePreset: MutatePreset) {
  const on = Boolean(stream) && data.triggers.some((t) => t.enabled);
  const video = useVideo(stream, on);
  const latest = useRef(data);
  useEffect(() => {
    latest.current = data;
  });

  useEffect(() => {
    if (!on) return;
    const canvas = document.createElement('canvas');
    const states = new Map<string, DebounceState>();
    let busy = false;
    const tick = async () => {
      const v = video.current;
      const active = latest.current.triggers.filter((t) => t.enabled);
      if (busy || !v || !v.videoWidth || !active.length) return;
      busy = true;
      try {
        const texts = await readBoxes(v, active, canvas);
        if (!texts) return;
        const now = Date.now();
        // Triggers switched off start over when they come back on.
        for (const id of [...states.keys()]) if (!active.some((t) => t.id === id)) states.delete(id);
        active.forEach((t, i) => {
          const data = latest.current;
          const { key, name } = readingKey(data, t, texts[i] ?? '');
          const step = stepDebounce(states.get(t.id) ?? freshDebounce(), key, now, t.cooldownSec);
          states.set(t.id, step.state);
          if (!step.fire) return;
          const plan = planFire(data, t, name);
          if (!plan) return;
          mutatePreset((d) => {
            plan.apply(d);
            const x = d.triggers.find((k) => k.id === t.id);
            if (x) x.at = now;
          });
          countFired(t.id);
          offerUndo(plan.message, () => mutatePreset(plan.undo));
        });
      } catch {
        // Server busy or restarting; the next second tries again.
      } finally {
        busy = false;
      }
    };
    const t = setInterval(() => void tick(), EVERY_MS);
    return () => clearInterval(t);
  }, [on, video, mutatePreset]);
}

/** Starts the run timer when the preset's game starts, and pauses it when the game closes. */
export function useGameDetect(exe: string | undefined, mutatePreset: MutatePreset) {
  useEffect(() => {
    if (!exe) return;
    let was: boolean | null = null;
    const check = async () => {
      const r = await fetch(`/api/running?names=${encodeURIComponent(exe)}`).catch(() => null);
      if (!r?.ok) return;
      const now = ((await r.json()) as { running: string[] }).running.length > 0;
      if (now === was) return;
      // Not running when Uncbox opens: leave a timer that was started by hand alone.
      const first = was === null;
      was = now;
      if (first && !now) return;
      mutatePreset((d) => {
        const t = d.run.timer;
        if (now && t.startedAt === null) t.startedAt = Date.now();
        else if (!now && t.startedAt !== null) {
          t.elapsedMs += Date.now() - t.startedAt;
          t.startedAt = null;
        }
      });
    };
    void check();
    const t = setInterval(() => void check(), 5000);
    return () => clearInterval(t);
  }, [exe, mutatePreset]);
}

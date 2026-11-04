import { useEffect, useRef, useState } from 'react';
import type { PresetData } from '../../src/state/model';
import type { MutatePreset } from '../../src/state/useAppState';
import { Assembler, COLS, fromBlocks, KIND_CHARACTER, KIND_GUILD, KIND_PARTY, KIND_QUESTS, locate, readBlocks, ROWS, type StripSpot } from './codec';
import { markWowSeen, sendWowLive } from '../../src/wow';
import { parseCharacter, parseParty, parseQuests, partySlots } from './parse';
import type { FromWorker, ToWorker } from './strip.worker';

// The addon shows each page for 50 ms, and only for a moment after something changes, so every
// captured frame is looked at, up to this many a second. Where the browser can, that happens in a
// worker (strip.worker.ts), copying only the strip's few rows of each frame, so the page's main
// thread, which draws the dashboard viewers see, does none of it; what is below is the fallback.
const MAX_FPS = 60;
// Room for the strip at the biggest block size locate() tries, below a title bar and border.
const REGION_W = 60 + COLS * 4;
const REGION_H = 100 + ROWS * 4 + 4;
/**
 * After this many unreadable frames in a row, every few frames also search the whole corner, in
 * case the window moved or resized. Searching less often than every frame keeps it cheap while the
 * strip is hidden, and still lands inside its shortest burst (150 ms).
 */
const MISSES_BEFORE_SEARCH = 20;
const SEARCH_EVERY = 6;
/**
 * The strip is hidden most of the time, so the crop from the last session is kept until it shows
 * up again. Otherwise its first appearance after a reload could reach viewers for a frame.
 */
const LAST_CROP_KEY = 'uncbox.wowStripPct';

/**
 * Whether the strip can be read in a worker of its own (see strip.worker.ts): the frames are handed
 * over as a stream, which needs a track processor and streams that can be transferred.
 */
function workerReads(): boolean {
  return typeof Worker === 'function' && typeof MediaStreamTrackProcessor === 'function' && typeof ReadableStream === 'function';
}

function lastCrop(): number {
  try {
    return Number(localStorage.getItem(LAST_CROP_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Reads the Uncbox addon's strip out of the game video and writes the character, quest log and party into
 * the WoW preset, only when something changed. The guild and raid messages (kinds 4 to 7) go to the
 * server, which keeps them in its database. Pass data only while the WoW preset is showing. `corner`
 * is where the addon was told to put the strip.
 * Returns how much of the video's height the strip covers from the top, in percent, so the game
 * panel can crop it out of what viewers see.
 */
export function useWowLink(stream: MediaStream | null, data: PresetData | null, mutatePreset: MutatePreset, corner: 'TOPLEFT' | 'TOPRIGHT' = 'TOPLEFT'): number {
  const [stripPct, setStripPct] = useState(lastCrop);
  const latest = useRef(data);
  useEffect(() => {
    latest.current = data;
  });
  const on = stream !== null && data !== null;

  useEffect(() => {
    if (!on || !stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const assembler = new Assembler();
    let spot: StripSpot | null = null;
    let misses = 0;
    let searches = 0;

    const strip = (pct: number) => {
      setStripPct(pct);
      try {
        localStorage.setItem(LAST_CROP_KEY, String(pct));
      } catch {
        // Private window: the crop just isn't remembered.
      }
    };

    const apply = (kind: number, text: string) => {
      const d = latest.current;
      if (!d) return;
      markWowSeen();
      if (kind >= KIND_GUILD) {
        sendWowLive(kind, text);
      } else if (kind === KIND_CHARACTER) {
        const c = parseCharacter(text);
        if (!c) return;
        const changed = (Object.keys(c) as (keyof typeof c)[]).some((k) => c[k] !== d.character[k]);
        if (changed || !d.wowLinkAt) {
          mutatePreset((p) => {
            Object.assign(p.character, c);
            p.wowLinkAt = Date.now();
          });
        }
      } else if (kind === KIND_QUESTS) {
        const quests = parseQuests(text);
        if (JSON.stringify(quests) !== JSON.stringify(d.quests) || !d.wowLinkAt) {
          mutatePreset((p) => {
            p.quests = quests;
            p.wowLinkAt = Date.now();
          });
        }
      } else if (kind === KIND_PARTY) {
        const slots = partySlots(parseParty(text), d.slots);
        if (JSON.stringify(slots) !== JSON.stringify(d.slots)) {
          mutatePreset((p) => {
            p.slots = partySlots(parseParty(text), p.slots);
            p.wowLinkAt = Date.now();
          });
        }
      }
    };

    /** The part of the frame from (x, y), w × h, at the canvas's top-left. */
    const grab = (frame: CanvasImageSource, x: number, y: number, w: number, h: number) => {
      if (canvas.width < w || canvas.height < h) {
        canvas.width = Math.max(canvas.width, w);
        canvas.height = Math.max(canvas.height, h);
      }
      ctx!.drawImage(frame, x, y, w, h, 0, 0, w, h);
      return ctx!.getImageData(0, 0, w, h);
    };

    const read = (frame: CanvasImageSource, vw: number, vh: number) => {
      if (!ctx || !vw || !vh) return;
      let page = null;
      if (spot) {
        // Only the strip's own few rows, which is all most frames need.
        const x = Math.max(0, Math.floor(spot.x) - 1);
        const y = Math.max(0, Math.floor(spot.y) - 1);
        const w = Math.min(vw - x, Math.ceil(COLS * spot.block) + 3);
        const h = Math.min(vh - y, Math.ceil(ROWS * spot.block) + 3);
        page = fromBlocks(readBlocks(grab(frame, x, y, w, h), { ...spot, x: spot.x - x, y: spot.y - y }));
      }
      if (!page) {
        if (spot && ++misses < MISSES_BEFORE_SEARCH) return;
        if (++searches % SEARCH_EVERY !== 0) return;
        // The strip is at the left edge, or the right one if the addon was told so.
        const x0 = corner === 'TOPRIGHT' ? Math.max(0, vw - REGION_W) : 0;
        const img = grab(frame, x0, 0, Math.min(REGION_W, vw), Math.min(REGION_H, vh));
        const local = locate(img, corner === 'TOPRIGHT' ? Infinity : undefined);
        page = local && fromBlocks(readBlocks(img, local));
        if (!local || !page) return;
        const found = { ...local, x: local.x + x0 };
        spot = found;
        // One pixel more, so a blurred edge never peeks through.
        strip(((found.y + ROWS * found.block + 1) / vh) * 100);
      }
      misses = 0;
      const text = assembler.push(page);
      if (text) apply(text.kind, text.text);
    };

    let stopped = false;
    let stop: () => void;
    let worker: Worker | null = null;
    if (workerReads()) {
      try {
        // The frames go to the worker as they arrive; the page only hears whole messages.
        const own = track.clone();
        const frames = new MediaStreamTrackProcessor({ track: own }).readable;
        worker = new Worker(new URL('./strip.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<FromWorker>) => {
          if (stopped) return;
          if (e.data.type === 'strip') strip(e.data.pct);
          else if (e.data.type === 'text') apply(e.data.kind, e.data.text);
        };
        worker.postMessage({ type: 'start', frames, corner } satisfies ToWorker, [frames as unknown as Transferable]);
        const running = worker;
        stop = () => {
          running.postMessage({ type: 'stop' } satisfies ToWorker);
          own.stop();
          running.terminate();
        };
      } catch {
        worker?.terminate();
        worker = null;
      }
    }
    if (worker) {
      // Started above.
    } else if (typeof MediaStreamTrackProcessor === 'function') {
      // Frames arrive as the game draws them, even while this window is in the background, where
      // timers slow to once a second and would miss the addon's short bursts.
      const own = track.clone();
      const reader = new MediaStreamTrackProcessor({ track: own }).readable.getReader();
      let lastAt = -Infinity;
      void (async () => {
        while (!stopped) {
          const { value: frame, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done || !frame) break;
          if (frame.timestamp - lastAt >= 1e6 / MAX_FPS - 2000) {
            lastAt = frame.timestamp;
            read(frame, frame.displayWidth, frame.displayHeight);
          }
          frame.close();
        }
      })();
      stop = () => {
        void reader.cancel().catch(() => {});
        own.stop();
      };
    } else {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.play().catch(() => {});
      const timer = setInterval(() => read(video, video.videoWidth, video.videoHeight), 1000 / MAX_FPS);
      stop = () => {
        clearInterval(timer);
        video.srcObject = null;
      };
    }
    return () => {
      stopped = true;
      stop();
    };
  }, [on, stream, mutatePreset, corner]);

  return on ? stripPct : 0;
}

import { useEffect, useRef, useState } from 'react';
import type { PresetData } from '../../src/state/model';
import type { MutatePreset } from '../../src/state/useAppState';
import { Assembler, COLS, fromBlocks, KIND_CHARACTER, KIND_PARTY, KIND_QUESTS, locate, readBlocks, ROWS, type StripSpot } from './codec';
import { parseCharacter, parseParty, parseQuests, partySlots } from './parse';

// The addon shows each page for 50 ms, and only for a moment after something changes, so every
// captured frame is looked at, up to this many a second.
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

function lastCrop(): number {
  try {
    return Number(localStorage.getItem(LAST_CROP_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Reads the Uncbox addon's strip out of the game video and writes the character, quest log and party into
 * the WoW preset, only when something changed. Pass data only while the WoW preset is showing.
 * Returns how much of the video's height the strip covers from the top, in percent, so the game
 * panel can crop it out of what viewers see.
 */
export function useWowLink(stream: MediaStream | null, data: PresetData | null, mutatePreset: MutatePreset): number {
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

    const apply = (kind: number, text: string) => {
      const d = latest.current;
      if (!d) return;
      if (kind === KIND_CHARACTER) {
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
        const img = grab(frame, 0, 0, Math.min(REGION_W, vw), Math.min(REGION_H, vh));
        const found = locate(img);
        page = found && fromBlocks(readBlocks(img, found));
        if (!found || !page) return;
        spot = found;
        // One pixel more, so a blurred edge never peeks through.
        const pct = ((found.y + ROWS * found.block + 1) / vh) * 100;
        setStripPct(pct);
        try {
          localStorage.setItem(LAST_CROP_KEY, String(pct));
        } catch {
          // Private window: the crop just isn't remembered.
        }
      }
      misses = 0;
      const text = assembler.push(page);
      if (text) apply(text.kind, text.text);
    };

    let stopped = false;
    let stop: () => void;
    if (typeof MediaStreamTrackProcessor === 'function') {
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
  }, [on, stream, mutatePreset]);

  return on ? stripPct : 0;
}

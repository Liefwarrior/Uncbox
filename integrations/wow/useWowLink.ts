import { useEffect, useRef, useState } from 'react';
import type { PresetData } from '../../src/state/model';
import type { MutatePreset } from '../../src/state/useAppState';
import { Assembler, COLS, fromBlocks, KIND_CHARACTER, KIND_QUESTS, locate, readBlocks, ROWS, type StripSpot } from './codec';
import { parseCharacter, parseQuests } from './parse';

const INTERVAL_MS = 100;
// Room for the strip at the biggest block size locate() tries, below a title bar and border.
const REGION_W = 60 + COLS * 4;
const REGION_H = 100 + ROWS * 4 + 4;
/** Unreadable frames in a row before searching for the strip again (the window moved or resized). */
const MISSES_BEFORE_SEARCH = 20;

/**
 * Reads the Uncbox addon's strip out of the game video and writes the character and quest log into
 * the WoW preset, only when something changed. Pass data only while the WoW preset is showing.
 * Returns how much of the video's height the strip covers from the top, in percent, so the game
 * panel can crop it out of what viewers see.
 */
export function useWowLink(stream: MediaStream | null, data: PresetData | null, mutatePreset: MutatePreset): number {
  const [stripPct, setStripPct] = useState(0);
  const latest = useRef(data);
  useEffect(() => {
    latest.current = data;
  });
  const on = stream !== null && data !== null;

  useEffect(() => {
    if (!on || !stream) return;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const assembler = new Assembler();
    let spot: StripSpot | null = null;
    let misses = 0;

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
      }
    };

    const tick = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!ctx || !vw || !vh) return;
      const w = Math.min(REGION_W, vw);
      const h = Math.min(REGION_H, vh);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(video, 0, 0, w, h, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      let page = spot ? fromBlocks(readBlocks(img, spot)) : null;
      if (!page) {
        if (spot && ++misses < MISSES_BEFORE_SEARCH) return;
        const found = locate(img);
        page = found && fromBlocks(readBlocks(img, found));
        if (!found || !page) return;
        spot = found;
        // One pixel more, so a blurred edge never peeks through.
        setStripPct(((found.y + ROWS * found.block + 1) / vh) * 100);
      }
      misses = 0;
      const text = assembler.push(page);
      if (text) apply(text.kind, text.text);
    };

    const timer = setInterval(tick, INTERVAL_MS);
    return () => {
      clearInterval(timer);
      video.srcObject = null;
      setStripPct(0);
    };
  }, [on, stream, mutatePreset]);

  return stripPct;
}

import { useEffect, useRef } from 'react';
import { useGameStream, useVideo } from '../hud/reader';
import { shell } from '../native';
import type { MutatePreset } from '../state/useAppState';
import { type SmiteSnapshot, useSmite } from '../smite';
import type { FromWorker, Job, Recipe, ToWorker } from './image.worker';
import {
  type Box,
  type CropInfo,
  type DamageHeading,
  type OcrLine,
  centerCrop,
  combatRowsCrop,
  findDamageHeadings,
  fpsCrop,
  hudGoldCrop,
  hudKdaCrop,
  hudTopCrop,
  KDA_PITCH,
  matchGod,
  parseCombatScreen,
  parseFps,
  parseHudGold,
  parseHudKda,
  parseHudTop,
  parseKillBanner,
  parseScoreboard,
  parseTopCards,
  toFrame,
} from './screen';
import { addKill, currentScreen, type KdaTracker, nextKda, noKda, publish, resetScreen } from './store';

// Reads SMITE 2's Tab screen, T screen and HUD off the game picture, once a second, with Windows'
// OCR (through the server). It only runs while it can matter: the SMITE 2 preset is showing, the
// game is on screen, the log says a match is on, and the page isn't hidden (unless this is the
// Uncbox app, which keeps running behind the game). The heavy part, turning a frame into pictures
// for the OCR, happens in a worker; the page only asks the browser for the crops.

const EVERY_MS = 1000;
/** The Tab screen's own look and the T screen's rows are read at this size for the second pass. */
const ROWS_SCALE = 2;
const BRIGHT_CUT = 170;

type Crop = { box: Box; scale: number; recipe: Recipe };

interface Reading {
  lines: OcrLine[][];
}

/** A whole read: asks the browser for each crop, has the worker make the pictures, and OCRs them in one request. */
async function look(
  video: HTMLVideoElement,
  worker: Worker,
  nextId: () => number,
  crops: Crop[],
): Promise<Reading | null> {
  const bitmaps = await Promise.all(
    crops.map(({ box, scale }) => {
      const x = Math.max(0, box.x);
      const y = Math.max(0, box.y);
      const w = Math.min(box.w, video.videoWidth - x);
      const h = Math.min(box.h, video.videoHeight - y);
      return createImageBitmap(video, x, y, w, h, { resizeWidth: Math.max(1, Math.round(w * scale)), resizeHeight: Math.max(1, Math.round(h * scale)), resizeQuality: 'high' });
    }),
  );
  const id = nextId();
  const images = await new Promise<(string | null)[]>((resolve) => {
    // A worker that never answers must not leave the reader waiting for good.
    const giveUp = setTimeout(() => {
      worker.removeEventListener('message', on);
      resolve([]);
    }, 5000);
    const on = (e: MessageEvent<FromWorker>) => {
      if (e.data.id !== id) return;
      clearTimeout(giveUp);
      worker.removeEventListener('message', on);
      resolve(e.data.images);
    };
    worker.addEventListener('message', on);
    const jobs: Job[] = bitmaps.map((bitmap, i) => ({ bitmap, recipe: crops[i].recipe }));
    worker.postMessage({ id, jobs } satisfies ToWorker, bitmaps);
  });
  const sent = images.map((img, i) => ({ img, i })).filter((x): x is { img: string; i: number } => x.img !== null);
  if (!sent.length) return null;
  const res = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: sent.map((x) => x.img), words: true }),
  });
  if (!res.ok) return null;
  const { lines } = (await res.json()) as { lines: OcrLine[][] };
  const out: OcrLine[][] = crops.map(() => []);
  sent.forEach((x, k) => (out[x.i] = lines[k] ?? []));
  return { lines: out };
}

const cropInfo = (c: Crop): CropInfo => ({ ox: c.box.x, oy: c.box.y, scale: c.scale });

/** Which row of the scoreboard is you: the one playing the god the log says you picked. */
function ownRow(rows: { god: string; k: number | null; d: number | null; a: number | null }[], god: string) {
  if (!god) return null;
  return rows.find((r) => r.god && matchGod(r.god, [god])) ?? null;
}

export function useSmiteScreen(on: boolean, mutatePreset: MutatePreset) {
  const stream = useGameStream();
  const snap = useSmite(on);
  const video = useVideo(stream);
  const active = on && Boolean(stream) && snap?.phase === 'match';
  // The latest log snapshot, for the loop to read without restarting.
  const snapRef = useRef<SmiteSnapshot | null>(snap);
  useEffect(() => {
    snapRef.current = snap;
  });
  // A new match starts from nothing.
  const matchKey = snap ? `${snap.startedAt}` : '';
  useEffect(() => resetScreen, [matchKey, active]);

  useEffect(() => {
    if (!active) return;
    const worker = new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module' });
    let seq = 0;
    const nextId = () => ++seq;
    let busy = false;
    let tracker: KdaTracker = noKda;
    let written = '';

    // Your own K/D/A goes into the Match panel, only when it differs from what was last written.
    const writeKda = (k: number, d: number, a: number) => {
      const key = `${k}/${d}/${a}`;
      if (key === written) return;
      written = key;
      mutatePreset((p) => {
        p.match.k = k;
        p.match.d = d;
        p.match.a = a;
      });
    };

    const tick = async () => {
      const v = video.current;
      const s = snapRef.current;
      if (busy || !v || !v.videoWidth || !s || s.phase !== 'match') return;
      // The Uncbox app keeps running behind the game; a browser tab that's hidden doesn't need to.
      if (document.hidden && !shell) return;
      busy = true;
      try {
        const { videoWidth: w, videoHeight: h } = v;
        const centre = centerCrop(w, h);
        const crops: Crop[] = [
          { box: centre.box, scale: centre.scale, recipe: { kind: 'plain', format: 'jpeg' } },
          { box: hudTopCrop(w, h), scale: 2, recipe: { kind: 'plain', format: 'png' } },
          { box: fpsCrop(w, h), scale: 3, recipe: { kind: 'bright', cut: BRIGHT_CUT } },
          { box: hudGoldCrop(w, h), scale: 3, recipe: { kind: 'plain', format: 'png' } },
          { box: hudKdaCrop(w, h), scale: 1, recipe: { kind: 'kda', pitch: KDA_PITCH * h } },
        ];
        const first = await look(v, worker, nextId, crops);
        if (!first) return;
        const now = Date.now();
        const [centreLines, topLines, fpsLines, goldLines, kdaLines] = first.lines;
        const frame = toFrame(centreLines, cropInfo(crops[0]));
        const gods = { allies: s.allies, enemies: s.enemies };

        // The top bar and corner are visible whichever screen is up.
        const top = parseHudTop(toFrame(topLines, cropInfo(crops[1])));
        if (top) publish({ top: { at: now, value: top } });
        const fps = parseFps(fpsLines);
        if (fps !== null) publish({ fps: { at: now, value: fps } });
        const gold = parseHudGold(toFrame(goldLines, cropInfo(crops[3])));
        if (gold !== null) publish({ gold: { at: now, value: gold } });

        const board = parseScoreboard(frame, gods);
        const heads = board ? null : findDamageHeadings(frame);
        if (board) {
          publish({ scoreboard: { at: now, value: board } });
          const me = ownRow([...board.order, ...board.chaos], s.god);
          if (me && me.k !== null && me.d !== null && me.a !== null) {
            // The Tab screen is the reliable reading, so it overrides the HUD's.
            tracker = { accepted: { k: me.k, d: me.d, a: me.a }, pending: null };
            writeKda(me.k, me.d, me.a);
          }
        } else if (heads) {
          await readCombat(v, worker, nextId, frame, heads, h, now);
        } else {
          // No big screen is up: the K/D/A strip is visible, and a kill banner may be.
          tracker = nextKda(tracker, parseHudKda(kdaLines));
          if (tracker.accepted) {
            const t = tracker.accepted;
            publish({ kda: { at: now, value: t } });
            writeKda(t.k, t.d, t.a);
          }
          const sc = currentScreen();
          const known = [...s.allies, ...s.enemies, ...(sc.scoreboard ? [...sc.scoreboard.value.order, ...sc.scoreboard.value.chaos].map((r) => r.player) : [])];
          const banner = parseKillBanner(frame, { w, h }, known);
          if (banner) publish({ kills: addKill(sc.kills, banner, now, sc.top?.value.time ?? '') });
        }
      } catch {
        // The server is busy or restarting, or the frame wasn't there; the next second tries again.
      } finally {
        busy = false;
      }
    };

    // The T screen's rows are garbled in the whole-picture read, so each side's rows are cut out,
    // enlarged and read twice: as they are, and with only the brightest pixels kept.
    async function readCombat(
      v: HTMLVideoElement,
      wk: Worker,
      id: () => number,
      frame: OcrLine[],
      heads: { dealt: DamageHeading | null; taken: DamageHeading | null },
      h: number,
      now: number,
    ) {
      const rows: Crop[] = [];
      for (const side of [heads.dealt, heads.taken]) {
        if (!side) continue;
        const box = combatRowsCrop(side, h);
        rows.push({ box, scale: ROWS_SCALE, recipe: { kind: 'plain', format: 'jpeg' } });
        rows.push({ box, scale: ROWS_SCALE, recipe: { kind: 'bright', cut: BRIGHT_CUT } });
      }
      const second = await look(v, wk, id, rows);
      if (!second) return;
      const plain: OcrLine[] = [];
      const bright: OcrLine[] = [];
      rows.forEach((c, i) => (c.recipe.kind === 'bright' ? bright : plain).push(...toFrame(second.lines[i], cropInfo(c))));
      const combat = parseCombatScreen(frame, plain, bright);
      if (combat) publish({ combat: { at: now, value: combat } });
      const cards = parseTopCards(frame);
      if (cards) publish({ cards: { at: now, value: cards } });
    }

    const timer = setInterval(() => void tick(), EVERY_MS);
    return () => {
      clearInterval(timer);
      worker.terminate();
    };
  }, [active, video, mutatePreset]);
}

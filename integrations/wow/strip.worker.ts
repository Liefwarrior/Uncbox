/// <reference lib="webworker" />
import { Assembler, COLS, fromBlocks, locate, readBlocks, ROWS, type Rgba, type StripSpot } from './codec';
import { inside, isPacked, rgbaFrom } from './region';

// The WoW link's strip reader, off the page's main thread (useWowLink.ts starts it).
//
// The addon shows each page of its strip for 50 ms, so every captured frame is looked at, up to 60
// a second. On the page's main thread that was a draw of the whole frame into a canvas and a read
// back of part of it, 60 times a second, on the same thread that draws the dashboard viewers see.
// Here, in a worker of its own, only the strip's few rows are copied out of each frame
// (VideoFrame.copyTo with a rectangle), and the page only hears about a message once all its pages
// have arrived: a few times a minute.

export type ToWorker = { type: 'start'; frames: ReadableStream<VideoFrame>; corner: 'TOPLEFT' | 'TOPRIGHT' } | { type: 'stop' };

export type FromWorker =
  /** A whole message from the addon. */
  | { type: 'text'; kind: number; text: string }
  /** Where the strip is: how much of the frame's height it covers from the top, in percent. */
  | { type: 'strip'; pct: number };

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

const post = (message: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);

/** For a frame that isn't packed RGB: drawn into a small canvas of the worker's own, then read. */
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

/**
 * The frame's pixels from (x, y), w x h (in the frame's visible picture), as RGBA with its top-left
 * there. Packed RGB frames are copied straight out, just that rectangle; others go through the canvas.
 */
async function region(frame: VideoFrame, x: number, y: number, w: number, h: number): Promise<{ img: Rgba; x: number; y: number } | null> {
  const visible = frame.visibleRect;
  const vw = visible?.width ?? frame.displayWidth;
  const vh = visible?.height ?? frame.displayHeight;
  const r = inside(x, y, w, h, vw, vh);
  if (!r) return null;
  if (isPacked(frame.format)) {
    try {
      const rect = { x: r.x + (visible?.x ?? 0), y: r.y + (visible?.y ?? 0), width: r.width, height: r.height };
      const bytes = new Uint8Array(frame.allocationSize({ rect }));
      const [plane] = await frame.copyTo(bytes, { rect });
      const img = plane && rgbaFrom(frame.format, bytes, plane.stride, r.width, r.height);
      if (img) return { img, x: r.x, y: r.y };
    } catch {
      // Not copyable here: the canvas does it.
    }
  }
  if (typeof OffscreenCanvas !== 'function') return null;
  if (!canvas || canvas.width < r.width || canvas.height < r.height) {
    canvas = new OffscreenCanvas(Math.max(canvas?.width ?? 0, r.width), Math.max(canvas?.height ?? 0, r.height));
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) return null;
  ctx.drawImage(frame, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return { img: ctx.getImageData(0, 0, r.width, r.height), x: r.x, y: r.y };
}

/** Reads every frame from `frames` until told to stop or the stream ends. */
async function run(frames: ReadableStream<VideoFrame>, corner: 'TOPLEFT' | 'TOPRIGHT', stopped: () => boolean) {
  const reader = frames.getReader();
  const assembler = new Assembler();
  let spot: StripSpot | null = null;
  let misses = 0;
  let searches = 0;
  let lastAt = -Infinity;
  let lastPct = -1;

  const read = async (frame: VideoFrame) => {
    const vw = frame.visibleRect?.width ?? frame.displayWidth;
    const vh = frame.visibleRect?.height ?? frame.displayHeight;
    if (!vw || !vh) return;
    let page = null;
    if (spot) {
      // Only the strip's own few rows, which is all most frames need.
      const got = await region(frame, Math.floor(spot.x) - 1, Math.floor(spot.y) - 1, Math.ceil(COLS * spot.block) + 3, Math.ceil(ROWS * spot.block) + 3);
      if (got) page = fromBlocks(readBlocks(got.img, { ...spot, x: spot.x - got.x, y: spot.y - got.y }));
    }
    if (!page) {
      if (spot && ++misses < MISSES_BEFORE_SEARCH) return;
      if (++searches % SEARCH_EVERY !== 0) return;
      // The strip is at the left edge, or the right one if the addon was told so.
      const x0 = corner === 'TOPRIGHT' ? Math.max(0, vw - REGION_W) : 0;
      const got = await region(frame, x0, 0, Math.min(REGION_W, vw), Math.min(REGION_H, vh));
      if (!got) return;
      const local = locate(got.img, corner === 'TOPRIGHT' ? Infinity : undefined);
      page = local && fromBlocks(readBlocks(got.img, local));
      if (!local || !page) return;
      spot = { ...local, x: local.x + got.x, y: local.y + got.y };
      // One pixel more, so a blurred edge never peeks through.
      const pct = ((spot.y + ROWS * spot.block + 1) / vh) * 100;
      if (pct !== lastPct) {
        lastPct = pct;
        post({ type: 'strip', pct });
      }
    }
    misses = 0;
    const text = assembler.push(page);
    if (text) post({ type: 'text', kind: text.kind, text: text.text });
  };

  try {
    while (!stopped()) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        if (frame.timestamp - lastAt >= 1e6 / MAX_FPS - 2000) {
          lastAt = frame.timestamp;
          await read(frame);
        }
      } finally {
        frame.close();
      }
    }
  } catch {
    // The capture ended.
  } finally {
    await reader.cancel().catch(() => {});
  }
}

let stop = false;
self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'stop') {
    stop = true;
    return;
  }
  stop = false;
  void run(msg.frames, msg.corner, () => stop);
};

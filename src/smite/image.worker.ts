// Turns the cut-outs of a game frame into pictures for the OCR, off the page's main thread. The
// page hands over small ImageBitmaps (already cut and sized by the browser); this draws each one,
// applies its recipe (see pixels.ts) and encodes it, so nothing heavier than a request is left on
// the page. Replies with base64 (no data: prefix), which is what /api/ocr takes.

import { brightText, kdaPicture, type Picture } from './pixels';

export type Recipe =
  /** As it is, as JPEG (big pictures) or PNG (small ones, where JPEG blurs thin text). */
  | { kind: 'plain'; format: 'jpeg' | 'png' }
  /** Only the brightest pixels, black on white. */
  | { kind: 'bright'; cut: number }
  /** The K/D/A strip's three numbers laid side by side; `pitch` is how far apart they are in pixels. */
  | { kind: 'kda'; pitch: number };

export interface Job {
  bitmap: ImageBitmap;
  recipe: Recipe;
}

export interface ToWorker {
  id: number;
  jobs: Job[];
}

export interface FromWorker {
  id: number;
  /** One per job, null where the picture couldn't be made (the strip wasn't found). */
  images: (string | null)[];
}

const JPEG_QUALITY = 0.9;

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function render(job: Job): Promise<string | null> {
  const { bitmap, recipe } = job;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: recipe.kind !== 'plain' })!;
  ctx.drawImage(bitmap, 0, 0);
  if (recipe.kind === 'plain') {
    const blob = await canvas.convertToBlob(recipe.format === 'jpeg' ? { type: 'image/jpeg', quality: JPEG_QUALITY } : { type: 'image/png' });
    return base64(blob);
  }
  const src = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pic: Picture = { data: src.data, w: src.width, h: src.height };
  const out = recipe.kind === 'bright' ? brightText(pic, recipe.cut) : kdaPicture(pic, recipe.pitch);
  if (!out) return null;
  const target = new OffscreenCanvas(out.w, out.h);
  target.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.w, out.h), 0, 0);
  return base64(await target.convertToBlob({ type: 'image/png' }));
}

onmessage = async (e: MessageEvent<ToWorker>) => {
  const { id, jobs } = e.data;
  const images: (string | null)[] = [];
  for (const job of jobs) {
    try {
      images.push(await render(job));
    } catch {
      images.push(null);
    } finally {
      job.bitmap.close();
    }
  }
  postMessage({ id, images } satisfies FromWorker);
};

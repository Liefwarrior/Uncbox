const AVATAR_MAX = 128;

/**
 * Shrinks an uploaded image so it can live inside state.json. Small sprites are kept at their
 * native size (no smoothing) so pixel art survives; only big images get resampled.
 */
export async function fileToAvatar(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, AVATAR_MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

/** Pulls an image out of a drop: a file from disk, or a URL dragged from another browser tab. */
export async function imageFromDrop(data: DataTransfer): Promise<string | null> {
  const file = Array.from(data.files).find((f) => f.type.startsWith('image/'));
  if (file) return fileToAvatar(file);
  const url = data.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#'));
  return url && /^https?:\/\//.test(url) ? url.trim() : null;
}

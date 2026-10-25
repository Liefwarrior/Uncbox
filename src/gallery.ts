import { useCallback, useEffect, useState } from 'react';
import type { PresetId } from './state/model';

// The preset gallery's page side: asking the local server (server/gallery.mjs) for the list and for
// a preset's file, and the plain logic around it (search, tag filters). Installing goes through
// parsePresetText and addImportedPreset in presetio.ts, the same as a file you import.

export interface GalleryEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  base: PresetId;
  tags: string[];
  /** A picture to show on the card, if the preset has one. */
  preview: string;
  updated: string;
}

export interface GalleryIndex {
  presets: GalleryEntry[];
  /** True when the gallery couldn't be reached and this is the last copy that was. */
  stale: boolean;
}

/** Where to read how to submit a preset. Opened in the browser. */
export const GALLERY_README_URL = 'https://github.com/Liefwarrior/Uncbox/blob/main/gallery/README.md';

const OPEN_EVENT = 'uncbox:gallery';

/** Opens the gallery from a button or a palette command. */
export function openGallery() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onOpenGallery(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}

/** Why the list isn't there, in words for the person looking at it. */
export class GalleryUnavailable extends Error {}

export async function fetchGalleryIndex(signal?: AbortSignal): Promise<GalleryIndex> {
  let res: Response;
  try {
    res = await fetch('/api/gallery', { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new GalleryUnavailable('Can’t reach Uncbox right now.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !Array.isArray(body.presets)) {
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    if (reason === 'missing') throw new GalleryUnavailable('The gallery isn’t online yet. Check back soon.');
    if (reason === 'offline') throw new GalleryUnavailable('Couldn’t reach the gallery. Check your internet connection and try again.');
    throw new GalleryUnavailable(typeof body?.error === 'string' ? body.error : 'The gallery isn’t available right now.');
  }
  return { presets: body.presets as GalleryEntry[], stale: body.stale === true };
}

/** The text of a gallery preset's file, to go through parsePresetText. */
export async function fetchGalleryPreset(id: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api/gallery/preset/${encodeURIComponent(id)}`);
  } catch {
    throw new GalleryUnavailable('Can’t reach Uncbox right now.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new GalleryUnavailable(typeof body?.error === 'string' ? body.error : 'Couldn’t download that preset. Try again.');
  }
  return res.text();
}

export const previewUrl = (id: string) => `/api/gallery/preview/${encodeURIComponent(id)}`;

/** The list, loaded when the gallery opens, with a way to try again. */
export function useGallery(): { index: GalleryIndex | null; error: string | null; reload: () => void } {
  const [index, setIndex] = useState<GalleryIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    fetchGalleryIndex(abort.signal)
      .then(setIndex)
      .catch((err) => {
        if (abort.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'The gallery isn’t available right now.');
      });
    return () => abort.abort();
  }, [tries]);
  const reload = useCallback(() => {
    setIndex(null);
    setTries((n) => n + 1);
  }, []);
  return { index, error, reload };
}

/** Every tag in the list, most used first. */
export function allTags(entries: GalleryEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const e of entries) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/**
 * The entries that match what was typed (every word, in the name, author, description, tags or
 * the game's name) and, if one is chosen, carry the tag.
 */
export function filterGallery(entries: GalleryEntry[], query: string, tag: string | null, baseName: (base: PresetId) => string = (b) => b): GalleryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (tag && !e.tags.includes(tag)) return false;
    const haystack = [e.name, e.author, e.description, baseName(e.base), ...e.tags].join(' ').toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

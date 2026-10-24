import { useEffect, useSyncExternalStore } from 'react';

// The launcher's tiles are saved on this PC by the server (server/launcher.mjs), not in the page's
// state: the page only keeps which tile ids a widget shows, and asks the server to open one by id.

export type TileType = 'app' | 'folder' | 'file' | 'url' | 'steam';

export interface Tile {
  id: string;
  name: string;
  type: TileType;
  target: string;
}

export interface TileDraft {
  id?: string;
  name: string;
  type: TileType;
  target: string;
}

export interface Shortcut {
  name: string;
  path: string;
}

export const TILE_KINDS: { type: TileType; label: string; placeholder: string }[] = [
  { type: 'app', label: 'App or shortcut', placeholder: 'C:\\Program Files\\App\\App.exe' },
  { type: 'folder', label: 'Folder', placeholder: 'C:\\Users\\you\\Documents' },
  { type: 'file', label: 'File', placeholder: 'C:\\Users\\you\\notes.txt' },
  { type: 'url', label: 'Website', placeholder: 'https://example.com' },
  { type: 'steam', label: 'Steam game or link', placeholder: 'steam://rungameid/570 (or just the game number)' },
];

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data as T;
}

// One list shared by every launcher widget, so adding a tile in one shows up in the others.
let tiles: Tile[] | null = null;
const listeners = new Set<() => void>();
const publish = (next: Tile[]) => {
  tiles = next;
  listeners.forEach((l) => l());
};

export async function loadTiles() {
  publish((await call<{ tiles: Tile[] }>('/api/launcher/tiles')).tiles);
}

/** Every saved tile, or null until the first answer. */
export function useTiles(): Tile[] | null {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => tiles,
  );
  useEffect(() => {
    void loadTiles().catch(() => {});
  }, []);
  return list;
}

/** Saves a new tile or an edit of one; resolves to the saved tile. */
export async function saveTile(draft: TileDraft): Promise<Tile> {
  const { tile } = await call<{ tile: Tile }>('/api/launcher/tiles', draft);
  publish([...(tiles ?? []).filter((t) => t.id !== tile.id), tile]);
  return tile;
}

export const launchTile = (id: string) => call('/api/launcher/launch', { id });

export async function findShortcuts(query: string): Promise<Shortcut[]> {
  return (await call<{ items: Shortcut[] }>(`/api/launcher/start-menu?q=${encodeURIComponent(query)}`)).items;
}

/** Icon addresses to try for a website, best first: Google's favicon service, then the site's own. */
export function faviconSources(link: string): string[] {
  try {
    const url = new URL(link);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
    return [`https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=64`, `${url.origin}/favicon.ico`];
  } catch {
    return [];
  }
}

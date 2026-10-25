import { readableOnDark } from './classColor';

// Item quality, as the game colors it: gray, white, green, blue, purple, orange.

export const QUALITIES = [
  { id: 0, name: 'Poor', color: '#9d9d9d' },
  { id: 1, name: 'Common', color: '#ffffff' },
  { id: 2, name: 'Uncommon', color: '#1eff00' },
  { id: 3, name: 'Rare', color: '#0070dd' },
  { id: 4, name: 'Epic', color: '#a335ee' },
  { id: 5, name: 'Legendary', color: '#ff8000' },
  { id: 6, name: 'Artifact', color: '#e6cc80' },
] as const;

/** The color to draw an item's name in (lightened where the game's own is too dark to read on a panel). */
export function qualityColor(quality: number): string {
  const q = QUALITIES.find((x) => x.id === quality) ?? QUALITIES[1];
  return readableOnDark(q.color);
}

export const qualityName = (quality: number): string => QUALITIES.find((x) => x.id === quality)?.name ?? 'Common';

import type { StreamSettings } from '../state/model';

// The Quality choices in the sidebar: a picture size, a frame rate and a bitrate chosen together,
// so nobody has to know which bitrate suits which size.

export type Quality = Pick<StreamSettings, 'height' | 'fps' | 'kbps'>;

export const QUALITIES = [
  { id: '1080p60', label: '1080p60 · 6000', height: 1080, fps: 60, kbps: 6000 },
  { id: '1080p30', label: '1080p30 · 4500', height: 1080, fps: 30, kbps: 4500 },
  { id: '720p60', label: '720p60 · 4500', height: 720, fps: 60, kbps: 4500 },
  { id: '720p30', label: '720p30 · 3000', height: 720, fps: 30, kbps: 3000 },
  { id: 'screen', label: 'Screen size', height: 0, fps: 60, kbps: 6000 },
] as const satisfies readonly (Quality & { id: string; label: string })[];

export type QualityId = (typeof QUALITIES)[number]['id'];

/** Which choice the settings match, or null for a combination the list doesn't have (a hand-edited file). */
export function qualityOf(s: Quality): QualityId | null {
  return QUALITIES.find((q) => q.height === s.height && q.fps === s.fps && q.kbps === s.kbps)?.id ?? null;
}

/** The picture size, frame rate and bitrate a choice stands for. */
export function qualityValues(id: QualityId): Quality {
  const q = QUALITIES.find((x) => x.id === id) ?? QUALITIES[0];
  return { height: q.height, fps: q.fps, kbps: q.kbps };
}

/** "1080p60 · 6000" for any settings, listed or not. */
export function qualityLabel(s: Quality): string {
  const id = qualityOf(s);
  if (id) return QUALITIES.find((q) => q.id === id)!.label;
  return `${s.height ? `${s.height}p` : 'Screen size '}${s.fps} · ${s.kbps}`;
}

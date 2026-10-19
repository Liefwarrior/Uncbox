// Backgrounds behind the board. Each preset keeps its own choice, and every one is drawn in that
// preset's theme colors: "particles" are animated shapes (tsParticles), "pattern" a repeating tile
// (Hero Patterns), "plain" the theme's own soft glow.

export const BACKGROUNDS = [
  { id: 'plain', name: 'Plain', kind: 'plain' },
  { id: 'network', name: 'Network', kind: 'particles' },
  { id: 'stars', name: 'Stars', kind: 'particles' },
  { id: 'bubbles', name: 'Bubbles', kind: 'particles' },
  { id: 'shards', name: 'Shards', kind: 'particles' },
  { id: 'circuit', name: 'Circuit', kind: 'pattern' },
  { id: 'waves', name: 'Waves', kind: 'pattern' },
  { id: 'hexagons', name: 'Hexagons', kind: 'pattern' },
  { id: 'grid', name: 'Grid', kind: 'pattern' },
] as const;

export type BackgroundId = (typeof BACKGROUNDS)[number]['id'];
export type BackgroundKind = (typeof BACKGROUNDS)[number]['kind'];

export function isBackgroundId(v: unknown): v is BackgroundId {
  return BACKGROUNDS.some((b) => b.id === v);
}

export function backgroundKind(id: BackgroundId): BackgroundKind {
  return BACKGROUNDS.find((b) => b.id === id)?.kind ?? 'plain';
}

export type LootSettings = {
  /** What the widget opens on: the drops, or who has had the fewest. */
  view: 'history' | 'fair';
  /** Items of this quality and better (2 is green). */
  minQuality: number;
  /** Only the last this many days; 0 for all of it. */
  days: number;
  /** Show names on stream. Off, viewers see Member 1, Member 2… */
  showNamesOnStream: boolean;
};

export const defaultLootSettings = (): LootSettings => ({ view: 'history', minQuality: 2, days: 30, showNamesOnStream: false });

export function cleanLootSettings(s: LootSettings): LootSettings {
  const q = Math.round(Number(s.minQuality));
  const days = Math.round(Number(s.days));
  return { ...s, view: s.view === 'fair' ? 'fair' : 'history', minQuality: q >= 0 && q <= 6 ? q : 2, days: [0, 7, 30, 90].includes(days) ? days : 30 };
}

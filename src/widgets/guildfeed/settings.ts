import { DEFAULT_KINDS, FEED_KINDS, type FeedKind } from './feed';

export type FeedSettings = {
  /** Which kinds of news to show. Coming online and going offline are off to start with: they are noisy. */
  kinds: FeedKind[];
  /** Loot of this quality and better is news. 4 is epic. */
  lootMinQuality: number;
  /** Show who left, was removed or was demoted on stream too. */
  showDeparturesOnStream: boolean;
};

export const defaultFeedSettings = (): FeedSettings => ({ kinds: [...DEFAULT_KINDS], lootMinQuality: 4, showDeparturesOnStream: false });

export function cleanFeedSettings(s: FeedSettings): FeedSettings {
  const kinds = Array.isArray(s.kinds) ? FEED_KINDS.filter((k) => s.kinds.includes(k)) : [...DEFAULT_KINDS];
  const q = Math.round(Number(s.lootMinQuality));
  return { ...s, kinds, lootMinQuality: q >= 0 && q <= 6 ? q : 4 };
}

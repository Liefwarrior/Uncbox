import { describe, expect, it } from 'vitest';
import { EVENTS, LOOT, RAIDS } from '../../wowMocks';
import { buildFeed, DEFAULT_KINDS, eventLine, FEED_KINDS, type FeedOptions, newIds } from './feed';
import { cleanFeedSettings, defaultFeedSettings } from './settings';

const input = { events: EVENTS, raids: RAIDS, loot: LOOT };
const opts: FeedOptions = { kinds: DEFAULT_KINDS, lootMinQuality: 4, hideDepartures: false, max: 100 };

describe('eventLine', () => {
  it('says each kind of news in plain words', () => {
    const e = (type: string, a = '', b = '') => eventLine({ id: 1, at: 1, type: type as never, name: 'Zoë', a, b }).text;
    expect(e('join')).toBe('Zoë joined the guild');
    expect(e('leave')).toBe('Zoë left the guild');
    expect(e('kick', '', 'Lief')).toBe('Zoë was removed from the guild by Lief');
    expect(e('promote', 'Officer', 'Lief')).toBe('Zoë was promoted to Officer by Lief');
    expect(e('demote', 'Initiate')).toBe('Zoë was demoted to Initiate');
    expect(e('level', '42')).toBe('Zoë reached level 42');
    expect(e('on')).toBe('Zoë came online');
    expect(e('off')).toBe('Zoë went offline');
  });

  it('marks the news about someone going or coming down a rank', () => {
    const dep = (type: string) => eventLine({ id: 1, at: 1, type: type as never, name: 'x', a: '', b: '' }).departure;
    expect([dep('leave'), dep('kick'), dep('demote')]).toEqual([true, true, true]);
    expect([dep('join'), dep('promote'), dep('level'), dep('on')]).toEqual([false, false, false, false]);
  });
});

describe('buildFeed', () => {
  it('puts events, boss kills and notable loot together, newest first', () => {
    const feed = buildFeed(input, opts);
    expect(feed.map((i) => i.at)).toEqual([...feed.map((i) => i.at)].sort((a, b) => b - a));
    expect(feed.some((i) => i.kind === 'boss' && i.text === 'Lucifron was defeated in Molten Core')).toBe(true);
    expect(feed.find((i) => i.kind === 'loot')?.text).toBe('Kaz got Arcanist Bindings from Magmadar');
  });

  it('leaves out coming online and going offline until they are turned on', () => {
    expect(buildFeed(input, opts).some((i) => i.kind === 'online')).toBe(false);
    expect(buildFeed(input, { ...opts, kinds: [...FEED_KINDS] }).some((i) => i.kind === 'online')).toBe(true);
  });

  it('only counts loot of the quality set, and a stack as one line', () => {
    expect(buildFeed(input, { ...opts, kinds: ['loot'] }).map((i) => i.quality)).toEqual([4, 4]);
    expect(buildFeed(input, { ...opts, kinds: ['loot'], lootMinQuality: 3 })).toHaveLength(3);
    const stack = buildFeed({ events: [], raids: [], loot: [{ ...LOOT[0], count: 3 }] }, { ...opts, kinds: ['loot'] });
    expect(stack[0].text).toContain('×3');
  });

  it('shows only the kinds asked for', () => {
    expect(buildFeed(input, { ...opts, kinds: ['join'] }).map((i) => i.text)).toEqual(['Vex joined the guild']);
    expect(buildFeed(input, { ...opts, kinds: [] })).toEqual([]);
  });

  it('drops who left or was demoted when asked (stream), keeping the rest', () => {
    const all = buildFeed(input, opts);
    const kept = buildFeed(input, { ...opts, hideDepartures: true });
    expect(all.some((i) => i.text.includes('Grim left'))).toBe(true);
    expect(kept.some((i) => i.departure)).toBe(false);
    expect(kept).toHaveLength(all.filter((i) => !i.departure).length);
  });

  it('keeps only the newest max lines, and ignores a boss that was not killed', () => {
    expect(buildFeed(input, { ...opts, max: 2 })).toHaveLength(2);
    const wipe = { ...RAIDS[0], bosses: [{ ...RAIDS[0].bosses[0], success: false }] };
    expect(buildFeed({ events: [], raids: [wipe], loot: [] }, opts)).toEqual([]);
  });

  it('gives the same news the same id each time, so a refetch is not new', () => {
    expect(buildFeed(input, opts).map((i) => i.id)).toEqual(buildFeed(input, opts).map((i) => i.id));
    expect(new Set(buildFeed(input, { ...opts, kinds: [...FEED_KINDS] }).map((i) => i.id)).size).toBe(buildFeed(input, { ...opts, kinds: [...FEED_KINDS] }).length);
  });
});

describe('newIds', () => {
  it('is empty the first time, so nothing fades in on load', () => {
    expect(newIds(null, buildFeed(input, opts)).size).toBe(0);
  });

  it('is the lines that were not there before', () => {
    const feed = buildFeed(input, opts);
    const before = new Set(feed.slice(1).map((i) => i.id));
    expect([...newIds(before, feed)]).toEqual([feed[0].id]);
  });
});

describe('settings', () => {
  it('start without online and offline, and with epic loot', () => {
    const s = defaultFeedSettings();
    expect(s.kinds).not.toContain('online');
    expect(s.lootMinQuality).toBe(4);
    expect(s.showDeparturesOnStream).toBe(false);
  });

  it('are put right when they come from a hand-edited file', () => {
    expect(cleanFeedSettings({ ...defaultFeedSettings(), kinds: ['loot', 'nonsense', 'join'] as never, lootMinQuality: 40 })).toMatchObject({ kinds: ['join', 'loot'], lootMinQuality: 4 });
    expect(cleanFeedSettings({ ...defaultFeedSettings(), kinds: 'x' as never }).kinds).toEqual(DEFAULT_KINDS);
  });
});
